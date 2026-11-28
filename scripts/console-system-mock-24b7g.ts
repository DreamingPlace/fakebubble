/**
 * Part 24b-7f round 3: the data the offline fixture cannot produce for 系统状态, so its tables can be measured with real rows: fourteen days
 * of 技术指标, a cleanup failure and three 未确认的调用 (one with a long error code). Applied by intercepting the two reads; nothing is
 * stored and nothing reaches a provider. `page` is a Playwright page.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
export async function mockSystemRows(page: any) {
  const pct = (s: number, a: number, b: number) => ({ samples: s, p50Ms: s ? a : null, p95Ms: s ? b : null });
  const day = (i: number) => ({
    day: `2026-11-${String(20 - i).padStart(2, '0')}`,
    operations: 1234 + i * 77,
    textQueueWait: pct(120 + i, 420, 2310),
    audioQueueWait: pct(90, 1840, 9120),
    textStage: pct(120, 3100, 12800),
    audioStage: pct(0, 0, 0),
    rateLimitRetries: i,
    fallbacks: 2 * i,
    review: { samples: 118, changed: 23 + i, rate: 0.19 },
    memoryDropped: { topics: 3, facts: 12 },
    cache: {
      draft: { calls: 100, hitTokens: 120000, missTokens: 30000, hitRatio: 0.8 },
      review: { calls: 100, hitTokens: 12000, missTokens: 30000, hitRatio: 0.29 },
    },
    embedding: { calls: 321, texts: 400, failures: 2, unknowns: 1, queryFallbacks: 0, queryTimeouts: 0 },
  });
  // biome-ignore lint/suspicious/noExplicitAny: Playwright route
  await page.route('**/admin/system/status', async (route: any) => {
    const response = await route.fetch();
    const body = await response.json();
    body.metrics = Array.from({ length: 14 }, (_, i) => day(i));
    body.retention = {
      failing: 2,
      oldestAgeBucket: '1-7d',
      lastSuccessAt: Date.UTC(2026, 10, 19, 3, 0),
      purging: 1,
      oldestPurgingMinutes: 20,
      failures: [
        {
          code: 'WEB_RETENTION_UNEXPECTED_WORLD_DATA',
          phase: 'purge',
          sub: 'chat',
          errorName: 'TypeError',
          messageShape: 'Cannot read properties of undefined',
          table: 'web_messages',
          count: 3,
        },
        {
          code: 'WEB_RETENTION_FAILED',
          phase: 'sweep',
          sub: 'audio',
          errorName: 'Error',
          messageShape: 'database is locked',
          count: 1,
        },
      ],
    };
    return route.fulfill({ response, json: body });
  });
  // biome-ignore lint/suspicious/noExplicitAny: Playwright route
  await page.route('**/admin/system/unknown-calls', async (route: any) => {
    const calls = (
      [
        [
          'U7K2-9QXM',
          'deepseek',
          'deepseek-v4-pro',
          'review',
          1_320_000,
          86_400_000 * 2.4,
          'WEB_PROVIDER_RESULT_UNKNOWN',
        ],
        ['H3P8-2DLA', 'fish', 's2.1-pro', 'speech', 45_100, 3_600_000 * 5, 'SPEECH_CALL_UNKNOWN'],
        ['B6T1-5NWC', 'gemini', 'gemini-3.8-flash', 'draft', 220_000, 540_000, 'WEB_PROVIDER_TIMEOUT_AFTER_SEND'],
      ] as const
    ).map(([code, provider, model, stage, heldMicros, ageMs, errorCode]) => ({
      code,
      provider,
      model,
      stage,
      heldMicros,
      ageMs,
      errorCode,
    }));
    return route.fulfill({ json: { calls, other: { embed: 2 }, resolved: 4 } });
  });
}
