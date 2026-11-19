import assert from 'node:assert/strict';
import test from 'node:test';
import { modelsView } from '../../src/features/admin/models-view.ts';
import type { ModelAdminView } from '../../../../packages/contracts/model-settings.ts';
import type { WriterSettingView } from '../../../../packages/contracts/web-writer.ts';
import type { FakeElement } from './fake-dom.ts';
import { installFakeDom } from './fake-dom.ts';

/** Part 41: 回复写法 is never silently hidden for the owner. A failed read is said in the card; anyone else still gets nothing. */
const table = (): ModelAdminView => ({
  featureOn: true,
  revision: 1,
  priceVersion: 1,
  voicePoints: 2,
  canManage: true,
  models: [],
  recent: [],
});

function mount(
  t: test.TestContext,
  options: { owner?: boolean; writer: () => Promise<WriterSettingView>; review?: () => Promise<never> },
) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  let writerReads = 0;
  const api = modelsView(root, {
    load: async () => table(),
    save: async () => ({}),
    ...(options.review ? { review: { load: options.review, save: async () => ({}) } as never } : {}),
    writer: {
      load: () => {
        writerReads++;
        return options.writer();
      },
      save: async () => ({}),
    },
    isOwner: () => options.owner !== false,
    run: async (work) => {
      try {
        await work();
      } catch {
        /* the page shows the message */
      }
    },
    confirm: async () => true,
    toast: () => undefined,
    newRequestId: () => 'id',
    disposed: () => false,
  });
  const card = () => (root as unknown as FakeElement).querySelector('.models-writer') as FakeElement;
  return { api, card, reads: () => writerReads };
}

test('a failed read shows the error in the owner’s card, as a sentence, not a hidden card', async (t) => {
  const f = mount(t, {
    writer: async () => {
      throw Object.assign(new Error('x'), { code: 'RATE_LIMITED' });
    },
  });
  await f.api.load();
  assert.equal(f.card().hidden, false);
  assert.match(f.card().textContent, /回复写法/);
  assert.match(f.card().textContent, /操作太频繁/);
  // (the code itself sits on hover and behind 复制代码, as ui/error-line.ts does everywhere in the console)
});

test('a failed read of a non-owner stays hidden and nothing is requested', async (t) => {
  const f = mount(t, {
    owner: false,
    writer: async () => {
      throw new Error('x');
    },
  });
  await f.api.load();
  assert.equal(f.card().hidden, true);
  assert.equal(f.reads(), 0);
});

test('the review switch failing does not keep the owner from the writer card', async (t) => {
  const f = mount(t, {
    writer: async () => ({ writer: 'v7', available: true }),
    review: async () => {
      throw new Error('review');
    },
  });
  await assert.rejects(() => f.api.load());
  assert.equal(f.card().hidden, false);
  assert.match(f.card().textContent, /当前：旧写法/);
});

test('a site without the setting table says so to the owner instead of hiding the card', async (t) => {
  const f = mount(t, { writer: async () => ({ writer: 'v7', available: false }) });
  await f.api.load();
  assert.equal(f.card().hidden, false);
  assert.match(f.card().textContent, /设置表/);
});
