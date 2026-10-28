import {
  CAST_ALIAS_ATTITUDES,
  CAST_LIMITS,
  type CastAliasAttitude,
  type CastCharacter,
  type CastText,
} from '../../../../../../packages/contracts/web-cast.ts';
import type { CastCompilePreviewResult } from '../../../services/cast-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { KNOWLEDGE_LABEL, nameOf } from './cast-model.ts';
import { bound, dot, toggleChip, type CastCtx } from './cast-ui.ts';

const L = CAST_LIMITS;
const ATTITUDE_LABEL: Record<CastAliasAttitude, string> = { likes: '喜欢', ok: '无所谓', dislikes: '不喜欢' };

/** A list of short texts (names, catchphrases, ...): each its own field, + to add, ✕ to remove, capped like the server. */
function textList(
  ctx: CastCtx,
  label: string,
  items: CastText[],
  max: number,
  textMax: number,
  minItems = 0,
  after?: () => void,
) {
  const box = h('div', { class: 'cs-list' }, h('span', { class: 'cs-label', text: label }));
  const paint = () => {
    box.replaceChildren(h('span', { class: 'cs-label', text: label }));
    items.forEach((item) => {
      const row = h(
        'div',
        { class: 'cs-list-row' },
        bound(
          ctx,
          label,
          () => item.text,
          (v) => (item.text = v),
          { max: textMax, after },
        ).input,
      );
      if (ctx.canEdit() && items.length > minItems) {
        const remove = h('button', {
          class: 'cs-clear',
          text: '✕',
          attrs: { type: 'button', 'aria-label': `删除这条${label}` },
        });
        remove.addEventListener('click', () => {
          items.splice(items.indexOf(item), 1);
          ctx.edited();
          paint();
          after?.();
        });
        row.append(remove);
      }
      box.append(row);
    });
    if (ctx.canEdit() && items.length < max) {
      const add = h('button', { class: 'cs-add', text: '+ 添加', attrs: { type: 'button' } });
      add.addEventListener('click', () => {
        items.push({ id: '', text: '' });
        ctx.edited();
        paint();
      });
      box.append(add);
    }
  };
  paint();
  return box;
}

/**
 * One character: identity (names, aliases and how they feel about each), profile, personality, speech, experiences, 演绎说明
 * and hidden settings. Opened from the grid's row header. Nothing here is folded or tabbed.
 */
export function characterPanel(
  host: HTMLElement,
  ctx: CastCtx,
  selected: () => string | null,
  /** 从阵容移除: the page asks, then takes the character (and every mention of them) out of the working copy. */
  removeFromCast: (characterId: string) => void,
) {
  // Part 24b-3: one section at a time, picked from a rail; which one stays while the panel is painted again for the same character.
  let shown = { character: '', section: 0 };
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    const character: CastCharacter | undefined = doc.characters.find((c) => c.characterId === selected());
    if (!character) {
      host.append(
        h('div', { class: 'cs-card-head' }, h('h2', { text: '角色' })),
        h('p', { class: 'cs-hint', text: '点关系网左边的头像，打开这个角色。' }),
      );
      return;
    }
    const repaintNames = () => ctx.paint('grid', 'stories', 'side', 'groups');
    const head = h('div', { class: 'cs-card-head' }, h('h2', { text: nameOf(doc, character.characterId) }));
    if (ctx.canEdit()) {
      const out = h('button', { class: 'cs-danger', text: '从阵容移除', attrs: { type: 'button' } });
      out.addEventListener('click', () => removeFromCast(character.characterId));
      head.append(out);
    }
    // Everyone of the cast, one click away: a roster of fifteen is picked here as well as from the grid's row headers.
    const roster = h('div', { class: 'cs-chips cs-roster', attrs: { role: 'group', 'aria-label': '切换角色' } });
    for (const c of doc.characters)
      roster.append(
        toggleChip(
          nameOf(doc, c.characterId),
          c.characterId === character.characterId,
          true,
          () => ctx.openCharacter(c.characterId),
          dot(ctx.colour(c.characterId)),
        ),
      );
    host.append(head, roster);
    const id = character.identity;
    const parts: HTMLElement[] = [];
    const section = (title: string, ...nodes: Node[]) =>
      h('section', { class: 'cs-section', attrs: { 'data-title': title } }, h('h3', { text: title }), ...nodes);
    const body = {
      append: (...nodes: HTMLElement[]) => {
        parts.push(...nodes);
      },
    };
    body.append(
      section(
        '身份',
        bound(
          ctx,
          `一句话（≤${L.oneLiner} 字）`,
          () => id.oneLiner,
          (v) => (id.oneLiner = v),
          { max: L.oneLiner },
        ).wrap,
        textList(ctx, '名字（第一个是对外的名字）', id.names, L.names, L.name, 1, repaintNames),
      ),
    );
    const aliases = h(
      'div',
      { class: 'cs-list' },
      h('span', { class: 'cs-label', text: '别名，和他对这个叫法的感觉' }),
    );
    const paintAliases = () => {
      aliases.replaceChildren(h('span', { class: 'cs-label', text: '别名，和他对这个叫法的感觉' }));
      for (const alias of id.aliases) {
        const feel = h('select', { attrs: { 'aria-label': `对「${alias.text}」的感觉` } });
        for (const a of CAST_ALIAS_ATTITUDES)
          feel.append(h('option', { text: ATTITUDE_LABEL[a], attrs: { value: a } }));
        feel.value = alias.attitude;
        if (!ctx.canEdit()) feel.setAttribute('data-locked', 'true');
        feel.addEventListener('change', () => {
          alias.attitude = feel.value as CastAliasAttitude;
          ctx.edited(true);
        });
        const row = h(
          'div',
          { class: 'cs-list-row' },
          bound(
            ctx,
            '别名',
            () => alias.text,
            (v) => (alias.text = v),
            { max: L.alias },
          ).input,
          feel,
        );
        if (ctx.canEdit()) {
          const remove = h('button', {
            class: 'cs-clear',
            text: '✕',
            attrs: { type: 'button', 'aria-label': '删除这个别名' },
          });
          remove.addEventListener('click', () => {
            id.aliases.splice(id.aliases.indexOf(alias), 1);
            ctx.edited();
            paintAliases();
          });
          row.append(remove);
        }
        aliases.append(row);
      }
      if (ctx.canEdit() && id.aliases.length < L.aliases) {
        const add = h('button', { class: 'cs-add', text: '+ 添加', attrs: { type: 'button' } });
        add.addEventListener('click', () => {
          id.aliases.push({ id: '', text: '', attitude: 'ok' });
          ctx.edited();
          paintAliases();
        });
        aliases.append(add);
      }
    };
    paintAliases();
    body.append(
      section(
        '别名',
        aliases,
        bound(
          ctx,
          '自我认知',
          () => id.selfConcept,
          (v) => (id.selfConcept = v),
          { area: true, max: L.selfConcept, rows: 3 },
        ).wrap,
      ),
      section(
        '资料',
        bound(
          ctx,
          '简介',
          () => character.profile,
          (v) => (character.profile = v),
          { area: true, max: L.profile, rows: 5 },
        ).wrap,
      ),
      section(
        '性格',
        bound(
          ctx,
          '性格与行为',
          () => character.personality,
          (v) => (character.personality = v),
          { area: true, max: L.personality, rows: 5 },
        ).wrap,
      ),
      section(
        '说话方式',
        textList(ctx, '口头禅', character.speech.catchphrases, L.catchphrases, L.catchphrase),
        textList(ctx, '说话样例', character.speech.samples, L.samples, L.sample),
        textList(ctx, '不会这样说', character.speech.avoid, L.avoid, L.avoidText),
      ),
    );
    const experiences = h('div', { class: 'cs-list' });
    const paintExperiences = () => {
      experiences.replaceChildren();
      for (const e of character.experiences) {
        const card = h(
          'div',
          { class: 'cs-exp' },
          bound(
            ctx,
            '标题',
            () => e.title,
            (v) => (e.title = v),
            { max: L.experienceTitle },
          ).wrap,
          bound(
            ctx,
            '内容',
            () => e.text,
            (v) => (e.text = v),
            { area: true, max: L.experienceText, rows: 3 },
          ).wrap,
        );
        if (ctx.canEdit()) {
          const remove = h('button', { class: 'cs-danger', text: '删除', attrs: { type: 'button' } });
          remove.addEventListener('click', () => {
            character.experiences.splice(character.experiences.indexOf(e), 1);
            ctx.edited();
            paintExperiences();
          });
          card.append(remove);
        }
        experiences.append(card);
      }
      if (ctx.canEdit() && character.experiences.length < L.experiences) {
        const add = h('button', { class: 'cs-add', text: '+ 经历', attrs: { type: 'button' } });
        add.addEventListener('click', () => {
          character.experiences.push({ id: '', title: '', text: '' });
          ctx.edited();
          paintExperiences();
        });
        experiences.append(add);
      }
    };
    paintExperiences();
    body.append(
      section('经历', experiences),
      section(
        '演绎说明',
        bound(
          ctx,
          '只给他自己的模型看',
          () => character.performance,
          (v) => (character.performance = v),
          { area: true, max: L.performance, rows: 4 },
        ).wrap,
      ),
      section('不公开设定', textList(ctx, '他知道、但绝不直接说出口的设定', character.hidden, L.hidden, L.hiddenText)),
    );
    if (character.unmapped)
      body.append(section('旧资料里没能放进去的', h('pre', { class: 'cs-unmapped', text: character.unmapped })));
    // ---- the rail ----
    const rail = h('nav', {
      class: 'wb-rail cs-rail',
      attrs: { 'aria-label': `${nameOf(doc, character.characterId)} 的分区` },
    });
    const items = parts.map((part, index) => {
      const item = h('button', {
        class: 'wb-rail-item',
        text: part.getAttribute('data-title') ?? '',
        attrs: { type: 'button', 'aria-current': 'false' },
      });
      item.addEventListener('click', () => show(index));
      rail.append(item);
      return item;
    });
    const show = (index: number) => {
      shown = { character: character.characterId, section: index };
      parts.forEach((part, i) => {
        part.hidden = i !== index;
        items[i]!.setAttribute('aria-current', String(i === index));
      });
    };
    host.append(h('div', { class: 'cs-character-split' }, rail, h('div', { class: 'cs-character-body' }, ...parts)));
    show(shown.character === character.characterId && shown.section < parts.length ? shown.section : 0);
  };
  return { paint };
}

/** "What this character sees": the saved draft compiled the way the prompt receives it (compile-preview), plus the knowledge table. */
export function seesPanel(
  host: HTMLElement,
  result: CastCompilePreviewResult | null,
  state: {
    loading: boolean;
    failed: boolean;
    /** The character was added after the draft was last saved: there is nothing on the server to compile yet. */
    unsaved: boolean;
    stale: boolean;
    names: (id: string) => string;
    storyTitle: (id: string) => string;
    selected: string | null;
    limit: number;
  },
) {
  host.replaceChildren(
    h(
      'div',
      { class: 'cs-card-head' },
      h('h2', { text: state.selected ? `${state.names(state.selected)} 看到的` : '他看到的' }),
    ),
  );
  if (!state.selected) {
    host.append(h('p', { class: 'cs-hint', text: '打开一个角色就能看到。' }));
    return;
  }
  if (state.unsaved) {
    host.append(h('p', { class: 'cs-hint', text: '保存草稿后，这里会显示他看到的内容。' }));
    return;
  }
  if (state.failed) {
    host.append(h('p', { class: 'cs-hint', text: '读取失败（这个角色可能还没存进草稿）。' }));
    return;
  }
  if (!result) {
    host.append(h('p', { class: 'cs-hint', text: state.loading ? '读取中…' : '' }));
    return;
  }
  const view = result.view;
  const meta = h(
    'div',
    { class: 'cs-sees-meta' },
    h('span', {
      class: 'cs-mono',
      text: `草稿 修订 ${result.source.kind === 'draft' ? result.source.revision : ''} · ${result.size} / ${state.limit}`,
    }),
  );
  if (state.stale) meta.append(h('span', { class: 'cs-tag is-warn', text: '有没保存的修改，这里是已保存的草稿' }));
  host.append(meta);
  const block = (title: string, ...lines: (string | null | undefined)[]) => {
    const shown = lines.filter((line): line is string => !!line);
    if (!shown.length) return;
    host.append(
      h(
        'section',
        { class: 'cs-sees-block' },
        h('h3', { text: title }),
        ...shown.map((line) => h('p', { text: line })),
      ),
    );
  };
  block('世界', view.world.background);
  block(
    '他自己',
    view.self.oneLiner,
    view.self.names.join(' / '),
    view.self.profile,
    view.self.personality,
    view.self.performance,
  );
  block(
    '说话',
    ...view.self.speech.catchphrases.map((t) => `口头禅：${t}`),
    ...view.self.speech.samples.map((t) => `样例：${t}`),
  );
  block('别人（只有名片）', ...view.others.map((o) => `${o.name}：${o.oneLiner}`));
  block(
    '他对别人',
    ...view.relations.map((r) =>
      [r.to, r.rating === undefined ? null : `${r.rating} 星`, r.address ? `叫：${r.address}` : null, r.treatment]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  block(
    '组合',
    ...view.groups.map((g) => `${g.name}：${g.background}`),
    ...view.groups.flatMap((g) => g.stories.map((s) => `${s.level}｜${s.title}：${s.summary}`)),
  );
  block(
    '故事',
    ...view.stories.map((s) => `${s.level}｜${s.title}：${s.summary}${s.details ? `（${s.details}）` : ''}`),
  );
  const table = h('section', { class: 'cs-sees-block' }, h('h3', { text: '每个故事他知道多少' }));
  for (const row of result.knowledge)
    table.append(
      h(
        'p',
        { class: 'cs-know-line' },
        h('span', {
          class: `cs-level is-${row.level}${row.fromOverride ? ' is-override' : ''}`,
          text: KNOWLEDGE_LABEL[row.level],
        }),
        ` ${state.storyTitle(row.storyId)}`,
      ),
    );
  host.append(table);
}
