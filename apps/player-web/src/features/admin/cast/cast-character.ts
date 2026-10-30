import {
  CAST_ALIAS_ATTITUDES,
  CAST_LIMITS,
  type CastAliasAttitude,
  type CastCharacter,
  type CastText,
} from '../../../../../../packages/contracts/web-cast.ts';
import type { CastCompilePreviewResult } from '../../../services/cast-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { KNOWLEDGE_LABEL } from './cast-model.ts';
import { dot, type CastCtx } from './cast-ui.ts';
import { markDirty } from '../ui/unsaved.ts';

const L = CAST_LIMITS;
const ATTITUDE_LABEL: Record<CastAliasAttitude, string> = { likes: '喜欢', ok: '无所谓', dislikes: '不喜欢' };

/**
 * 名片 (Cast3): what the OTHER characters know of one character, and nothing else: a one-liner, the names (the first is the one
 * said out loud), the nicknames with how he feels about each, and the prototype he is modelled on. Everything else about a
 * character (人设, 说话, 经历 ...) lives in 角色工作台 and is not drawn here; it is carried through a save untouched.
 */
export function nameCard(host: HTMLElement, ctx: CastCtx, selected: () => string | null) {
  const paint = () => {
    const doc = ctx.doc();
    host.replaceChildren();
    const id = selected();
    const character: CastCharacter | undefined = doc.characters.find((c) => c.characterId === id);
    host.hidden = !character;
    if (!character) return;
    const name = ctx.nameOf(character.characterId);
    const identity = character.identity;
    const edit = ctx.canEdit();
    const repaintNames = () => ctx.paint('grid', 'side', 'groups', 'stories');
    const link = h('a', {
      class: 'cs-go',
      text: '人设、说话、经历在角色工作台 →',
      attrs: { href: `#/characters/${character.characterId}` },
    });
    const oneLiner = h('input', { attrs: { type: 'text', maxlength: String(L.oneLiner), 'aria-label': '一句话' } });
    oneLiner.value = identity.oneLiner;
    if (!edit) oneLiner.setAttribute('readonly', '');
    oneLiner.addEventListener('input', () => {
      identity.oneLiner = oneLiner.value;
      markDirty(
        oneLiner,
        oneLiner.value !==
          (ctx.base().characters.find((c) => c.characterId === character.characterId)?.identity.oneLiner ?? ''),
      );
      ctx.edited(true);
    });
    const pill = (input: HTMLInputElement, extra: Node | null, remove: (() => void) | null) => {
      const node = h('span', { class: 'cs-pill' }, input, extra);
      if (remove && edit) {
        const x = h('button', { class: 'cs-pill-x', text: '×', attrs: { type: 'button', 'aria-label': '去掉' } });
        x.addEventListener('click', remove);
        node.append(x);
      }
      return node;
    };
    const textInput = (value: string, max: number, label: string, set: (v: string) => void, after?: () => void) => {
      const input = h('input', {
        class: 'cs-pill-input',
        attrs: {
          type: 'text',
          maxlength: String(max),
          'aria-label': label,
          size: String(Math.max(2, [...value].length + 1)),
        },
      });
      input.value = value;
      if (!edit) input.setAttribute('readonly', '');
      input.addEventListener('input', () => {
        set(input.value);
        input.setAttribute('size', String(Math.max(2, [...input.value].length + 1)));
        ctx.edited(true);
      });
      if (after) input.addEventListener('change', after);
      return input;
    };
    const addPill = (label: string, onAdd: () => void) => {
      const button = h('button', {
        class: 'cs-pill is-add',
        text: '+',
        attrs: { type: 'button', 'aria-label': label },
      });
      button.addEventListener('click', onAdd);
      return button;
    };
    const names = h('div', { class: 'cs-lb' }, h('span', { text: '名字 · 第一个是对外的' }));
    const nameRow = h('span', { class: 'cs-pills' });
    identity.names.forEach((entry, index) => {
      nameRow.append(
        pill(
          textInput(entry.text, L.name, `名字 ${index + 1}`, (v) => (entry.text = v), repaintNames),
          null,
          identity.names.length > 1
            ? () => {
                identity.names.splice(index, 1);
                ctx.edited();
                repaintNames();
                ctx.paint('character');
              }
            : null,
        ),
      );
    });
    if (edit && identity.names.length < L.names)
      nameRow.append(
        addPill('加一个名字', () => {
          identity.names.push({ id: '', text: '' });
          ctx.edited();
          ctx.paint('character');
        }),
      );
    names.append(nameRow);
    const aliases = h('div', { class: 'cs-lb' }, h('span', { text: '别名 · 他对这个叫法的感觉' }));
    const aliasRow = h('span', { class: 'cs-pills' });
    identity.aliases.forEach((alias, index) => {
      const feel = h('button', {
        class: `cs-feel is-${alias.attitude}`,
        text: ATTITUDE_LABEL[alias.attitude],
        attrs: {
          type: 'button',
          'aria-label': `对「${alias.text}」的感觉：${ATTITUDE_LABEL[alias.attitude]}，点一下换`,
        },
      });
      feel.disabled = !edit;
      feel.addEventListener('click', () => {
        alias.attitude =
          CAST_ALIAS_ATTITUDES[(CAST_ALIAS_ATTITUDES.indexOf(alias.attitude) + 1) % CAST_ALIAS_ATTITUDES.length]!;
        ctx.edited();
        ctx.paint('character');
      });
      aliasRow.append(
        pill(
          textInput(alias.text, L.alias, `别名 ${index + 1}`, (v) => (alias.text = v)),
          feel,
          () => {
            identity.aliases.splice(index, 1);
            ctx.edited();
            ctx.paint('character');
          },
        ),
      );
    });
    if (edit && identity.aliases.length < L.aliases)
      aliasRow.append(
        addPill('加一个别名', () => {
          identity.aliases.push({ id: '', text: '', attitude: 'ok' });
          ctx.edited();
          ctx.paint('character');
        }),
      );
    aliases.append(aliasRow);
    const prototype = h('select', { attrs: { 'aria-label': '原型' } });
    prototype.append(h('option', { text: '不用原型', attrs: { value: '' } }));
    for (const person of doc.people.filter((p) => p.kind === 'prototype'))
      prototype.append(h('option', { text: person.names[0]?.text ?? person.id, attrs: { value: person.id } }));
    prototype.value = identity.prototype?.personId ?? '';
    if (!edit) prototype.setAttribute('data-locked', 'true');
    prototype.addEventListener('change', () => {
      identity.prototype = prototype.value
        ? {
            personId: prototype.value,
            inherited: identity.prototype?.personId === prototype.value ? identity.prototype.inherited : '',
            notInherited: identity.prototype?.personId === prototype.value ? identity.prototype.notInherited : '',
          }
        : null;
      ctx.edited(true);
    });
    host.append(
      h(
        'div',
        { class: 'cs-card-head' },
        h(
          'h2',
          {},
          dot(ctx.colour(character.characterId), 10),
          `${name} 的名片`,
          h('span', { class: 'cs-hint-line', text: '别的角色只知道这些' }),
        ),
        link,
      ),
      h(
        'div',
        { class: 'cs-namecard' },
        h('label', { class: 'cs-lb' }, h('span', { text: '一句话' }), oneLiner),
        names,
        aliases,
        h('label', { class: 'cs-lb' }, h('span', { text: '原型' }), prototype),
      ),
    );
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
