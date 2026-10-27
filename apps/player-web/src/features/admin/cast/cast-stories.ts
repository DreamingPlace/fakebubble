import {
  CAST_LIMITS,
  type CastGroup,
  type CastGroupStory,
  type CastKnowledge,
  type CastPeriod,
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
  setKnowledge,
} from './cast-model.ts';
import { bound, dot, toggleChip, type CastCtx } from './cast-ui.ts';
import type { ConfirmOptions } from '../ui/confirm-dialog.ts';

export type StoryState = {
  /** 'group' while a 组合 card is open; the pair panel otherwise. */
  panel: 'pair' | 'group';
  group: number;
  /** Index into doc.stories of the story being edited. */
  story: number | null;
  /** The character whose knowledge the story list shows. */
  sel: string | null;
};

const L = CAST_LIMITS;
const period = (ctx: CastCtx, value: CastPeriod, after: () => void) =>
  h(
    'div',
    { class: 'cs-period' },
    bound(
      ctx,
      '时间段 开始',
      () => value.start,
      (v) => (value.start = v),
      { max: L.storyPeriod, placeholder: '2024 或 2024-05', after },
    ).wrap,
    bound(
      ctx,
      '结束',
      () => value.end,
      (v) => (value.end = v),
      { max: L.storyPeriod, placeholder: '可空', after },
    ).wrap,
  );

const move = <T>(list: T[], item: T) => list.splice(list.indexOf(item), 1);

/** 组合 cards: pick one to open its panel; + 组合 adds one. Everything about the card is visible on it. */
export function groupCards(host: HTMLElement, ctx: CastCtx, state: StoryState) {
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    const head = h('div', { class: 'cs-card-head' }, h('h2', { text: '组合' }));
    if (ctx.canEdit() && doc.groups.length < L.groups) {
      const add = h('button', { class: 'cs-add', text: '+ 组合', attrs: { type: 'button' } });
      add.addEventListener('click', () => {
        doc.groups.push(blankGroup());
        state.panel = 'group';
        state.group = doc.groups.length - 1;
        ctx.edited();
        ctx.paint('groups', 'side');
      });
      head.append(add);
    }
    const list = h('div', { class: 'cs-groups' });
    doc.groups.forEach((group, index) => {
      const on = state.panel === 'group' && state.group === index;
      const card = h('button', { class: 'cs-group-card', attrs: { type: 'button', 'aria-pressed': String(on) } });
      card.style.setProperty('--tint', `hsl(${(index * 67 + 260) % 360} 70% 93%)`);
      card.style.setProperty('--edge', `hsl(${(index * 67 + 260) % 360} 65% 78%)`);
      card.append(
        h('span', { class: 'cs-group-name', text: group.name || '（未命名）' }),
        h(
          'span',
          { class: 'cs-stack' },
          ...group.members.map((id) => {
            const at = doc.characters.findIndex((c) => c.characterId === id);
            return dot(Math.max(0, at), nameOf(doc, id), 26);
          }),
        ),
      );
      card.addEventListener('click', () => {
        state.panel = 'group';
        state.group = index;
        ctx.paint('groups', 'side');
      });
      list.append(card);
    });
    if (!doc.groups.length) list.append(h('p', { class: 'cs-hint', text: '还没有组合。' }));
    host.append(head, list);
  };
  return { paint };
}

/** The open 组合: name, members, 组合背景 and 组合故事 (every member lived them). */
export function groupPanel(
  host: HTMLElement,
  ctx: CastCtx,
  state: StoryState,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
) {
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    const group: CastGroup | undefined = doc.groups[state.group];
    if (!group) {
      state.panel = 'pair';
      return;
    }
    const edit = ctx.canEdit();
    const head = h('div', { class: 'cs-card-head' });
    const name = bound(
      ctx,
      '组合名',
      () => group.name,
      (v) => (group.name = v),
      { max: L.groupName, after: () => ctx.paint('groups') },
    );
    head.append(name.wrap);
    if (edit) {
      const remove = h('button', { class: 'cs-danger', text: '删除组合', attrs: { type: 'button' } });
      remove.addEventListener('click', () => {
        void confirm({
          title: '删除组合',
          message: `删除「${group.name}」和它的组合故事？保存草稿后才生效。`,
          confirmLabel: '删除',
          danger: true,
        }).then((yes) => {
          if (!yes) return;
          move(doc.groups, group);
          state.panel = 'pair';
          state.group = 0;
          ctx.edited();
          ctx.paint('groups', 'side');
        });
      });
      head.append(remove);
    }
    const members = h('div', { class: 'cs-chips', attrs: { role: 'group', 'aria-label': '成员' } });
    doc.characters.forEach((c, index) => {
      const on = group.members.includes(c.characterId);
      members.append(
        toggleChip(
          nameOf(doc, c.characterId),
          on,
          edit && (on || group.members.length < L.groupMembers),
          () => {
            if (on) move(group.members, c.characterId);
            else group.members.push(c.characterId);
            ctx.edited();
            ctx.paint('groups', 'side', 'stories');
          },
          dot(index, nameOf(doc, c.characterId), 22),
        ),
      );
    });
    host.append(
      head,
      members,
      bound(
        ctx,
        '组合背景',
        () => group.background,
        (v) => (group.background = v),
        { area: true, max: L.groupBackground, rows: 3 },
      ).wrap,
    );
    const stories = h('div', { class: 'cs-gstories' });
    const title = h('div', { class: 'cs-card-head' }, h('h3', { text: '组合故事' }));
    if (edit && group.stories.length < L.groupStories) {
      const add = h('button', { class: 'cs-add', text: '+ 组合故事', attrs: { type: 'button' } });
      add.addEventListener('click', () => {
        group.stories.push(blankGroupStory());
        ctx.edited();
        ctx.paint('side');
      });
      title.append(add);
    }
    stories.append(title);
    for (const story of group.stories) stories.append(groupStoryEditor(ctx, group, story, confirm));
    if (!group.stories.length) stories.append(h('p', { class: 'cs-hint', text: '还没有。' }));
    host.append(stories);
  };
  return { paint };
}

function groupStoryEditor(
  ctx: CastCtx,
  group: CastGroup,
  story: CastGroupStory,
  confirm: (o: ConfirmOptions) => Promise<boolean>,
) {
  const card = h('div', { class: 'cs-gstory' });
  card.append(
    h(
      'div',
      { class: 'cs-gstory-head' },
      bound(
        ctx,
        '标题',
        () => story.title,
        (v) => (story.title = v),
        { max: L.storyTitle },
      ).wrap,
      h('span', { class: 'cs-lived', text: '全员亲历' }),
    ),
    bound(
      ctx,
      '摘要',
      () => story.summary,
      (v) => (story.summary = v),
      { area: true, max: L.storySummary, rows: 2 },
    ).wrap,
    period(ctx, story.period, () => undefined),
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
      { area: true, max: L.storyDetails, rows: 3 },
    ).wrap,
  );
  if (ctx.canEdit()) {
    const remove = h('button', { class: 'cs-danger', text: '删除', attrs: { type: 'button' } });
    remove.addEventListener('click', () => {
      void confirm({
        title: '删除组合故事',
        message: `删除「${story.title}」？保存草稿后才生效。`,
        confirmLabel: '删除',
        danger: true,
      }).then((yes) => {
        if (!yes) return;
        move(group.stories, story);
        ctx.edited();
        ctx.paint('side');
      });
    });
    card.append(remove);
  }
  return card;
}

const LEVEL_CLASS: Record<CastKnowledge, string> = { lived: 'is-lived', heard: 'is-heard', unknown: 'is-unknown' };

/**
 * 故事. Left: every story with what the open character knows of it (click to cycle; an orange outline marks a manual setting,
 * ✕ returns it to the computed default). Right: the open story's text, participants and what each character knows of it.
 */
export function storiesPanel(
  host: HTMLElement,
  ctx: CastCtx,
  state: StoryState,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
) {
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
    const list = h('div', { class: 'cs-story-list' });
    const head = h(
      'div',
      { class: 'cs-card-head' },
      h('h2', { text: sel ? `${nameOf(doc, sel)} 知道的故事` : '故事' }),
      h(
        'span',
        { class: 'cs-levels' },
        ...(['lived', 'heard', 'unknown'] as const).map((l) =>
          h('span', { class: `cs-level ${LEVEL_CLASS[l]}`, text: KNOWLEDGE_LABEL[l] }),
        ),
      ),
    );
    if (ctx.canEdit() && doc.stories.length < L.stories) {
      const add = h('button', { class: 'cs-add', text: '+ 故事', attrs: { type: 'button' } });
      add.addEventListener('click', () => {
        doc.stories.push(blankStory(sel ? [sel] : []));
        state.story = doc.stories.length - 1;
        ctx.edited();
        ctx.paint('stories');
      });
      head.append(add);
    }
    list.append(head);
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
          ...story.participants.map((id) =>
            dot(
              Math.max(
                0,
                doc.characters.findIndex((c) => c.characterId === id),
              ),
              nameOf(doc, id),
              24,
            ),
          ),
        ),
      );
      if (sel) row.append(levelCell(story, sel, false));
      list.append(row);
    });
    if (!doc.stories.length) list.append(h('p', { class: 'cs-hint', text: '还没有故事。' }));
    host.append(list);

    const story = state.story === null ? null : doc.stories[state.story]!;
    const editor = h('div', { class: 'cs-story-edit' });
    if (!story) {
      editor.append(h('p', { class: 'cs-hint', text: '点一个故事，编辑它并设置谁知道。' }));
      host.append(editor);
      return;
    }
    editor.append(
      bound(
        ctx,
        '标题',
        () => story.title,
        (v) => (story.title = v),
        { max: L.storyTitle, after: () => ctx.paint('stories') },
      ).wrap,
      bound(
        ctx,
        '摘要（听说的人只知道这一段）',
        () => story.summary,
        (v) => (story.summary = v),
        { area: true, max: L.storySummary, rows: 2 },
      ).wrap,
      period(ctx, story.period, () => undefined),
      bound(
        ctx,
        '叙述边界',
        () => story.boundary,
        (v) => (story.boundary = v),
        { area: true, max: L.storyBoundary, rows: 2 },
      ).wrap,
      bound(
        ctx,
        '细节（只给亲历的人）',
        () => story.details,
        (v) => (story.details = v),
        { area: true, max: L.storyDetails, rows: 3 },
      ).wrap,
    );
    const participants = h('div', { class: 'cs-chips', attrs: { role: 'group', 'aria-label': '参与者' } });
    const options = [...doc.characters.map((c) => c.characterId), ...doc.people.map((p) => p.id)];
    for (const id of options) {
      const on = story.participants.includes(id);
      const at = doc.characters.findIndex((c) => c.characterId === id);
      participants.append(
        toggleChip(
          nameOf(doc, id),
          on,
          ctx.canEdit() && (on || story.participants.length < L.storyParticipants),
          () => {
            if (on) move(story.participants, id);
            else story.participants.push(id);
            ctx.edited();
            ctx.paint('stories');
          },
          at >= 0 ? dot(at, nameOf(doc, id), 22) : undefined,
        ),
      );
    }
    editor.append(
      h('span', { class: 'cs-label', text: '参与者' }),
      participants,
      h('span', { class: 'cs-label', text: '谁知道（自动 = 参与者亲历；对参与者评分 ≥ 3 星的听说）' }),
    );
    const matrix = h('div', { class: 'cs-know-matrix' });
    for (const c of doc.characters) matrix.append(levelCell(story, c.characterId, true));
    editor.append(matrix);
    if (ctx.canEdit()) {
      const remove = h('button', { class: 'cs-danger', text: '删除这个故事', attrs: { type: 'button' } });
      remove.addEventListener('click', () => {
        void confirm({
          title: '删除故事',
          message: `删除「${story.title}」？保存草稿后才生效。`,
          confirmLabel: '删除',
          danger: true,
        }).then((yes) => {
          if (!yes) return;
          move(doc.stories, story);
          state.story = null;
          ctx.edited();
          ctx.paint('stories');
        });
      });
      editor.append(remove);
    }
    host.append(editor);
  };
  return { paint };
}
