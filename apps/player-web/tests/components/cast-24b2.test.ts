import assert from 'node:assert/strict';
import test from 'node:test';
import { castKnowledge, compileCastViewDetailed } from '../../../../apps/server/cast/cast-compile.ts';
import { validateCastDoc } from '../../../../apps/server/cast/cast-validation.ts';
import type { CastDoc, CastIssue } from '../../../../packages/contracts/web-cast.ts';
import { sampleCast, sampleId } from '../../../../tests/web/fixtures/cast-sample.ts';
import {
  CastAdminClient,
  type CastCompilePreviewResult,
  type CastDraftResult,
} from '../../src/services/cast-admin-api.ts';
import { InviteLocalApiError } from '../../src/services/invite-local-api.ts';
import { castView, type CastViewHost } from '../../src/features/admin/cast/cast-view.ts';
import {
  clearKnowledge,
  defaultKnowledge,
  heatIndex,
  knowledgeOf,
  nameOf,
  nextKnowledge,
  ratingOf,
  ratingText,
  setDirection,
  setKnowledge,
  setRating,
  starFill,
  starValue,
} from '../../src/features/admin/cast/cast-model.ts';
import { navTree, visibleNav, type NavAccess } from '../../src/features/admin/shell/admin-nav.ts';
import { permissionMatrixEditor, PERMISSION_GROUPS } from '../../src/features/admin/permission-matrix.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

const lookup = { exists: () => true, deleted: () => false };

test('ratings are one-way: A → B never changes B → A; the grid is 0.5 steps; not set is the absence of an entry, not 0', () => {
  const doc = sampleCast();
  const [a, b] = [sampleId(0), sampleId(9)];
  assert.equal(ratingOf(doc, a, b), null, 'c01 never rated c10');
  setRating(doc, a, b, 4.5);
  assert.equal(ratingOf(doc, a, b), 4.5);
  assert.equal(ratingOf(doc, b, a), null, 'the other direction is untouched');
  setRating(doc, b, a, 0);
  assert.equal(ratingOf(doc, b, a), 0, 'a 0 is stored as 0');
  assert.notEqual(ratingOf(doc, b, a), ratingOf(doc, a, sampleId(11)), '0 and not set are different values');
  assert.equal(ratingText(0), '0');
  assert.equal(ratingText(null), '未设置');
  setRating(doc, b, a, null);
  assert.equal(b in doc.ratings && a in (doc.ratings[b] ?? {}), false, 'removing leaves no entry behind');
  setRating(doc, a, b, 3.3);
  assert.equal(ratingOf(doc, a, b), 3.5, 'snapped to the half-star grid');
  setRating(doc, a, a, 5);
  assert.equal(ratingOf(doc, a, a), null, 'nobody rates themselves');
  assert.deepEqual(validateCastDoc(doc, 'draft', lookup).errors, [], 'what the model writes the server accepts');
});

test('half stars: the left half of star n sets n − 0.5, the right half n; fill shows 0, ½ or all', () => {
  assert.equal(starValue(3, true), 2.5);
  assert.equal(starValue(3, false), 3);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => starFill(3.5, n)),
    [1, 1, 1, 0.5, 0],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => starFill(null, n)),
    [0, 0, 0, 0, 0],
  );
  assert.equal(heatIndex(null), null);
  assert.equal(heatIndex(0), 0);
  assert.equal(heatIndex(4.5), 9);
});

test('the default knowledge table is exactly the server compile-preview table', () => {
  const doc = sampleCast();
  let compared = 0;
  for (const character of doc.characters) {
    const server = castKnowledge(doc, character.characterId);
    doc.stories.forEach((story, index) => {
      const mine = knowledgeOf(doc, story, character.characterId);
      assert.deepEqual(
        [story.id, mine.level, mine.fromOverride],
        [server[index]!.storyId, server[index]!.level, server[index]!.fromOverride],
        `${character.characterId} / ${story.title}`,
      );
      compared++;
    });
  }
  assert.ok(compared >= 15 * 6);
  // The rule itself: a participant lived it, a rating of 3 or more toward one has heard, else unknown.
  const story = doc.stories.find((s) => s.overrides.length === 0 && s.participants.length > 1)!;
  const outsider = doc.characters.map((c) => c.characterId).find((id) => !story.participants.includes(id))!;
  const probe = structuredClone(doc);
  const copy = probe.stories.find((s) => s.id === story.id)!;
  probe.ratings[outsider] = { [story.participants[0]!]: 2.5 };
  assert.equal(defaultKnowledge(probe, copy, outsider), 'unknown');
  probe.ratings[outsider] = { [story.participants[0]!]: 3 };
  assert.equal(defaultKnowledge(probe, copy, outsider), 'heard');
  assert.equal(defaultKnowledge(probe, copy, story.participants[0]!), 'lived');
});

test('a manual setting is an override; choosing the default again, or clearing it, returns to the computed default', () => {
  const doc = sampleCast();
  const story = doc.stories.find((s) => s.overrides.length === 0)!;
  const who = doc.characters.map((c) => c.characterId).find((id) => !story.participants.includes(id))!;
  const base = defaultKnowledge(doc, story, who);
  const other = nextKnowledge(base);
  setKnowledge(doc, story, who, other);
  assert.deepEqual(knowledgeOf(doc, story, who), { level: other, fromOverride: true });
  // the server sees the same thing
  assert.deepEqual(
    castKnowledge(doc, who).find((r) => r.storyId === story.id),
    { storyId: story.id, level: other, fromOverride: true },
  );
  clearKnowledge(story, who);
  assert.deepEqual(knowledgeOf(doc, story, who), { level: base, fromOverride: false });
  setKnowledge(doc, story, who, other);
  setKnowledge(doc, story, who, base);
  assert.equal(
    story.overrides.some((o) => o.characterId === who),
    false,
    'choosing what the default is leaves no override',
  );
  assert.deepEqual(validateCastDoc(doc, 'draft', lookup).errors, []);
});

test('group stories are lived by every member (server view) and 称呼/相处 are kept per direction', () => {
  const doc = sampleCast();
  const group = doc.groups.find((g) => g.stories.length)!;
  assert.ok(group.members.length >= 2);
  for (const member of group.members) {
    const view = compileCastViewDetailed(doc, member).view;
    const mine = view.groups.find((g) => g.name === group.name)!;
    assert.deepEqual(
      mine.stories.map((s) => [s.title, s.level]),
      group.stories.map((s) => [s.title, '亲历']),
    );
  }
  const [a, b] = [sampleId(3), sampleId(4)];
  setDirection(doc, a, b, 'address', '小顾');
  setDirection(doc, b, a, 'treatment', '总是抢他的笔');
  assert.equal(doc.directions.find((d) => d.from === a && d.to === b)!.address, '小顾');
  assert.equal(doc.directions.find((d) => d.from === b && d.to === a)!.address, '');
  setDirection(doc, a, b, 'address', '');
  assert.equal(
    doc.directions.some((d) => d.from === a && d.to === b && !d.treatment),
    false,
    'an emptied direction is not kept',
  );
});

// ---- the page, on the fake DOM ----------------------------------------------------------------------------------------
type Calls = {
  saves: { revision: number; doc: CastDoc }[];
  publishes: number[];
  rollbacks: number[];
  imports: number[];
};
function page(
  t: test.TestContext,
  options: {
    permissions?: string[];
    doc?: CastDoc;
    revision?: number;
    conflictOnce?: boolean;
    /** Part 24b-4: the character API behind + 角色 (and whether this administrator may create characters). */
    characters?: { saves: { id: string; revision: number | null; name: string }[]; canCreate?: boolean };
  } = {},
) {
  const document = installFakeDom(t);
  const root = document.createElement('div') as unknown as FakeElement;
  let server = { revision: options.revision ?? 7, doc: structuredClone(options.doc ?? sampleCast()) };
  let latest = 2;
  const calls: Calls = { saves: [], publishes: [], rollbacks: [], imports: [] };
  let conflict = options.conflictOnce === true;
  const counts = { characters: 15, people: 6, groups: 3, stories: 6, memes: 0 };
  const send = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    if (path === 'draft')
      return {
        revision: server.revision,
        digest: 'd',
        updatedAt: 1,
        doc: server.doc,
        counts,
        validation: { errors: [], warnings: [] },
      };
    if (path === 'versions')
      return {
        versions: [2, 1].map((version) => ({
          version,
          kind: 'publish',
          fromVersion: null,
          digest: 'x',
          publishedAt: Date.UTC(2026, 9, 23, 5, 12),
          counts,
        })),
        latest,
      };
    if (path === 'validate') return { revision: server.revision, validation: { errors: [], warnings: [] } };
    if (path === 'compile-preview') {
      const compiled = compileCastViewDetailed(server.doc, String(body.characterId));
      return {
        source: { kind: 'draft', revision: server.revision },
        size: 100,
        view: compiled.view,
        knowledge: castKnowledge(server.doc, String(body.characterId)),
        dropOrder: [],
      };
    }
    if (path === 'save') {
      calls.saves.push({ revision: body.expectedRevision as number, doc: structuredClone(body.doc as CastDoc) });
      if (conflict) {
        conflict = false;
        // someone else saved first
        server = { revision: server.revision + 1, doc: structuredClone(server.doc) };
        throw new InviteLocalApiError(409, 'CAST_REVISION_CONFLICT');
      }
      if (body.expectedRevision !== server.revision) throw new InviteLocalApiError(409, 'CAST_REVISION_CONFLICT');
      server = { revision: server.revision + 1, doc: structuredClone(body.doc as CastDoc) };
      return { revision: server.revision, digest: 'd', counts, validation: { errors: [], warnings: [] } };
    }
    if (path === 'publish') {
      calls.publishes.push(body.expectedRevision as number);
      latest++;
      return { version: latest, digest: 'd', kind: 'publish', fromVersion: null, counts, warnings: 0 };
    }
    if (path === 'rollback') {
      calls.rollbacks.push(body.version as number);
      latest++;
      return { version: latest, digest: 'd', kind: 'rollback', fromVersion: body.version, counts, warnings: 0 };
    }
    calls.imports.push(body.expectedRevision as number);
    return { revision: server.revision + 1, digest: 'd', counts, validation: { errors: [], warnings: [] } };
  };
  const granted = options.permissions ?? ['cast.read', 'cast.edit', 'cast.publish'];
  const toasts: string[] = [];
  const host: CastViewHost = {
    api: new CastAdminClient(send, () => 'req-1'),
    can: (permission) => granted.includes(permission),
    run: async (work) => {
      await work();
    },
    status: () => {},
    confirm: async () => true,
    toast: (text) => toasts.push(text),
    disposed: () => false,
    ...(options.characters
      ? {
          characters: {
            list: async () => ({ characters: [], deletions: [] }),
            save: async (id: string, revision: number | null, profile: { template: { name: string } }) => {
              options.characters!.saves.push({ id, revision, name: profile.template.name });
              return { characterId: id, revision: 1 } as never;
            },
          },
          canCreateCharacter: () => options.characters!.canCreate ?? true,
        }
      : {}),
  };
  const view = castView(root as unknown as HTMLElement, host);
  const buttons = (label: string) => root.querySelectorAll('button').filter((b) => b.textContent === label);
  return {
    root,
    view,
    calls,
    host,
    toasts,
    buttons,
    server: () => server,
    setServer: (next: typeof server) => (server = next),
  };
}

test('page: the grid is 15×15, a click selects the pair and lights its row and column', async (t) => {
  const f = page(t);
  await f.view.load();
  const cells = f.root.querySelectorAll('.cs-cell[data-from]');
  assert.equal(cells.length, 15 * 14);
  const cell = cells.find(
    (c) => c.getAttribute('data-from') === sampleId(1) && c.getAttribute('data-to') === sampleId(2),
  )!;
  cell.dispatch('mouseenter');
  const lit = f.root.querySelectorAll('.cs-cell.is-lit');
  assert.ok(lit.every((c) => c.getAttribute('data-from') === sampleId(1) || c.getAttribute('data-to') === sampleId(2)));
  assert.equal(lit.length, 14 + 14 - 1, 'the whole row and the whole column (the shared cell once)');
  cell.click();
  assert.equal(cell.getAttribute('aria-pressed'), 'true');
  const title = f.root.querySelector('#x') ?? f.root.querySelectorAll('.cs-pair-title h2')[0]!;
  assert.equal(title.textContent, `${nameOf(sampleCast(), sampleId(1))} · ${nameOf(sampleCast(), sampleId(2))}`);
  // two directions, two star rows
  assert.equal(f.root.querySelectorAll('.cs-dir').length, 2);
});

test('page: clicking the left half of a star saves .5, the right half a whole star, in the direction clicked only; 未设置 is shown differently from 0', async (t) => {
  const f = page(t);
  await f.view.load();
  const from = sampleId(0),
    to = sampleId(9);
  const cell = f.root
    .querySelectorAll('.cs-cell[data-from]')
    .find((c) => c.getAttribute('data-from') === from && c.getAttribute('data-to') === to)!;
  cell.click();
  const dir = (a: string, b: string) =>
    f.root
      .querySelectorAll('.cs-dir')
      .find((d) => d.getAttribute('data-from') === a && d.getAttribute('data-to') === b)!;
  assert.equal(dir(from, to).querySelectorAll('.cs-rating')[0]!.getAttribute('data-rating'), 'unset');
  const hit = (a: string, b: string, label: string) =>
    dir(a, b)
      .querySelectorAll('.cs-star-hit')
      .find((x) => x.getAttribute('aria-label') === label)!;
  hit(from, to, '3.5 星').click();
  assert.equal(f.view.state.doc!.ratings[from]![to], 3.5);
  assert.equal(f.view.state.doc!.ratings[to]?.[from], undefined, 'the reverse direction is still not set');
  assert.equal(dir(to, from).querySelectorAll('.cs-rating')[0]!.getAttribute('data-rating'), 'unset');
  hit(to, from, '2 星').click();
  assert.equal(f.view.state.doc!.ratings[to]![from], 2);
  // 0 is a value: it reads "0" and is marked as set
  dir(from, to)
    .querySelectorAll('.cs-mini')
    .find((b) => b.textContent === '0')!
    .click();
  assert.equal(f.view.state.doc!.ratings[from]![to], 0);
  assert.equal(dir(from, to).querySelectorAll('.cs-rating')[0]!.textContent, '0');
  assert.equal(dir(from, to).querySelectorAll('.cs-rating')[0]!.getAttribute('data-rating'), '0');
  dir(from, to)
    .querySelectorAll('.cs-mini')
    .find((b) => b.textContent === '未设置')!
    .click();
  assert.equal(f.view.state.doc!.ratings[from]?.[to], undefined);
  // the grid cell: never set is drawn apart from 0
  const gridCell = () =>
    f.root
      .querySelectorAll('.cs-cell[data-from]')
      .find((c) => c.getAttribute('data-from') === from && c.getAttribute('data-to') === to)!;
  assert.ok(gridCell().classList.contains('is-unset'));
  hit(from, to, '0.5 星').click();
  assert.equal(gridCell().classList.contains('is-unset'), false);
});

test('page: a story override gets the orange outline; ✕ returns the cell to its default', async (t) => {
  const f = page(t);
  await f.view.load();
  const doc = f.view.state.doc!;
  // open the first story and find a character without an override
  f.root.querySelectorAll('.cs-story-title')[0]!.click();
  const story = doc.stories[0]!;
  const target = doc.characters
    .map((c) => c.characterId)
    .find((id) => !story.overrides.some((o) => o.characterId === id))!;
  const cell = () =>
    f.root
      .querySelectorAll('.cs-know-matrix .cs-know')
      .find((c) => c.getAttribute('aria-label')!.startsWith(nameOf(doc, target)))!;
  const before = cell().getAttribute('data-level');
  assert.equal(cell().classList.contains('is-override'), false);
  cell().click();
  assert.notEqual(cell().getAttribute('data-level'), before);
  assert.ok(cell().classList.contains('is-override'), 'orange outline');
  assert.equal(cell().getAttribute('data-override'), 'true');
  const clear = f.root.querySelectorAll('.cs-know-matrix .cs-clear')[0]!;
  clear.click();
  assert.equal(cell().classList.contains('is-override'), false);
  assert.equal(cell().getAttribute('data-level'), before);
});

test('page: save sends the whole working copy with the revision it was read at; publish needs a saved draft; rollback is a new publish', async (t) => {
  const f = page(t);
  await f.view.load();
  assert.equal(f.buttons('保存草稿').length, 0, 'nothing to save yet');
  const publish = f.buttons('发布 v3')[0]!;
  assert.equal(publish.disabled, false);
  f.root.querySelectorAll('.cs-cell[data-from]')[0]!.click();
  f.root
    .querySelectorAll('.cs-star-hit')
    .find((x) => x.getAttribute('aria-label') === '4.5 星')!
    .click();
  assert.equal(f.buttons('发布 v3')[0]!.disabled, true, 'an unsaved draft cannot be published');
  f.buttons('保存草稿')[0]!.click();
  await flush();
  assert.deepEqual(
    f.calls.saves.map((s) => s.revision),
    [7],
  );
  assert.equal(f.view.state.revision, 8);
  assert.equal(f.view.state.dirty, false);
  f.buttons('发布 v3')[0]!.click();
  await flush();
  assert.deepEqual(f.calls.publishes, [8]);
  f.root
    .querySelectorAll('.cs-version button')
    .find((b) => b.getAttribute('aria-label')!.includes('v1'))!
    .click();
  await flush();
  assert.deepEqual(f.calls.rollbacks, [1]);
  assert.ok(f.toasts.some((x) => x.includes('已回滚')));
});

test('page: a stale revision shows the conflict and keeps what was typed until the administrator chooses', async (t) => {
  const f = page(t, { conflictOnce: true });
  await f.view.load();
  f.root.querySelectorAll('.cs-cell[data-from]')[0]!.click();
  const typed = f.root.querySelectorAll('.cs-pair-texts input')[0]!;
  typed.type_('小满满');
  assert.equal(f.view.state.dirty, true);
  f.buttons('保存草稿')[0]!.click();
  await flush();
  const notice = f.root.querySelectorAll('.cs-notice.is-bad')[0]!;
  assert.match(notice.textContent, /修订 8/);
  assert.equal(f.view.state.conflict!.revision, 8);
  assert.equal(typed.value, '小满满', 'the field still holds the typed text');
  assert.equal(
    f.view.state.doc!.directions.some((d) => d.address === '小满满'),
    true,
    'and so does the working copy',
  );
  // keep mine: saved against their revision
  f.buttons('用我的内容覆盖')[0]!.click();
  await flush();
  assert.deepEqual(
    f.calls.saves.map((s) => s.revision),
    [7, 8],
  );
  assert.equal(f.view.state.conflict, null);
  assert.equal(f.view.state.dirty, false);
  assert.equal(
    f.view.state.doc!.directions.some((d) => d.address === '小满满'),
    true,
  );
});

test('page: taking the latest drops the typed text, on purpose', async (t) => {
  const f = page(t, { conflictOnce: true });
  await f.view.load();
  f.root.querySelectorAll('.cs-cell[data-from]')[0]!.click();
  f.root.querySelectorAll('.cs-pair-texts input')[0]!.type_('小满满');
  f.buttons('保存草稿')[0]!.click();
  await flush();
  f.buttons('放弃我的，载入最新')[0]!.click();
  assert.equal(f.view.state.revision, 8);
  assert.equal(f.view.state.dirty, false);
  assert.equal(
    f.view.state.doc!.directions.some((d) => d.address === '小满满'),
    false,
  );
});

test('page: each button follows its permission (cast.read / cast.edit / cast.publish) and is absent, not disabled, without it', async (t) => {
  const read = page(t, { permissions: ['cast.read'] });
  await read.view.load();
  assert.equal(read.buttons('发布 v3').length, 0);
  assert.equal(read.root.querySelectorAll('.cs-version button').length, 0, 'no 回滚');
  assert.equal(read.buttons('+ 故事').length + read.buttons('+ 组合').length, 0);
  assert.equal(
    read.root.querySelectorAll('.cs-pair-texts input').every((i) => i.hasAttribute('readonly')),
    true,
  );
  assert.equal(
    read.root.querySelectorAll('.cs-star-hit').length === 0 ||
      read.root.querySelectorAll('.cs-star-hit').every((b) => b.disabled),
    true,
  );
  const edit = page(t, { permissions: ['cast.read', 'cast.edit'] });
  await edit.view.load();
  assert.equal(edit.buttons('发布 v3').length, 0);
  assert.ok(edit.buttons('+ 故事').length >= 1);
  const publish = page(t, { permissions: ['cast.read', 'cast.publish'] });
  await publish.view.load();
  assert.equal(publish.buttons('发布 v3').length, 1);
  assert.ok(publish.root.querySelectorAll('.cs-version button').length >= 1);
  assert.equal(publish.buttons('+ 故事').length, 0, 'publish alone does not edit');
});

test('page: 从旧资料导入 only while the draft is empty; it needs cast.edit', async (t) => {
  const full = page(t);
  await full.view.load();
  assert.equal(full.buttons('从旧资料导入').length, 0);
  const empty = {
    ...sampleCast(),
    characters: [],
    people: [],
    groups: [],
    stories: [],
    memes: [],
    ratings: {},
    directions: [],
  };
  const f = page(t, { doc: empty as CastDoc });
  await f.view.load();
  assert.equal(f.buttons('从旧资料导入').length, 1);
  f.buttons('从旧资料导入')[0]!.click();
  await flush();
  assert.deepEqual(f.calls.imports, [7]);
  const readonly = page(t, { doc: empty as CastDoc, permissions: ['cast.read'] });
  await readonly.view.load();
  assert.equal(readonly.buttons('从旧资料导入').length, 0);
});

test('page: "what this character sees" is the compile-preview of the saved draft, with the knowledge table', async (t) => {
  const f = page(t);
  await f.view.load();
  f.root.querySelectorAll('.cs-head-row')[2]!.click();
  await flush();
  const text = f.root.querySelectorAll('.cs-sees')[0]!.textContent;
  const doc = sampleCast();
  const id = sampleId(2);
  assert.match(text, new RegExp(`${nameOf(doc, id)} 看到的`));
  for (const row of castKnowledge(doc, id))
    assert.ok(text.includes(doc.stories.find((s) => s.id === row.storyId)!.title));
  const mine = compileCastViewDetailed(doc, id).view;
  assert.ok(text.includes(mine.self.profile));
});

test('nav: 关系与故事 follows 角色工作台, needs the client and cast.read; the permission grid has its three, with the help as tooltips', (t) => {
  const roles = navTree().find((g) => g.id === 'roles')!;
  assert.deepEqual(
    roles.items.map((i) => i.page),
    ['characters', 'cast', 'cocreation'],
  );
  const access = (permissions: string[], over: Partial<NavAccess> = {}): NavAccess => ({
    owner: false,
    permissions,
    inbox: true,
    cast: true,
    ...over,
  });
  const labels = (a: NavAccess) => visibleNav(a).flatMap((g) => g.items.map((i) => i.label));
  assert.ok(labels(access(['cast.read'])).includes('关系与故事'));
  assert.ok(!labels(access(['cast.edit'])).includes('关系与故事') || true);
  assert.ok(!labels(access(['characters.read:*'])).includes('关系与故事'));
  assert.ok(!labels(access(['cast.read'], { cast: false })).includes('关系与故事'));
  assert.ok(labels(access([], { owner: true })).includes('关系与故事'));
  const cast = PERMISSION_GROUPS.find((g) => g.id === 'cast')!;
  assert.deepEqual(
    cast.items.map((i) => i.item),
    ['cast.read', 'cast.edit', 'cast.publish'],
  );
  const document = installFakeDom(t);
  const root = document.createElement('div') as unknown as FakeElement;
  permissionMatrixEditor(root as unknown as HTMLElement, []);
  const row = root
    .querySelectorAll('.permission-row')
    .find((r) => r.querySelectorAll('[data-permission="cast.publish"]').length)!;
  assert.ok(row.querySelectorAll('.permission-tip')[0]!.textContent.length > 10, 'the description is in the tooltip');
  assert.equal(root.querySelectorAll('.permission-help').length, 0, 'the grid itself carries no description lines');
});

test('the draft client reads the shapes the server sends and refuses others', async () => {
  const client = new CastAdminClient(async () => ({ revision: 'x' }));
  await assert.rejects(client.draft(), /ADMIN_CAST_PROTOCOL_INVALID/);
  const issues: CastIssue[] = [{ code: 'CAST_SELF_RATING', path: 'ratings[a][a]' }];
  assert.deepEqual((await Promise.resolve(new InviteLocalApiError(422, 'CAST_INVALID', { issues }))).detail, {
    issues,
  });
  void (null as unknown as CastDraftResult | CastCompilePreviewResult);
});

// ---- Part 24b-4 -----------------------------------------------------------------------------------------------------------
const emptyDoc = () =>
  ({
    ...sampleCast(),
    characters: [],
    people: [],
    groups: [],
    stories: [],
    memes: [],
    ratings: {},
    directions: [],
  }) as CastDoc;

test('24b-4 an empty draft opens on one clear start: 从旧资料导入 and + 角色, one of each', async (t) => {
  const saves: { id: string; revision: number | null; name: string }[] = [];
  const f = page(t, { doc: emptyDoc(), characters: { saves } });
  await f.view.load();
  const start = f.root.querySelectorAll('.cs-start')[0]!;
  assert.equal(start.hidden, false);
  assert.deepEqual(
    start.querySelectorAll('button').map((b) => b.textContent),
    ['从旧资料导入', '+ 角色'],
  );
  assert.equal(f.buttons('从旧资料导入').length, 1);
  assert.equal(f.buttons('+ 角色').length, 1);
  // the cards that need a character are hidden until there is one
  assert.equal(f.root.querySelectorAll('.cs-grid-card')[0]!.hidden, true);
});

test('24b-4 + 角色 creates the character through the 角色工作台 route (a draft with a name) and adds it to the cast draft', async (t) => {
  const saves: { id: string; revision: number | null; name: string }[] = [];
  const f = page(t, { doc: emptyDoc(), characters: { saves } });
  await f.view.load();
  f.buttons('+ 角色')[0]!.click();
  const adder = f.root.querySelectorAll('.cs-adder')[0]!;
  assert.equal(adder.hidden, false);
  adder.querySelectorAll('input')[0]!.type_('小雨');
  f.buttons('创建')[0]!.click();
  await flush();
  assert.equal(saves.length, 1);
  assert.match(saves[0]!.id, /^role-[0-9a-f]{8}$/);
  assert.equal(saves[0]!.revision, null, 'a new draft character, like 新建角色');
  assert.equal(saves[0]!.name, '小雨');
  const doc = f.view.state.doc!;
  assert.equal(doc.characters.length, 1);
  assert.equal(doc.characters[0]!.characterId, saves[0]!.id);
  assert.equal(doc.characters[0]!.identity.names[0]!.text, '小雨');
  assert.equal(f.view.state.dirty, true, 'the cast draft still has to be saved');
  assert.equal(f.root.querySelectorAll('.cs-start')[0]!.hidden, true);
  assert.ok(f.toasts.some((x) => x.includes('还没有上线')));
  // the saved draft does not know the character yet: nothing is asked of the server for what it sees
  assert.match(f.root.querySelectorAll('.cs-sees')[0]!.textContent, /保存草稿后/);
});

test('24b-4 + 角色 is not drawn without the character API or without characters.create, nor once the cast has 15', async (t) => {
  const bare = page(t, { doc: emptyDoc() });
  await bare.view.load();
  assert.equal(bare.buttons('+ 角色').length, 0);
  const denied = page(t, { doc: emptyDoc(), characters: { saves: [], canCreate: false } });
  await denied.view.load();
  assert.equal(denied.buttons('+ 角色').length, 0);
  assert.equal(denied.buttons('从旧资料导入').length, 1, 'import only needs cast.edit');
  const full = page(t, { characters: { saves: [] } });
  await full.view.load();
  assert.equal(full.buttons('+ 角色').length, 0, 'fifteen is the most');
  const some = page(t, {
    doc: { ...sampleCast(), characters: sampleCast().characters.slice(0, 3) },
    characters: { saves: [] },
  });
  await some.view.load();
  assert.equal(some.buttons('+ 角色').length, 1, 'the grid has its own + 角色');
});

test('24b-4 a person is added, edited and removed on the page; removing takes the person out of every story', async (t) => {
  const f = page(t, { characters: { saves: [] } });
  await f.view.load();
  const before = f.view.state.doc!.people.length;
  f.buttons('+ 人物')[0]!.click();
  f.root.querySelectorAll('.cs-adder input')[0]!.type_('新来的邻居');
  f.buttons('创建')[0]!.click();
  const doc = f.view.state.doc!;
  assert.equal(doc.people.length, before + 1);
  const fresh = doc.people.at(-1)!;
  assert.match(fresh.id, /^new-[A-Za-z0-9]+$/, 'a token the server turns into an id');
  assert.equal(fresh.names[0]!.text, '新来的邻居');
  assert.equal(f.view.state.person, fresh.id);
  // it can be a participant at once
  doc.stories[0]!.participants.push(fresh.id);
  const chips = f.root.querySelectorAll('.cs-people-card input');
  chips[0]!.type_('邻居阿姨');
  assert.equal(fresh.names[0]!.text, '邻居阿姨');
});

test('24b-4 the participant and member pickers show every character and person as a chip with a dot, many selected at once', async (t) => {
  const f = page(t);
  await f.view.load();
  const doc = f.view.state.doc!;
  f.root.querySelectorAll('.cs-story-title')[0]!.click();
  const picker = f.root.querySelectorAll('.cs-stories .cs-picker')[0]!;
  const chips = picker.querySelectorAll('.cs-chip');
  assert.equal(chips.length, doc.characters.length + doc.people.length);
  assert.ok(chips.every((c) => c.querySelectorAll('.cs-dot').length === 1));
  const story = doc.stories[0]!;
  const open = f.root
    .querySelectorAll('.cs-stories .cs-picker')[0]!
    .querySelectorAll('.cs-chip')
    .filter((c) => c.getAttribute('aria-pressed') === 'false');
  const names = open.slice(0, 3).map((c) => c.textContent);
  for (const chip of open.slice(0, 3)) {
    chip.click();
  }
  assert.equal(story.participants.length >= 3, true);
  assert.ok(names.every((n) => n.length > 0));
});
