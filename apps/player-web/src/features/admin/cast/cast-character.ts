import {
  CAST_ALIAS_ATTITUDE_LABEL,
  CAST_ALIAS_ATTITUDES,
  CAST_ALIAS_KIND_LABEL,
  CAST_ALIAS_KINDS,
  CAST_LIMITS,
  type CastAlias,
  type CastAliasAttitude,
  type CastAliasKind,
  type CastCharacter,
  type CastText,
} from '../../../../../../packages/contracts/web-cast.ts';
import type { CastCompilePreviewResult } from '../../../services/cast-admin-api.ts';
import { shortInput } from '../ui/grow-box.ts';
import { h } from '../../cocreation/h.ts';
import { KNOWLEDGE_LABEL } from './cast-model.ts';
import { itemList } from './cast-items.ts';
import { dot, type CastCtx } from './cast-ui.ts';
import { markDirty } from '../ui/unsaved.ts';

const L = CAST_LIMITS;

/**
 * 名片 (Cast3): what the OTHER characters know of one character, and nothing else: a one-liner, the names (the first is the one
 * said out loud) and the nicknames with how he feels about each. Part 24l: this is also ALL the cast tells the character about
 * himself. Everything else about a character (人设, 说话, 经历, 原型 ...) lives in 角色工作台; the stored fields stay in the cast
 * document, are carried through a save untouched, and are neither compiled nor editable here.
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
    // 名片一句话 holds at most 40 characters: one line sized to it (wider only when its text is)
    shortInput(oneLiner, L.oneLiner);
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
    const select = <V extends string>(
      label: string,
      values: readonly V[],
      names: Readonly<Record<V, string>>,
      current: V,
      set: (value: V) => void,
      className: string,
    ) => {
      const node = h('select', { class: className, attrs: { 'aria-label': label } });
      for (const value of values) node.append(h('option', { text: names[value], attrs: { value } }));
      node.value = current;
      if (!edit) node.setAttribute('data-locked', 'true');
      node.disabled = !edit;
      node.addEventListener('change', () => set(node.value as V));
      return node;
    };
    const base = ctx.base().characters.find((c) => c.characterId === character.characterId)?.identity.aliases ?? null;
    const aliases = itemList<CastAlias>({
      ctx,
      label: '别名',
      hint: '自称、别人可以怎么叫他、中性称呼、黑称；右边是他对这个叫法的感觉',
      items: identity.aliases,
      base,
      max: L.aliases,
      maxText: L.alias,
      blank: () => ({ id: '', text: '', kind: 'other', attitude: 'ok' }),
      path: (index) => `characters[${character.characterId}].identity.aliases[${index}].text`,
      listPath: `characters[${character.characterId}].identity.aliases`,
      testId: 'aliases',
      extra: (alias, changed) => {
        const saved = () => base?.find((b) => b.id === alias.id);
        const kind = select(
          '类型',
          CAST_ALIAS_KINDS,
          CAST_ALIAS_KIND_LABEL,
          alias.kind,
          (value: CastAliasKind) => {
            alias.kind = value;
            markDirty(kind, saved()?.kind !== value);
            changed();
          },
          'cs-item-kind',
        );
        const attitude = select(
          '他对这个叫法的感觉',
          CAST_ALIAS_ATTITUDES,
          CAST_ALIAS_ATTITUDE_LABEL,
          alias.attitude,
          (value: CastAliasAttitude) => {
            alias.attitude = value;
            attitude.className = `cs-item-attitude is-${value}`;
            markDirty(attitude, saved()?.attitude !== value);
            changed();
          },
          `cs-item-attitude is-${alias.attitude}`,
        );
        markDirty(kind, !!alias.id && saved()?.kind !== alias.kind);
        markDirty(attitude, !!alias.id && saved()?.attitude !== alias.attitude);
        return [kind, attitude];
      },
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
  // Part 24l: view.self is the name card only; persona, speech and boundaries come from the character profile.
  block(
    '他的名片',
    view.self.oneLiner,
    view.self.names.join(' / '),
    ...view.self.aliases.map((a) => `${a.kind}：${a.text}`),
  );
  block('别人（只有名片）', ...view.others.map((o) => `${o.name}：${o.oneLiner}`));
  block(
    '他对别人',
    ...view.relations.map((r) =>
      [
        r.to,
        r.rating === undefined ? null : `${r.rating} 星`,
        r.addresses?.length ? `叫：${r.addresses.join(' / ')}` : null,
        r.treatment,
      ]
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
