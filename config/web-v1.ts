/** Initial web-only limits. Live tuning must update this single source and rerun load tests. */
export const WEB_LIMITS = Object.freeze({
  trialReplies: 3,
  ipWindowMs: 24 * 60 * 60_000,
  maxInputCodePoints: 500,
  maxPrincipalPending: 3, // one active pipeline plus two additional waiting inputs
  maxPrincipalActive: 1,
  maxConversationActive: 1,
  maxPrincipalWaiting: 2,
  // One ticket per nonterminal operation, including running stages. For configured deployments the value is
  // maxGlobalReservedOperations = maxTextRunning + maxAudioRunning + maxWaitingOperations (config/web-concurrency.ts);
  // both defaults (20+4+104 and the library 4+4+120) give 128, which is what this constant keeps.
  maxGlobalReservedOperations: 128,
  operationDeadlineMs: 300_000,
  // maxTextRunning / maxAudioRunning / audioFallbackWaitMs are deployment configuration: config/web-concurrency.ts.
  // A provider rejects with HTTP 429 before running the request: retry the same stage after 2s, 4s, 8s, then give up.
  rateLimitBackoffMs: Object.freeze([2_000, 4_000, 8_000]),
  queueWaitMs: 60_000,
  textLeaseMs: 90_000,
  audioLeaseMs: 120_000,
  coordinatorLeaseMs: 30_000,
});

/** Public Web transport only; scoped application quotas still authorize every send. */
export const WEB_HTTP_LIMITS = Object.freeze({
  requestsPerIpPerMinute: 600,
  writesPerIpPerMinute: 60,
  welcomePerIpPerMinute: 60,
  welcomeGlobalPerMinute: 300,
  requestsGlobalPerMinute: 6000,
  streamMaxMs: 30_000,
  streamPollMs: 1000,
});

/** Internal identity defaults; no HTTP service uses these until its own security gate is approved. */
export const WEB_IDENTITY_LIMITS = Object.freeze({
  guestAbsoluteMs: 24 * 60 * 60_000,
  accountIdleMs: 30 * 60_000,
  accountAbsoluteMs: 24 * 60 * 60_000,
  receiptMs: 300_000,
  receiptSuccessfulRetrievals: 3,
  receiptFailedAttempts: 5,
  receiptFailedWindowMs: 30_000,
  argon2MemoryKiB: 19_456,
  argon2Passes: 2,
  kdfConcurrent: 2,
  kdfWaiting: 8,
  kdfWaitMs: 5_000,
});

/** User-fixed browse-card welcome lines (DEC-WEB-WELCOME-001); change only with a new decision. */
export const WEB_PROVIDER_WELCOME = Object.freeze({
  'wei-guagua': { text: '我才放学回来，让你等久了', version: 'welcome-v1' },
  jojo: { text: 'Thanks Kobe，你终于来了', version: 'welcome-v1' },
  'chen-jimi': { text: '打瓦请按1，王者请按2，其他事请挂断', version: 'welcome-v1' },
} as const);

/** Browse-ring order and short display names used by the approved prototype. */
export const WEB_PROVIDER_CATALOG = Object.freeze([
  { characterId: 'wei-guagua', displayName: '瓜瓜' },
  { characterId: 'jojo', displayName: 'JOJO' },
  { characterId: 'chen-jimi', displayName: '陈吉米' },
] as const);
