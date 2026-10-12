const id = '[A-Za-z0-9_-]{1,128}';
const readOnlyAdmin = new RegExp(
  `^/(?:admin/(?:characters/list|eval-sets/list|invites/list|members/list|metrics/stage-latency|cocreation/(?:counts|list|detail)|characters/${id}/(?:detail|review-status|run-list|run-detail|preview-detail|previews-status|material-list|delete-status)))$`,
);

/**
 * Admin calls that are POST only for the CSRF/origin model but never write: they count against the read-only budget,
 * not the shared write budget, so several open admin tabs polling status do not starve real writes (or each other).
 * An explicit allowlist: anything not listed here (including every unknown path) is still a write.
 * `path` is relative to the provider API prefix.
 */
export const isReadOnlyAdminPost = (path: string): boolean => readOnlyAdmin.test(path);
