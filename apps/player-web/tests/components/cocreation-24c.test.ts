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
  without: ('submitPair' | 'submitMemo')[] = [],
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
    submitPair: async (input) => {
      calls.pairs.push(structuredClone(input));
      return { submissionId: 'p', duplicate: false, earned: 5 };
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
    others: [{ characterId: 'wei-guagua', name: NAME }, ...OTHERS],
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
  assert.equal(cocreationCopy.pairBetween, '之间的故事');
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

test('pair card: "{name} 和 [select] [🎲] 之间的故事", the select lists the OTHER live characters', (t) => {
  const f = setup(t);
  const card = f.root().querySelector('[data-card="pair-story"]')!;
  assert.ok(card);
  assert.deepEqual(
    card
      .querySelector('.cc-pair-line')!
      .querySelectorAll('span')
      .map((node) => node.textContent),
    ['瓜瓜 和', '之间的故事'],
  );
  const options = card.querySelectorAll('option');
  assert.deepEqual(
    options.map((option) => [option.getAttribute('value'), option.textContent]),
    OTHERS.map((entry) => [entry.characterId, entry.name]),
    'never the character itself',
  );
  assert.equal(card.querySelector('.cc-pair-roll')!.textContent, '🎲');
  assert.equal(card.querySelector('textarea')!.getAttribute('maxlength'), String(COCREATION_PAIR_NOTE_MAX));
  assert.equal(card.querySelector('textarea')!.getAttribute('placeholder'), '瓜瓜和JOJO之间发生过什么？');
});

test('pair card: 🎲 picks another character and can be tapped again to re-roll; the choice goes with the note', async (t) => {
  const picks = [0.1, 0.9, 0.1];
  let n = 0;
  const f = setup(t, {}, () => picks[n++ % picks.length]!);
  const card = f.root().querySelector('[data-card="pair-story"]')!;
  const select = () => card.querySelector('select')!;
  const roll = card.querySelector('.cc-pair-roll')!;
  assert.equal(select().value, 'jojo');
  roll.click();
  assert.notEqual(select().value, 'jojo', 'a roll never lands on the character already showing');
  const first = select().value;
  roll.click();
  const second = select().value;
  assert.notEqual(second, first, 're-rolling changes it again');
  assert.equal(
    card
      .querySelector('textarea')!
      .getAttribute('placeholder')!
      .includes(OTHERS.find((e) => e.characterId === second)!.name),
    true,
  );
  // Choosing by hand works too.
  select().value = 'xiao-an';
  select().dispatch('change');
  const send = f.root().querySelector('.cc-send')!;
  assert.equal(send.disabled, true, 'nothing to hand over yet');
  card.querySelector('textarea')!.type_('她们一起养过一只猫');
  assert.equal(send.disabled, false, 'a pair note alone is enough to send');
  send.click();
  await flush();
  assert.deepEqual(f.calls.pairs, [
    { requestId: 'request-1', characterId: 'wei-guagua', partnerId: 'xiao-an', text: '她们一起养过一只猫' },
  ]);
  assert.equal(f.calls.cards.length, 0, 'no cards were written, so no card submission');
  assert.equal(f.root().querySelector('.cc-thanks-sub')!.textContent.includes(cocreationCopy.earned(5)), true);
});

test('pair card: sent together with cards; a failed pair keeps its text and the cards that went through are spent', async (t) => {
  let fail = true;
  const f = setup(t, {
    submitPair: async (input) => {
      if (fail) throw Object.assign(new Error('x'), { code: 'COCREATION_IP_LIMIT' });
      return { submissionId: 'p', duplicate: false, ...(input.text ? {} : {}) };
    },
  });
  const pairArea = f.root().querySelector('[data-card="pair-story"]')!.querySelector('textarea')!;
  const textCard = f
    .root()
    .querySelectorAll('.cc-card')
    .find((card) => card.getAttribute('data-card') === 'free')!;
  textCard.querySelector('.cc-face')!.click();
  textCard.querySelector('textarea')!.type_('随便写点');
  pairArea.type_('一个故事');
  f.root().querySelector('.cc-send')!.click();
  await flush();
  assert.equal(f.calls.cards.length, 1, 'the cards were handed over');
  assert.equal(
    f.root().querySelector('.cc-notice')!.textContent,
    cocreationCopy.errors.COCREATION_IP_LIMIT ?? cocreationCopy.errors.unknown,
  );
  assert.equal(
    f.root().querySelector('[data-card="pair-story"]')!.querySelector('textarea')!.value,
    '一个故事',
    'the pair text is kept',
  );
  // Sending again retries ONLY the pair note (the cards are spent), with the same request id.
  fail = false;
  f.root().querySelector('.cc-send')!.click();
  await flush();
  assert.equal(f.calls.cards.length, 1, 'cards are never submitted twice');
});

test('pair card: not shown without other characters or without the route', (t) => {
  const f = setup(t, {}, () => 0, ['submitPair']);
  assert.equal(f.root().querySelector('[data-card="pair-story"]'), null);
  const doc = installFakeDom(t);
  const alone = openCocreationSheet({
    api: {
      submitCocreation: async () => ({ submissionId: 's', answered: 1, duplicate: false }),
      submitPair: async () => ({ submissionId: 'p', duplicate: false }),
    },
    characterId: 'wei-guagua',
    name: NAME,
    others: [{ characterId: 'wei-guagua', name: NAME }],
    mount: doc.body as unknown as HTMLElement,
  });
  assert.equal((alone.element as unknown as FakeElement).querySelector('[data-card="pair-story"]'), null);
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
  assert.equal(f.calls.cards.length + f.calls.pairs.length, 0, 'a memo is not a card or a pair note');
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
