// Part 39b (named exception): the old pair card of Part 24c ("{name} 和 [select] [🎲] 之间的故事", four tests) is gone: the relationship card
// (🎲 on the deck, opened from THIS character) replaces it and is tested in relation-flow-39.test.ts. The memo, wording, model-sheet
// and points tests below are unchanged.
// Part 24c: the player side of notes - the pair story card, the 留言条 entry, the new wording, 获得点数 and 共创奖励 in 消费记录.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guideCopy } from '../../src/features/cocreation/chat-guide.ts';
import {
  cocreationCopy,
  openCocreationSheet,
  resetCocreationDrafts,
  type CocreationApi,
} from '../../src/features/cocreation/cocreation-sheet.ts';
import { earnCopy, openEarnSheet } from '../../src/features/cocreation/earn-sheet.ts';
import { billingCopy, billingRow } from '../../src/features/account/billing-sheet.ts';
import { openMyInfo, infoCopy, type MyInfoOptions } from '../../src/features/account/my-info.ts';
import { modelCopy, openModelPicker } from '../../src/features/prototype/model-picker.ts';
import { ProviderApi } from '../../src/services/provider-api.ts';
import { parseBillingPage } from '../../../../packages/contracts/player-billing.ts';
import { COCREATION_PAIR_NOTE_MAX } from '../../../../packages/contracts/cocreation-cards.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

const NAME = '瓜瓜';
const OTHERS = [
  { characterId: 'jojo', name: 'JOJO' },
  { characterId: 'chen-jimi', name: '陈吉米' },
  { characterId: 'xiao-an', name: '小安' },
];

type Calls = {
  cards: { characterId: string; requestId: string }[];
  pairs: { requestId: string; characterId: string; partnerId: string; text: string }[];
  memos: { requestId: string; text: string }[];
};
function setup(
  t: test.TestContext,
  over: Partial<CocreationApi> = {},
  random: () => number = () => 0,
  without: 'submitMemo'[] = [],
) {
  const doc = installFakeDom(t);
  resetCocreationDrafts();
  t.after(resetCocreationDrafts);
  const calls: Calls = { cards: [], pairs: [], memos: [] };
  const api: CocreationApi = {
    submitCocreation: async (input) => {
      calls.cards.push({ characterId: input.characterId, requestId: input.requestId });
      return { submissionId: 's', answered: input.answers.length, duplicate: false };
    },
    submitMemo: async (input) => {
      calls.memos.push(structuredClone(input));
      return { submissionId: 'm', duplicate: false };
    },
    ...over,
  };
  for (const key of without) delete api[key];
  let ids = 0;
  const sheet = openCocreationSheet({
    api,
    characterId: 'wei-guagua',
    name: NAME,
    mount: doc.body as unknown as HTMLElement,
    random,
    newRequestId: () => `request-${++ids}`,
    thanksMs: 0,
  });
  const root = () => sheet.element as unknown as FakeElement;
  return { doc, sheet, root, calls, api };
}

test('wording: the hint, the co-creation entry and the model sheet title', () => {
  assert.equal(guideCopy.text('瓜瓜'), '给瓜瓜换个大脑？或者来说说你心中的瓜瓜～');
  assert.equal(cocreationCopy.title('瓜瓜'), '一起共创角色');
  assert.equal(modelCopy.title, '当前大脑');
  // The old words are gone.
  for (const old of ['点这里可以切换回复模型，或和角色一起共创', '点这里可以和角色一起共创', '共创 · 让瓜瓜更像瓜瓜'])
    assert.notEqual(old, guideCopy.text('瓜瓜') + cocreationCopy.title('瓜瓜'));
  assert.equal(cocreationCopy.memoOpen, '给制作组的留言条');
});

test('model sheet: opens titled 当前大脑', (t) => {
  const doc = installFakeDom(t);
  const picker = openModelPicker({
    info: {
      models: [{ id: 'deepseek', points: 10, voicePoints: 2 }],
      selected: 'deepseek',
      metered: true,
      balance: 100,
      repliesLeft: 8,
      version: 2,
    },
    characterName: NAME,
    api: { setModel: async () => ({}) as never },
    onChanged: () => {},
    mount: doc.body as unknown as HTMLElement,
  });
  assert.equal((picker.element as unknown as FakeElement).querySelector('.mp-title')!.textContent, '当前大脑');
  assert.equal((picker.element as unknown as FakeElement).querySelector('.mp-brain') !== null, true);
});

test('留言条: an entry in the sheet, free text to the production team, sent on its own', async (t) => {
  const f = setup(t);
  const open = f.root().querySelector('.cc-memo-open')!;
  assert.equal(open.textContent, '给制作组的留言条');
  const panel = f.root().querySelector('.cc-memo')!;
  assert.equal(panel.hidden, true);
  open.click();
  assert.equal(panel.hidden, false);
  const send = panel.querySelector('.cc-memo-send')!;
  assert.equal(send.disabled, true);
  panel.querySelector('textarea')!.type_('想要更多角色');
  assert.equal(send.disabled, false);
  send.click();
  await flush();
  assert.deepEqual(f.calls.memos, [{ requestId: 'request-1', text: '想要更多角色' }]);
  assert.equal(f.calls.cards.length + f.calls.pairs.length, 0, 'a memo is not a card or a relation note');
  assert.equal(f.root().querySelector('.cc-notice')!.textContent, cocreationCopy.memoThanks);
  assert.equal(panel.hidden, true);
  assert.equal(panel.querySelector('textarea')!.value, '');
});

test('留言条: an uncertain send is retried with the same request id; without the route there is no entry', async (t) => {
  let fail = true;
  const f = setup(t, {
    submitMemo: async (input) => {
      f.calls.memos.push(structuredClone(input));
      if (fail) throw new Error('network');
      return { submissionId: 'm', duplicate: false };
    },
  });
  f.root().querySelector('.cc-memo-open')!.click();
  f.root().querySelector('.cc-memo')!.querySelector('textarea')!.type_('你好');
  f.root().querySelector('.cc-memo-send')!.click();
  await flush();
  fail = false;
  f.root().querySelector('.cc-memo-send')!.click();
  await flush();
  assert.deepEqual(
    f.calls.memos.map((call) => call.requestId),
    ['request-1', 'request-1'],
  );
  assert.equal(
    setup(t, {}, () => 0, ['submitMemo'])
      .root()
      .querySelector('.cc-memo-entry'),
    null,
  );
});

test('ProviderApi: memo, pair and rewards post their exact bodies and check the answers', async () => {
  const seen: { url: string; body: unknown }[] = [];
  const api = new ProviderApi(async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith('rewards')) return Response.json({ notePoints: 5, dailyCap: 15, adoptPoints: 20 });
    return Response.json({ submissionId: 's', answered: 1, duplicate: false, earned: 5 }, { status: 201 });
  });
  assert.deepEqual(await api.submitMemo({ requestId: 'r', text: '嗯' }), {
    submissionId: 's',
    duplicate: false,
    earned: 5,
  });
  assert.deepEqual(await api.submitPair({ requestId: 'r', characterId: 'a', partnerId: 'b', text: '嗯' }), {
    submissionId: 's',
    duplicate: false,
    earned: 5,
  });
  assert.deepEqual(await api.cocreationRewards(), { notePoints: 5, dailyCap: 15, adoptPoints: 20 });
  assert.deepEqual(
    seen.map((s) => s.url),
    ['/api/web/provider/cocreation/memo', '/api/web/provider/cocreation/pair', '/api/web/provider/cocreation/rewards'],
  );
  assert.deepEqual(seen[0]!.body, { requestId: 'r', text: '嗯' });
  assert.deepEqual(seen[1]!.body, { requestId: 'r', characterId: 'a', partnerId: 'b', text: '嗯' });
  const junk = new ProviderApi(async () => Response.json({ notePoints: 5 }));
  await assert.rejects(junk.cocreationRewards(), /PROTOCOL_INVALID/);
});

test('获得点数: the sheet shows the LIVE numbers in one line and a button that opens co-creation', async (t) => {
  const doc = installFakeDom(t);
  let opened = 0,
    live = { notePoints: 5, dailyCap: 15, adoptPoints: 20 };
  const open = () =>
    openEarnSheet({
      api: { cocreationRewards: async () => live },
      openCocreation: () => opened++,
      mount: doc.body as unknown as HTMLElement,
    });
  let sheet = open();
  const el = () => sheet.element as unknown as FakeElement;
  assert.equal(el().querySelector('.earn-go')!.disabled, true, 'nothing to open until the numbers are known');
  await flush();
  assert.equal(el().querySelector('.earn-line')!.textContent, '写共创 +5（每天最多 15 条）· 被采用 +20');
  el().querySelector('.earn-go')!.click();
  assert.equal(opened, 1);
  assert.equal(doc.body.querySelector('.earn-sheet'), null, 'it closes behind the button');
  // The administrators change the numbers: the next opening says so.
  live = { notePoints: 7, dailyCap: 3, adoptPoints: 50 };
  sheet = open();
  await flush();
  assert.equal(el().querySelector('.earn-line')!.textContent, earnCopy.line(live));
  assert.equal(el().querySelector('.earn-line')!.textContent, '写共创 +7（每天最多 3 条）· 被采用 +50');
  // A failure says so and keeps the button off.
  const failing = openEarnSheet({
    api: { cocreationRewards: async () => Promise.reject(new Error('x')) },
    openCocreation: () => opened++,
    mount: doc.body as unknown as HTMLElement,
  });
  await flush();
  assert.equal((failing.element as unknown as FakeElement).querySelector('.earn-line')!.textContent, earnCopy.failed);
  assert.equal((failing.element as unknown as FakeElement).querySelector('.earn-go')!.disabled, true);
});

test('我的信息: 获得点数 sits next to the points only when the page offers it', (t) => {
  const doc = installFakeDom(t);
  const base = (earn?: () => void): MyInfoOptions => ({
    mode: 'player',
    nickname: '小明',
    playerNumber: 'P1',
    emailMasked: 'a***@example.com',
    quota: { pill: '注册玩家', expiry: null, big: '100', unit: '点', daily: null, fill: null, unlimited: false },
    trialLine: null,
    signupOpen: true,
    deleteEnabled: true,
    saveNickname: async () => {},
    actions: {
      password() {},
      logoutOthers: async () => {},
      logout: async () => {},
      deleteAccount() {},
      clearDevice() {},
      signup() {},
      login() {},
      ...(earn ? { earn } : {}),
    },
    mount: doc.body as unknown as HTMLElement,
  });
  const without = openMyInfo(base());
  assert.equal((without.element as unknown as FakeElement).querySelector('.mi-earn'), null);
  without.close();
  let tapped = 0;
  const withEarn = openMyInfo(base(() => tapped++));
  const button = (withEarn.element as unknown as FakeElement).querySelector('.mi-q-number')!.querySelector('.mi-earn')!;
  assert.equal(button.textContent, infoCopy.earn);
  assert.equal(infoCopy.earn, '获得点数');
  button.click();
  assert.equal(tapped, 1);
});

test('消费记录: a co-creation reward is shown as 共创奖励 (and an adopted one says 被采用)', () => {
  const name = () => '瓜瓜';
  const at = new Date(2026, 9, 29, 10, 30).getTime();
  const note = billingRow({ kind: 'cocreation_note', at, points: 5 }, name);
  assert.deepEqual([note.title.endsWith(billingCopy.cocreation), note.sub, note.points], [true, '', '+5 点']);
  assert.equal(billingCopy.cocreation, '共创奖励');
  const adopted = billingRow({ kind: 'cocreation_adopted', at, points: 20 }, name);
  assert.deepEqual([adopted.title.endsWith('共创奖励'), adopted.sub, adopted.points], [true, '被采用', '+20 点']);
  // The strict parser of the server's page takes both kinds and still refuses an unknown one.
  const page = (kind: string) => ({
    metered: true,
    balance: 125,
    quota: { total: 125, used: 0 },
    trial: null,
    month: { byModel: [], byCharacter: [] },
    items: [{ kind, at, points: 5 }],
    page: 1,
    hasMore: false,
  });
  for (const kind of ['cocreation_note', 'cocreation_adopted'])
    assert.equal(parseBillingPage(page(kind))!.items[0]!.kind, kind);
  assert.equal(parseBillingPage(page('cocreation_other')), undefined);
});
