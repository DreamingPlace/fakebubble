const id = '[A-Za-z0-9_-]{1,128}';
const readOnlyAdmin = new RegExp(
  `^/(?:admin/(?:characters/list|eval-sets/list|invites/batch-list|members/list|metrics/stage-latency|models/read|overview/read|system/status|points/reset-preview|stats/(?:players|costs)|cast/(?:draft|versions|validate|compile-preview)|cocreation/(?:counts|list|detail)|conversations/(?:list|detail|export)|characters/${id}/(?:detail|review-status|run-list|run-detail|preview-detail|previews-status|material-list|delete-status)))$`,
);

/**
 * Admin calls that are POST only for the CSRF/origin model but never write: they count against the read-only budget,
 * not the shared write budget, so several open admin tabs polling status do not starve real writes (or each other).
 * invites/batch-detail is not listed: since Part 22a2 a view that hands out plain codes writes an audit row.
 * An explicit allowlist: anything not listed here (including every unknown path) is still a write.
 * `path` is relative to the provider API prefix.
 */
export const isReadOnlyAdminPost = (path: string): boolean => readOnlyAdmin.test(path);
