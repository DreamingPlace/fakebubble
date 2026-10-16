import { ensure } from '../../../packages/domain/errors.ts';
import type { WebInviteRequest, WebInviteResult } from '../invites/web-invite-routes.ts';
import type { WebBilling } from './web-billing.ts';

/** POST /api/web/local/billing/history { page?, tzOffsetMinutes? }: the player's own 消费记录 (a read, sent as a POST for CSRF/Origin). */
export const BILLING_HISTORY_PATH = '/api/web/local/billing/history';

export function routeWebBilling(billing: WebBilling, req: WebInviteRequest): WebInviteResult | null {
  if (req.path !== BILLING_HISTORY_PATH) return null;
  ensure(req.method === 'POST', 'NOT_FOUND');
  const body = req.body as Record<string, unknown> | null;
  ensure(
    body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      Object.keys(body).every((key) => key === 'page' || key === 'tzOffsetMinutes'),
    'INVALID_REQUEST',
  );
  ensure(typeof req.playerToken === 'string' && req.playerToken !== '', 'AUTH_REQUIRED');
  ensure(typeof req.csrf === 'string' && typeof req.origin === 'string', 'CSRF_INVALID');
  return { status: 200, body: billing.history(req.playerToken, req.csrf, req.origin, body) };
}
