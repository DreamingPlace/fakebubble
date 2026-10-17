/**
 * Part 21b (PLAYER_MODEL_CHOICE_ENABLED): the model picker. A self-contained module: the page reaches it through three small
 * hooks (a menu entry, the footer line, the "answered by the backup model" note). It only exists for a signed-up player with
 * a points account; guests never see it. Prices and names come from the one table in packages/contracts/player-models.ts.
 */
import {
  PLAYER_MODELS,
  billedModel,
  type ModelChoiceInfo,
  type PlayerModelId,
} from '../../../../../packages/contracts/player-models.ts';
import { h } from '../cocreation/h.ts';

export const modelCopy = {
  menuTitle: '写回复的模型',
  /** The entry of the chat's ⋯ menu. */
  menuLabel: '切换回复模型',
  menuSub: (info: ModelChoiceInfo) =>
    info.metered
      ? `${PLAYER_MODELS[info.selected].label} · ${modelCopy.perMessage(pointsOf(info, info.selected))}`
      : PLAYER_MODELS[info.selected].label,
  perMessage: (points: number) => `约 ${points} 点/条`,
  voice: (points: number) => `语音 +${points}`,
  current: '当前',
  balance: (points: number, messages: number) => `剩余 ${points} 点 · 约可聊 ${messages} 条`,
  confirm: (label: string, points: number, voicePoints: number) =>
    `之后的消息用 ${label}，约 ${points} 点/条（语音 +${voicePoints}）。记忆和聊天记录不变。`,
  /** Invited players are not charged: no prices. */
  confirmFree: (label: string) => `之后的消息用 ${label}。记忆和聊天记录不变。`,
  confirmButton: '确认切换',
  cancelButton: '取消',
  close: '关闭',
  /** "{chosen} 繁忙，由 {actual} 回复 · 按 {billed} 计费"; an invited player is not billed, so no billing clause. */
  backup: (chosen: PlayerModelId, actual: PlayerModelId, metered: boolean, billed?: PlayerModelId) =>
    `${PLAYER_MODELS[chosen].label} 繁忙，由 ${PLAYER_MODELS[actual].label} 回复${
      // The server names the billed model at the operation's own price version; the constant rule is only the fallback.
      metered ? ` · 按 ${PLAYER_MODELS[billed ?? billedModel(chosen, actual)].label} 计费` : ''
    }`,
  withdrawn: '之前选的模型暂时不提供了，已改用 DeepSeek',
  switched: (label: string) => `已切换为 ${label}`,
  failed: '没能切换，稍后再试试',
};

const pointsOf = (info: ModelChoiceInfo, id: PlayerModelId) =>
  info.models.find((entry) => entry.id === id)?.points ?? 0;

/** The footer line while the picker is on: replaces the old "free replies" count. */
export const modelFooterNote = (info: ModelChoiceInfo) => modelCopy.balance(info.balance, info.repliesLeft);

/** The entry of the chat's ⋯ menu. */
export function modelMenuItem(info: ModelChoiceInfo, open: () => void) {
  return { label: modelCopy.menuLabel, sub: modelCopy.menuSub(info), onSelect: open };
}

/** The small note under a reply that a backup model wrote. Plain text; no error, no retry. Ordinary replies get none. */
export function backupNote(
  backup: { chosen: PlayerModelId; actual: PlayerModelId; billed?: PlayerModelId },
  metered: boolean,
) {
  return h('span', {
    class: 'backup-note',
    text: modelCopy.backup(backup.chosen, backup.actual, metered, backup.billed),
  });
}

export interface ModelPickerOptions {
  info: ModelChoiceInfo;
  api: { setModel(model: PlayerModelId): Promise<ModelChoiceInfo> };
  /** Called with the new state after a successful switch. */
  onChanged(info: ModelChoiceInfo): void;
  say?: (message: string) => void;
  mount?: HTMLElement;
}

export function openModelPicker(options: ModelPickerOptions) {
  const { api } = options;
  let info = options.info;
  const mountPoint = options.mount ?? document.body;
  const opener = document.activeElement as HTMLElement | null;
  const title = h('strong', { class: 'acct-title', text: modelCopy.menuTitle, attrs: { id: 'mp-title' } });
  const closeButton = h('button', {
    class: 'acct-close icon-button',
    attrs: { type: 'button', 'aria-label': modelCopy.close },
    text: '×',
  });
  const balance = h('p', { class: 'mp-balance', attrs: { role: 'status', 'aria-live': 'polite' } });
  const body = h('div', { class: 'acct-body mp-body' });
  const status = h('p', { class: 'acct-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const sheet = h(
    'div',
    { class: 'acct-sheet mp-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mp-title' } },
    h('header', { class: 'acct-head' }, title, closeButton),
    h('div', { class: 'acct-body' }, balance),
    body,
    status,
  );
  let closed = false;
  let busy = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.remove();
    document.removeEventListener?.('keydown', onKey, true);
    opener?.focus?.();
  };
  function onKey(event: Event) {
    if ((event as KeyboardEvent).key === 'Escape') close();
  }

  const list = () => {
    balance.textContent = info.metered ? modelFooterNote(info) : '';
    balance.hidden = !info.metered;
    status.textContent = '';
    body.replaceChildren(
      ...info.models.map((entry) => {
        const model = PLAYER_MODELS[entry.id];
        const selected = entry.id === info.selected;
        const card = h(
          'button',
          {
            class: `mp-card${selected ? ' is-current' : ''}`,
            attrs: { type: 'button', 'aria-pressed': String(selected), 'data-model': entry.id },
          },
          h(
            'span',
            { class: 'mp-name' },
            model.label,
            selected ? h('i', { class: 'mp-tag', text: modelCopy.current }) : null,
          ),
          h('span', { class: 'mp-blurb', text: model.blurb }),
          h('span', { class: 'mp-speed', text: model.speed }),
          info.metered
            ? h(
                'span',
                { class: 'mp-prices' },
                h('b', { text: modelCopy.perMessage(entry.points) }),
                h('b', { text: modelCopy.voice(entry.voicePoints) }),
              )
            : null,
        );
        card.addEventListener('click', () => {
          if (!selected && !busy) confirm(entry.id);
        });
        return card;
      }),
    );
  };

  const confirm = (id: PlayerModelId) => {
    const entry = info.models.find((item) => item.id === id)!;
    const sure = h('button', { class: 'acct-primary', attrs: { type: 'button' }, text: modelCopy.confirmButton });
    const back = h('button', { class: 'acct-link', attrs: { type: 'button' }, text: modelCopy.cancelButton });
    back.addEventListener('click', list);
    sure.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      sure.disabled = true;
      try {
        info = await api.setModel(id);
        options.onChanged(info);
        options.say?.(modelCopy.switched(PLAYER_MODELS[id].label));
        close();
      } catch {
        status.textContent = modelCopy.failed;
        sure.disabled = false;
      } finally {
        busy = false;
      }
    });
    body.replaceChildren(
      h('p', {
        class: 'acct-intro mp-confirm',
        text: info.metered
          ? modelCopy.confirm(PLAYER_MODELS[id].label, entry.points, entry.voicePoints)
          : modelCopy.confirmFree(PLAYER_MODELS[id].label),
        attrs: { role: 'status' },
      }),
      h('div', { class: 'acct-links' }, back, sure),
    );
    sure.focus?.();
  };

  closeButton.addEventListener('click', close);
  document.addEventListener?.('keydown', onKey, true);
  list();
  mountPoint.append(sheet);
  (body.querySelector('.mp-card.is-current') as HTMLElement | null)?.focus?.();
  return { close, element: sheet };
}
