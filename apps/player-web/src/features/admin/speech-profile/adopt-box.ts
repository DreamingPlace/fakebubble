import {
  CORE_FIELDS,
  CORE_FIELD_LABELS,
  CORE_FIELD_MAX,
  EXAMPLES_PER_SITUATION_MAX,
  SPEECH_SITUATIONS,
  addSample,
  bankCounts,
  cardText,
  settingsOf,
  writeCoreCard,
  type CoreField,
  type SpeechSituation,
} from '../../../../../../packages/contracts/speech-profile.ts';
import type { CharacterAdminClient } from '../../../services/character-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { drawer } from '../ui/drawer.ts';
import { adminConnection, INTERRUPTED_LINE, isInterrupted } from '../../../services/admin-connection.ts';
import { hoverValue } from '../ui/hover-value.ts';
import { segmented } from '../ui/segmented.ts';
import {
  NOT_SAVED_TEXT,
  NO_DRAFT_TEXT,
  OTHERS_UNREADABLE_TEXT,
  independence,
  independenceSentences,
  profileErrorText,
  readTarget,
  saveTemplate,
  type OthersReader,
} from './profile-draft.ts';

/**
 * Part 37b: the ONE box every 采纳 into the 说话档案 goes through (共创收件箱, ⭐ in 多轮预演, ⭐ in 测试对话). The owner picks the
 * destination: 核心卡 + a field, or 说话样本 + a situation. The result goes into that character's 草稿 through the existing draft
 * save (compare-and-swap); nothing is published (正式版本 stays the one way live). No queue and no storage of its own: the draft and
 * its version history are the review and the rollback.
 */
export type AdoptSource = {
  characterId: string;
  /** What the player said (a sample's 玩家说). May be empty: the owner fills it in. */
  player?: string;
  /** The character's line. */
  reply: string;
  /** Called after the draft was saved (the inbox marks the note adopted). A throw is shown, the draft stays saved. */
  onSaved?: (revision: number) => void | Promise<void>;
};
export type AdoptBoxDeps = {
  characters: Pick<CharacterAdminClient, 'list' | 'detail' | 'save'>;
  others: OthersReader;
  parent: () => HTMLElement;
  canEdit: (characterId: string) => boolean;
  nameOf: (characterId: string) => string;
  run: (work: () => Promise<void>) => Promise<void>;
  toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
  errorText: (error: unknown) => string | null;
  disposed: () => boolean;
};

const lines = (text: string) =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
const count = (text: string) => [...text].length;

export function adoptBox(deps: AdoptBoxDeps) {
  let panel: ReturnType<typeof drawer> | null = null;
  const close = () => {
    panel?.dispose();
    panel = null;
  };

  async function open(source: AdoptSource) {
    close();
    if (deps.disposed()) return;
    // Display names of every role (the independence sentences name the other character): one read of the roster.
    const roster = new Map<string, string>();
    try {
      for (const role of (await deps.characters.list()).characters) roster.set(role.characterId, role.displayName);
    } catch {
      /* the page's own names are used */
    }
    if (deps.disposed()) return;
    const nameOf = (characterId: string) => roster.get(characterId) ?? deps.nameOf(characterId);
    const name = nameOf(source.characterId);
    const view = drawer(deps.parent(), { title: `加入说话档案 · ${name}`, onClose: () => close() });
    panel = view;
    view.body.classList.add('sp-adopt');
    const mayEdit = deps.canEdit(source.characterId);

    let destination: 'card' | 'sample' = 'sample';
    let warned = '';
    const error = h('p', { class: 'sp-error', attrs: { role: 'alert' }, hidden: true });
    const warn = h('div', { class: 'sp-warn', hidden: true, attrs: { role: 'status' } });
    const showError = (text: string) => {
      error.textContent = text;
      error.hidden = text === '';
    };
    const clearWarn = () => {
      warned = '';
      warn.hidden = true;
      warn.replaceChildren();
      save.textContent = '保存到草稿';
    };

    // ---- the two destinations ----
    const cardField = h('select', { attrs: { 'aria-label': '核心卡的哪一栏' } });
    for (const field of CORE_FIELDS)
      cardField.append(h('option', { text: CORE_FIELD_LABELS[field], attrs: { value: field } }));
    const cardBox = h('textarea', { class: 'sp-text', attrs: { 'aria-label': '加入核心卡的内容', rows: '4' } });
    cardBox.value = source.reply;
    const cardNow = h('p', { class: 'sp-now' });
    const cardCount = h('span', { class: 'sp-count' });
    const cardPane = h(
      'div',
      { class: 'sp-pane', hidden: true },
      h('label', { class: 'sp-lab' }, h('span', { text: '栏目' }), cardField),
      cardNow,
      h('label', { class: 'sp-lab' }, h('span', { text: '加入的内容' }), cardBox),
      cardCount,
    );
    const situation = h('select', { attrs: { 'aria-label': '样本的情境' } });
    const player = h('input', {
      attrs: { type: 'text', 'aria-label': '玩家说', maxlength: '120', placeholder: '玩家说了什么' },
    });
    player.value = source.player ?? '';
    const reply = h('textarea', { class: 'sp-text', attrs: { 'aria-label': `${name}的回复，一句一行`, rows: '3' } });
    reply.value = source.reply;
    const samplePane = h(
      'div',
      { class: 'sp-pane' },
      h('label', { class: 'sp-lab' }, h('span', { text: '情境' }), situation),
      h('label', { class: 'sp-lab' }, h('span', { text: '玩家说' }), player),
      h('label', { class: 'sp-lab' }, h('span', { text: `${name}回复（一句一行，最多两句）` }), reply),
    );
    const seg = segmented<'card' | 'sample'>(
      '去向',
      [
        { id: 'sample', label: '说话样本' },
        { id: 'card', label: '核心卡' },
      ],
      destination,
      (id) => {
        destination = id;
        cardPane.hidden = id !== 'card';
        samplePane.hidden = id !== 'sample';
        clearWarn();
        showError('');
      },
      'm',
    );

    const cancel = h('button', { class: 'admin-secondary', text: '取消', attrs: { type: 'button' } });
    const save = h('button', { class: 'admin-primary', text: '保存到草稿', attrs: { type: 'button' } });
    hoverValue(save, '只存进草稿，发布后玩家才看得到');
    save.disabled = !mayEdit;
    cancel.addEventListener('click', close);

    view.body.append(
      h('p', { class: 'sp-from', text: `${name}：${source.reply}` }),
      seg.root,
      cardPane,
      samplePane,
      error,
      warn,
      h('div', { class: 'sp-actions' }, cancel, save),
    );
    view.open();
    if (!mayEdit) showError('没有修改这个角色的权限。');

    // The draft this goes into: counts and the field's present text are shown from it.
    let target: Awaited<ReturnType<typeof readTarget>> = null;
    const paintTarget = () => {
      const template = target?.base.template;
      const counts = template ? bankCounts(template) : null;
      const chosen = situation.value as SpeechSituation | '';
      situation.replaceChildren();
      for (const tag of SPEECH_SITUATIONS) {
        const used = counts?.[tag] ?? 0;
        const option = h('option', {
          text: `${tag}（${used}/${EXAMPLES_PER_SITUATION_MAX}）`,
          attrs: { value: tag },
        });
        if (used >= EXAMPLES_PER_SITUATION_MAX) option.disabled = true;
        situation.append(option);
      }
      situation.value = chosen || '日常闲聊';
      const field = cardField.value as CoreField;
      const present = template ? cardText(settingsOf(template), field) : '';
      cardNow.textContent = present ? `现在：${present}` : '';
      cardNow.hidden = !present;
      updateCount();
    };
    const updateCount = () => {
      const field = cardField.value as CoreField;
      const present = target ? cardText(settingsOf(target.base.template), field).trimEnd() : '';
      const total = count(present) + (present ? 1 : 0) + count(cardBox.value.trim());
      cardCount.textContent = `${total} / ${CORE_FIELD_MAX}`;
      cardCount.classList.toggle('is-over', total > CORE_FIELD_MAX);
    };
    cardField.addEventListener('change', () => {
      paintTarget();
      clearWarn();
    });
    for (const node of [cardBox, player, reply, situation]) node.addEventListener('input', clearWarn);
    cardBox.addEventListener('input', updateCount);
    situation.addEventListener('change', clearWarn);
    try {
      target = await readTarget(deps.characters, source.characterId);
    } catch {
      target = null;
    }
    if (panel !== view || deps.disposed()) return;
    if (!target) showError(NO_DRAFT_TEXT);
    paintTarget();

    save.addEventListener(
      'click',
      () =>
        void deps.run(async () => {
          showError('');
          if (!target || panel !== view) return;
          try {
            const before = target.base.template;
            const next =
              destination === 'card'
                ? writeCoreCard(before, cardField.value as CoreField, cardBox.value)
                : addSample(before, {
                    situation: situation.value,
                    player: player.value,
                    reply: lines(reply.value),
                  });
            const key = `${destination}:${cardField.value}:${situation.value}:${cardBox.value}:${player.value}:${reply.value}`;
            let result;
            try {
              result = await independence(deps.others, source.characterId, before, next);
            } catch {
              showError(OTHERS_UNREADABLE_TEXT);
              return;
            }
            if (result.level === 'block') {
              clearWarn();
              showError(`这句话和别的角色太像了，不能保存。${independenceSentences(result, nameOf).join('；')}`);
              return;
            }
            if (result.level === 'warn' && warned !== key) {
              warned = key;
              warn.hidden = false;
              warn.replaceChildren(
                h('b', { text: '和别的角色有点接近：' }),
                ...independenceSentences(result, nameOf).map((sentence) => h('p', { text: sentence })),
              );
              save.textContent = '仍然保存';
              return;
            }
            const saved = await saveTemplate(deps.characters, source.characterId, target, next);
            deps.others.forget();
            if (panel !== view) return;
            try {
              await source.onSaved?.(saved.revision);
            } catch {
              deps.toast(`草稿 ${saved.revision} 已保存，但后续标记没有成功。请勿重复加入，可刷新核对。`, 'warn');
              close();
              return;
            }
            deps.toast(`已加入草稿 ${saved.revision}。发布前玩家看不到。`, 'ok');
            close();
          } catch (caught) {
            // Part 59: not a failed save but an interruption: the box stays as typed and saves again after re-authentication.
            if (isInterrupted(caught)) {
              showError(INTERRUPTED_LINE);
              adminConnection.retryAfterReauth(`adopt-box:${source.characterId}`, () => save.click());
              return;
            }
            showError(profileErrorText(caught) ?? deps.errorText(caught) ?? NOT_SAVED_TEXT);
          }
        }),
    );
  }

  return { open, close, isOpen: () => panel !== null };
}
export type AdoptBox = ReturnType<typeof adoptBox>;
