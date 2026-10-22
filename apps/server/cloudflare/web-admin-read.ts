const id = '[A-Za-z0-9_-]{1,128}';
const readOnlyAdmin = new RegExp(
  `^/(?:admin/(?:characters/list|eval-sets/list|invites/(?:batch-list|batch-detail)|members/list|metrics/stage-latency|models/read|overview/read|system/status|points/(?:preview|reset-preview)|cocreation/(?:counts|list|detail)|conversations/(?:list|detail|export)|characters/${id}/(?:detail|review-status|run-list|run-detail|preview-detail|previews-status|material-list|delete-status)))$`,
);

/**
 * Admin calls that are POST only for the CSRF/origin model but never write: they count against the read-only budget,
 * not the shared write budget, so several open admin tabs polling status do not starve real writes (or each other).
 * An explicit allowlist: anything not listed here (including every unknown path) is still a write.
 * `path` is relative to the provider API prefix.
 */
export const isReadOnlyAdminPost = (path: string): boolean => readOnlyAdmin.test(path);
