import {
  MODEL_LIMITS,
  MODEL_TIER_LABELS,
  emptyTiers,
  type ModelAdminView,
  type ModelChangeView,
  type ModelSaveInput,
  type ModelSetting,
  type SettingField,
} from '../../../../../packages/contracts/model-settings.ts';
import type { PlayerModelId } from '../../../../../packages/contracts/player-models.ts';
import { h } from '../cocreation/h.ts';
import { statusBadge } from './ui/status-badge.ts';
import { hoverValue } from './ui/hover-value.ts';
import type { ConfirmInPlace } from './ui/inline-confirm.ts';
import { fillStatus, pageHead } from './ui/page-head.ts';
import { markDirty, unsavedText } from './ui/unsaved.ts';

const FIELD_LABELS: Record<SettingField, string> = {
  enabled: '总开关',
  allowed_guest: '游客',
  allowed_registered: '注册玩家',
  allowed_invited: '受邀玩家',
  points_per_reply: '每条点数',
  voice_points: '语音加点',
};
const isSwitch = (field: SettingField) =>
  field === 'enabled' || field === 'allowed_guest' || field === 'allowed_registered' || field === 'allowed_invited';
const valueText = (field: SettingField, value: number) => (isSwitch(field) ? (value ? '开' : '关') : `${value} 点`);
const when = (at: number) => {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${two(date.getHours())}:${two(date.getMinutes())}`;
};
/** One line of the 最近修改 list: no ids, no emails - the administrator's label, the model, the field, before → after. */
export const changeLine = (change: ModelChangeView, labels: Readonly<Record<PlayerModelId, string>>) =>
  `${when(change.at)} · ${change.admin} · ${change.model ? `${labels[change.model]} ` : ''}${FIELD_LABELS[change.field]}：${valueText(change.field, change.from)} → ${valueText(change.field, change.to)}`;

type Draft = { models: ModelSetting[]; voicePoints: number };
const copy = (view: Draft): Draft => ({
  models: view.models.map((m) => ({
    model: m.model,
    enabled: m.enabled,
    guest: m.guest,
    registered: m.registered,
    invited: m.invited,
    points: m.points,
  })),
  voicePoints: view.voicePoints,
});

/** What differs between the saved table and the draft, as lines for the confirmation. */
export function describeChanges(saved: Draft, draft: Draft, labels: Readonly<Record<PlayerModelId, string>>): string[] {
  const lines: string[] = [];
  const keys = [
    ['enabled', 'enabled'],
    ['guest', 'allowed_guest'],
    ['registered', 'allowed_registered'],
    ['invited', 'allowed_invited'],
    ['points', 'points_per_reply'],
  ] as const;
  for (const next of draft.models) {
    const before = saved.models.find((m) => m.model === next.model)!;
    for (const [key, field] of keys)
      if (before[key] !== next[key]) {
        const a = Number(before[key]),
          b = Number(next[key]);
        lines.push(`${labels[next.model]} · ${FIELD_LABELS[field]}：${valueText(field, a)} → ${valueText(field, b)}`);
      }
  }
  if (saved.voicePoints !== draft.voicePoints)
    lines.push(
      `语音加点：${valueText('voice_points', saved.voicePoints)} → ${valueText('voice_points', draft.voicePoints)}`,
    );
  return lines;
}

/**
 * 系统 → 模型与价格. One table: rows are models, columns the master switch, the three tiers, points per message and the
 * environment status (未配置 = outside PLAYER_TEXT_MODELS or without its API key; 可用 otherwise), then the voice price, one
 * 保存 with a confirmation that lists the changes, and the 最近修改 list. Any administrator may read; the owner and anyone
 * holding models.manage may save (the server decides; the controls only follow `canManage`).
 */
export function modelsView(
  root: HTMLElement,
  deps: {
    load: () => Promise<ModelAdminView>;
    save: (input: ModelSaveInput) => Promise<unknown>;
    run: (work: () => Promise<void>) => Promise<void>;
    /** 保存 opens the list of changes in place (no dialog); 确认保存 is its confirm button. */
    confirm: ConfirmInPlace;
    toast: (text: string) => void;
    newRequestId: () => string;
    disposed: () => boolean;
  },
) {
  let view: ModelAdminView | null = null;
  let draft: Draft | null = null;
  // A save whose outcome was never seen is retried under the same request id, so it can never apply twice.
  let pending: { id: string; signature: string } | null = null;
  const labels = (): Record<PlayerModelId, string> =>
    Object.fromEntries((view?.models ?? []).map((m) => [m.model, m.label])) as Record<PlayerModelId, string>;

  const banner = h('p', { class: 'admin-hint models-banner', attrs: { role: 'status' } });
  const headStatus = h('span', { class: 'head-status' });
  const confirmHost = h('div', { class: 'models-confirm' });
  const problem = h('p', { class: 'admin-hint models-problem', attrs: { role: 'alert' }, hidden: true });
  const body = h('tbody');
  const foot = h('tfoot');
  const table = h(
    'table',
    { class: 'admin-table models-table', attrs: { 'aria-label': '模型与价格' } },
    h('caption', { text: '模型与价格' }),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...['模型', '总开关', '游客', '注册玩家', '受邀玩家', '每条点数', '状态', '最近修改'].map((label) =>
          h('th', { text: label, attrs: { scope: 'col' } }),
        ),
      ),
    ),
    body,
    foot,
  );
  const voiceInput = h('input', {
    attrs: {
      id: 'models-voice',
      type: 'number',
      inputmode: 'numeric',
      min: String(MODEL_LIMITS.voiceMin),
      max: String(MODEL_LIMITS.voiceMax),
      step: '1',
    },
  });
  const saveButton = h('button', {
    class: 'admin-primary',
    text: '保存',
    attrs: { type: 'button', id: 'models-save' },
  });
  const readonly = h('p', {
    class: 'admin-hint',
    text: '只读：需要“模型与价格”管理权限',
    hidden: true,
  });

  root.replaceChildren(
    pageHead('模型与价格', headStatus, saveButton),
    banner,
    confirmHost,
    readonly,
    problem,
    h('div', { class: 'models-card' }, table),
  );

  const signature = () => JSON.stringify(draft);
  const changes = () => (view && draft ? describeChanges(view, draft, labels()) : []);
  const invalid = (): string | null => {
    if (!draft) return null;
    for (const m of draft.models)
      if (!Number.isSafeInteger(m.points) || m.points < MODEL_LIMITS.pointsMin || m.points > MODEL_LIMITS.pointsMax)
        return `每条点数需要是 ${MODEL_LIMITS.pointsMin}–${MODEL_LIMITS.pointsMax} 的整数。`;
    if (
      !Number.isSafeInteger(draft.voicePoints) ||
      draft.voicePoints < MODEL_LIMITS.voiceMin ||
      draft.voicePoints > MODEL_LIMITS.voiceMax
    )
      return `语音加点需要是 ${MODEL_LIMITS.voiceMin}–${MODEL_LIMITS.voiceMax} 的整数。`;
    const empty = emptyTiers(draft.models);
    if (empty.length)
      return `${empty.map((tier) => MODEL_TIER_LABELS[tier]).join('、')}至少要保留一个已开启的模型，不能全部关闭。`;
    return null;
  };
  const refreshControls = () => {
    const manage = !!view?.canManage;
    const dirty = changes().length > 0;
    const message = dirty ? invalid() : null;
    problem.hidden = !message;
    problem.textContent = message ?? '';
    saveButton.hidden = !manage;
    saveButton.disabled = !manage || !dirty || !!message;
    // The page re-enables controls after every request; a lock is what keeps 保存 off until something changed.
    saveButton.dataset.locked = String(saveButton.disabled);
    readonly.hidden = !view || manage;
    voiceInput.disabled = !manage;
    const n = changes().length;
    // 保存 says how many changes it will save (and is off until there is one).
    saveButton.textContent = n > 0 ? `保存 ${n} 处改动` : '保存';
    const pill = h('span', {
      class: view?.featureOn ? 'models-pill is-on' : 'models-pill',
      text: `玩家选模型 · ${view?.featureOn ? '开' : '关'}`,
    });
    hoverValue(pill, 'PLAYER_MODEL_CHOICE_ENABLED');
    fillStatus(headStatus, view ? pill : null, n > 0 ? h('span', { class: 'is-warn', text: unsavedText(n) }) : null);
    // A changed value is amber until it is saved.
    if (view && draft) {
      for (const input of body.querySelectorAll<HTMLInputElement>('input[data-model]')) {
        const model = input.dataset.model!;
        const field = input.dataset.field!;
        const now = draft.models.find((m) => m.model === model);
        const before = view.models.find((m) => m.model === model);
        if (!now || !before) continue;
        const key = field as 'enabled' | 'guest' | 'registered' | 'invited' | 'points';
        markDirty(input, now[key] !== before[key]);
      }
      markDirty(voiceInput, draft.voicePoints !== view.voicePoints);
    }
  };

  /** 最近修改 of a row: the UTC day and who; the whole line (before → after) is the hover. */
  function lastChange(change: ModelChangeView | undefined): Node {
    if (!change) return h('span', { class: 'models-at', text: '—' });
    const node = h('span', {
      class: 'models-at',
      text: `${new Date(change.at).toISOString().slice(5, 10)} · ${change.admin}`,
    });
    return hoverValue(node, changeLine(change, labels()));
  }
  function cell(label: string, ...children: Node[]) {
    return h('td', { attrs: { 'data-label': label } }, ...children);
  }
  function paint() {
    if (!view || !draft) return;
    // Only a warning that changes what the administrator should do: while the switch is off the table has no effect on players.
    // The title row carries the state (玩家选模型 · 开 / 关); the sentence stays for screen readers.
    banner.textContent = view.featureOn ? '' : '玩家选模型未开启（PLAYER_MODEL_CHOICE_ENABLED）';
    banner.hidden = true;
    body.replaceChildren();
    for (const entry of draft.models) {
      const info = view.models.find((m) => m.model === entry.model)!;
      const box = (key: 'enabled' | 'guest' | 'registered' | 'invited', label: string) => {
        const input = h('input', {
          attrs: {
            type: 'checkbox',
            'aria-label': `${info.label} · ${label}`,
            'data-model': entry.model,
            'data-field': key,
          },
        });
        input.checked = entry[key];
        input.disabled = !view!.canManage;
        input.addEventListener('change', () => {
          entry[key] = input.checked;
          refreshControls();
        });
        return cell(label, input);
      };
      const points = h('input', {
        attrs: {
          type: 'number',
          inputmode: 'numeric',
          min: String(MODEL_LIMITS.pointsMin),
          max: String(MODEL_LIMITS.pointsMax),
          step: '1',
          'aria-label': `${info.label} · 每条点数`,
          'data-model': entry.model,
          'data-field': 'points',
        },
      });
      points.value = String(entry.points);
      points.disabled = !view.canManage;
      points.addEventListener('input', () => {
        entry.points = points.value.trim() === '' ? Number.NaN : Number(points.value);
        refreshControls();
      });
      body.append(
        h(
          'tr',
          { attrs: { 'data-model': entry.model } },
          h('th', { text: info.label, attrs: { scope: 'row' } }),
          box('enabled', '总开关'),
          box('guest', '游客'),
          box('registered', '注册玩家'),
          box('invited', '受邀玩家'),
          cell('每条点数', points),
          cell('状态', info.configured ? statusBadge('可用', 'ok') : statusBadge('未配置', 'warn')),
          cell('最近修改', lastChange(view.recent.find((c) => c.model === entry.model))),
        ),
      );
    }
    voiceInput.value = String(draft.voicePoints);
    foot.replaceChildren(
      h(
        'tr',
        { class: 'models-voice' },
        h('th', { text: '语音加点', attrs: { scope: 'row' } }),
        cell(''),
        cell(''),
        cell(''),
        cell(''),
        cell('语音加点', voiceInput, h('span', { class: 'models-unit', text: '每条' })),
        cell(''),
        cell('最近修改', lastChange(view.recent.find((c) => c.field === 'voice_points'))),
      ),
    );
    refreshControls();
  }
  voiceInput.addEventListener('input', () => {
    if (!draft) return;
    draft.voicePoints = voiceInput.value.trim() === '' ? Number.NaN : Number(voiceInput.value);
    refreshControls();
  });

  async function load() {
    const next = await deps.load();
    if (deps.disposed()) return;
    view = next;
    draft = copy(next);
    pending = null;
    paint();
  }
  saveButton.addEventListener(
    'click',
    () =>
      void deps.run(async () => {
        if (!view || !draft || !view.canManage) return;
        const lines = changes();
        if (!lines.length || invalid()) return;
        const ok = await deps.confirm(
          {
            title: '确认保存模型与价格',
            message: `将保存以下 ${lines.length} 项修改，下一条消息起生效：\n${lines.map((line) => `· ${line}`).join('\n')}`,
            confirmLabel: '确认保存',
          },
          confirmHost,
        );
        if (!ok || deps.disposed()) return;
        const sig = signature();
        if (!pending || pending.signature !== sig) pending = { id: deps.newRequestId(), signature: sig };
        await deps.save({
          requestId: pending.id,
          expectedRevision: view.revision,
          models: copy(draft).models,
          voicePoints: draft.voicePoints,
        });
        pending = null;
        deps.toast('已保存');
        await load();
      }),
  );
  return {
    load,
    clear() {
      view = null;
      draft = null;
      pending = null;
      body.replaceChildren();
      foot.replaceChildren();
    },
  };
}
