import type { WebDurableStore } from '../../../apps/server/cloudflare/web-store.ts';

/** Test-only read of the Part 19 tables: live codes, banner marks and every archive row (the archive has no id to hide). */
export function reviewState(store: Pick<WebDurableStore, 'all' | 'get'>) {
  return {
    codes: store.all<{ principal_id: string; code: string }>(
      'SELECT principal_id,code FROM web_review_codes ORDER BY code',
    ),
    notices: store.get<{ n: number }>('SELECT count(*) n FROM web_review_notice')!.n,
    archive: store.all<Record<string, unknown>>('SELECT * FROM web_review_archive ORDER BY label,line_order'),
  };
}
