import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { connect } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import type { WebStore } from './store.ts';
import { WebIdentity } from './web-identity.ts';
import { WebAdmission } from './web-admission.ts';
import { WebVerticalPublisher } from './web-vertical-publisher.ts';
import { WebLocalExecutor } from './web-local-executor.ts';
import { localTls, type WebLocalConfig } from './web-local-config.ts';
import { serveLocalStatic } from './web-local-static.ts';
import { requireWebContent, webDataLifecycleEnabled, type WebRetentionRow } from './web-retention.ts';
import { WebInviteAdmin } from './web-invite-admin.ts';
import { WebInvites } from './web-invites.ts';
import { WebInviteActions } from './web-invite-actions.ts';
import { routeWebInvite } from './web-invite-routes.ts';

const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
type Principal = ReturnType<WebIdentity['authenticate']>;

/** Local-only transport. The Store remains the sole business writer. */
export class WebLocalServer {
  readonly server: Server;
  readonly executor: WebLocalExecutor;
  private readonly store: WebStore;
  private readonly config: WebLocalConfig;
  private readonly identity: WebIdentity;
  private readonly admission: WebAdmission;
  private readonly publisher: WebVerticalPublisher;
  private readonly clock: Clock;
  private readonly inviteAdmin: WebInviteAdmin | null;
  private readonly inviteActions: WebInviteActions | null;
  private readonly streams = new Map<string, number>();
  private readonly activeStreams = new Set<ServerResponse>();

  constructor(store: WebStore, config: WebLocalConfig, clock: Clock) {
    const schema = store.get<{ user_version: number }>('PRAGMA user_version')?.user_version;
    ensure([109, 110, 112].includes(schema ?? -1), 'WEB_LOCAL_MIGRATION_REQUIRED');
    if (schema === 112) store.requireInviteTest();
    ensure(
      store.instanceId === config.instanceId &&
        store.get<{ recovery_epoch: string }>('SELECT recovery_epoch FROM web_instance WHERE singleton=1')
          ?.recovery_epoch === config.recoveryEpoch,
      'WEB_LOCAL_INSTANCE_MISMATCH',
    );
    const templates = store.all<{ id: string; config_json: string }>('SELECT id,config_json FROM character_templates');
    ensure(
      templates.length === 1 &&
        templates[0]?.id === 'synthetic-local' &&
        JSON.parse(templates[0].config_json).persona === '仅供本地离线接口测试，不是真实人物设定。',
      'WEB_LOCAL_SYNTHETIC_ONLY',
    );
    this.store = store;
    this.config = config;
    this.clock = clock;
    this.identity = new WebIdentity(store, {
      origin: config.origin,
      cookieName: config.cookieName,
      keys: {
        keyId: 'local-v1',
        sealKey: Buffer.from(config.sealKey, 'base64url'),
        requestKey: Buffer.from(config.requestKey, 'base64url'),
      },
      clock,
    });
    this.admission = new WebAdmission(store, clock, cryptoRandomId);
    this.publisher = new WebVerticalPublisher(store, clock);
    this.executor = new WebLocalExecutor(store, clock);
    this.inviteAdmin = schema === 112 ? new WebInviteAdmin(store, clock, config.origin) : null;
    const invites =
      schema === 112
        ? new WebInvites(store, {
            clock,
            codeKey: createHmac('sha256', Buffer.from(config.requestKey, 'base64url'))
              .update('web-local-invite-code-v1')
              .digest(),
            authorize: this.identity.authorizeInviteAction.bind(this.identity),
            identity: this.identity,
          })
        : null;
    this.inviteActions = invites ? new WebInviteActions(store, clock, config.origin, invites, this.identity) : null;
    this.server = createServer({ ...localTls(store.root), maxHeaderSize: 8192 }, (req, res) => {
      void this.handle(req, res);
    });
  }

  async listen() {
    for (let attempt = 0; ; attempt++) {
      try {
        this.executor.start();
        break;
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          error.code !== 'WEB_COORDINATOR_BUSY' ||
          attempt >= 128 ||
          (await this.portOccupied())
        )
          throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.config.port, '127.0.0.1', () => {
          this.server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.executor.stop();
      throw error;
    }
  }

  private portOccupied() {
    return new Promise<boolean>((resolveProbe) => {
      const socket = connect(this.config.port, '127.0.0.1');
      const done = (occupied: boolean) => {
        socket.destroy();
        resolveProbe(occupied);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(200, () => done(false));
    });
  }

  async close() {
    this.executor.stop();
    for (const stream of this.activeStreams) stream.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private cookie(req: IncomingMessage, name = this.config.cookieName): string | undefined {
    const raw = req.headers.cookie;
    if (raw === undefined) return undefined;
    ensure(raw.length <= 4096 && !/[\r\n]/.test(raw), 'INVALID_REQUEST');
    const found = raw
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`));
    ensure(found.length <= 1, 'INVALID_REQUEST');
    return found[0]?.slice(name.length + 1);
  }

  private setCookie(res: ServerResponse, token: string) {
    res.setHeader('Set-Cookie', `${this.config.cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`);
  }

  private authenticate(req: IncomingMessage): { principal: Principal; token: string } {
    const token = this.cookie(req);
    ensure(token, 'AUTH_REQUIRED');
    return { principal: this.identity.authenticate(token), token };
  }

  private authorizeWrite(req: IncomingMessage) {
    const token = this.cookie(req),
      origin = req.headers.origin,
      csrf = req.headers['x-csrf-token'];
    ensure(token, 'AUTH_REQUIRED');
    ensure(typeof origin === 'string' && typeof csrf === 'string', 'CSRF_INVALID');
    return { principal: this.identity.authorizeWrite(token, csrf, origin), token, csrf, origin };
  }

  private ipHash(req: IncomingMessage) {
    ensure(req.socket.remoteAddress === '127.0.0.1', 'REGION_UNAVAILABLE');
    return createHmac('sha256', Buffer.from(this.config.ipKey, 'base64url'))
      .update('web-local-ip-v1\0')
      .update('127.0.0.1')
      .digest('hex');
  }

  private cursor(principalId: string, seq: number, conversationId?: string) {
    const payload = Buffer.from(
      JSON.stringify([1, this.config.instanceId, this.config.recoveryEpoch, principalId, conversationId ?? null, seq]),
    ).toString('base64url');
    const mac = createHmac('sha256', Buffer.from(this.config.cursorKey, 'base64url'))
      .update(payload)
      .digest('base64url');
    return `${payload}.${mac}`;
  }

  private eventHighWater() {
    // AUTOINCREMENT keeps the allocated sequence after another principal's events are purged.
    const seq = this.store.get<{ seq: number }>(`SELECT coalesce(
      (SELECT seq FROM sqlite_sequence WHERE name='web_local_events'),0) seq`)!.seq;
    ensure(Number.isSafeInteger(seq) && seq >= 0, 'WEB_EVENT_SEQUENCE_INVALID');
    return seq;
  }

  private parseCursor(raw: string | null, principalId: string, conversationId?: string) {
    if (raw === null) return 0;
    ensure(raw.length <= 512 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw), 'INVALID_CURSOR');
    const [payload, supplied] = raw.split('.');
    const actual = createHmac('sha256', Buffer.from(this.config.cursorKey, 'base64url')).update(payload!).digest();
    const proposed = Buffer.from(supplied!, 'base64url');
    ensure(proposed.length === actual.length && timingSafeEqual(proposed, actual), 'INVALID_CURSOR');
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    } catch {
      ensure(false, 'INVALID_CURSOR');
    }
    ensure(
      Array.isArray(decoded) &&
        decoded.length === 6 &&
        decoded[0] === 1 &&
        decoded[1] === this.config.instanceId &&
        decoded[2] === this.config.recoveryEpoch &&
        decoded[3] === principalId &&
        decoded[4] === (conversationId ?? null) &&
        Number.isSafeInteger(decoded[5]) &&
        decoded[5] >= 0,
      'INVALID_CURSOR',
    );
    return decoded[5] as number;
  }

  private json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { ...privateHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    ensure(req.headers['content-type'] === 'application/json', 'INVALID_REQUEST');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      ensure(size <= 8192, 'INVALID_REQUEST');
      chunks.push(bytes);
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      ensure(false, 'INVALID_REQUEST');
    }
    ensure(data !== null && typeof data === 'object' && !Array.isArray(data), 'INVALID_REQUEST');
    return data as Record<string, unknown>;
  }

  private access(principal: Principal, ipHash: string) {
    const now = this.clock.now();
    const row = this.store.get<{
      kind: string;
      trial_used: number;
      trial_reserved: number;
      trial_character_id: string | null;
      revision: number;
    }>('SELECT * FROM web_principals WHERE id=? AND world_id=?', principal.principalId, principal.world_id)!;
    if (row.kind === 'invite') {
      ensure(this.inviteActions, 'WEB_INVITE_ACCESS_REQUIRED');
      const grant = this.store.get<{ id: string; expires_at: number | null; revoked_at: number | null }>(
        `SELECT id,expires_at,revoked_at FROM web_invite_grants WHERE principal_id=?
          AND player_id=? AND world_id=?`,
        principal.principalId,
        principal.player_id,
        principal.world_id,
      );
      ensure(grant, 'WEB_INVITE_ACCESS_REQUIRED');
      const status =
        grant.revoked_at !== null
          ? 'revoked'
          : grant.expires_at !== null && now >= grant.expires_at
            ? 'expired'
            : 'active';
      return {
        kind: 'invite',
        principalId: principal.principalId,
        playerId: principal.player_id,
        worldId: principal.world_id,
        revision: row.revision,
        grantId: grant.id,
        status,
        expiresAt: grant.expires_at,
        canSend: status === 'active',
        canChooseText: false,
        trialCharacterId: row.trial_character_id,
        trialRemaining: null,
        trialReserved: null,
        retentionState: 'protected',
        trialExpiresAt: null,
      };
    }
    const lifecycle = webDataLifecycleEnabled(this.store);
    const retention = lifecycle
      ? this.store.get<WebRetentionRow>(
          `SELECT * FROM web_guest_retention
      WHERE principal_id=? AND world_id=?`,
          principal.principalId,
          principal.world_id,
        )
      : null;
    if (lifecycle) ensure(retention, 'WEB_RETENTION_SCOPE_INVALID');
    const quota = lifecycle
      ? this.store.get<{ used_total: number; reserved_total: number }>(
          'SELECT used_total,reserved_total FROM web_ip_lifetime_quota WHERE ip_hash=?',
          ipHash,
        )
      : null;
    const window = lifecycle
      ? null
      : this.store.get<{ used: number; reserved: number }>(
          `SELECT used,reserved FROM web_ip_windows
      WHERE ip_hash=? AND starts_at<=? AND expires_at>? ORDER BY starts_at DESC LIMIT 1`,
          ipHash,
          now,
          now,
        );
    const expired =
      lifecycle &&
      row.kind === 'guest' &&
      retention?.state !== 'unstarted' &&
      (retention?.state !== 'active' || retention.expires_at === null || now >= retention.expires_at);
    const trialRemaining =
      row.kind === 'guest'
        ? Math.max(
            0,
            Math.min(
              3 - row.trial_used - row.trial_reserved,
              lifecycle
                ? 3 - (quota?.used_total ?? 0) - (quota?.reserved_total ?? 0)
                : 3 - (window?.used ?? 0) - (window?.reserved ?? 0),
            ),
          )
        : null;
    return {
      kind: row.kind,
      principalId: principal.principalId,
      playerId: principal.player_id,
      worldId: principal.world_id,
      revision: row.revision,
      trialCharacterId: row.trial_character_id,
      trialRemaining,
      trialReserved: row.kind === 'guest' ? row.trial_reserved : null,
      canSend: !expired && (row.kind !== 'guest' || trialRemaining! > 0),
      canChooseText: false,
      ...(lifecycle
        ? { trialExpiresAt: retention?.expires_at ?? null, retentionState: expired ? 'expired' : retention?.state }
        : {}),
    };
  }

  private bootstrap(req: IncomingMessage, res: ServerResponse) {
    const ipHash = this.ipHash(req),
      token = this.cookie(req);
    let issued: string | null = null;
    const result = this.store.transaction(() => {
      if (!token) {
        const start = Math.floor(this.clock.now() / 86_400_000) * 86_400_000;
        this.store.run(
          `INSERT INTO web_local_guest_budget(ip_hash,window_start,created)
          VALUES (?,?,0) ON CONFLICT DO NOTHING`,
          ipHash,
          start,
        );
        ensure(
          this.store.run(
            `UPDATE web_local_guest_budget SET created=created+1
          WHERE ip_hash=? AND window_start=? AND created<32`,
            ipHash,
            start,
          ).changes === 1,
          'WEB_GUEST_RATE_LIMITED',
        );
      }
      const boot = this.identity.bootstrap(token);
      issued = boot.issuedToken;
      const principal = this.identity.authenticate(token ?? boot.issuedToken!);
      const access = this.access(principal, ipHash);
      if (access.retentionState !== 'expired' && access.status !== 'revoked' && access.status !== 'expired')
        for (const character of this.store.all<{ id: string }>('SELECT id FROM character_templates'))
          this.store.run(
            `INSERT OR IGNORE INTO world_characters(world_id,character_id,relationship)
            VALUES (?,?,'new')`,
            principal.world_id,
            character.id,
          );
      const high = this.eventHighWater();
      const characters = this.store
        .all<{ id: string; config_json: string }>('SELECT id,config_json FROM character_templates ORDER BY id')
        .map((row) => {
          const template = JSON.parse(row.config_json) as { name: string };
          return {
            characterId: row.id,
            name: template.name,
            synthetic: true,
            audition: { state: 'unavailable', reason: 'not_approved' },
          };
        });
      const inaccessible =
        access.retentionState === 'expired' || access.status === 'revoked' || access.status === 'expired';
      const conversations = inaccessible
        ? []
        : this.store
            .all<{ id: string; character_id: string }>(
              `SELECT c.id,
        c.private_character_id character_id FROM conversations c WHERE c.world_id=? AND c.kind='private'`,
              principal.world_id,
            )
            .map((row) => ({ conversationId: row.id, characterId: row.character_id }));
      const activeOperations = inaccessible
        ? []
        : this.store
            .all<{ id: string }>(
              `SELECT id FROM web_operations
        WHERE principal_id=? AND world_id=? AND status NOT IN ('published','cancelled','failed')
        ORDER BY admission_seq`,
              principal.principalId,
              principal.world_id,
            )
            .map((row) => this.operation(principal, row.id));
      return {
        contractVersion:
          access.kind === 'invite'
            ? 'web-v1-local-3'
            : webDataLifecycleEnabled(this.store)
              ? 'web-v1-local-2'
              : 'web-v1-local-1',
        mode: 'synthetic-local',
        region: 'local-test',
        instanceId: this.config.instanceId,
        recoveryEpoch: this.config.recoveryEpoch,
        csrf: boot.csrf,
        access,
        characters,
        conversations,
        activeOperations,
        syncCursor: this.cursor(principal.principalId, high),
        unsupported: this.inviteActions
          ? [
              ...(access.kind === 'account' ? ['invite'] : []),
              'login',
              'account-recovery',
              'trial-archive',
              'read',
              'listened',
              'text-delivery',
            ]
          : ['invite', 'login', 'account-recovery', 'trial-archive', 'read', 'listened', 'admin', 'text-delivery'],
      };
    });
    if (issued) this.setCookie(res, issued);
    this.json(res, 200, result);
  }

  private operation(principal: Principal, operationId: string) {
    requireWebContent(this.store, this.clock, principal.principalId, principal.world_id);
    const row = this.store.get<{
      id: string;
      request_id: string;
      conversation_id: string;
      status: string;
      stage_version: number;
      created_at: number;
      deadline_at: number;
      failure_code: string | null;
    }>(
      `SELECT * FROM web_operations WHERE id=? AND principal_id=? AND world_id=?`,
      operationId,
      principal.principalId,
      principal.world_id,
    );
    ensure(row, 'NOT_FOUND');
    const publication = this.store.get<{ receipt_json: string }>(
      'SELECT receipt_json FROM web_publications WHERE operation_id=? AND principal_id=?',
      operationId,
      principal.principalId,
    );
    return {
      operationId: row.id,
      requestId: row.request_id,
      conversationId: row.conversation_id,
      status: row.status,
      revision: row.stage_version + 1,
      acceptedAt: row.created_at,
      deadlineAt: row.deadline_at,
      errorCode: row.failure_code,
      canCancel: !['published', 'cancelled', 'failed'].includes(row.status),
      publication: publication ? JSON.parse(publication.receipt_json) : null,
    };
  }

  private events(principal: Principal, after: number, limit = 100) {
    requireWebContent(this.store, this.clock, principal.principalId, principal.world_id);
    const high = this.eventHighWater();
    ensure(after <= high && limit >= 1 && limit <= 100, 'INVALID_CURSOR');
    const rows = this.store.all<{
      seq: number;
      conversation_id: string | null;
      kind: string;
      revision: number;
      payload_json: string;
    }>(
      `SELECT seq,conversation_id,kind,revision,payload_json
      FROM web_local_events WHERE principal_id=? AND seq>? ORDER BY seq LIMIT ?`,
      principal.principalId,
      after,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.seq ?? after;
    return {
      events: page.map((row) => ({
        eventId: this.cursor(principal.principalId, row.seq),
        conversationId: row.conversation_id,
        kind: row.kind,
        revision: row.revision,
        payload: JSON.parse(row.payload_json),
      })),
      cursor: this.cursor(principal.principalId, last),
      hasMore: rows.length > limit,
    };
  }

  private stream(req: IncomingMessage, res: ServerResponse, principal: Principal, token: string, after: number) {
    const active = this.streams.get(principal.principalId) ?? 0;
    ensure(active < 1 && this.activeStreams.size < 32, 'WEB_STREAM_LIMITED');
    this.streams.set(principal.principalId, active + 1);
    this.activeStreams.add(res);
    res.writeHead(200, {
      ...privateHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let cursor = after,
      closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      this.activeStreams.delete(res);
      this.streams.set(principal.principalId, Math.max(0, (this.streams.get(principal.principalId) ?? 1) - 1));
      res.end();
    };
    const flush = () => {
      try {
        const current = this.identity.authenticate(token);
        ensure(current.principalId === principal.principalId, 'SESSION_EXPIRED');
        const page = this.events(current, cursor, 50);
        for (const event of page.events) {
          cursor = this.parseCursor(event.eventId, current.principalId);
          if (!res.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`)) {
            close();
            return;
          }
        }
        if (!page.events.length && !res.write(': heartbeat\n\n')) close();
      } catch {
        close();
      }
    };
    const timer = setInterval(flush, 250);
    timer.unref();
    req.on('close', close);
    flush();
  }

  private history(principal: Principal, conversationId: string, before: number | null) {
    requireWebContent(this.store, this.clock, principal.principalId, principal.world_id);
    const conversation = this.store.get<{ private_character_id: string }>(
      `SELECT private_character_id FROM conversations
      WHERE world_id=? AND id=? AND kind='private'`,
      principal.world_id,
      conversationId,
    );
    ensure(conversation, 'NOT_FOUND');
    const rows = this.store.all<{
      seq: number;
      id: string;
      body: string;
      created_at: number;
      operation_id: string;
      origin: string;
      ordinal: number | null;
      media_id: string | null;
    }>(
      `
      SELECT m.seq,m.id,m.body,m.created_at,o.id operation_id,'input' origin,NULL ordinal,NULL media_id
        FROM web_operations o JOIN messages m ON m.id=o.input_message_id
        WHERE o.principal_id=? AND o.world_id=? AND o.conversation_id=? AND m.seq<?
      UNION ALL
      SELECT m.seq,m.id,m.body,m.created_at,p.operation_id,i.origin,i.ordinal,i.media_id
        FROM web_publication_items i JOIN web_publications p ON p.operation_id=i.operation_id
        JOIN messages m ON m.id=i.message_id
        WHERE p.principal_id=? AND p.player_id=? AND p.world_id=? AND p.conversation_id=? AND m.seq<?
      ORDER BY seq DESC LIMIT 51`,
      principal.principalId,
      principal.world_id,
      conversationId,
      before ?? Number.MAX_SAFE_INTEGER,
      principal.principalId,
      principal.player_id,
      principal.world_id,
      conversationId,
      before ?? Number.MAX_SAFE_INTEGER,
    );
    const page = rows.slice(0, 50).reverse();
    return {
      conversationId,
      messages: page.map((row) => ({
        messageId: row.id,
        conversationId,
        characterId: conversation.private_character_id,
        operationId: row.operation_id,
        replyOrdinal: row.origin === 'narrative' ? row.ordinal : null,
        author: row.origin === 'input' ? 'player' : 'character',
        origin: row.origin,
        text: row.body,
        createdAt: row.created_at,
        audio: row.media_id ? { status: 'ready', mediaId: row.media_id, synthetic: true } : null,
      })),
      before: page.length ? this.cursor(principal.principalId, page[0]!.seq, conversationId) : null,
      hasMore: rows.length > 50,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      this.ipHash(req); // The listener is local-only even if configuration is changed accidentally.
      ensure(typeof req.url === 'string' && req.url.length <= 2048, 'INVALID_REQUEST');
      const url = new URL(req.url, this.config.origin),
        path = url.pathname;
      if (req.method === 'GET' && path === '/health') {
        this.json(res, 200, {
          mode: 'synthetic-local',
          status: this.executor.lastError ? 'degraded' : 'ok',
          workerError: this.executor.lastError,
        });
        return;
      }
      if (serveLocalStatic(req, res, fileURLToPath(new URL('../player-web/dist', import.meta.url)))) return;
      if (this.inviteAdmin && req.method === 'GET' && path === '/api/web/local/admin/session') {
        this.json(res, 200, this.inviteAdmin.session(this.cookie(req, `${this.config.cookieName}_admin`)));
        return;
      }
      if (
        this.inviteActions &&
        req.method === 'POST' &&
        (/^\/api\/web\/local\/invites\//.test(path) ||
          /^\/api\/web\/local\/admin\//.test(path) ||
          /^\/api\/web\/local\/identity\/invite-/.test(path))
      ) {
        const result = routeWebInvite(
          this.inviteActions,
          {
            method: req.method,
            path,
            origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
            csrf: typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
            playerToken: this.cookie(req),
            adminCookie: this.cookie(req, `${this.config.cookieName}_admin`),
            trustedIpHash: this.ipHash(req),
            body: await this.body(req),
          },
          this.inviteAdmin ?? undefined,
        );
        if (result.issuedToken) this.setCookie(res, result.issuedToken);
        if (result.issuedAdminCookie)
          res.setHeader(
            'Set-Cookie',
            `${this.config.cookieName}_admin=${result.issuedAdminCookie}; Path=/; Secure; HttpOnly; SameSite=Lax`,
          );
        if (path === '/api/web/local/admin/logout')
          res.setHeader(
            'Set-Cookie',
            `${this.config.cookieName}_admin=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
          );
        this.json(res, result.status, result.body);
        return;
      }
      if (req.method === 'GET' && path === '/api/web/local/bootstrap') {
        this.bootstrap(req, res);
        return;
      }
      if (req.method === 'GET' && path === '/api/web/local/identity/receipt-challenge') {
        const token = this.cookie(req);
        ensure(token, 'AUTH_REQUIRED');
        this.json(res, 200, this.identity.receiptChallenge(token));
        return;
      }
      if (req.method === 'POST' && path === '/api/web/local/identity/receipt-recover') {
        const token = this.cookie(req),
          csrf = req.headers['x-csrf-token'],
          origin = req.headers.origin;
        ensure(token && typeof csrf === 'string' && typeof origin === 'string', 'CSRF_INVALID');
        const body = await this.body(req);
        ensure(
          typeof body.requestId === 'string' && typeof body.username === 'string' && typeof body.password === 'string',
          'INVALID_REQUEST',
        );
        const recovered = await this.identity.recoverReceipt(token, csrf, origin, {
          requestId: body.requestId,
          username: body.username,
          password: body.password,
        });
        this.setCookie(res, recovered.issuedToken);
        this.json(res, 200, { ...recovered.receipt, csrf: recovered.csrf });
        return;
      }
      if (req.method === 'POST' && path === '/api/web/local/register') {
        const { token, csrf, origin } = this.authorizeWrite(req);
        const body = await this.body(req);
        ensure(
          typeof body.requestId === 'string' && typeof body.username === 'string' && typeof body.password === 'string',
          'INVALID_REQUEST',
        );
        const registered = await this.identity.register(token, csrf, origin, {
          requestId: body.requestId,
          username: body.username,
          password: body.password,
        });
        this.setCookie(res, registered.issuedToken);
        this.json(res, 200, { ...registered.receipt, csrf: registered.csrf });
        return;
      }
      if (req.method === 'POST' && path === '/api/web/local/identity/receipt-status') {
        const { token, csrf, origin } = this.authorizeWrite(req),
          body = await this.body(req);
        ensure(typeof body.requestId === 'string', 'INVALID_REQUEST');
        this.json(res, 200, this.identity.receiptStatus(token, csrf, origin, body.requestId));
        return;
      }
      if (req.method === 'POST' && path === '/api/web/local/logout') {
        const { token, csrf, origin } = this.authorizeWrite(req);
        this.identity.logout(token, csrf, origin);
        res.setHeader('Set-Cookie', `${this.config.cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
        res.writeHead(204, privateHeaders);
        res.end();
        return;
      }
      const send = path.match(/^\/api\/web\/local\/characters\/([A-Za-z0-9_-]{1,128})\/operations$/);
      if (req.method === 'POST' && send) {
        this.authorizeWrite(req);
        const body = await this.body(req);
        ensure(
          typeof body.requestId === 'string' &&
            typeof body.text === 'string' &&
            body.delivery === 'voice' &&
            Object.keys(body).sort().join(',') === 'delivery,requestId,text',
          'INVALID_REQUEST',
        );
        const ipHash = this.ipHash(req);
        const { principal, admitted } = this.store.transaction(() => {
          const { principal } = this.authorizeWrite(req);
          const admitted = this.admission.admit({
            principalId: principal.principalId,
            requestId: body.requestId as string,
            characterId: send[1]!,
            text: body.text as string,
            ipHash,
          });
          return { principal, admitted };
        });
        this.json(res, admitted.duplicate ? 200 : 202, {
          operation: this.operation(principal, admitted.operationId),
          duplicate: admitted.duplicate,
        });
        return;
      }
      const { principal, token } = this.authenticate(req);
      if (req.method === 'GET' && path === '/api/web/local/access') {
        this.json(res, 200, this.access(principal, this.ipHash(req)));
        return;
      }
      const byRequest = path.match(/^\/api\/web\/local\/operations\/by-request\/([A-Za-z0-9_.-]{1,128})$/);
      if (req.method === 'GET' && byRequest) {
        const row = this.store.get<{ id: string }>(
          `SELECT id FROM web_operations
          WHERE principal_id=? AND world_id=? AND request_id=?`,
          principal.principalId,
          principal.world_id,
          byRequest[1]!,
        );
        ensure(row, 'NOT_FOUND');
        this.json(res, 200, this.operation(principal, row.id));
        return;
      }
      const operation = path.match(/^\/api\/web\/local\/operations\/([A-Za-z0-9_-]{1,128})$/);
      if (req.method === 'GET' && operation) {
        this.json(res, 200, this.operation(principal, operation[1]!));
        return;
      }
      const cancel = path.match(/^\/api\/web\/local\/operations\/([A-Za-z0-9_-]{1,128})\/cancel$/);
      if (req.method === 'POST' && cancel) {
        this.authorizeWrite(req);
        await this.body(req);
        const result = this.store.transaction(() => {
          const current = this.authorizeWrite(req).principal;
          ensure(current.principalId === principal.principalId, 'NOT_FOUND');
          this.executor.cancel(cancel[1]!, current.principalId);
          return this.operation(current, cancel[1]!);
        });
        this.json(res, 200, result);
        return;
      }
      if (req.method === 'GET' && path === '/api/web/local/sync') {
        this.json(
          res,
          200,
          this.events(principal, this.parseCursor(url.searchParams.get('cursor'), principal.principalId)),
        );
        return;
      }
      if (req.method === 'GET' && path === '/api/web/local/events') {
        this.stream(
          req,
          res,
          principal,
          token,
          this.parseCursor(url.searchParams.get('cursor'), principal.principalId),
        );
        return;
      }
      const history = path.match(/^\/api\/web\/local\/conversations\/([A-Za-z0-9_-]{1,128})\/history$/);
      if (req.method === 'GET' && history) {
        const raw = url.searchParams.get('before');
        const before = raw === null ? null : this.parseCursor(raw, principal.principalId, history[1]!);
        this.json(res, 200, this.history(principal, history[1]!, before));
        return;
      }
      const audio = path.match(
        /^\/api\/web\/local\/conversations\/([A-Za-z0-9_-]{1,128})\/messages\/([A-Za-z0-9_-]{1,128})\/audio\/([A-Za-z0-9_-]{1,128})$/,
      );
      if (req.method === 'GET' && audio) {
        requireWebContent(this.store, this.clock, principal.principalId, principal.world_id);
        const row = this.store.get<{ character_id: string }>(
          `SELECT p.character_id FROM web_publication_items i
          JOIN web_publications p ON p.operation_id=i.operation_id WHERE i.message_id=? AND i.media_id=?
          AND p.principal_id=? AND p.player_id=? AND p.world_id=? AND p.conversation_id=?`,
          audio[2]!,
          audio[3]!,
          principal.principalId,
          principal.player_id,
          principal.world_id,
          audio[1]!,
        );
        ensure(row, 'NOT_FOUND');
        const bytes = this.publisher.readPublishedAudio(
          {
            principalId: principal.principalId,
            playerId: principal.player_id,
            worldId: principal.world_id,
            conversationId: audio[1]!,
            characterId: row.character_id,
          },
          audio[3]!,
        );
        res.writeHead(200, { ...privateHeaders, 'Content-Type': 'audio/wav', 'Content-Length': bytes.length });
        res.end(bytes);
        return;
      }
      ensure(false, 'NOT_FOUND');
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
      const publicCode =
        (
          {
            WEB_USER_QUEUE_FULL: 'QUEUE_FULL',
            WEB_CHARACTER_UNAVAILABLE: 'NOT_FOUND',
            WEB_REGISTER_INPUT_INVALID: 'INVALID_REQUEST',
            WEB_USERNAME_UNAVAILABLE: 'IDENTITY_UNAVAILABLE',
            WEB_IDENTITY_RATE_LIMITED: 'RATE_LIMITED',
            WEB_KDF_BUSY: 'RATE_LIMITED',
            WEB_GUEST_RATE_LIMITED: 'RATE_LIMITED',
            WEB_STREAM_LIMITED: 'RATE_LIMITED',
            WEB_INVITE_RATE_LIMITED: 'RATE_LIMITED',
            WEB_INVITE_ACCESS_REQUIRED: 'WEB_INVITE_ACCESS_REQUIRED',
            WEB_INVITE_UNAVAILABLE: 'WEB_INVITE_UNAVAILABLE',
            WEB_INVITE_RECOVERY_UNAVAILABLE: 'WEB_INVITE_RECOVERY_UNAVAILABLE',
            WEB_GUEST_REQUIRED: 'WEB_GUEST_REQUIRED',
            ADMIN_UNAUTHORIZED: 'ADMIN_UNAUTHORIZED',
            ADMIN_INVALID_GRANT: 'ADMIN_INVALID_GRANT',
            ADMIN_CSRF_REQUIRED: 'ADMIN_CSRF_REQUIRED',
            WEB_ADMISSION_ENTITLEMENT_REQUIRED: 'AUTH_REQUIRED',
            WEB_OPERATION_NOT_FOUND: 'NOT_FOUND',
          } as Record<string, string>
        )[code] ?? (code.startsWith('WEB_') ? 'INTERNAL_ERROR' : code);
      const status =
        publicCode === 'TRIAL_EXPIRED' || publicCode === 'WEB_INVITE_ACCESS_REQUIRED'
          ? 410
          : publicCode === 'NOT_FOUND'
            ? 404
            : publicCode === 'AUTH_REQUIRED' || publicCode === 'SESSION_EXPIRED' || publicCode === 'ADMIN_UNAUTHORIZED'
              ? 401
              : publicCode === 'CSRF_INVALID' ||
                  publicCode === 'ORIGIN_INVALID' ||
                  publicCode === 'TRIAL_EXHAUSTED' ||
                  publicCode === 'ADMIN_INVALID_GRANT' ||
                  publicCode === 'ADMIN_CSRF_REQUIRED'
                ? 403
                : publicCode === 'INVALID_CURSOR' || publicCode === 'INVALID_REQUEST' || publicCode === 'INVALID_TEXT'
                  ? 400
                  : publicCode === 'QUEUE_FULL' || publicCode === 'RATE_LIMITED'
                    ? 429
                    : publicCode === 'INTERNAL_ERROR'
                      ? 500
                      : 409;
      this.json(res, status, { error: { code: publicCode, requestId: null, retryAfterMs: null } });
    }
  }
}

function cryptoRandomId() {
  return globalThis.crypto.randomUUID();
}
