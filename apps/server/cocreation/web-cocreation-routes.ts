import { ensure } from '../../../packages/domain/errors.ts';
import type { WebInviteRequest, WebInviteResult } from '../invites/web-invite-routes.ts';
import type { WebCocreation } from './web-cocreation.ts';

/** The player's one write: POST /api/web/local/cocreation/submit (transport cookie, CSRF header and Origin as for any player write). */
export const COCREATION_SUBMIT_PATH = '/api/web/local/cocreation/submit';
/** An answer set can carry 12 cards of up to 300 (one of 1000) code points: more than the 8 KiB default body. */
export const COCREATION_BODY_LIMIT = 32_768;

/** POST /cocreation/today { characterId }: has this player used today's entry for the character? (a read, as a POST for CSRF) */
export const COCREATION_TODAY_PATH = '/api/web/local/cocreation/today';

/** Part 24c: POST /cocreation/memo { requestId, text } (留言条), /cocreation/pair { requestId, characterId, partnerId, text }, /cocreation/rewards {}. */
export const COCREATION_MEMO_PATH = '/api/web/local/cocreation/memo';
export const COCREATION_PAIR_PATH = '/api/web/local/cocreation/pair';
export const COCREATION_REWARDS_PATH = '/api/web/local/cocreation/rewards';

export function routeWebCocreation(cocreation: WebCocreation, req: WebInviteRequest): WebInviteResult | null {
  if (req.path === COCREATION_REWARDS_PATH) {
    ensure(req.method === 'POST', 'NOT_FOUND');
    const asked = req.body as Record<string, unknown> | null;
    ensure(
      asked !== null && typeof asked === 'object' && !Array.isArray(asked) && Object.keys(asked).length === 0,
      'INVALID_REQUEST',
    );
    ensure(typeof req.playerToken === 'string' && req.playerToken !== '', 'AUTH_REQUIRED');
    ensure(typeof req.csrf === 'string' && typeof req.origin === 'string', 'CSRF_INVALID');
    return { status: 200, body: cocreation.rewards(req.playerToken, req.csrf, req.origin) };
  }
  if (req.path === COCREATION_MEMO_PATH || req.path === COCREATION_PAIR_PATH) {
    ensure(req.method === 'POST', 'NOT_FOUND');
    const memo = req.path === COCREATION_MEMO_PATH,
      value = req.body as Record<string, unknown> | null;
    ensure(
      value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).sort().join(',') === (memo ? 'requestId,text' : 'characterId,partnerId,requestId,text'),
      'INVALID_REQUEST',
    );
    ensure(typeof req.playerToken === 'string' && req.playerToken !== '', 'AUTH_REQUIRED');
    ensure(typeof req.csrf === 'string' && typeof req.origin === 'string', 'CSRF_INVALID');
    ensure(typeof req.trustedIpHash === 'string', 'WEB_TRUSTED_IP_REQUIRED');
    const result = cocreation.submitNote(
      req.playerToken,
      req.csrf,
      req.origin,
      {
        kind: memo ? 'memo' : 'pair',
        requestId: value.requestId,
        text: value.text,
        ...(memo ? {} : { characterId: value.characterId, partnerId: value.partnerId }),
      },
      req.trustedIpHash,
    );
    return { status: result.duplicate ? 200 : 201, body: result };
  }
  if (req.path === COCREATION_TODAY_PATH) {
    ensure(req.method === 'POST', 'NOT_FOUND');
    const asked = req.body as Record<string, unknown> | null;
    ensure(
      asked !== null &&
        typeof asked === 'object' &&
        !Array.isArray(asked) &&
        Object.keys(asked).join(',') === 'characterId',
      'INVALID_REQUEST',
    );
    ensure(typeof req.playerToken === 'string' && req.playerToken !== '', 'AUTH_REQUIRED');
    ensure(typeof req.csrf === 'string' && typeof req.origin === 'string', 'CSRF_INVALID');
    return {
      status: 200,
      body: cocreation.usedToday(req.playerToken, req.csrf, req.origin, asked.characterId),
    };
  }
  if (req.path !== COCREATION_SUBMIT_PATH) return null;
  ensure(req.method === 'POST', 'NOT_FOUND');
  const body = req.body;
  ensure(
    body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      Object.keys(body).sort().join(',') === 'answers,characterId,requestId',
    'INVALID_REQUEST',
  );
  // Like the send route: no session is 401, a missing CSRF token or Origin is 403.
  ensure(typeof req.playerToken === 'string' && req.playerToken !== '', 'AUTH_REQUIRED');
  ensure(typeof req.csrf === 'string' && typeof req.origin === 'string', 'CSRF_INVALID');
  const value = body as Record<string, unknown>;
  ensure(typeof req.trustedIpHash === 'string', 'WEB_TRUSTED_IP_REQUIRED');
  const result = cocreation.submit(
    req.playerToken,
    req.csrf,
    req.origin,
    { characterId: value.characterId, requestId: value.requestId, answers: value.answers },
    req.trustedIpHash,
  );
  return { status: result.duplicate ? 200 : 201, body: result };
}
