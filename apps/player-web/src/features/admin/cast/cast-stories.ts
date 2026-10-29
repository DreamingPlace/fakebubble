import {
  CAST_LIMITS,
  type CastGroup,
  type CastGroupStory,
  type CastKnowledge,
  type CastPeriod,
  type CastPerson,
  type CastStory,
} from '../../../../../../packages/contracts/web-cast.ts';
import { h } from '../../cocreation/h.ts';
import { dangerZone } from '../ui/danger-zone.ts';
import { hoverValue } from '../ui/hover-value.ts';
import { openTable } from '../ui/open-table.ts';
import { markDirty } from '../ui/unsaved.ts';
import {
  HEARD_RATING,
  KNOWLEDGE_LABEL,
  blankGroup,
  blankGroupStory,
  blankPerson,
  clearKnowledge,
  knowledgeOf,
  nextKnowledge,
  ratingOf,
  removePerson,
  setKnowledge,
} from './cast-model.ts';
import { bound, dot, picker, type CastCtx } from './cast-ui.ts';

export type StoryState = {
  /** The open 组合 (its key), or null when none is open. */
  group: string | null;
  /** 组合 shows every group (true) or only those that hold all the selected people. */
  groupsAll: boolean;
  /** Index into doc.stories of the story open below. */
  story: number | null;
  /** The id of the person (a non-chat 人物) being edited in the 世界 card. */
  person: string | null;
  /** The character whose name card is open. */
  sel: string | null;
  /** The cell open in the grid. */
  pair: [string, string] | null;
  lit: string[] | null;
};

const L = CAST_LIMITS;
const take = <T>(list: T[], item: T) => list.splice(list.indexOf(item), 1);
const add = (text: string, onClick: () => void, className = 'cs-add') => {
  const button = h('button', { class: className, text, attrs: { type: 'button' } });
  button.addEventListener('click', onClick);
  return button;
};
const period = (ctx: CastCtx, value: CastPeriod, base: CastPeriod | null) =>
  [
    bound(ctx, '开始', () => value.start, (v) => (value.start = v), { max: L.storyPeriod, placeholder: '2024-05' }),
    bound(ctx, '结束', () => value.end, (v) => (value.end = v), { max: L.storyPeriod, placeholder: '可空' }),
  ].map((field, i) => {
    const key = i === 0 ? 'start' : 'end';
    field.input.addEventListener('input', () => markDirty(field.input, !!base && field.input.value !== base[key]));
    return field.wrap;
  });

/** Why a character knows a story at the level shown: the hover of a 谁知道 cell. */
export function knowledgeReason(ctx: CastCtx, story: CastStory, characterId: string) {
  const doc = ctx.doc();
  const known = knowledgeOf(doc, story, characterId);
  const who = ctx.nameOf(characterId);
  if (known.fromOverride) return `${who}：${KNOWLEDGE_LABEL[known.level]}（手动设置）· 再点几下回到自动那一档就恢复自动`;
  if (known.level === 'lived') return `${who}：亲历 · 他是这个故事的参与者`;
  if (known.level === 'heard') {
    const row = doc.ratings[characterId] ?? {};
    const friend = story.participants.find((id) => id !== characterId && (row[id] ?? -1) >= HEARD_RATING);
    return `${who}：听说 · 他对${friend ? ctx.nameOf(friend) : '参与者'}评了 ${friend ? ratingOf(doc, characterId, friend) : HEARD_RATING} 星（≥ ${HEARD_RATING}）`;
  }
  return `${who}：不知道 · 不是参与者，也没有对参与者评到 ${HEARD_RATING} 星`;
}

/** 组合: only the groups that hold ALL the selected people (or every group), each a row that opens below. */
export function groupsPanel(host: HTMLElement, ctx: CastCtx, state: StoryState) {
  const keys = new WeakMap<CastGroup, string>();
  let counter = 0;
  const keyOf = (group: CastGroup) => {
    let key = keys.get(group);
    if (!key) keys.set(group, (key = `g${++counter}`));
    return key;
  };
  const selected = () => (state.pair ? [...state.pair] : state.sel ? [state.sel] : []);
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    const edit = ctx.canEdit();
    const who = selected();
    const holds = (group: CastGroup) => who.every((id) => group.members.includes(id));
    const shown = state.groupsAll || !who.length ? doc.groups : doc.groups.filter(holds);
    const names = who.map((id) => ctx.nameOf(id)).join('、');
    const toggle = who.length
      ? add(state.groupsAll ? `只看有${names}的` : `全部 ${doc.groups.length} 个`, () => {
          state.groupsAll = !state.groupsAll;
          ctx.paint('groups');
        }, 'cs-quiet')
      : null;
    const create =
      edit && doc.groups.length < L.groups
        ? add(who.length ? `+ 用 ${names} 建组合` : '+ 组合', () => {
            const group = blankGroup([...who]);
            doc.groups.push(group);
            state.group = keyOf(group);
            ctx.edited();
            ctx.paint('groups', 'grid');
          }, 'cs-add is-tint')
        : null;
    const table = openTable<CastGroup>({
      label: '组合',
      rowKey: keyOf,
      emptyText: who.length ? '还没有同时有他们的组合' : '还没有组合',
      className: 'cs-groups-table',
      hover: (group) => {
        state.lit = group ? [...group.members] : null;
        ctx.light();
      },
      onToggle: (key) => {
        state.group = key;
      },
      columns: [
        { key: 'name', label: '组合', width: '140px', cell: (g) => h('b', { text: g.name || '（未命名）' }) },
        {
          key: 'members',
          label: '成员',
          width: '180px',
          cell: (g) => h('span', { class: 'cs-stack' }, ...g.members.map((id) => hoverValue(dot(ctx.colour(id), 12), ctx.nameOf(id)))),
        },
        { key: 'bg', label: '背景', cell: (g) => g.background || '—' },
        { key: 'n', label: '故事', width: '90px', align: 'end', cell: (g) => `${g.stories.length} 个故事` },
      ],
      detail: (group) => groupDetail(group),
    });
    table.setRows(shown);
    if (state.group) {
      const open = shown.find((g) => keyOf(g) === state.group);
      if (open) table.open(state.group);
      else state.group = null;
    }
    host.append(
      h('div', { class: 'cs-card-head' }, h('h2', {}, '组合', h('span', { class: 'cs-sub', text: who.length ? `同时有 ${names} 的` : '' })), h('span', { class: 'cs-actions' }, toggle, create)),
      table.root,
    );
  };
  const groupDetail = (group: CastGroup): HTMLElement => {
    const doc = ctx.doc();
    const base = ctx.base().groups.find((g) => g.id && g.id === group.id) ?? null;
    const edit = ctx.canEdit();
    const left = h('div', { class: 'cs-g-left' });
    const name = bound(ctx, '组合名', () => group.name, (v) => (group.name = v), { max: L.groupName });
    name.input.addEventListener('input', () => markDirty(name.input, !base || name.input.value !== base.name));
    left.append(
      name.wrap,
      picker(ctx, '成员', group.members, { people: false, max: L.groupMembers, after: () => ctx.paint('groups', 'grid') }),
      bound(ctx, '组合背景', () => group.background, (v) => (group.background = v), { max: L.groupBackground }).wrap,
    );
    if (edit)
      left.append(
        dangerZone({
          open: '删除组合',
          impact: () => [{ n: String(group.stories.length), label: '个组合故事一起删除' }],
          confirm: '确认删除',
          run: async () => {
            take(doc.groups, group);
            state.group = null;
            ctx.edited();
            ctx.paint('groups', 'grid');
          },
        }).root,
      );
    const right = h('div', { class: 'cs-g-right' }, h('span', { class: 'cs-label', text: '组合故事 · 成员全都亲历' }));
    for (const story of group.stories) right.append(groupStoryEditor(ctx, group, story));
    if (!group.stories.length) right.append(h('span', { class: 'cs-hint-line', text: '还没有' }));
    if (edit && group.stories.length < L.groupStories)
      right.append(
        add('+ 组合故事', () => {
          group.stories.push(blankGroupStory());
          ctx.edited();
          ctx.paint('groups');
        }, 'cs-dashed'),
      );
    return h('div', { class: 'ot-detail cs-g-detail' }, left, right);
  };
  return { paint };
}

function groupStoryEditor(ctx: CastCtx, group: CastGroup, story: CastGroupStory) {
  const card = h('div', { class: 'cs-gstory' });
  const title = bound(ctx, '标题', () => story.title, (v) => (story.title = v), { max: L.storyTitle });
  const [start, end] = period(ctx, story.period, null);
  card.append(
    title.wrap,
    start!,
    end!,
    bound(ctx, '摘要', () => story.summary, (v) => (story.summary = v), { max: L.storySummary }).wrap,
    bound(ctx, '叙述边界', () => story.boundary, (v) => (story.boundary = v), { max: L.storyBoundary }).wrap,
    bound(ctx, '细节（亲历者才知道）', () => story.details, (v) => (story.details = v), { max: L.storyDetails }).wrap,
  );
  if (ctx.canEdit())
    card.append(
      dangerZone({
        open: '删除这个组合故事',
        confirm: '确认删除',
        run: async () => {
          take(group.stories, story);
          ctx.edited();
          ctx.paint('groups');
        },
      }).root,
    );
  return card;
}

const LEVEL_CLASS: Record<CastKnowledge, string> = { lived: 'is-lived', heard: 'is-heard', unknown: 'is-unknown' };

/**
 * One story, open BELOW the grid over the full width. Left: title, period, summary, details, boundary. Right: the participants
 * (click names, characters and people, any number) and 谁知道, computed and clickable: an orange outline is a manual setting, and
 * hovering says why a character knows what they know.
 */
export function storyPanel(host: HTMLElement, ctx: CastCtx, state: StoryState) {
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    const story: CastStory | null = state.story === null ? null : (doc.stories[state.story] ?? null);
    host.hidden = !story;
    if (!story) {
      state.story = null;
      return;
    }
    const edit = ctx.canEdit();
    const base = ctx.base().stories.find((s) => s.id && s.id === story.id) ?? null;
    const dirtyOn = (input: HTMLInputElement | HTMLTextAreaElement, key: 'title' | 'summary' | 'details' | 'boundary') =>
      input.addEventListener('input', () => markDirty(input, !base || input.value !== base[key]));
    const title = bound(ctx, '标题', () => story.title, (v) => (story.title = v), { max: L.storyTitle });
    dirtyOn(title.input, 'title');
    const [from, to] = period(ctx, story.period, base?.period ?? null);
    const summary = bound(ctx, '摘要 · 听说的人只知道这一段', () => story.summary, (v) => (story.summary = v), { area: true, max: L.storySummary, rows: 2 });
    dirtyOn(summary.input, 'summary');
    const details = bound(ctx, '细节 · 只给亲历的人', () => story.details, (v) => (story.details = v), { area: true, max: L.storyDetails, rows: 3 });
    dirtyOn(details.input, 'details');
    const boundary = bound(ctx, '叙述边界', () => story.boundary, (v) => (story.boundary = v), { max: L.storyBoundary });
    dirtyOn(boundary.input, 'boundary');
    const close = h('button', { class: 'cs-close', text: '收起', attrs: { type: 'button' } });
    close.addEventListener('click', () => {
      state.story = null;
      ctx.paint('stories');
    });
    const left = h('div', { class: 'cs-story-left' }, h('div', { class: 'cs-fields-3' }, title.wrap, from!, to!), summary.wrap, details.wrap, boundary.wrap);
    if (edit)
      left.append(
        dangerZone({
          open: '删除这个故事',
          impact: () => [{ n: String(story.participants.length), label: '位参与者' }],
          confirm: '确认删除',
          run: async () => {
            take(doc.stories, story);
            state.story = null;
            ctx.edited();
            ctx.paint('stories', 'side', 'grid');
          },
        }).root,
      );
    const people = picker(ctx, '参与者 · 点名字加人或去掉', story.participants, {
      people: true,
      max: L.storyParticipants,
      after: () => ctx.paint('stories', 'grid', 'side'),
    });
    const matrix = h('div', { class: 'cs-know-matrix' });
    for (const id of ctx.ids()) {
      const known = knowledgeOf(doc, story, id);
      const cell = h(
        'button',
        {
          class: `cs-know ${LEVEL_CLASS[known.level]}${known.fromOverride ? ' is-override' : ''}`,
          attrs: { type: 'button', 'data-level': known.level, 'data-override': String(known.fromOverride), 'data-character': id },
        },
        h('span', { class: 'cs-know-name' }, dot(ctx.colour(id), 8), ctx.nameOf(id)),
        h('b', { class: 'cs-know-level', text: KNOWLEDGE_LABEL[known.level] }),
      );
      if (!edit) {
        cell.setAttribute('data-locked', 'true');
        cell.disabled = true;
      }
      hoverValue(cell, knowledgeReason(ctx, story, id));
      cell.addEventListener('click', () => {
        const now = knowledgeOf(doc, story, id).level;
        setKnowledge(doc, story, id, nextKnowledge(now));
        ctx.edited();
        ctx.paint('stories');
      });
      cell.addEventListener('dblclick', () => {
        clearKnowledge(story, id);
        ctx.edited();
        ctx.paint('stories');
      });
      matrix.append(cell);
    }
    const right = h(
      'div',
      { class: 'cs-story-right' },
      people,
      h('div', { class: 'cs-picker' }, h('span', { class: 'cs-label', text: '谁知道 · 自动算，点一下改，橙框是手动' }), matrix),
    );
    host.append(h('div', { class: 'cs-story-head' }, h('h2', { text: story.title || '（无标题）' }), close), h('div', { class: 'cs-story-body' }, left, right));
  };
  return { paint };
}

/**
 * 世界: ONE compact card. The background every character knows, and the world's other people as chips; a click on a chip opens it
 * for editing in one row, "+ 人" adds one. Not chat characters: they show up as chips in the story picker.
 */
export function worldPanel(host: HTMLElement, ctx: CastCtx, state: StoryState) {
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    if (state.person && !doc.people.some((p) => p.id === state.person)) state.person = null;
    const edit = ctx.canEdit();
    const base = ctx.base();
    const background = h('textarea', { attrs: { 'aria-label': '世界背景', maxlength: String(L.worldBackground), rows: '3' } });
    background.value = doc.world.background;
    if (!edit) background.setAttribute('readonly', '');
    background.addEventListener('input', () => {
      doc.world.background = background.value;
      markDirty(background, background.value !== base.world.background);
      ctx.edited(true);
    });
    markDirty(background, background.value !== base.world.background);
    const chips = h('div', { class: 'cs-people-row' }, h('span', { class: 'cs-label', text: '世界里的其他人' }));
    for (const person of doc.people) {
      const chip = h('button', { class: 'cs-chip', attrs: { type: 'button', 'aria-pressed': String(state.person === person.id) } }, dot(ctx.colour(person.id), 8), person.names[0]?.text || '（未命名）');
      hoverValue(chip, person.oneLiner || (person.kind === 'prototype' ? '原型' : '人物'));
      chip.addEventListener('click', () => {
        state.person = state.person === person.id ? null : person.id;
        ctx.paint('world');
      });
      chips.append(chip);
    }
    if (edit && doc.people.length < L.people)
      chips.append(
        add('+ 人', () => {
          const person = blankPerson('新人物');
          doc.people.push(person);
          state.person = person.id;
          ctx.edited();
          ctx.paint('world', 'stories');
        }, 'cs-dashed'),
      );
    host.append(h('div', { class: 'cs-card-head' }, h('h2', {}, '世界', h('span', { class: 'cs-sub', text: '所有角色都知道' }))), background, chips);
    const person: CastPerson | undefined = doc.people.find((p) => p.id === state.person);
    if (!person) return;
    const kind = h('select', { attrs: { 'aria-label': '类型' } });
    kind.append(h('option', { text: '人物', attrs: { value: 'person' } }), h('option', { text: '原型', attrs: { value: 'prototype' } }));
    kind.value = person.kind;
    if (!edit) kind.setAttribute('data-locked', 'true');
    kind.addEventListener('change', () => {
      person.kind = kind.value as CastPerson['kind'];
      ctx.edited();
      ctx.paint('world', 'character');
    });
    const second = () => person.names[1];
    const row = h(
      'div',
      { class: 'cs-person-row' },
      bound(ctx, '名字', () => person.names[0]?.text ?? '', (v) => { if (person.names[0]) person.names[0].text = v; }, { max: L.name, after: () => ctx.paint('world', 'stories', 'groups') }).wrap,
      bound(ctx, '另一个叫法', () => second()?.text ?? '', (v) => {
        if (v === '') person.names.splice(1);
        else if (second()) second()!.text = v;
        else person.names.push({ id: '', text: v });
      }, { max: L.name, placeholder: '可空' }).wrap,
      h('label', { class: 'cs-field' }, h('span', { text: '类型' }), kind),
      bound(ctx, '一句话', () => person.oneLiner, (v) => (person.oneLiner = v), { max: L.oneLiner }).wrap,
    );
    if (edit)
      row.append(
        dangerZone({
          open: '删除',
          impact: () => [{ n: String(doc.stories.filter((s) => s.participants.includes(person.id)).length), label: '个故事里的参与会去掉' }],
          confirm: '确认删除',
          run: async () => {
            removePerson(doc, person.id);
            state.person = null;
            ctx.edited();
            ctx.paint('world', 'stories', 'groups', 'character', 'grid');
          },
        }).root,
      );
    host.append(row);
  };
  return { paint };
}
