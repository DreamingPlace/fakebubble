import { ensure } from '../../../packages/domain/errors.ts';
import type { WebInviteRequest, WebInviteResult } from '../invites/web-invite-routes.ts';
import type { WebCocreation } from './web-cocreation.ts';

/** The player's one write: POST /api/web/local/cocreation/submit (transport cookie, CSRF header and Origin as for any player write). */
export const COCREATION_SUBMIT_PATH = '/api/web/local/cocreation/submit';
/** An answer set can carry 12 cards of up to 300 (one of 1000) code points: more than the 8 KiB default body. */
export const COCREATION_BODY_LIMIT = 32_768;

export function routeWebCocreation(cocreation: WebCocreation, req: WebInviteRequest): WebInviteResult | null {
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
  const result = cocreation.submit(req.playerToken, req.csrf, req.origin, {
    characterId: value.characterId,
    requestId: value.requestId,
    answers: value.answers,
  });
  return { status: result.duplicate ? 200 : 201, body: result };
}
