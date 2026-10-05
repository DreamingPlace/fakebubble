import { WebCharacterPreviews } from './web-character-preview.ts';
import type { WebCharacterPreviewRunner } from './web-character-preview-runner.ts';
import { WebCharacterPreviewExecutor } from './web-character-preview-executor.ts';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { connect } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import {
  isWebProviderCharacterId,
  type WebProviderAccess,
  type WebProviderCharacterId,
  type WebProviderOperation,
} from '../../packages/contracts/web-provider.ts';
import type { WebStore } from './store.ts';
import { WebIdentity } from './web-identity.ts';
import { WebAdmission } from './web-admission.ts';
import { WebVerticalPublisher } from './web-vertical-publisher.ts';
import { WebProviderExecutor } from './web-provider-executor.ts';
import { WebProviderRunner } from './web-provider-runner.ts';
import { localTls, type WebLocalConfig } from './web-local-config.ts';
import { serveLocalStatic } from './web-local-static.ts';
import { requireWebContent } from './web-retention.ts';
import type { WebAccountAdmin } from './web-account-admin.ts';
import { routeWebAccountAdmin } from './web-account-admin-routes.ts';
import { WebInviteActions } from './web-invite-actions.ts';
import { routeWebInvite } from './web-invite-routes.ts';
import { WebProviderApplication } from './web-provider-application.ts';
import { webProviderHTTPError } from './web-provider-http-error.ts';

const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const API = '/api/web/provider';
type Principal = ReturnType<WebIdentity['authenticate']>;
const characterId = isWebProviderCharacterId;
/** RFC1918 IPv4 only (plain or IPv4-mapped); used solely by the opt-in LAN test listener. */
export function privateIPv4(address: string | undefined) {
  const ip = address?.startsWith('::ffff:') ? address.slice(7) : address;
  const parts = ip?.split('.').map(Number);
  if (!parts || parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b] = parts as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ? ip! : null;
}
/** Explicit device-test listener on one private LAN address; the default stays loopback-only. */
export type ProviderNetwork = { host: string; cert: Buffer; key: Buffer };

/**
 * Loopback-only transport for the three-character provider runtime (schema 113). The Store stays
 * the sole business writer; the executor decides whether transports are offline fakes or live.
 */
export class WebProviderServer {
  readonly server: Server;
  private readonly previews: WebCharacterPreviewExecutor | undefined;
  private previewTimer: NodeJS.Timeout | undefined;
  readonly executor: WebProviderExecutor;
  private readonly store: WebStore;
  private readonly config: WebLocalConfig;
  private readonly identity: WebIdentity;
  private readonly admission: WebAdmission;
  private readonly publisher: WebVerticalPublisher;
  private readonly clock: Clock;
  private readonly inviteAdmin: WebAccountAdmin;
  private readonly inviteActions: WebInviteActions;
  private readonly streams = new Map<string, number>();
  private readonly activeStreams = new Set<ServerResponse>();
  private readonly host: string;
  private deletionTimer: NodeJS.Timeout | null = null;
  private deletionError: string | null = null;
  private deletionTask: Promise<void> | null = null;
  private readonly application: WebProviderApplication;

  constructor(
    store: WebStore,
    config: WebLocalConfig,
    clock: Clock,
    runner: WebProviderRunner,
    network?: ProviderNetwork,
    previews?: WebCharacterPreviewRunner,
  ) {
    store.requireProviderRuntime();
    ensure(
      config.mode === 'provider-local' &&
        store.instanceId === config.instanceId &&
        store.get<{ recovery_epoch: string }>('SELECT recovery_epoch FROM web_instance WHERE singleton=1')
          ?.recovery_epoch === config.recoveryEpoch,
      'WEB_LOCAL_INSTANCE_MISMATCH',
    );
    ensure(!network || privateIPv4(network.host) === network.host, 'WEB_PROVIDER_LAN_INVALID');
    this.host = network?.host ?? '127.0.0.1';
    if (network) config = { ...config, origin: `https://${network.host}:${config.port}` };
    this.store = store;
    this.config = config;
    this.clock = clock;
    this.application = new WebProviderApplication(store, clock, { ...config, mode: 'provider-local' });
    if (previews) {
      this.application.characterAdmin.enablePreviews(new WebCharacterPreviews(store, clock));
      this.previews = new WebCharacterPreviewExecutor(previews);
    }
    this.identity = this.application.identity;
    this.admission = this.application.admission;
    this.publisher = this.application.publisher;
    this.executor = new WebProviderExecutor(store, clock, runner);
    this.inviteAdmin = this.application.inviteAdmin;
    this.inviteActions = this.application.inviteActions;
    this.server = createServer(
      { ...(network ? { cert: network.cert, key: network.key } : localTls(store.root)), maxHeaderSize: 8192 },
      (req, res) => {
        void this.handle(req, res);
      },
    );
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
        this.server.listen(this.config.port, this.host, () => {
          this.server.off('error', reject);
          resolve();
        });
      });
      this.deletionTimer = setInterval(() => {
        if (!this.deletionTask)
          this.deletionTask = this.application.characterDeletion
            .sweep()
            .then(
              () => {
                this.deletionError = null;
              },
              (error) => {
                this.deletionError = error instanceof DomainError ? error.code : 'CHARACTER_DELETION_FAILED';
              },
            )
            .finally(() => {
              this.deletionTask = null;
            });
      }, 1000);
      this.deletionTimer.unref();
      if (this.previews) {
        this.previewTimer = setInterval(() => this.previews!.kick(), 1000);
        this.previewTimer.unref();
      }
    } catch (error) {
      this.executor.stop();
      throw error;
    }
  }

  private portOccupied() {
    return new Promise<boolean>((resolveProbe) => {
      const socket = connect(this.config.port, this.host);
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
    if (this.deletionTimer) clearInterval(this.deletionTimer);
    await this.deletionTask;
    if (this.previewTimer) clearInterval(this.previewTimer);
    await this.previews?.close();
    this.executor.stop();
    for (const stream of this.activeStreams) stream.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.executor.close();
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

  private authorizeWrite(req: IncomingMessage) {
    const token = this.cookie(req),
      origin = req.headers.origin,
      csrf = req.headers['x-csrf-token'];
    ensure(token, 'AUTH_REQUIRED');
    ensure(typeof origin === 'string' && typeof csrf === 'string', 'CSRF_INVALID');
    return { principal: this.identity.authorizeWrite(token, csrf, origin), token, csrf, origin };
  }

  private ipHash(req: IncomingMessage) {
    const client =
      this.host === '127.0.0.1'
        ? req.socket.remoteAddress === '127.0.0.1'
          ? '127.0.0.1'
          : null
        : privateIPv4(req.socket.remoteAddress);
    ensure(client, 'REGION_UNAVAILABLE');
    return createHmac('sha256', Buffer.from(this.config.ipKey, 'base64url'))
      .update('web-local-ip-v1\0')
      .update(client)
      .digest('hex');
  }

  private cursor(principalId: string, seq: number, conversationId?: string) {
    return this.application.cursor(principalId, seq, conversationId);
  }

  private parseCursor(raw: string | null, principalId: string, conversationId?: string) {
    return this.application.parseCursor(raw, principalId, conversationId);
  }

  private eventHighWater() {
    return this.application.eventHighWater();
  }

  private json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { ...privateHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  private async body(req: IncomingMessage, maximum = 8192): Promise<Record<string, unknown>> {
    ensure(req.headers['content-type'] === 'application/json', 'INVALID_REQUEST');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      ensure(size <= maximum, 'INVALID_REQUEST');
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

  /** Provider wire access. Registration is deferred in this version, so accounts never appear. */
  private access(principal: Principal, ipHash: string): WebProviderAccess & { inaccessible: boolean } {
    return this.application.access(principal, ipHash);
  }

  private characters() {
    return this.application.characters();
  }

  private bootstrap(req: IncomingMessage, res: ServerResponse) {
    try {
      const result = this.application.bootstrap(this.cookie(req), this.ipHash(req));
      if (result.issuedToken) this.setCookie(res, result.issuedToken);
      this.json(res, 200, result.body);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'GUEST_SESSION_EXPIRED')
        res.setHeader('Set-Cookie', `${this.config.cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
      throw error;
    }
  }

  private operation(principal: Principal, operationId: string): WebProviderOperation {
    return this.application.operation(principal, operationId);
  }

  private events(principal: Principal, after: number, limit = 100) {
    return this.application.events(principal, after, limit);
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
    return this.application.history(principal, conversationId, before);
  }

  /** Welcome clips are approved public catalog media; private chat audio is never served here. */
  private publicAudio(res: ServerResponse, mediaId: string) {
    const row = this.store.get<{ audio_bytes: Uint8Array; byte_length: number }>(
      `SELECT w.audio_bytes,w.byte_length
      FROM web_provider_welcome_assets w JOIN web_provider_voice_bindings v
        ON v.character_id=w.character_id AND v.voice_version=w.voice_version
      JOIN web_character_catalog c ON c.character_id=w.character_id WHERE w.media_id=?`,
      mediaId,
    );
    ensure(row && row.audio_bytes.length === row.byte_length, 'NOT_FOUND');
    res.writeHead(200, {
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'audio/wav',
      'Content-Length': row.byte_length,
    });
    res.end(Buffer.from(row.audio_bytes));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      this.ipHash(req);
      ensure(req.headers.host === new URL(this.config.origin).host, 'ORIGIN_INVALID');
      ensure(
        typeof req.url === 'string' && req.url.length <= 2048 && req.url.startsWith('/') && !req.url.startsWith('//'),
        'INVALID_REQUEST',
      );
      const url = new URL(req.url, this.config.origin),
        path = url.pathname;
      if (req.method === 'GET' && path === '/health') {
        this.json(res, 200, {
          mode: 'provider-local',
          status: this.executor.lastError || this.deletionError ? 'degraded' : 'ok',
          workerError: this.executor.lastError,
          deletionError: this.deletionError,
        });
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/index.html')) {
        const modes = url.searchParams.getAll('mode');
        if (modes.length === 0) {
          url.searchParams.set('mode', 'provider');
          res.writeHead(302, { ...privateHeaders, Location: url.pathname + url.search });
          res.end();
          return;
        }
        // Local demos remain available on the synthetic listener, not on the live service.
        ensure(modes.length === 1 && ['provider', 'provider-admin'].includes(modes[0]!), 'NOT_FOUND');
      }
      if (serveLocalStatic(req, res, fileURLToPath(new URL('../player-web/dist', import.meta.url)))) return;
      const welcome = path.match(new RegExp(`^${API}/public-audio/([A-Za-z0-9_-]{1,128})$`));
      if (req.method === 'GET' && welcome) {
        this.publicAudio(res, welcome[1]!);
        return;
      }
      if (req.method === 'GET' && path === `${API}/admin/session`) {
        this.json(res, 200, this.inviteAdmin.session(this.cookie(req, `${this.config.cookieName}_admin`)));
        return;
      }
      if (
        req.method === 'POST' &&
        (path.startsWith(`${API}/invites/`) ||
          path.startsWith(`${API}/admin/`) ||
          path.startsWith(`${API}/identity/invite-`))
      ) {
        const localPath = `/api/web/local${path.slice(API.length)}`;
        const materialUpload = path.match(
          /^\/api\/web\/provider\/admin\/characters\/([A-Za-z0-9_-]{1,128})\/material-upload$/,
        );
        if (materialUpload)
          this.application.characterAdmin.authorizeMaterialUpload(
            {
              cookie: this.cookie(req, `${this.config.cookieName}_admin`),
              csrf: req.headers['x-csrf-token'],
              origin: req.headers.origin,
            },
            materialUpload[1]!,
          );
        const characterWrite =
          /^\/api\/web\/provider\/admin\/characters\/[A-Za-z0-9_-]{1,128}\/(save|review-start)$/.test(path);
        if (characterWrite)
          this.inviteAdmin.authorize(
            this.cookie(req, `${this.config.cookieName}_admin`),
            req.headers['x-csrf-token'],
            req.headers.origin,
          );
        const input = {
          method: req.method,
          path: localPath,
          origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
          csrf: typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined,
          playerToken: this.cookie(req),
          adminCookie: this.cookie(req, `${this.config.cookieName}_admin`),
          trustedIpHash: this.ipHash(req),
          body: await this.body(req, materialUpload ? 8_001_024 : characterWrite ? 131072 : 8192),
        };
        const result =
          (await routeWebAccountAdmin(this.inviteAdmin, input, this.application.characterAdmin)) ??
          routeWebInvite(this.inviteActions, input, this.inviteAdmin);
        if (result.issuedToken) this.setCookie(res, result.issuedToken);
        if (result.issuedAdminCookie)
          res.setHeader(
            'Set-Cookie',
            `${this.config.cookieName}_admin=${result.issuedAdminCookie}; Path=/; Secure; HttpOnly; SameSite=Lax`,
          );
        if (localPath === '/api/web/local/admin/logout')
          res.setHeader(
            'Set-Cookie',
            `${this.config.cookieName}_admin=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
          );
        let body = result.body;
        if (localPath === '/api/web/local/invites/redeem' && result.issuedToken) {
          const principal = this.identity.authenticate(result.issuedToken);
          const grant = this.store.get<{ id: string }>(
            `SELECT id FROM web_invite_grants
            WHERE principal_id=? AND player_id=? AND world_id=?`,
            principal.principalId,
            principal.player_id,
            principal.world_id,
          );
          body = { ...(result.body as Record<string, unknown>), grantId: grant?.id ?? null, duplicate: false };
        }
        this.json(res, result.status, body);
        return;
      }
      if (req.method === 'GET' && path === `${API}/bootstrap`) {
        this.bootstrap(req, res);
        return;
      }
      const send = path.match(new RegExp(`^${API}/characters/([A-Za-z0-9_-]{1,128})/operations$`));
      if (req.method === 'POST' && send) {
        ensure(characterId(send[1]!), 'NOT_FOUND');
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
      const token = this.cookie(req);
      ensure(token, 'AUTH_REQUIRED');
      const principal = this.identity.authenticate(token);
      const byRequest = path.match(new RegExp(`^${API}/operations/by-request/([A-Za-z0-9_.-]{1,128})$`));
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
      const operation = path.match(new RegExp(`^${API}/operations/([A-Za-z0-9_-]{1,128})$`));
      if (req.method === 'GET' && operation) {
        this.json(res, 200, this.operation(principal, operation[1]!));
        return;
      }
      const cancel = path.match(new RegExp(`^${API}/operations/([A-Za-z0-9_-]{1,128})/cancel$`));
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
      if (req.method === 'GET' && path === `${API}/sync`) {
        this.json(
          res,
          200,
          this.events(principal, this.parseCursor(url.searchParams.get('cursor'), principal.principalId)),
        );
        return;
      }
      if (req.method === 'GET' && path === `${API}/events`) {
        this.stream(
          req,
          res,
          principal,
          token,
          this.parseCursor(url.searchParams.get('cursor'), principal.principalId),
        );
        return;
      }
      const history = path.match(new RegExp(`^${API}/conversations/([A-Za-z0-9_-]{1,128})/history$`));
      if (req.method === 'GET' && history) {
        const raw = url.searchParams.get('before');
        const before = raw === null ? null : this.parseCursor(raw, principal.principalId, history[1]!);
        this.json(res, 200, this.history(principal, history[1]!, before));
        return;
      }
      const audio = path.match(
        new RegExp(
          `^${API}/conversations/([A-Za-z0-9_-]{1,128})/messages/([A-Za-z0-9_-]{1,128})/audio/([A-Za-z0-9_-]{1,128})$`,
        ),
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
      const failure = webProviderHTTPError(error);
      this.json(res, failure.status, failure.body);
    }
  }
}
