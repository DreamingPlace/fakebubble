import {
  CORE_FIELDS,
  CORE_FIELD_LABELS,
  CORE_FIELD_MAX,
  EXAMPLES_PER_SITUATION_MAX,
  SPEECH_SITUATIONS,
  UNCATEGORIZED,
  cardEditable,
  cardText,
  deleteSample,
  moveSample,
  readBank,
  readCoreCard,
  readDailyLife,
  settingsOf,
  writeCoreCard,
  writeDailyPart,
  type CoreField,
} from '../../../../../../packages/contracts/speech-profile.ts';
import {
  MEME_LEVELS,
  MEME_LEVEL_LABELS,
  MEME_OVERRIDES_MAX,
  readMemeUse,
  writeMemeUse,
  type MemeLevel,
} from '../../../../../../packages/contracts/web-memes.ts';
import { segmented } from '../ui/segmented.ts';
import {
  DAILY_LIFE_LABEL,
  DAY_PARTS,
  DAY_PART_LABELS,
  DAY_PART_MAX,
  type DayPart,
} from '../../../../../../packages/contracts/cocreation-day.ts';
import type { CharacterAdminClient, CharacterDetail } from '../../../services/character-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { adminConnection, INTERRUPTED_LINE, isInterrupted } from '../../../services/admin-connection.ts';
import { panelKeeper, plainEl } from '../ui/edit-keeper.ts';
import { hoverValue } from '../ui/hover-value.ts';
import { statusBadge } from '../ui/status-badge.ts';
import {
  NOT_SAVED_TEXT,
  OTHERS_UNREADABLE_TEXT,
  independence,
  independenceSentences,
  profileErrorText,
  saveTemplate,
  type DraftTarget,
  type OthersReader,
} from './profile-draft.ts';

/**
 * Part 37b: 说话档案, a section of 角色工作台. The 核心卡 (four fields, editable) and the 说话样本 grouped by the eight situations
 * (count x/6, 删除, 移到另一个情境). Everything is read from, and saved into, the character's 草稿 (the published version while there
 * is none) through the existing draft save; 发布 stays the only way live. While the form beside holds unsaved changes the section is
 * read-only (a save here would move the draft under it).
 */
export type SpeechPanelDeps = {
  snapshot: CharacterDetail;
  characters: Pick<CharacterAdminClient, 'list' | 'detail' | 'save'>;
  others: OthersReader;
  nameOf: (characterId: string) => string;
  canEdit: () => boolean;
  /** The form beside holds unsaved changes. */
  unsaved: () => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
  errorText: (error: unknown) => string | null;
  disposed: () => boolean;
  /** The draft moved: the editor reads the role again. */
  reload: () => Promise<void>;
  /** Part 37c-1: does the dictionary hold exactly this term? */
  memeLookup?: (term: string) => Promise<boolean>;
};

const count = (text: string) => [...text].length;

export function speechPanel(parent: HTMLElement, deps: SpeechPanelDeps) {
  const { snapshot } = deps;
  const characterId = snapshot.characterId;
  const base = snapshot.draft?.profile ?? snapshot.published?.profile;
  const root = h('section', { class: 'sp-panel' });
  parent.append(root);
  if (!base) {
    root.append(h('p', { class: 'sp-empty', text: '这个角色还没有可编辑的版本。' }));
    return { root, refresh: () => {}, dispose: () => {} };
  }
  const target: DraftTarget = {
    base,
    revision: snapshot.draft?.revision ?? null,
    publishedVersion: snapshot.published?.version ?? null,
  };
  const template = base.template;
  const settings = settingsOf(template);
  const current = readCoreCard(template);
  const locked = () => !deps.canEdit() || deps.unsaved();
  /** The controls that are read-only while the section is locked (the 保存核心卡 button follows its own rule in sync()). */
  const lockables: { disabled: boolean }[] = [];
  /** Part 47: 一天的安排 (six parts) is checked on every input like the 核心卡. */
  const syncers: (() => void)[] = [];

  const message = h('p', { class: 'sp-error', attrs: { role: 'alert' }, hidden: true });
  const warn = h('div', { class: 'sp-warn', hidden: true, attrs: { role: 'status' } });
  const show = (text: string) => {
    message.textContent = text;
    message.hidden = text === '';
  };
  const lockNote = h('p', { class: 'sp-lock', hidden: true });
  const paintLock = () => {
    const off = locked();
    lockNote.hidden = !off || !deps.canEdit();
    lockNote.textContent = deps.unsaved() ? '本页有未保存的修改，先保存草稿，再改说话档案。' : '';
    for (const control of lockables) control.disabled = off;
    sync();
    for (const run of syncers) run();
    syncUse();
    paintUse();
  };

  /** One save of a changed template, with the independence check (a close line asks twice). */
  let warnedKey = '';
  async function commit(next: unknown, key: string, done: string) {
    show('');
    let result;
    try {
      result = await independence(deps.others, characterId, template, next);
    } catch {
      show(OTHERS_UNREADABLE_TEXT);
      return;
    }
    if (result.level === 'block') {
      warn.hidden = true;
      show(`这句话和别的角色太像了，不能保存。${independenceSentences(result, deps.nameOf).join('；')}`);
      return;
    }
    if (result.level === 'warn' && warnedKey !== key) {
      warnedKey = key;
      warn.hidden = false;
      warn.replaceChildren(
        h('b', { text: '和别的角色有点接近，再点一次保存才会存：' }),
        ...independenceSentences(result, deps.nameOf).map((sentence) => h('p', { text: sentence })),
      );
      return;
    }
    warnedKey = '';
    warn.hidden = true;
    const saved = await saveTemplate(deps.characters, characterId, target, next);
    deps.others.forget();
    deps.toast(`${done}（草稿 ${saved.revision}）。发布前玩家看不到。`, 'ok');
    await deps.reload();
  }
  const guarded = (work: () => Promise<void>) =>
    void deps.run(async () => {
      if (locked()) return;
      try {
        await work();
        adminConnection.forget(`speech-save:${characterId}`);
      } catch (caught) {
        // Part 59: a challenge page / lost connection / expired session: the typed text stays (and is kept in this browser); the
        // save is sent again by itself after the owner has verified or signed in again.
        if (isInterrupted(caught)) {
          kept?.keepNow();
          show(INTERRUPTED_LINE);
          adminConnection.retryAfterReauth(`speech-save:${characterId}`, () => guarded(work));
          return;
        }
        show(profileErrorText(caught) ?? deps.errorText(caught) ?? NOT_SAVED_TEXT);
      }
    });

  // ---- 核心卡 ----
  const card = h('div', { class: 'sp-card' });
  const boxes = new Map<CoreField, HTMLTextAreaElement>();
  const counters = new Map<CoreField, HTMLElement>();
  for (const field of CORE_FIELDS) {
    const editable = cardEditable(settings, field);
    const original = current[field];
    const box = h('textarea', {
      class: 'sp-text',
      attrs: { 'aria-label': CORE_FIELD_LABELS[field], rows: '3', 'data-sp': 'card', 'data-field': field },
    });
    box.value = original;
    if (!editable) box.disabled = true;
    else lockables.push(box);
    const counter = h('span', { class: 'sp-count' });
    boxes.set(field, box);
    counters.set(field, counter);
    const empty = original === '';
    card.append(
      h(
        'label',
        { class: 'sp-field' },
        h(
          'span',
          { class: 'sp-field-head' },
          h('b', { text: CORE_FIELD_LABELS[field] }),
          empty ? hoverValue(statusBadge('用现有设定', 'neutral'), '这一栏还没写，现在用角色已有的设定') : null,
          counter,
        ),
        box,
      ),
    );
    box.addEventListener('input', () => {
      warnedKey = '';
      warn.hidden = true;
      sync();
    });
  }
  const saveCard = h('button', {
    class: 'admin-primary',
    text: '保存核心卡',
    attrs: { type: 'button', 'data-sp': 'save' },
  });
  hoverValue(saveCard, '只存进草稿，发布后玩家才看得到');
  const changedFields = () => CORE_FIELDS.filter((field) => boxes.get(field)!.value !== current[field]);
  function sync() {
    for (const field of CORE_FIELDS) {
      const total = count(boxes.get(field)!.value.trim());
      const counter = counters.get(field)!;
      counter.textContent = `${total} / ${CORE_FIELD_MAX}`;
      counter.classList.toggle('is-over', total > CORE_FIELD_MAX);
    }
    const changed = changedFields();
    saveCard.disabled =
      locked() ||
      changed.length === 0 ||
      changed.some((field) => count(boxes.get(field)!.value.trim()) > CORE_FIELD_MAX);
  }
  saveCard.addEventListener('click', () =>
    guarded(async () => {
      let next: unknown = template;
      for (const field of changedFields())
        next = writeCoreCard(next as object, field, boxes.get(field)!.value.trim(), 'replace');
      await commit(
        next,
        `card:${changedFields()
          .map((f) => boxes.get(f)!.value)
          .join('|')}`,
        '核心卡已保存',
      );
    }),
  );

  // ---- 说话样本 ----
  const bank = readBank(template);
  const groups = h('div', { class: 'sp-groups' });
  const tags = [
    ...SPEECH_SITUATIONS,
    ...(bank.some((entry) => entry.situation === UNCATEGORIZED) ? [UNCATEGORIZED] : []),
  ];
  for (const tag of tags) {
    const entries = bank.filter((entry) => entry.situation === tag);
    const full = tag !== UNCATEGORIZED && entries.length >= EXAMPLES_PER_SITUATION_MAX;
    const head = h(
      'div',
      { class: 'sp-group-head' },
      h('b', { text: tag }),
      h('span', {
        class: `sp-count${full ? ' is-full' : ''}`,
        text: tag === UNCATEGORIZED ? `${entries.length} 条` : `${entries.length}/${EXAMPLES_PER_SITUATION_MAX}`,
        attrs: { 'data-count': tag },
      }),
    );
    if (tag === UNCATEGORIZED) hoverValue(head, '以前写的样本，还没有归到八个情境。选一个情境后才会按情境使用。');
    const list = h('ul', { class: 'sp-samples' });
    if (!entries.length) list.append(h('li', { class: 'sp-none', text: '还没有' }));
    for (const entry of entries) {
      const move = h('select', { attrs: { 'aria-label': '移到另一个情境', 'data-sp': 'move' } });
      move.append(h('option', { text: '移到…', attrs: { value: '' } }));
      for (const other of SPEECH_SITUATIONS)
        if (other !== tag) move.append(h('option', { text: other, attrs: { value: other } }));
      const remove = h('button', {
        class: 'admin-secondary',
        text: '删除',
        attrs: { type: 'button', 'data-sp': 'delete' },
      });
      lockables.push(move, remove);
      move.addEventListener('change', () => {
        const to = move.value;
        if (to)
          guarded(async () =>
            commit(moveSample(template, entry.index, to), `move:${entry.index}:${to}`, `已移到「${to}」`),
          );
      });
      remove.addEventListener('click', () =>
        guarded(async () => {
          const next = deleteSample(template, entry.index);
          const saved = await saveTemplate(deps.characters, characterId, target, next);
          deps.others.forget();
          deps.toast(`已删除（草稿 ${saved.revision}）。发布前玩家看不到。`, 'ok');
          await deps.reload();
        }),
      );
      list.append(
        h(
          'li',
          { class: 'sp-sample', attrs: { 'data-index': String(entry.index) } },
          h(
            'div',
            { class: 'sp-sample-text' },
            h('p', { class: 'sp-player', text: `玩家：${entry.example.player ?? ''}` }),
            ...(entry.example.reply ?? []).map((line) =>
              h('p', { class: 'sp-reply', text: `${deps.nameOf(characterId)}：${line}` }),
            ),
          ),
          h('div', { class: 'sp-sample-actions' }, move, remove),
        ),
      );
    }
    groups.append(h('section', { class: 'sp-group', attrs: { 'data-situation': tag } }, head, list));
  }

  // ---- 一天的安排 (Part 47): the six parts the owner adopted from 共创 or wrote; part of the settings, live only through 发布 ----
  const daily = readDailyLife(template);
  const dayBoxes = new Map<DayPart, HTMLTextAreaElement>();
  const dayCounters = new Map<DayPart, HTMLElement>();
  const dayCard = h('div', { class: 'sp-daily', attrs: { 'data-sp': 'daily' } });
  for (const part of DAY_PARTS) {
    const box = h('textarea', {
      class: 'sp-text',
      attrs: {
        'aria-label': DAY_PART_LABELS[part],
        rows: part === 'whole' ? '5' : '3',
        'data-sp': 'daily-part',
        'data-part': part,
      },
    });
    box.value = daily.parts[part];
    if (!daily.editable) box.disabled = true;
    else lockables.push(box);
    const counter = h('span', { class: 'sp-count' });
    dayBoxes.set(part, box);
    dayCounters.set(part, counter);
    dayCard.append(
      h(
        'label',
        { class: 'sp-field' },
        h('span', { class: 'sp-field-head' }, h('b', { text: DAY_PART_LABELS[part] }), counter),
        box,
      ),
    );
    box.addEventListener('input', () => syncDaily());
  }
  const saveDaily = h('button', {
    class: 'admin-primary',
    text: `保存${DAILY_LIFE_LABEL}`,
    attrs: { type: 'button', 'data-sp': 'save-daily' },
  });
  hoverValue(saveDaily, '只存进草稿，发布后玩家才看得到');
  const dayChanged = () => DAY_PARTS.filter((part) => dayBoxes.get(part)!.value.trim() !== daily.parts[part].trim());
  function syncDaily() {
    for (const part of DAY_PARTS) {
      const total = count(dayBoxes.get(part)!.value.trim());
      const counter = dayCounters.get(part)!;
      counter.textContent = `${total} / ${DAY_PART_MAX[part]}`;
      counter.classList.toggle('is-over', total > DAY_PART_MAX[part]);
    }
    const changed = dayChanged();
    saveDaily.disabled =
      locked() ||
      !daily.editable ||
      changed.length === 0 ||
      changed.some((part) => count(dayBoxes.get(part)!.value.trim()) > DAY_PART_MAX[part]);
  }
  syncers.push(syncDaily);
  saveDaily.addEventListener('click', () =>
    guarded(async () => {
      let next: unknown = template;
      for (const part of dayChanged())
        next = writeDailyPart(next as object, part, dayBoxes.get(part)!.value, 'replace');
      const saved = await saveTemplate(deps.characters, characterId, target, next);
      deps.others.forget();
      deps.toast(`${DAILY_LIFE_LABEL}已保存（草稿 ${saved.revision}）。发布前玩家看不到。`, 'ok');
      await deps.reload();
    }),
  );
  syncDaily();
  // ---- 网络梗 (Part 37c-1): the character's own use of the dictionary; 草稿 only, live with 发布 ----
  const savedUse = readMemeUse(template);
  let useLevel: MemeLevel = savedUse.level;
  const useOverrides: Record<string, MemeLevel> = { ...savedUse.overrides };
  const useChanged = () =>
    useLevel !== savedUse.level || JSON.stringify(sorted(useOverrides)) !== JSON.stringify(sorted(savedUse.overrides));
  const sorted = (record: Record<string, MemeLevel>) => Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));
  const levelSwitch = segmented<MemeLevel>(
    '默认档位',
    MEME_LEVELS.map((id) => ({ id, label: MEME_LEVEL_LABELS[id] })),
    useLevel,
    (id) => {
      useLevel = id;
      syncUse();
    },
    'm',
  );
  for (const button of levelSwitch.root.querySelectorAll('button')) lockables.push(button as HTMLButtonElement);
  hoverValue(
    levelSwitch.root,
    '会用：听得懂，也可能自己用 · 只懂：听得懂，自己不用 · 不碰：听得懂，自己不用，也不跟着玩',
  );
  const useList = h('ul', { class: 'mm-use-list', attrs: { 'aria-label': '单条设置' } });
  const useTerm = h('input', {
    attrs: { type: 'text', 'aria-label': '词', placeholder: '词（词库里的原词）', maxlength: '40' },
  });
  const useLevelPick = h('select', { attrs: { 'aria-label': '档位' } });
  for (const id of MEME_LEVELS) useLevelPick.append(h('option', { text: MEME_LEVEL_LABELS[id], attrs: { value: id } }));
  const useAdd = h('button', {
    class: 'admin-secondary',
    text: '添加',
    attrs: { type: 'button', 'data-sp': 'meme-add' },
  });
  const useSave = h('button', {
    class: 'admin-primary',
    text: '保存网络梗档位',
    attrs: { type: 'button', 'data-sp': 'meme-save' },
  });
  hoverValue(useSave, '只存进草稿，发布后玩家才看得到');
  lockables.push(useTerm, useLevelPick);
  const paintUse = () => {
    useList.replaceChildren(
      ...sorted(useOverrides).map(([term, level]) => {
        const pick = h('select', { attrs: { 'aria-label': `「${term}」的档位` } });
        for (const id of MEME_LEVELS) pick.append(h('option', { text: MEME_LEVEL_LABELS[id], attrs: { value: id } }));
        pick.value = level;
        pick.disabled = locked();
        pick.addEventListener('change', () => {
          useOverrides[term] = pick.value as MemeLevel;
          syncUse();
        });
        const drop = h('button', {
          class: 'admin-secondary',
          text: '删除',
          attrs: { type: 'button', 'aria-label': `删除「${term}」的单条设置` },
        });
        drop.disabled = locked();
        drop.addEventListener('click', () => {
          delete useOverrides[term];
          paintUse();
          syncUse();
        });
        return h('li', { class: 'mm-use-item', attrs: { 'data-term': term } }, h('b', { text: term }), pick, drop);
      }),
    );
  };
  function syncUse() {
    useSave.disabled = locked() || !useChanged();
    useAdd.disabled = locked() || !deps.memeLookup;
  }
  useAdd.addEventListener('click', () =>
    guarded(async () => {
      const term = useTerm.value.trim();
      if (term === '') return;
      if (Object.keys(useOverrides).length >= MEME_OVERRIDES_MAX && !(term in useOverrides)) {
        show(`单条设置最多 ${MEME_OVERRIDES_MAX} 条。`);
        return;
      }
      if (!(await deps.memeLookup!(term))) {
        show('词库里没有这个词，请核对后再添加（要和词库里的原词一样）。');
        return;
      }
      show('');
      useOverrides[term] = useLevelPick.value as MemeLevel;
      useTerm.value = '';
      paintUse();
      syncUse();
    }),
  );
  useSave.addEventListener('click', () =>
    guarded(async () => {
      await commit(
        writeMemeUse(template, { level: useLevel, overrides: { ...useOverrides } }),
        `meme:${useLevel}`,
        '网络梗档位已保存',
      );
    }),
  );
  const memeSection = h(
    'section',
    { class: 'mm-use', attrs: { 'data-sp': 'memes' } },
    hoverValue(h('h3', { class: 'sp-title', text: '网络梗' }), '词义是共享的；这里只设置这个角色怎么对待它们。'),
    h('div', { class: 'mm-use-row' }, h('span', { class: 'mm-use-label', text: '默认档位' }), levelSwitch.root),
    h('h4', { class: 'sp-title', text: '单条设置' }),
    useList,
    h('div', { class: 'mm-use-add' }, useTerm, useLevelPick, useAdd),
    h('div', { class: 'sp-actions' }, useSave),
  );
  paintUse();

  root.append(
    hoverValue(h('h3', { class: 'sp-title', text: '核心卡' }), '没写的栏目，就用角色现有的设定。'),
    card,
    h('div', { class: 'sp-actions' }, saveCard),
    h('h3', { class: 'sp-title', text: '说话样本' }),
    groups,
    h('h3', { class: 'sp-title', text: DAILY_LIFE_LABEL }),
    dayCard,
    h('div', { class: 'sp-actions' }, saveDaily),
    memeSection,
    lockNote,
    warn,
    message,
  );
  paintLock();
  // Part 59: what is typed in this section is kept in this browser until it is saved (loses nothing on a reload or a failed save).
  const kept = panelKeeper(
    root,
    {
      page: 'characters',
      character: characterId,
      section: 'speech',
      revision: snapshot.draft?.revision ?? `v${snapshot.published?.version ?? 0}`,
    },
    plainEl,
  );
  const offer = kept.bar();
  if (offer) root.prepend(offer);
  return { root, refresh: paintLock, dispose: () => kept.stop() };
}
