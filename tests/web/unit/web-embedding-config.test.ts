import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  WEB_EMBED_DEFAULT,
  embeddingsEnabled,
  parseWebEmbedConfig,
  webEmbedConfigFromEnv,
} from '../../../config/web-embeddings.ts';
import { WEB_CONCURRENCY_DEPLOYMENT_DEFAULT, webConcurrencyFromEnv } from '../../../config/web-concurrency.ts';

test('embedding concurrency is its own limit (default 2) and the query timeout defaults to 3 seconds', () => {
  assert.deepEqual({ ...WEB_EMBED_DEFAULT }, { maxEmbedRunning: 2, queryTimeoutMs: 3000 });
  assert.deepEqual(parseWebEmbedConfig(undefined), WEB_EMBED_DEFAULT);
  assert.deepEqual(webEmbedConfigFromEnv({}), WEB_EMBED_DEFAULT);
  const configured = webEmbedConfigFromEnv({ MAX_EMBED_RUNNING: '5', EMBED_QUERY_TIMEOUT_MS: '1500' });
  assert.deepEqual({ ...configured }, { maxEmbedRunning: 5, queryTimeoutMs: 1500 });
  assert.equal(parseWebEmbedConfig({ maxEmbedRunning: 16, queryTimeoutMs: 10_000 }).maxEmbedRunning, 16);
  for (const bad of [0, 17, 1.5, 'x', null, ''])
    assert.throws(() => parseWebEmbedConfig({ maxEmbedRunning: bad }), /WEB_EMBED_CONFIG_INVALID_RUNNING/, String(bad));
  for (const bad of [199, 10_001, 'x', null])
    assert.throws(
      () => parseWebEmbedConfig({ queryTimeoutMs: bad }),
      /WEB_EMBED_CONFIG_INVALID_QUERY_TIMEOUT/,
      String(bad),
    );
  assert.equal(embeddingsEnabled({ EMBEDDINGS_ENABLED: 'true' }), true);
  for (const off of [undefined, 'false', '1', 'TRUE', ''])
    assert.equal(embeddingsEnabled({ EMBEDDINGS_ENABLED: off }), false, String(off));
});

test('the deployment examples keep embeddings off by default and name the AI binding on the generation Worker only', () => {
  const generation = JSON.parse(readFileSync('workers/web-cloudflare/deploy/generation.json.example', 'utf8')) as {
    vars: Record<string, string>;
    ai?: { binding: string };
  };
  assert.deepEqual(generation.ai, { binding: 'AI' });
  assert.equal(generation.vars.EMBEDDINGS_ENABLED, 'false');
  assert.equal(generation.vars.EXTERNAL_CALLS, 'false');
  const business = JSON.parse(readFileSync('workers/web-cloudflare/deploy/business.json.example', 'utf8')) as {
    vars: Record<string, string>;
    ai?: unknown;
  };
  assert.equal(embeddingsEnabled(business.vars), false);
  assert.deepEqual({ ...webEmbedConfigFromEnv(business.vars) }, { ...WEB_EMBED_DEFAULT });
  assert.equal(
    business.ai,
    undefined,
    'the business object has no Workers AI binding: only the generation Worker can call it',
  );
  assert.deepEqual(
    webConcurrencyFromEnv(business.vars),
    WEB_CONCURRENCY_DEPLOYMENT_DEFAULT,
    'text/audio limits untouched',
  );
});
