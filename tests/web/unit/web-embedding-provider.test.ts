import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  EmbeddingFailure,
  OfflineEmbeddings,
  WorkersAiEmbeddings,
  WorkersAiRestEmbeddings,
  embeddingMicros,
  estimateEmbeddingTokens,
  fixtureVector,
  offlineVector,
} from '../../../apps/server/generation/embedding-provider.ts';

const live = () => new AbortController().signal;
const rows = (n: number) => Array.from({ length: n }, (_, i) => Array.from(fixtureVector({ [i]: 1 })));
const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof EmbeddingFailure, String(error));
    return error;
  }
  assert.fail('expected an EmbeddingFailure');
};

test('price: USD 0.0118 per million tokens on a bytes/2 estimate, rounded up and never zero', () => {
  assert.equal(estimateEmbeddingTokens(['abcd']), 2);
  assert.equal(estimateEmbeddingTokens(['猫']), 2, 'a three-byte character is 3 bytes, 2 tokens');
  assert.equal(estimateEmbeddingTokens(['a', 'b']), 1, 'bytes are summed over the array before halving');
  assert.equal(embeddingMicros(1), 1, 'a hold is always positive');
  assert.equal(embeddingMicros(1_000_000), 11_800);
  assert.equal(embeddingMicros(1_000_001), 11_801, 'rounded up');
});

test('Workers AI binding: one call with the whole array, authorize first, vectors in order', async () => {
  const seen: unknown[] = [];
  const order: string[] = [];
  const provider = new WorkersAiEmbeddings({
    async run(model, input) {
      order.push('run');
      seen.push([model, input]);
      return { shape: [2, 1024], data: rows(2), usage: { prompt_tokens: 9 } };
    },
  });
  const result = await provider.embed(['猫', '工作'], live(), () => {
    order.push('authorize');
  });
  assert.deepEqual(order, ['authorize', 'run']);
  assert.deepEqual(seen, [[EMBEDDING_MODEL, { text: ['猫', '工作'] }]]);
  assert.equal(result.vectors.length, 2);
  assert.equal(result.vectors[0]!.length, EMBEDDING_DIMS);
  assert.equal(result.vectors[1]![1], 1);
  assert.equal(result.usageTokens, 9);
});

test('Workers AI binding: a refused gate sends nothing; only "not executed" errors are known', async () => {
  let runs = 0;
  const ai = (error: unknown) => ({
    async run() {
      runs++;
      throw error;
    },
  });
  const refused = new WorkersAiEmbeddings(ai(new Error('x')));
  const gate = await failure(
    refused.embed(['a'], live(), () => {
      throw new Error('closed');
    }),
  ).catch((e) => e);
  assert.equal(runs, 0);
  assert.ok(gate instanceof Error);
  assert.equal(
    (await failure(new WorkersAiEmbeddings(ai(new Error('AiError: 3040: Capacity'))).embed(['a'], live()))).known,
    true,
  );
  assert.equal(
    (await failure(new WorkersAiEmbeddings(ai(new Error('429 Too Many Requests'))).embed(['a'], live()))).known,
    true,
  );
  const other = await failure(new WorkersAiEmbeddings(ai(new Error('InferenceUpstreamError'))).embed(['a'], live()));
  assert.equal(other.known, false, 'an unexplained error may have run and been billed');
  assert.equal(runs, 3);
});

test('Workers AI binding: bad payloads and aborts are never known', async () => {
  for (const data of [
    [[1, 2]],
    rows(1).concat(rows(1)),
    [Array(1024).fill(0)],
    [[...Array(1023).fill(1), Number.NaN]],
  ]) {
    const provider = new WorkersAiEmbeddings({ run: async () => ({ data }) });
    assert.equal((await failure(provider.embed(['a'], live()))).known, false);
  }
  const controller = new AbortController();
  const hang = new WorkersAiEmbeddings({ run: () => new Promise(() => {}) });
  const pending = failure(hang.embed(['a'], controller.signal));
  setTimeout(() => controller.abort(), 5);
  const aborted = await pending;
  assert.deepEqual([aborted.code, aborted.known], ['EMBEDDING_ABORTED', false]);
  for (const bad of [[], Array(17).fill('a'), [''], ['x'.repeat(4097)]])
    assert.equal(
      (await failure(new WorkersAiEmbeddings({ run: async () => ({}) }).embed(bad, live()))).code,
      'EMBEDDING_INPUT_INVALID',
    );
});

test('Workers AI REST: account URL, bearer token and body; 4xx known, 5xx and network errors unknown; token never leaks', async () => {
  const accountId = 'a'.repeat(32);
  const apiToken = 'secret-token-0123456789-abcdef';
  const requests: { url: string; init: RequestInit }[] = [];
  const make = (respond: () => Response | Promise<Response>) =>
    new WorkersAiRestEmbeddings({
      accountId,
      apiToken,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return respond();
      },
    });
  const ok = make(() =>
    Response.json({ success: true, result: { shape: [1, 1024], data: rows(1), usage: { total_tokens: 3 } } }),
  );
  const result = await ok.embed(['猫'], live());
  assert.equal(requests[0]!.url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-m3`);
  assert.equal((requests[0]!.init.headers as Record<string, string>).authorization, `Bearer ${apiToken}`);
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { text: ['猫'] });
  assert.equal(result.usageTokens, 3);
  for (const status of [400, 401, 403, 404, 422, 429])
    assert.equal(
      (await failure(make(() => new Response('{}', { status })).embed(['a'], live()))).known,
      true,
      String(status),
    );
  for (const status of [500, 502, 503])
    assert.equal(
      (await failure(make(() => new Response('{}', { status })).embed(['a'], live()))).known,
      false,
      String(status),
    );
  const network = await failure(
    make(() => {
      throw new Error(`connect failed with ${apiToken}`);
    }).embed(['a'], live()),
  );
  assert.equal(network.known, false);
  assert.ok(!JSON.stringify([network.message, network.code]).includes(apiToken));
  assert.equal(
    (await failure(make(() => Response.json({ success: false, errors: [] })).embed(['a'], live()))).known,
    false,
  );
  assert.equal((await failure(make(() => new Response('not json')).embed(['a'], live()))).known, false);
  assert.throws(() => new WorkersAiRestEmbeddings({ accountId: 'x', apiToken }), /EMBEDDING_CREDENTIAL_INVALID/);
  assert.throws(() => new WorkersAiRestEmbeddings({ accountId, apiToken: 'short' }), /EMBEDDING_CREDENTIAL_INVALID/);
});

test('offline embedder is deterministic; the fixture embedder maps chosen sentences to chosen vectors; outcomes are scripted', async () => {
  assert.deepEqual(offlineVector('猫'), offlineVector('猫'));
  assert.notDeepEqual(offlineVector('猫'), offlineVector('狗'));
  assert.ok(Math.abs(Math.hypot(...offlineVector('猫')) - 1) < 1e-4);
  const cat = fixtureVector({ 0: 1 });
  const fixtures = new Map([['我家的猫', cat]]);
  const provider = new OfflineEmbeddings({ fixtures });
  const [mapped, fallback] = (await provider.embed(['我家的猫', '别的'], live())).vectors;
  assert.deepEqual(mapped, cat);
  assert.deepEqual(fallback, offlineVector('别的'));
  assert.deepEqual(provider.calls, [['我家的猫', '别的']]);
  const scripted = new OfflineEmbeddings({ outcome: (i) => (['ok', 'known', 'unknown', 'invalid'] as const)[i]! });
  await scripted.embed(['a'], live());
  assert.equal((await failure(scripted.embed(['a'], live()))).known, true);
  assert.equal((await failure(scripted.embed(['a'], live()))).known, false);
  assert.equal((await failure(scripted.embed(['a'], live()))).known, false);
});
