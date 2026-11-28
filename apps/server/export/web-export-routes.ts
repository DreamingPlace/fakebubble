import { ensure } from '../../../packages/domain/errors.ts';
import type { WebInviteRequest, WebInviteResult } from '../invites/web-invite-routes.ts';
import type { WebExportAdmin } from './web-export-admin.ts';

const BASE = '/api/web/local/admin/export/';

/**
 * Part 57: POST /api/web/local/admin/export/file (one file of an export) and /export/allowed (which exports this administrator may
 * see a button for). A path outside /export/ is not this router's: it returns null and the next router looks at it.
 */
export function routeWebAdminExport(exporter: WebExportAdmin | null, req: WebInviteRequest): WebInviteResult | null {
  if (!req.path.startsWith(BASE)) return null;
  ensure(exporter && req.method === 'POST', 'NOT_FOUND');
  ensure(
    typeof req.adminCookie === 'string' && typeof req.csrf === 'string' && typeof req.origin === 'string',
    'ADMIN_UNAUTHORIZED',
  );
  const auth = { cookie: req.adminCookie, csrf: req.csrf, origin: req.origin };
  const action = req.path.slice(BASE.length);
  if (action === 'allowed') return { status: 200, body: { kinds: exporter.allowed(auth) } };
  if (action === 'file') return { status: 200, body: exporter.export(auth, req.body) };
  ensure(false, 'NOT_FOUND');
}
