import { ensure } from '../../../packages/domain/errors.ts';
import type { WebInviteActions } from './web-invite-actions.ts';
import type { WebInviteAdmin } from './web-invite-admin.ts';

export type WebInviteRequest = {
  method: string;
  path: string;
  origin?: string | undefined;
  csrf?: string | undefined;
  playerToken?: string | undefined;
  adminCookie?: string | undefined;
  trustedIpHash?: string | undefined;
  body?: unknown;
};
export type WebInviteResult = {
  status: number;
  body: unknown;
  issuedToken?: string;
  issuedAdminCookie?: string;
  /** The transport expires the player cookie (log-out / abandoning a dead session). */
  clearPlayerCookie?: boolean;
};
function object(value: unknown, keys: string[]) {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === keys.sort().join(','),
    'INVALID_REQUEST',
  );
  return value as Record<string, unknown>;
}
function string(value: unknown) {
  ensure(typeof value === 'string', 'INVALID_REQUEST');
  return value;
}
function admin(req: WebInviteRequest) {
  ensure(
    typeof req.adminCookie === 'string' && typeof req.csrf === 'string' && typeof req.origin === 'string',
    'ADMIN_UNAUTHORIZED',
  );
  return { cookie: req.adminCookie, csrf: req.csrf, origin: req.origin };
}
function player(req: WebInviteRequest) {
  ensure(
    typeof req.playerToken === 'string' && typeof req.csrf === 'string' && typeof req.origin === 'string',
    'CSRF_INVALID',
  );
  return { token: req.playerToken, csrf: req.csrf, origin: req.origin };
}

/** Entitlement route core; the transport supplies trusted IP, cookies and CSRF headers. */
export function routeWebInvite(
  actions: WebInviteActions,
  req: WebInviteRequest,
  adminAccess?: WebInviteAdmin,
): WebInviteResult {
  ensure(req.method === 'POST' && !req.path.includes('?') && !req.path.includes('#'), 'NOT_FOUND');
  if (adminAccess && req.path === '/api/web/local/admin/login') {
    ensure(typeof req.origin === 'string' && typeof req.body === 'object' && req.body !== null, 'INVALID_REQUEST');
    const body = object(req.body, ['token']);
    const login = adminAccess.login(string(body.token), req.origin);
    return { status: 200, issuedAdminCookie: login.cookie, body: { csrf: login.csrf, expiresAt: login.expiresAt } };
  }
  if (adminAccess && req.path === '/api/web/local/admin/logout') {
    const auth = admin(req);
    object(req.body, []);
    adminAccess.authorize(auth.cookie, auth.csrf, auth.origin);
    adminAccess.logout(auth.cookie);
    return { status: 200, body: { loggedOut: true } };
  }
  const batchBase = '/api/web/local/admin/invites/';
  if (
    req.path.startsWith(batchBase + 'batch-') ||
    req.path === batchBase + 'entitlement-revoke' ||
    req.path === batchBase + 'tier-code-revoke'
  ) {
    const auth = admin(req),
      action = req.path.slice(batchBase.length);
    if (action === 'batch-create') {
      // Part 22d: `test` (测试组) is optional; the 22a body without it stays valid.
      const keys = ['requestId', 'name', 'count', 'tier', 'durationDays', 'redeemBy'];
      const body = object(
        req.body,
        (req.body as { test?: unknown } | null)?.test === undefined ? keys : [...keys, 'test'],
      );
      const tier = object(
        body.tier,
        (body.tier as { kind?: string } | null)?.kind === 'daily_refill' ? ['kind', 'dailyAmount', 'cap'] : ['kind'],
      );
      const result = actions.createBatch(auth.cookie, auth.csrf, auth.origin, {
        requestId: string(body.requestId),
        name: string(body.name),
        count: body.count as number,
        tier: tier as never,
        durationDays: body.durationDays as number | null,
        redeemBy: body.redeemBy as number | null,
        ...(body.test === undefined ? {} : { test: body.test as boolean }),
      });
      return { status: result.duplicate ? 200 : 201, body: result };
    }
    if (action === 'batch-list') {
      object(req.body, []);
      return { status: 200, body: actions.listBatches(auth.cookie, auth.csrf, auth.origin) };
    }
    if (action === 'batch-detail')
      return {
        status: 200,
        body: actions.batchDetail(auth.cookie, auth.csrf, auth.origin, string(object(req.body, ['batchId']).batchId)),
      };
    if (action === 'batch-export')
      return {
        status: 200,
        body: actions.exportBatch(auth.cookie, auth.csrf, auth.origin, string(object(req.body, ['batchId']).batchId)),
      };
    if (action === 'batch-edit') {
      const body = object(req.body, ['requestId', 'batchId', 'dailyAmount', 'cap']);
      return {
        status: 200,
        body: actions.editBatch(auth.cookie, auth.csrf, auth.origin, {
          requestId: string(body.requestId),
          batchId: string(body.batchId),
          dailyAmount: body.dailyAmount as number,
          cap: body.cap as number,
        }),
      };
    }
    if (action === 'batch-revoke')
      return {
        status: 200,
        body: actions.revokeBatch(auth.cookie, auth.csrf, auth.origin, string(object(req.body, ['batchId']).batchId)),
      };
    if (action === 'tier-code-revoke')
      return {
        status: 200,
        body: actions.revokeTierCode(auth.cookie, auth.csrf, auth.origin, string(object(req.body, ['id']).id)),
      };
    if (action === 'entitlement-revoke')
      return {
        status: 200,
        body: actions.revokeEntitlement(auth.cookie, auth.csrf, auth.origin, string(object(req.body, ['id']).id)),
      };
    ensure(false, 'NOT_FOUND');
  }
  if (req.path === '/api/web/local/invites/redeem' && actions.tiersEnabled()) {
    const auth = player(req),
      body = object(req.body, ['code', 'requestId']);
    ensure(typeof req.trustedIpHash === 'string', 'WEB_TRUSTED_IP_REQUIRED');
    const result = actions.redeemTier(auth.token, auth.csrf, auth.origin, req.trustedIpHash, {
      code: string(body.code),
      requestId: string(body.requestId),
    });
    return { status: result.duplicate ? 200 : 201, body: result };
  }
  ensure(false, 'NOT_FOUND');
}
