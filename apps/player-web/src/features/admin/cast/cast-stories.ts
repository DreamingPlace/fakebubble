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
import {
  KNOWLEDGE_LABEL,
  blankGroup,
  blankGroupStory,
  blankStory,
  clearKnowledge,
  knowledgeOf,
  nameOf,
  nextKnowledge,
  removePerson,
  setKnowledge,
} from './cast-model.ts';
import { bound, dot, picker, type CastCtx } from './cast-ui.ts';
import type { ConfirmOptions } from '../ui/confirm-dialog.ts';

export type StoryState = {
  /** Index into doc.groups of the 组合 whose editor is open. */
  group: number;
  /** Index into doc.stories of the story being edited. */
  story: number | null;
  /** The id of the person (a non-chat 人物) being edited. */
  person: string | null;
  /** The character whose knowledge the story list shows. */
  sel: string | null;
};
type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const L = CAST_LIMITS;
const period = (ctx: CastCtx, value: CastPeriod) =>
  h(
    'div',
    { class: 'cs-period' },
    bound(
      ctx,
      '时间段 开始',
      () => value.start,
      (v) => (value.start = v),
      { max: L.storyPeriod, placeholder: '2024 或 2024-05' },
    ).wrap,
    bound(
      ctx,
      '结束',
      () => value.end,
      (v) => (value.end = v),
      { max: L.storyPeriod, placeholder: '可空' },
    ).wrap,
  );

const take = <T>(list: T[], item: T) => list.splice(list.indexOf(item), 1);
const add = (text: string, onClick: () => void) => {
  const button = h('button', { class: 'cs-add', text, attrs: { type: 'button' } });
  button.addEventListener('click', onClick);
  return button;
};
const remove = (text: string, onClick: () => void) => {
  const button = h('button', { class: 'cs-danger', text, attrs: { type: 'button' } });
  button.addEventListener('click', onClick);
  return button;
};
/** A card of two panes: the list on the left (with its + button in the head), the open one's editor on the right. */
const panes = (title: string, ...headActions: (Node | null)[]) => {
  const list = h('div', { class: 'cs-pane-list' });
  const editor = h('div', { class: 'cs-pane-editor' });
  const head = h('div', { class: 'cs-card-head' }, h('h2', { text: title }), ...headActions);
  list.append(head);
  return { list, editor, head };
};

/** 组合: the list of groups (name, member dots) with + 组合, and beside it the open group's editor. */
export function groupsPanel(host: HTMLElement, ctx: CastCtx, state: StoryState, confirm: Confirm) {
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    if (state.group >= doc.groups.length) state.group = 0;
    const edit = ctx.canEdit();
    const addGroup =
      edit && doc.groups.length < L.groups
        ? add('+ 组合', () => {
            doc.groups.push(blankGroup());
            state.group = doc.groups.length - 1;
            ctx.edited();
            ctx.paint('groups');
          })
        : null;
    const { list, editor } = panes('组合', addGroup);
    const cards = h('div', { class: 'cs-groups' });
    doc.groups.forEach((group, index) => {
      const on = state.group === index;
      const card = h('button', { class: 'cs-group-card', attrs: { type: 'button', 'aria-pressed': String(on) } });
      card.append(
        h('span', { class: 'cs-group-name', text: group.name || '（未命名）' }),
        h(
          'span',
          { class: 'cs-stack' },
          ...group.members.map((id) => dot(ctx.colour(id), 14)),
          h('span', { class: 'cs-count-text', text: `${group.members.length} 人` }),
        ),
      );
      card.addEventListener('click', () => {
        state.group = index;
        ctx.paint('groups');
      });
      cards.append(card);
    });
    if (!doc.groups.length) cards.append(h('p', { class: 'cs-hint', text: '还没有组合。' }));
    list.append(cards);

    const group: CastGroup | undefined = doc.groups[state.group];
    if (!group) {
      editor.append(h('p', { class: 'cs-hint', text: '点一个组合，编辑它的成员、背景和故事。' }));
    } else {
      const head = h('div', { class: 'cs-card-head' });
      head.append(
        bound(
          ctx,
          '组合名',
          () => group.name,
          (v) => (group.name = v),
          { max: L.groupName, after: () => ctx.paint('groups') },
        ).wrap,
      );
      if (edit)
        head.append(
          remove('删除组合', () => {
            void confirm({
              title: '删除组合',
              message: `删除「${group.name}」和它的组合故事？保存草稿后才生效。`,
              confirmLabel: '删除',
              danger: true,
            }).then((yes) => {
              if (!yes) return;
              take(doc.groups, group);
              state.group = 0;
              ctx.edited();
              ctx.paint('groups');
            });
          }),
        );
      editor.append(
        head,
        picker(ctx, '成员', group.members, {
          people: false,
          max: L.groupMembers,
          after: () => ctx.paint('groups', 'grid'),
        }),
        bound(
          ctx,
          '组合背景',
          () => group.background,
          (v) => (group.background = v),
          { area: true, max: L.groupBackground, rows: 2 },
        ).wrap,
      );
      const stories = h('div', { class: 'cs-gstories' });
      stories.append(
        h(
          'div',
          { class: 'cs-card-head' },
          h('h3', { text: '组合故事（全员亲历）' }),
          edit && group.stories.length < L.groupStories
            ? add('+ 组合故事', () => {
                group.stories.push(blankGroupStory());
                ctx.edited();
                ctx.paint('groups');
              })
            : null,
        ),
      );
      for (const story of group.stories) stories.append(groupStoryEditor(ctx, group, story, confirm));
      if (!group.stories.length) stories.append(h('p', { class: 'cs-hint', text: '还没有。' }));
      editor.append(stories);
    }
    host.append(list, editor);
  };
  return { paint };
}

function groupStoryEditor(ctx: CastCtx, group: CastGroup, story: CastGroupStory, confirm: Confirm) {
  const card = h('div', { class: 'cs-gstory' });
  card.append(
    bound(
      ctx,
      '标题',
      () => story.title,
      (v) => (story.title = v),
      { max: L.storyTitle },
    ).wrap,
    period(ctx, story.period),
    bound(
      ctx,
      '摘要',
      () => story.summary,
      (v) => (story.summary = v),
      { area: true, max: L.storySummary, rows: 2 },
    ).wrap,
    bound(
      ctx,
      '叙述边界',
      () => story.boundary,
      (v) => (story.boundary = v),
      { area: true, max: L.storyBoundary, rows: 2 },
    ).wrap,
    bound(
      ctx,
      '细节（亲历者才知道）',
      () => story.details,
      (v) => (story.details = v),
      { area: true, max: L.storyDetails, rows: 2 },
    ).wrap,
  );
  if (ctx.canEdit())
    card.append(
      remove('删除', () => {
        void confirm({
          title: '删除组合故事',
          message: `删除「${story.title}」？保存草稿后才生效。`,
          confirmLabel: '删除',
          danger: true,
        }).then((yes) => {
          if (!yes) return;
          take(group.stories, story);
          ctx.edited();
          ctx.paint('groups');
        });
      }),
    );
  return card;
}

const LEVEL_CLASS: Record<CastKnowledge, string> = { lived: 'is-lived', heard: 'is-heard', unknown: 'is-unknown' };

/**
 * 故事. Left: every story with its participants and what the open character knows of it (click to cycle; an orange outline marks a
 * manual setting, ✕ returns it to the computed default). Right: the open story's text, a picker for the participants (characters
 * and people) and what each character knows of it.
 */
export function storiesPanel(host: HTMLElement, ctx: CastCtx, state: StoryState, confirm: Confirm) {
  const levelCell = (story: CastStory, characterId: string, named: boolean) => {
    const doc = ctx.doc();
    const known = knowledgeOf(doc, story, characterId);
    const wrap = h('span', { class: 'cs-know-wrap' });
    const button = h('button', {
      class: `cs-know ${LEVEL_CLASS[known.level]}${known.fromOverride ? ' is-override' : ''}`,
      text: named ? `${nameOf(doc, characterId)} ${KNOWLEDGE_LABEL[known.level]}` : KNOWLEDGE_LABEL[known.level],
      attrs: {
        type: 'button',
        'data-level': known.level,
        'data-override': String(known.fromOverride),
        'aria-label': `${nameOf(doc, characterId)} 对「${story.title}」：${KNOWLEDGE_LABEL[known.level]}${known.fromOverride ? '（手动设置）' : '（自动）'}，点击切换`,
      },
    });
    if (!ctx.canEdit()) {
      button.setAttribute('data-locked', 'true');
      button.disabled = true;
    }
    button.addEventListener('click', () => {
      setKnowledge(doc, story, characterId, nextKnowledge(known.level));
      ctx.edited();
      ctx.paint('stories');
    });
    wrap.append(button);
    if (known.fromOverride && ctx.canEdit()) {
      const clear = h('button', {
        class: 'cs-clear',
        text: '✕',
        attrs: { type: 'button', 'aria-label': `${nameOf(doc, characterId)}：恢复自动`, title: '恢复自动' },
      });
      clear.addEventListener('click', () => {
        clearKnowledge(story, characterId);
        ctx.edited();
        ctx.paint('stories');
      });
      wrap.append(clear);
    }
    return wrap;
  };
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    const sel =
      state.sel && doc.characters.some((c) => c.characterId === state.sel)
        ? state.sel
        : (doc.characters[0]?.characterId ?? null);
    state.sel = sel;
    if (state.story !== null && !doc.stories[state.story]) state.story = null;
    const addStory =
      ctx.canEdit() && doc.stories.length < L.stories
        ? add('+ 故事', () => {
            doc.stories.push(blankStory(sel ? [sel] : []));
            state.story = doc.stories.length - 1;
            ctx.edited();
            ctx.paint('stories');
          })
        : null;
    const levels = h(
      'span',
      { class: 'cs-levels' },
      ...(['lived', 'heard', 'unknown'] as const).map((l) =>
        h('span', { class: `cs-level ${LEVEL_CLASS[l]}`, text: KNOWLEDGE_LABEL[l] }),
      ),
    );
    const { list, editor } = panes(sel ? `${nameOf(doc, sel)} 知道的故事` : '故事', levels, addStory);
    const rows = h('div', { class: 'cs-story-list' });
    doc.stories.forEach((story, index) => {
      const row = h('div', { class: 'cs-story-row', attrs: { 'aria-current': String(state.story === index) } });
      const open = h('button', {
        class: 'cs-story-title',
        text: story.title || '（无标题）',
        attrs: { type: 'button' },
      });
      open.addEventListener('click', () => {
        state.story = index;
        ctx.paint('stories');
      });
      row.append(
        open,
        h(
          'span',
          { class: 'cs-stack' },
          ...story.participants.map((id) => dot(ctx.colour(id), 14)),
          h('span', { class: 'cs-count-text', text: `${story.participants.length} 人` }),
        ),
      );
      if (sel) row.append(levelCell(story, sel, false));
      rows.append(row);
    });
    if (!doc.stories.length) rows.append(h('p', { class: 'cs-hint', text: '还没有故事。' }));
    list.append(rows);

    const story = state.story === null ? null : doc.stories[state.story]!;
    if (!story) {
      editor.append(h('p', { class: 'cs-hint', text: '点一个故事，编辑它并设置谁知道。' }));
      host.append(list, editor);
      return;
    }
    editor.append(
      h(
        'div',
        { class: 'cs-fields-3' },
        bound(
          ctx,
          '标题',
          () => story.title,
          (v) => (story.title = v),
          { max: L.storyTitle, after: () => ctx.paint('stories') },
        ).wrap,
        period(ctx, story.period),
      ),
      h(
        'div',
        { class: 'cs-fields-2' },
        bound(
          ctx,
          '摘要（听说的人只知道这一段）',
          () => story.summary,
          (v) => (story.summary = v),
          { area: true, max: L.storySummary, rows: 2 },
        ).wrap,
        bound(
          ctx,
          '叙述边界',
          () => story.boundary,
          (v) => (story.boundary = v),
          { area: true, max: L.storyBoundary, rows: 2 },
        ).wrap,
      ),
      bound(
        ctx,
        '细节（只给亲历的人）',
        () => story.details,
        (v) => (story.details = v),
        { area: true, max: L.storyDetails, rows: 2 },
      ).wrap,
      picker(ctx, '参与者', story.participants, {
        people: true,
        max: L.storyParticipants,
        after: () => ctx.paint('stories'),
      }),
      h('span', { class: 'cs-label', text: '谁知道（自动 = 参与者亲历；对参与者评分 ≥ 3 星的听说）' }),
    );
    const matrix = h('div', { class: 'cs-know-matrix' });
    for (const c of doc.characters) matrix.append(levelCell(story, c.characterId, true));
    editor.append(matrix);
    if (ctx.canEdit())
      editor.append(
        remove('删除这个故事', () => {
          void confirm({
            title: '删除故事',
            message: `删除「${story.title}」？保存草稿后才生效。`,
            confirmLabel: '删除',
            danger: true,
          }).then((yes) => {
            if (!yes) return;
            take(doc.stories, story);
            state.story = null;
            ctx.edited();
            ctx.paint('stories');
          });
        }),
      );
    host.append(list, editor);
  };
  return { paint };
}

/**
 * 人物: everyone in the world who is not a chat character (a parent, a teacher, a singer a character is modelled on). Added and
 * edited here; they show up as chips in the story picker. A new one carries a `new-…` token the server turns into a real id.
 */
export function peoplePanel(host: HTMLElement, ctx: CastCtx, state: StoryState, confirm: Confirm, create: () => void) {
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    if (state.person && !doc.people.some((p) => p.id === state.person)) state.person = null;
    const edit = ctx.canEdit();
    const addPerson = edit && doc.people.length < L.people ? add('+ 人物', create) : null;
    const { list, editor } = panes('人物（不是聊天角色）', addPerson);
    const rows = h('div', { class: 'cs-people-list' });
    for (const person of doc.people) {
      const row = h('button', {
        class: 'cs-person-row',
        attrs: { type: 'button', 'aria-pressed': String(state.person === person.id) },
      });
      row.append(
        dot(ctx.colour(person.id), 12),
        h('span', { class: 'cs-person-name', text: person.names[0]?.text ?? person.id }),
        h('span', { class: 'cs-tag', text: person.kind === 'prototype' ? '原型' : '人物' }),
      );
      row.addEventListener('click', () => {
        state.person = person.id;
        ctx.paint('people');
      });
      rows.append(row);
    }
    if (!doc.people.length) rows.append(h('p', { class: 'cs-hint', text: '还没有。' }));
    list.append(rows);

    const person: CastPerson | undefined = doc.people.find((p) => p.id === state.person);
    if (!person) {
      editor.append(h('p', { class: 'cs-hint', text: '点一个人物来编辑；它会出现在故事的参与者里。' }));
      host.append(list, editor);
      return;
    }
    const kind = h('select', { attrs: { 'aria-label': '类型' } });
    kind.append(
      h('option', { text: '人物', attrs: { value: 'person' } }),
      h('option', { text: '原型（某个角色的参照）', attrs: { value: 'prototype' } }),
    );
    kind.value = person.kind;
    if (!edit) kind.setAttribute('data-locked', 'true');
    kind.addEventListener('change', () => {
      person.kind = kind.value as CastPerson['kind'];
      ctx.edited();
      ctx.paint('people');
    });
    const second = () => person.names[1];
    editor.append(
      h(
        'div',
        { class: 'cs-fields-3' },
        bound(
          ctx,
          '名字',
          () => person.names[0]?.text ?? '',
          (v) => {
            if (person.names[0]) person.names[0].text = v;
          },
          { max: L.name, after: () => ctx.paint('people', 'stories', 'groups') },
        ).wrap,
        bound(
          ctx,
          '另一个叫法（可空）',
          () => second()?.text ?? '',
          (v) => {
            if (v === '') person.names.splice(1);
            else if (second()) second()!.text = v;
            else person.names.push({ id: '', text: v });
          },
          { max: L.name },
        ).wrap,
        h('label', { class: 'cs-field' }, h('span', { text: '类型' }), kind),
      ),
      bound(
        ctx,
        '一句话',
        () => person.oneLiner,
        (v) => (person.oneLiner = v),
        { max: L.oneLiner },
      ).wrap,
    );
    if (edit)
      editor.append(
        remove('删除人物', () => {
          void confirm({
            title: '删除人物',
            message: `删除「${person.names[0]?.text ?? ''}」？他在故事里的参与也会一并去掉。保存草稿后才生效。`,
            confirmLabel: '删除',
            danger: true,
          }).then((yes) => {
            if (!yes) return;
            removePerson(doc, person.id);
            state.person = null;
            ctx.edited();
            ctx.paint('people', 'stories', 'groups', 'character');
          });
        }),
      );
    host.append(list, editor);
  };
  return { paint };
}
