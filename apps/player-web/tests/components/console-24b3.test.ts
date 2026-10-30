import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { humanIssue } from '../../src/features/admin/cast/cast-model.ts';
import { rolePicker } from '../../src/features/admin/shell/role-picker.ts';
import { changedSections, emptyCharacter } from '../../src/features/admin/character-form.ts';
import { characterWorkbench } from '../../src/features/admin/character-workbench.ts';
import { pageHead } from '../../src/features/admin/ui/page-head.ts';
import type { CharacterDetail, CharacterProfile } from '../../src/services/character-admin-api.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
/** Everything the console owns: from the first 24b-1 block to the player-only Part 15 block. */
const consoleCss = css.slice(
  css.indexOf('Part 24b-1: the administrator console'),
  css.indexOf('/* Part 15: player only'),
);
const block = css.slice(css.indexOf('Part 24b-3: calmer colour'), css.indexOf('/* Part 15: player only'));

const profile = (): CharacterProfile => {
  const p = emptyCharacter();
  Object.assign(p.template, { id: 'jojo', name: 'JOJO', persona: '离线合成人设', version: 3 });
  p.presentation = { displayName: 'JOJO', publicDescription: '', welcome: { text: '你好', version: 'welcome-v1' } };
  return p;
};
const owner = { id: 'm', label: 'o', role: 'owner' as const, email: null, permissions: [], createdAt: 1 };

function bench(t: test.TestContext, withDraft: boolean) {
  const doc = installFakeDom(t);
  for (const [name, tag] of [
    ['HTMLInputElement', 'INPUT'],
    ['HTMLTextAreaElement', 'TEXTAREA'],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: class {
        static [Symbol.hasInstance](value: unknown) {
          return (value as { tagName?: string } | null)?.tagName === tag;
        }
      },
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const draftProfile = profile();
  draftProfile.template.version = 4;
  draftProfile.template.persona = '草稿人设';
  const detail = {
    characterId: 'jojo',
    previews: [],
    previewAvailable: true,
    published: { version: 3, profile: profile() },
    draft: withDraft
      ? {
          characterId: 'jojo',
          revision: 2,
          baseVersion: 3,
          profile: draftProfile,
          contentHash: 'a'.repeat(64),
          savedAt: 1,
        }
      : null,
  } as CharacterDetail;
  const api = {
    list: async () => ({ characters: [], deletions: [] }),
    detail: async () => detail,
    materials: async () => [],
    profilePreview: async () => ({ draft: detail.draft, published: detail.published?.profile ?? null }),
  };
  const root = doc.createElement('div') as unknown as FakeElement;
  const header = doc.createElement('div') as unknown as FakeElement;
  const workbench = characterWorkbench(root as unknown as HTMLElement, {
    api: api as never,
    member: () => owner,
    run: async (work) => work(),
    status: () => {},
    disposed: () => false,
    directory: 'none',
    headerHost: header as unknown as HTMLElement,
  });
  return { root, rail: root, header, workbench };
}
// Named exception (Part 24b-6, Workbench4): the rail of sections is ONE section bar of .wb-tab buttons across the top of the card; it has no
// 删除角色 any more (that is a danger zone at the foot of 发布), 作者设定与样例 is 说话方式 / 经历 / 其余设定, and the title row shows the name
// alone, the status line and 预演后发布. The assertions below follow those; the behaviours they test (one section at a time, edits survive a
// visit elsewhere, a dot on the section, 预演后发布 jumps to 发布 and hides there) are unchanged.
const railItems = (rail: FakeElement) => rail.querySelectorAll('.wb-tab');
const labels = (rail: FakeElement) => railItems(rail).map((b) => b.textContent);
const current = (rail: FakeElement) =>
  railItems(rail).find((b) => b.getAttribute('aria-current') === 'true')!.textContent;

test('24b-3 角色工作台: a saved role gets a bar of sections, 发布 among them (删除角色 inside it), and shows only the first', async (t) => {
  const f = bench(t, true);
  await f.workbench.open('jojo');
  assert.deepEqual(labels(f.rail), [
    '身份与展示',
    '欢迎内容',
    '性格',
    '说话方式',
    '经历',
    '其余设定',
    '声音',
    '资料改动',
    '发布',
  ]);
  assert.equal(current(f.rail), '身份与展示');
  const form = f.root.querySelector('form')!;
  const shown = form.children.filter((c) => !(c as FakeElement).hidden);
  assert.equal(shown.length, 1, 'one section of the form at a time');
  assert.equal(f.root.querySelector('.wb-savebar')!.querySelectorAll('button').length, 2);
  assert.ok(
    f.root.querySelector('#wb-delete'),
    '删除角色 is a danger zone at the foot of 发布, not an item of the bar',
  );
  assert.ok(f.root.querySelector('#wb-discard'), '放弃服务器草稿 is the other one');
});

test('24b-3 角色工作台: switching sections keeps what was typed, a dot marks the section with changes and clears when it is typed back', async (t) => {
  const f = bench(t, false);
  await f.workbench.open('jojo');
  assert.deepEqual(labels(f.rail), ['身份与展示', '欢迎内容', '性格', '说话方式', '经历', '其余设定', '声音', '发布']);
  const items = railItems(f.rail);
  const persona = f.root.querySelectorAll('textarea')[1]!;
  items[2]!.click();
  assert.equal(current(f.rail), '性格');
  assert.equal(items[2]!.getAttribute('aria-current'), 'true');
  assert.equal(items[0]!.getAttribute('aria-current'), 'false');
  const dot = (i: number) => items[i]!.querySelector('.wb-dot')!;
  assert.equal(dot(2).hidden, true);
  const original = persona.value;
  persona.type_('改过的人设');
  assert.equal(dot(2).hidden, false, 'the 性格 dot shows');
  assert.equal(dot(0).hidden, true, 'no other dot');
  assert.match(f.root.querySelector('.wb-savestate')!.textContent, /1 处未保存/);
  items[0]!.click();
  items[7]!.click();
  items[2]!.click();
  assert.equal(persona.value, '改过的人设', 'the edit survived the visit elsewhere');
  persona.type_(original);
  assert.equal(dot(2).hidden, true, 'typed back to what it was: no dot');
});

test('24b-3 角色工作台: the title row says how many sections the draft changes and 预演后发布 opens 发布 (and hides there)', async (t) => {
  const f = bench(t, true);
  await f.workbench.open('jojo');
  const chip = f.header.querySelector('.head-status')!;
  assert.match(chip.textContent, /草稿有 1 处改动/);
  const go = f.header.querySelector('.admin-primary')!;
  assert.equal(go.textContent, '预演后发布');
  assert.equal(go.hidden, false);
  go.click();
  assert.equal(current(f.rail), '发布');
  assert.equal(go.hidden, true, 'the one solid button is the confirm inside 发布 now');
  await flush();
});

test('24b-3 changedSections names the editor sections a draft changes', () => {
  const a = profile();
  const b = structuredClone(a);
  assert.deepEqual(changedSections(a, b), []);
  b.template.persona = '别的';
  b.presentation.welcome.text = '新欢迎';
  b.presentation.color = '#2BA84A';
  assert.deepEqual(changedSections(a, b), ['identity', 'welcome', 'persona']);
  // Named exception (Part 24b-6): 作者设定与样例 became 说话方式 / 经历 / 其余设定, so there are seven sections, not five.
  assert.equal(changedSections(null, b).length, 7, 'a role with no published profile changes every section');
});

test('24b-3 every page starts with the same title row: the name on the left, the one status or action on the right', (t) => {
  const doc = installFakeDom(t);
  const button = doc.createElement('button');
  const head = pageHead('消耗表', button as unknown as Node) as unknown as FakeElement;
  assert.equal(head.className, 'page-head');
  assert.equal(head.children[0]!.textContent, '消耗表');
  assert.equal((head.children[1] as FakeElement).className, 'page-head-actions');
  assert.match(css, /\.admin-content \.page-head \{[^}]*height: 56px;/);
});

test('24b-3 the console palette: the D1 tokens, no black fill, one primary colour', () => {
  for (const token of [
    '--ad-bg: #f6f4f1',
    '--ad-text: #2b2833',
    '--ad-muted: #6e6875',
    '--ad-primary: #5b4fc4',
    '--ad-tint: #eeebfa',
    '--ad-tint-ink: #3f3596',
    '--ad-ok: #2f7a4f',
    '--ad-ok-soft: #e7f3ec',
    '--ad-warn: #8a5a00',
    '--ad-warn-soft: #fdf3dc',
    '--ad-danger: #b23a26',
    '--ad-danger-soft: #fbedea',
    '--ad-hairline: #ece8e3',
    '--ad-border: #e2ddd6',
  ])
    assert.ok(css.includes(token), token);
  assert.doesNotMatch(consoleCss, /#141414|#000\b|#000000|#111\b/, 'no black in the console');
  // The selected nav item, chips and segments are the tint with primary text.
  assert.match(
    css,
    /\.admin-nav-item\[aria-current="page"\] \{[^}]*background: var\(--ad-tint\);[^}]*color: var\(--ad-tint-ink\);/,
  );
  assert.match(css, /\.seg-button\[aria-pressed="true"\],[^{]*\{[^}]*background: var\(--ad-tint\);/);
  assert.match(css, /button\.admin-primary,[^{]*\{[^}]*background: var\(--ad-primary\);/);
});

test('24b-3 the page frame: the sidebar is sticky and as tall as the window, the page scrolls, sizes come from one scale', () => {
  assert.match(block, /\.admin-sidebar \{[^}]*position: sticky;[^}]*top: 0;[^}]*height: 100dvh;[^}]*overflow-y: auto;/);
  assert.match(block, /html:has\(\.admin-shell\),\s*body:has\(\.admin-shell\) \{[^}]*overflow: visible;/);
  assert.match(block, /--ad-page-max/);
  // Named exception (Part 24b-4): the one content width is 1680 px (side padding only), not 1160; the token stays, its value moved.
  assert.match(consoleCss, /--ad-page-max: 1680px/);
  // Fields are 40. Named exception (Part 24b-4): buttons have exactly two heights now, 36 and compact 30 (a segment is compact), not 40 / 32.
  assert.match(block, /input:not\([^)]*\),\s*\.account-admin-page\.admin-shell select \{[^}]*height: 40px;/);
  assert.match(block, /\.seg-button \{[^}]*height: 30px;/);
  // Cards share one hairline and one radius.
  assert.match(block, /border: 1px solid var\(--ad-hairline\);\s*border-radius: var\(--ad-card-radius\);/);
});

test('24b-3 no endless pages: the workbench, the inbox, the permission grid and the long tables scroll inside their cards', () => {
  assert.match(block, /\.wb-card-body > :not\(\[hidden\]\)/);
  assert.match(block, /\.wb-savebar \{[^}]*position: sticky;[^}]*bottom: 0;/);
  assert.match(block, /\.wb-preview \{[^}]*position: sticky;/);
  // Named exception (Part 24b-6, Inbox3): the inbox is a grid of fixed 176 px cards with the detail under the open row; the page itself
  // scrolls (the next page is read at the window's end), so the old inner scrollers and the 4-column row grid are replaced by these.
  assert.match(consoleCss, /\.cc-row \{[^}]*height: 176px;/);
  assert.match(consoleCss, /\.cc-list \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(block, /\.cc-chip \{[^}]*white-space: nowrap;/);
  assert.match(block, /\.admin-member \.permission-matrix \{[^}]*overflow-y: auto;/);
  assert.match(block, /\.admin-table-wrap \{[^}]*max-height:[^}]*overflow: auto;/);
  assert.match(block, /\.admin-table-wrap thead th \{[^}]*position: sticky;/);
});

test('24b-3 motion follows prefers-reduced-motion: every new duration is multiplied by --ad-motion', () => {
  const durations = [...block.matchAll(/\b(?:animation|transition):[^;]*\d+ms[^;]*;/g)].map((m) => m[0]);
  assert.ok(durations.length >= 4);
  for (const line of durations) assert.match(line, /var\(--ad-motion\)/, line);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--ad-motion: 0;/);
});

test('24b-3 the roles are one row of pills: colour dot, full name, one compact state, the co-creation badge', (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div') as unknown as FakeElement;
  const picker = rolePicker(host as unknown as HTMLElement, {
    emptyText: '无',
    onPick: () => {},
    badges: () => ({ jojo: 2 }),
    compact: { colour: (_id, index) => ['#E8561E', '#2F7BEA'][index]! },
  });
  picker.show([
    { characterId: 'jojo', displayName: 'JOJO', publishedVersion: 2, draftRevision: 1 },
    { characterId: 'new-one', displayName: '新角色', publishedVersion: null, draftRevision: null },
  ]);
  const rows = host.querySelectorAll('.admin-pick-row');
  assert.equal(rows.length, 2, 'every role is one pill');
  assert.match(rows[0]!.textContent, /JOJO/);
  // Named exception (Part 24b-6, round 2): the rail row has the name and ONE mark; no version and no "草稿" word in it (a draft is a dot).
  assert.doesNotMatch(rows[0]!.textContent, /v2|草稿|正式/, 'one mark, no version');
  assert.equal(
    rows[0]!.querySelectorAll('.admin-pick-mark').length + rows[0]!.querySelectorAll('.cocreation-badge').length,
    1,
  );
  // Named exception (Part 24b-6, round 2): the circle carries its initial in white, so a tint too light for 4.5:1 is darkened a step
  // (same hue): #E8561E becomes #c4491a. Colours that already read keep their value.
  assert.equal(rows[0]!.querySelector('.admin-pick-dot')!.style.getPropertyValue('--dot'), '#c4491a');
  assert.equal(rows[0]!.querySelector('.admin-pick-dot')!.textContent, 'J');
  assert.equal(rows[0]!.querySelector('.cocreation-badge')!.textContent, '2');
  // Named exception (Part 24b-6): the rail says 未上线 for a role that was never published (Workbench4).
  assert.match(rows[1]!.textContent, /未上线/);
});

test('24b-3 an issue of the cast is read with names, not ids, and grouped by character', () => {
  const doc = {
    characters: [{ characterId: 'c01', identity: { names: [{ id: '', text: '林小满' }] } }],
    people: [{ id: 'p1', names: [{ id: '', text: '老师' }] }],
    groups: [{ id: 'g1', name: '文学社' }],
    stories: [{ id: 's1', title: '雨夜的告白' }],
  } as never;
  assert.deepEqual(humanIssue(doc, 'characters[c01]'), { who: '林小满', where: '' });
  assert.deepEqual(humanIssue(doc, 'characters[0].identity.names'), { who: '林小满', where: '身份 · 名字' });
  assert.deepEqual(humanIssue(doc, 'stories[0].participants[1]'), { who: null, where: '故事「雨夜的告白」 · 参与者' });
  assert.deepEqual(humanIssue(doc, 'groups[g1].members'), { who: null, where: '组合「文学社」 · 成员' });
  assert.ok(!/c01|characters\[/.test(humanIssue(doc, 'characters[c01].profile').where));
});

test('24b-3 hard rules in CSS: no ellipsis, chips never wrap, two columns with 预演 at 420 px that goes under below ~1360 px', () => {
  assert.match(block, /\.admin-shell \* \{\s*text-overflow: clip;/);
  assert.doesNotMatch(block, /text-overflow: ellipsis/);
  assert.doesNotMatch(block, /line-clamp|-webkit-box/);
  assert.match(block, /\.cc-chip,[\s\S]*?\) \{\s*white-space: nowrap;/);
  assert.match(block, /grid-template-columns: minmax\(600px, 1fr\) 420px;/);
  assert.match(
    block,
    /@container adc \(max-width: 1063px\) \{[^@]*\.wb:has\(\.wb-preview:not\(\[hidden\]\)\) \{\s*grid-template-columns: minmax\(0, 1fr\);/,
  );
  // The console has no @media query but the one that shows the narrow-window notice.
  assert.doesNotMatch(block, /@media/);
});
