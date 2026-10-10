import { ensure } from '../../../packages/domain/errors.ts';
import type { WebInviteRequest, WebInviteResult } from '../invites/web-invite-routes.ts';
import type { PlayerSessionInput, WebPlayerAccounts } from './web-player-accounts.ts';

function object(value: unknown, keys: string[]) {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === [...keys].sort().join(','),
    'INVALID_REQUEST',
  );
  return value as Record<string, unknown>;
}
function session(req: WebInviteRequest): PlayerSessionInput {
  ensure(typeof req.playerToken === 'string', 'AUTH_REQUIRED');
  ensure(typeof req.csrf === 'string' && typeof req.origin === 'string', 'CSRF_INVALID');
  return { token: req.playerToken, csrf: req.csrf, origin: req.origin };
}
function optionalSession(req: WebInviteRequest) {
  return typeof req.playerToken === 'string' && typeof req.csrf === 'string' && typeof req.origin === 'string'
    ? session(req)
    : undefined;
}

/**
 * Account routes (POST /account/*). Calls that carry a session also carry its CSRF token; the signed-out ones
 * (reset, login, abandoning a dead cookie) are bound by the Origin check, like the administrator's own login.
 * Returns null for a path that is not an account path.
 */
export async function routeWebPlayerAccounts(
  accounts: WebPlayerAccounts | null,
  req: WebInviteRequest,
): Promise<WebInviteResult | null> {
  const prefix = '/api/web/local/account/';
  if (!req.path.startsWith(prefix)) return null;
  ensure(accounts && req.method === 'POST' && !req.path.includes('?') && !req.path.includes('#'), 'NOT_FOUND');
  const action = req.path.slice(prefix.length);
  ensure(typeof req.trustedIpHash === 'string', 'WEB_TRUSTED_IP_REQUIRED');
  const ipHash = req.trustedIpHash;
  if (action === 'request-code') {
    const body = object(req.body, ['purpose', 'email']);
    const result = accounts.requestCode({
      purpose: body.purpose,
      email: body.email,
      ipHash,
      origin: req.origin,
      session: optionalSession(req),
    });
    return { status: 200, body: result };
  }
  if (action === 'verify-code') {
    const body = object(req.body, ['challengeId', 'code']);
    return {
      status: 200,
      body: accounts.verifyCode({
        challengeId: body.challengeId,
        code: body.code,
        origin: req.origin,
        session: optionalSession(req),
      }),
    };
  }
  if (action === 'signup' || action === 'bind') {
    const body = object(req.body, ['challengeId', 'password', 'nickname']);
    const result = await accounts.complete({
      challengeId: body.challengeId,
      password: body.password,
      nickname: body.nickname,
      session: session(req),
      purpose: action,
    });
    // The same token goes out again so the cookie gains the long (400-day) lifetime a login session has.
    return {
      status: 200,
      issuedToken: result.token,
      body: { nickname: result.nickname, emailMasked: result.emailMasked },
    };
  }
  if (action === 'login') {
    const body = object(req.body, ['email', 'password']);
    const result = await accounts.login({ email: body.email, password: body.password, origin: req.origin, ipHash });
    return { status: 200, issuedToken: result.issuedToken, body: { csrf: result.csrf } };
  }
  if (action === 'reset') {
    const body = object(req.body, ['challengeId', 'password']);
    const result = await accounts.reset({
      challengeId: body.challengeId,
      password: body.password,
      origin: req.origin,
      ipHash,
    });
    return { status: 200, issuedToken: result.issuedToken, body: { csrf: result.csrf } };
  }
  if (action === 'password') {
    const body = object(req.body, ['current', 'next', 'logoutOthers']);
    return {
      status: 200,
      body: await accounts.changePassword({
        current: body.current,
        next: body.next,
        logoutOthers: body.logoutOthers,
        session: session(req),
      }),
    };
  }
  if (action === 'nickname') {
    const body = object(req.body, ['nickname']);
    return { status: 200, body: accounts.setNickname({ nickname: body.nickname, session: session(req) }) };
  }
  if (action === 'logout-others') {
    object(req.body, []);
    return { status: 200, body: accounts.logoutOthers(session(req)) };
  }
  if (action === 'logout') {
    object(req.body, []);
    return { status: 200, clearPlayerCookie: true, body: accounts.logout(session(req)) };
  }
  if (action === 'signed-out') {
    // Abandoning a dead or unwanted cookie so the next visit starts fresh. Revokes nothing: only the browser forgets it.
    object(req.body, []);
    ensure(req.origin !== undefined, 'ORIGIN_INVALID');
    accounts.requireOrigin(req.origin);
    return { status: 200, clearPlayerCookie: true, body: { signedOut: true } };
  }
  ensure(false, 'NOT_FOUND');
}
