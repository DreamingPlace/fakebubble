import { createHmac } from 'node:crypto';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { WEB_HTTP_LIMITS as LIMITS } from '../../../config/web-v1.ts';
import {
  WebProviderApplication,
  WEB_PROVIDER_API as API,
  providerCharacterId,
  type WebProviderPrincipal,
} from '../web-provider-application.ts';
import { WebProviderOffline } from '../web-provider-offline.ts';
import { webProviderHTTPError } from '../web-provider-http-error.ts';
import { routeWebInvite } from '../web-invite-routes.ts';
import { routeWebAccountAdmin } from '../web-account-admin-routes.ts';
import { requireWebContent } from '../web-retention.ts';
import { CloudRequestLimits } from './request-limits.ts';
import { cloudJSON } from './json.ts';

export interface WebHTTPExecution {
  wake(): Promise<void>;
  cancel(operationId: string, principalId: string): unknown;
}
const privateHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** Internal business-DO transport. The separate edge supplies the peer, never JSON or forwarded headers. */
export class WebProviderHTTP {
  private readonly app: WebProviderApplication;
  private readonly execution: WebHTTPExecution;
  private readonly limits: CloudRequestLimits;
  private readonly streams = new Map<string, () => void>();
  constructor(app: WebProviderApplication, execution: WebHTTPExecution) {
    ensure(app.config.mode === 'provider-cloud' && app.store.providerAudio, 'WEB_CLOUD_MEDIA_MODE_MISMATCH');
    this.app = app;
    this.execution = execution;
    this.limits = new CloudRequestLimits(app.store, app.clock);
  }
  close() {
    for (const close of [...this.streams.values()]) close();
  }
  private cookie(request: Request, admin = false) {
    const raw = request.headers.get('cookie');
    if (raw === null) return undefined;
    ensure(raw.length <= 4096 && !/[\r\n,]/.test(raw), 'INVALID_REQUEST');
    const name = this.app.config.cookieName + (admin ? '_admin' : '');
    const found = raw
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`));
    ensure(found.length <= 1, 'INVALID_REQUEST');
    return found[0]?.slice(name.length + 1);
  }
  private setCookie(response: Response, token: string, admin = false, clear = false) {
    response.headers.append(
      'set-cookie',
      `${this.app.config.cookieName}${admin ? '_admin' : ''}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax${clear ? '; Max-Age=0' : ''}`,
    );
  }
  private write(request: Request) {
    const token = this.cookie(request),
      origin = request.headers.get('origin'),
      csrf = request.headers.get('x-csrf-token');
    ensure(token, 'AUTH_REQUIRED');
    ensure(origin && csrf, 'CSRF_INVALID');
    ensure(!request.signal.aborted, 'INVALID_REQUEST');
    return this.app.identity.authorizeWrite(token, csrf, origin);
  }
  private async body(request: Request, maximum = 8192) {
    ensure(request.headers.get('content-type') === 'application/json', 'INVALID_REQUEST');
    let value: unknown;
    try {
      value = await cloudJSON(request, maximum);
    } catch {
      ensure(false, 'INVALID_REQUEST');
    }
    ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST');
    return value as Record<string, unknown>;
  }
  async fetch(request: Request, trustedPeer: string) {
    let response: Response;
    try {
      response = await this.route(request, trustedPeer);
    } catch (error) {
      const failure = webProviderHTTPError(error);
      response = Response.json(failure.body, { status: failure.status });
      if (failure.status === 429) response.headers.set('retry-after', '60');
    }
    for (const [key, value] of Object.entries(privateHeaders)) response.headers.set(key, value);
    return response;
  }
  private async route(request: Request, trustedPeer: string): Promise<Response> {
    const app = this.app,
      url = new URL(request.url),
      path = url.pathname,
      method = request.method;
    ensure(
      url.origin === app.config.origin &&
        !url.username &&
        !url.password &&
        (!request.headers.has('host') || request.headers.get('host') === url.host),
      'ORIGIN_INVALID',
    );
    ensure(!request.headers.has('origin') || request.headers.get('origin') === app.config.origin, 'ORIGIN_INVALID');
    const site = request.headers.get('sec-fetch-site');
    ensure(site === null || site === 'same-origin' || site === 'none', 'ORIGIN_INVALID');
    const fields = [...request.headers];
    ensure(
      fields.length <= 40 &&
        fields.reduce((n, [k, v]) => n + k.length + v.length + 4, 0) <= 8192 &&
        path.length + url.search.length <= 2048 &&
        !/[\\%]/.test(path) &&
        !path.startsWith('//'),
      'INVALID_REQUEST',
    );
    ensure(
      typeof trustedPeer === 'string' &&
        trustedPeer.length > 0 &&
        trustedPeer.length <= 128 &&
        /^[0-9a-fA-F:.]+$/.test(trustedPeer),
      'REGION_UNAVAILABLE',
    );
    const ipHash = createHmac('sha256', Buffer.from(app.config.ipKey, 'base64url'))
      .update('web-cloud-ip-v1\0')
      .update(trustedPeer)
      .digest('hex');
    this.limits.rate('web:global', LIMITS.requestsGlobalPerMinute);
    this.limits.rate(`web:ip:${ipHash}`, LIMITS.requestsPerIpPerMinute);
    if (method !== 'GET') this.limits.rate(`web:write:${ipHash}`, LIMITS.writesPerIpPerMinute);
    const allowedQuery =
      path === `${API}/sync` || path === `${API}/events` ? 'cursor' : path.endsWith('/history') ? 'before' : null;
    ensure(
      [...url.searchParams].every(([key]) => key === allowedQuery) &&
        (allowedQuery === null || url.searchParams.getAll(allowedQuery).length <= 1),
      'INVALID_REQUEST',
    );
    const welcome = path.match(new RegExp(`^${API}/public-audio/([A-Za-z0-9_-]{1,128})$`));
    if (method === 'GET' && welcome) {
      this.limits.rate(`web:welcome:${ipHash}`, LIMITS.welcomePerIpPerMinute);
      this.limits.rate('web:welcome:global', LIMITS.welcomeGlobalPerMinute);
      const bytes = await new WebProviderOffline(app.store, app.clock).readWelcomeAudio(welcome[1]!);
      return new Response(Uint8Array.from(bytes), {
        headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length) },
      });
    }
    if (method === 'GET' && path === `${API}/admin/session`)
      return Response.json(app.inviteAdmin.session(this.cookie(request, true)));
    if (
      method === 'POST' &&
      (path.startsWith(`${API}/invites/`) ||
        path.startsWith(`${API}/admin/`) ||
        path.startsWith(`${API}/identity/invite-`))
    ) {
      const localPath = `/api/web/local${path.slice(API.length)}`;
      const materialUpload = path.match(
        /^\/api\/web\/provider\/admin\/characters\/([A-Za-z0-9_-]{1,128})\/material-upload$/,
      );
      if (materialUpload)
        app.characterAdmin.authorizeMaterialUpload(
          {
            cookie: this.cookie(request, true),
            csrf: request.headers.get('x-csrf-token'),
            origin: request.headers.get('origin'),
          },
          materialUpload[1]!,
        );
      const characterWrite =
        /^\/api\/web\/provider\/admin\/characters\/[A-Za-z0-9_-]{1,128}\/(save|review-start)$/.test(path);
      if (characterWrite)
        app.inviteAdmin.authorize(
          this.cookie(request, true),
          request.headers.get('x-csrf-token'),
          request.headers.get('origin'),
        );
      const input = {
        method,
        path: localPath,
        origin: request.headers.get('origin') ?? undefined,
        csrf: request.headers.get('x-csrf-token') ?? undefined,
        playerToken: this.cookie(request),
        adminCookie: this.cookie(request, true),
        trustedIpHash: ipHash,
        body: await this.body(request, materialUpload ? 8_001_024 : characterWrite ? 131072 : 8192),
      };
      const result =
        (await routeWebAccountAdmin(app.inviteAdmin, input, app.characterAdmin)) ??
        routeWebInvite(app.inviteActions, input, app.inviteAdmin);
      if (/\/admin\/characters\/[A-Za-z0-9_-]{1,128}\/(review-start|delete-start)$/.test(localPath))
        await this.execution.wake();
      let body = result.body;
      if (localPath === '/api/web/local/invites/redeem' && result.issuedToken) {
        const actor = app.identity.authenticate(result.issuedToken);
        const grant = app.store.get<{ id: string }>(
          `SELECT id FROM web_invite_grants
          WHERE principal_id=? AND player_id=? AND world_id=?`,
          actor.principalId,
          actor.player_id,
          actor.world_id,
        );
        body = { ...(body as Record<string, unknown>), grantId: grant?.id ?? null, duplicate: false };
      }
      const response = Response.json(body, { status: result.status });
      if (result.issuedToken) this.setCookie(response, result.issuedToken);
      if (result.issuedAdminCookie) this.setCookie(response, result.issuedAdminCookie, true);
      if (localPath === '/api/web/local/admin/logout') this.setCookie(response, '', true, true);
      return response;
    }
    if (method === 'GET' && path === `${API}/bootstrap`) {
      try {
        const result = app.bootstrap(this.cookie(request), ipHash),
          response = Response.json(result.body);
        if (result.issuedToken) this.setCookie(response, result.issuedToken);
        return response;
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'GUEST_SESSION_EXPIRED') throw error;
        const failure = webProviderHTTPError(error),
          response = Response.json(failure.body, { status: failure.status });
        this.setCookie(response, '', false, true);
        return response;
      }
    }
    const send = path.match(new RegExp(`^${API}/characters/([A-Za-z0-9_-]{1,128})/operations$`));
    if (method === 'POST' && send) {
      ensure(providerCharacterId(send[1]!), 'NOT_FOUND');
      this.write(request);
      const body = await this.body(request);
      ensure(
        typeof body.requestId === 'string' &&
          typeof body.text === 'string' &&
          body.delivery === 'voice' &&
          Object.keys(body).sort().join(',') === 'delivery,requestId,text',
        'INVALID_REQUEST',
      );
      await this.execution.wake();
      return app.store.transaction(() => {
        const actor = this.write(request);
        const result = app.admission.admit({
          principalId: actor.principalId,
          ipHash,
          requestId: body.requestId as string,
          text: body.text as string,
          characterId: send[1]!,
        });
        return Response.json(
          { operation: app.operation(actor, result.operationId), duplicate: result.duplicate },
          { status: result.duplicate ? 200 : 202 },
        );
      });
    }
    const token = this.cookie(request);
    ensure(token, 'AUTH_REQUIRED');
    const actor = app.identity.authenticate(token);
    const byRequest = path.match(new RegExp(`^${API}/operations/by-request/([A-Za-z0-9_.-]{1,128})$`));
    if (method === 'GET' && byRequest) {
      const row = app.store.get<{ id: string }>(
        'SELECT id FROM web_operations WHERE principal_id=? AND world_id=? AND request_id=?',
        actor.principalId,
        actor.world_id,
        byRequest[1]!,
      );
      ensure(row, 'NOT_FOUND');
      return Response.json(app.operation(actor, row.id));
    }
    const operation = path.match(new RegExp(`^${API}/operations/([A-Za-z0-9_-]{1,128})$`));
    if (method === 'GET' && operation) return Response.json(app.operation(actor, operation[1]!));
    const cancel = path.match(new RegExp(`^${API}/operations/([A-Za-z0-9_-]{1,128})/cancel$`));
    if (method === 'POST' && cancel) {
      this.write(request);
      const body = await this.body(request);
      ensure(Object.keys(body).length === 0, 'INVALID_REQUEST');
      await this.execution.wake();
      return app.store.transaction(() => {
        const current = this.write(request);
        ensure(current.principalId === actor.principalId, 'NOT_FOUND');
        this.execution.cancel(cancel[1]!, current.principalId);
        return Response.json(app.operation(current, cancel[1]!));
      });
    }
    if (method === 'GET' && path === `${API}/sync`)
      return Response.json(app.events(actor, app.parseCursor(url.searchParams.get('cursor'), actor.principalId)));
    if (method === 'GET' && path === `${API}/events`)
      return this.stream(request, actor, token, app.parseCursor(url.searchParams.get('cursor'), actor.principalId));
    const history = path.match(new RegExp(`^${API}/conversations/([A-Za-z0-9_-]{1,128})/history$`));
    if (method === 'GET' && history) {
      const before = url.searchParams.get('before');
      return Response.json(
        app.history(
          actor,
          history[1]!,
          before === null ? null : app.parseCursor(before, actor.principalId, history[1]!),
        ),
      );
    }
    const audio = path.match(
      new RegExp(
        `^${API}/conversations/([A-Za-z0-9_-]{1,128})/messages/([A-Za-z0-9_-]{1,128})/audio/([A-Za-z0-9_-]{1,128})$`,
      ),
    );
    if (method === 'GET' && audio) {
      requireWebContent(app.store, app.clock, actor.principalId, actor.world_id);
      const row = app.store.get<{ character_id: string }>(
        `SELECT p.character_id FROM web_publication_items i
        JOIN web_publications p ON p.operation_id=i.operation_id WHERE i.message_id=? AND i.media_id=?
        AND p.principal_id=? AND p.player_id=? AND p.world_id=? AND p.conversation_id=?`,
        audio[2]!,
        audio[3]!,
        actor.principalId,
        actor.player_id,
        actor.world_id,
        audio[1]!,
      );
      ensure(row, 'NOT_FOUND');
      const bytes = await app.publisher.readPublishedAudioAsync(
        {
          principalId: actor.principalId,
          playerId: actor.player_id,
          worldId: actor.world_id,
          conversationId: audio[1]!,
          characterId: row.character_id,
        },
        audio[3]!,
      );
      const current = app.identity.authenticate(token);
      ensure(current.principalId === actor.principalId && current.world_id === actor.world_id, 'SESSION_EXPIRED');
      return new Response(Uint8Array.from(bytes), {
        headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length) },
      });
    }
    ensure(false, 'NOT_FOUND');
  }
  private stream(request: Request, actor: WebProviderPrincipal, token: string, after: number) {
    const app = this.app;
    ensure(!this.streams.has(actor.principalId) && this.streams.size < 32, 'WEB_STREAM_LIMITED');
    app.events(actor, after, 50);
    let controller: ReadableStreamDefaultController<Uint8Array>,
      closed = false,
      cursor = after;
    let timer: ReturnType<typeof setInterval>, deadline: ReturnType<typeof setTimeout>;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(deadline);
      this.streams.delete(actor.principalId);
      request.signal.removeEventListener('abort', close);
      controller.close();
    };
    const flush = () => {
      try {
        if (request.signal.aborted || (controller.desiredSize ?? 0) <= 0) {
          close();
          return;
        }
        const current = app.identity.authenticate(token);
        ensure(current.principalId === actor.principalId && current.world_id === actor.world_id, 'SESSION_EXPIRED');
        const page = app.events(current, cursor, 50);
        let output = '';
        for (const event of page.events) {
          cursor = app.parseCursor(event.eventId, current.principalId);
          output += `id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`;
        }
        controller.enqueue(new TextEncoder().encode(output || ': heartbeat\n\n'));
      } catch {
        close();
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel: () => {
        if (!closed) {
          closed = true;
          clearInterval(timer);
          clearTimeout(deadline);
          this.streams.delete(actor.principalId);
          request.signal.removeEventListener('abort', close);
        }
      },
    });
    this.streams.set(actor.principalId, close);
    timer = setInterval(flush, LIMITS.streamPollMs);
    deadline = setTimeout(close, LIMITS.streamMaxMs);
    request.signal.addEventListener('abort', close, { once: true });
    flush();
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' },
    });
  }
}
