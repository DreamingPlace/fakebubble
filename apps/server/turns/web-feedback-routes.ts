import { ensure } from '../../../packages/domain/errors.ts';
import type { WebInviteRequest, WebInviteResult } from '../invites/web-invite-routes.ts';
import type { WebFeedbackAdmin } from './web-feedback-admin.ts';

const BASE = '/api/web/local/admin/feedback/';

/**
 * Part 36: the 语音反馈 page. POST .../admin/feedback/{counts,list,heard,audio} (owner only; session, CSRF and Origin first). A path
 * outside /feedback/ is not this router's: it returns null and the next router looks at it.
 */
export async function routeWebFeedbackAdmin(feedback: WebFeedbackAdmin | null, req: WebInviteRequest): Promise<WebInviteResult | null> {
  if (!req.path.startsWith(BASE)) return null;
  ensure(feedback && req.method === 'POST', 'NOT_FOUND');
  ensure(
    typeof req.adminCookie === 'string' && typeof req.csrf === 'string' && typeof req.origin === 'string',
    'ADMIN_UNAUTHORIZED',
  );
  const auth = { cookie: req.adminCookie, csrf: req.csrf, origin: req.origin };
  const action = req.path.slice(BASE.length);
  if (action === 'counts') return { status: 200, body: feedback.counts(auth, req.body) };
  if (action === 'list') return { status: 200, body: feedback.list(auth, req.body) };
  if (action === 'heard') return { status: 200, body: feedback.markHeard(auth, req.body) };
  if (action === 'audio') return { status: 200, body: await feedback.audio(auth, req.body) };
  ensure(false, 'NOT_FOUND');
}
