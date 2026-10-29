import type {
  PointsGrantResult,
  PointsLookup,
  PointsPreview,
  PointsResetResult,
  PointsSkipped,
  PointsTarget,
} from '../../../../../packages/contracts/web-system.ts';
import {
  COCREATION_POINTS_LIMITS,
  cocreationPointsOk,
  type CocreationPointsSettings,
} from '../../../../../packages/contracts/cocreation-cards.ts';
import { POINTS_GRANT_LIMITS } from '../../../../../packages/contracts/web-system.ts';
import { h, length } from '../cocreation/h.ts';
import { dollars } from './system-format.ts';
import { dangerZone } from './ui/danger-zone.ts';
import { hoverValue } from './ui/hover-value.ts';
import type { ConfirmInPlace } from './ui/inline-confirm.ts';
import { pageHead } from './ui/page-head.ts';
import { markDirty } from './ui/unsaved.ts';

const TIER_LABELS = {
  guest: '访客',
  registered: '注册玩家',
  daily_refill: '每日补充',
  unlimited: '不限量',
  account: '账号',
} as const;
const lookupLine = (player: PointsLookup) =>
  `玩家编号 ${player.playerNumber} · ${TIER_LABELS[player.tier]} · 余额 ${player.balance === null ? '还没有' : `${player.balance} 点`}`;
/** "跳过：访客 a · 不限量 b · 已达上限 c" - only the counts that are not zero; empty text when nothing was skipped. */
const skippedText = (skipped: PointsSkipped & { alreadyFull?: number }) => {
  const parts = [
    skipped.guests > 0 ? `访客 ${skipped.guests}` : null,
    skipped.unlimited > 0 ? `不限量 ${skipped.unlimited}` : null,
    skipped.atCap > 0 ? `已达上限 ${skipped.atCap}` : null,
    skipped.alreadyFull ? `已不低于目标 ${skipped.alreadyFull}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? `跳过：${parts.join(' · ')}` : '没有跳过任何人';
};

type Kind = PointsTarget['kind'];
/**
 * 玩家 → 积分发放. Pick who (everyone registered, one tier, one exact 玩家编号 or one exact email typed in full), an amount of
 * 1–10000 points and an optional note, then 发放: the server answers what it WOULD do and a confirmation shows the number of
 * players and the total points before anything is written. An email is only ever sent, never echoed back: the answer is the
 * 玩家编号, the tier and the balance. 重置全部额度 is the owner's alone.
 */
export function pointsView(
  root: HTMLElement,
  deps: {
    preview: (target: PointsTarget, amount: number) => Promise<PointsPreview>;
    grant: (input: {
      requestId: string;
      target: PointsTarget;
      amount: number;
      note: string;
    }) => Promise<PointsGrantResult>;
    resetPreview: () => Promise<PointsResetResult>;
    reset: (requestId: string) => Promise<PointsResetResult>;
    /** Part 24c: the three numbers of points for co-creation notes. Without them the form is not on the page. */
    cocreation?: {
      read: () => Promise<CocreationPointsSettings & { revision: number }>;
      save: (
        input: CocreationPointsSettings & { expectedRevision: number },
      ) => Promise<CocreationPointsSettings & { revision: number }>;
    };
    isOwner: () => boolean;
    run: (work: () => Promise<void>) => Promise<void>;
    /** The question opens in place, inside the host it is given (no dialog). */
    confirm: ConfirmInPlace;
    /** How long 重置全部额度 has to be held (default 1.5 s); tests shorten it. */
    holdMs?: number;
    toast: (text: string) => void;
    newRequestId: () => string;
    disposed: () => boolean;
    /** How long typing must pause before the live count asks the server (default 350 ms). */
    debounceMs?: number;
    /** The words for a refused or failed count (default: —). */
    errorText?: (error: unknown) => string;
  },
) {
  const pending = new Map<string, string>();
  const requestId = (key: string) => {
    const held = pending.get(key) ?? deps.newRequestId();
    pending.set(key, held);
    return held;
  };
  const radio = (value: Kind, label: string, checked = false) => {
    const input = h('input', { attrs: { type: 'radio', name: 'points-target', value, id: `points-kind-${value}` } });
    input.checked = checked;
    return { input, kind: value, node: h('label', { class: 'points-kind' }, input, ` ${label}`) };
  };
  const kinds = [
    radio('all', '全部注册玩家', true),
    radio('tier', '某一档'),
    radio('player', '一个玩家编号'),
    radio('email', '一个邮箱'),
  ];
  const tier = h('select', { attrs: { id: 'points-tier', 'aria-label': '档位' } });
  tier.append(
    h('option', { text: '注册玩家', attrs: { value: 'registered' } }),
    h('option', { text: '每日补充', attrs: { value: 'daily_refill' } }),
  );
  const number = h('input', {
    attrs: {
      id: 'points-number',
      maxlength: '8',
      autocomplete: 'off',
      placeholder: '8 位玩家编号',
      'aria-label': '玩家编号',
    },
  });
  const email = h('input', {
    attrs: {
      id: 'points-email',
      type: 'text',
      inputmode: 'email',
      maxlength: '254',
      autocomplete: 'off',
      placeholder: '完整邮箱地址',
      'aria-label': '玩家邮箱',
    },
  });
  const amount = h('input', {
    attrs: {
      id: 'points-amount',
      type: 'number',
      inputmode: 'numeric',
      min: String(POINTS_GRANT_LIMITS.min),
      max: String(POINTS_GRANT_LIMITS.max),
      step: '1',
      'aria-label': '点数（1–10000）',
    },
  });
  const note = h('input', {
    attrs: {
      id: 'points-note',
      maxlength: String(POINTS_GRANT_LIMITS.noteMax),
      autocomplete: 'off',
      'aria-label': '备注',
    },
  });
  const send = h('button', { class: 'admin-primary', text: '发放', attrs: { type: 'button', id: 'points-send' } });
  const confirmHost = h('div', { class: 'points-confirm' });
  const problem = h('p', { class: 'admin-hint models-problem', attrs: { role: 'alert' }, hidden: true });
  const outcome = h('div', { class: 'system-result', attrs: { role: 'status' } });
  const resetBox = h('section', { class: 'system-section' });

  const target = (): PointsTarget | string => {
    const kind = kinds.find((k) => k.input.checked)?.kind ?? 'all';
    if (kind === 'all') return { kind };
    if (kind === 'tier') return { kind, tier: tier.value as 'registered' | 'daily_refill' };
    if (kind === 'player') {
      const value = number.value.trim().toUpperCase();
      return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(value) ? { kind, playerNumber: value } : '请填写完整的 8 位玩家编号。';
    }
    const value = email.value.trim();
    return value.includes('@') ? { kind, email: value } : '请填写完整的邮箱地址。';
  };
  /** The first thing wrong with the inputs, or null; touches nothing on the page. */
  const validate = (): string | null => {
    const to = target();
    const points = Number(amount.value);
    const note_ = note.value.trim();
    return typeof to === 'string'
      ? to
      : !Number.isSafeInteger(points) || points < POINTS_GRANT_LIMITS.min || points > POINTS_GRANT_LIMITS.max
        ? `点数需要是 ${POINTS_GRANT_LIMITS.min}–${POINTS_GRANT_LIMITS.max} 的整数。`
        : length(note_) > POINTS_GRANT_LIMITS.noteMax
          ? `备注最多 ${POINTS_GRANT_LIMITS.noteMax} 个字。`
          : null;
  };
  const parsed = () => {
    const to = target();
    const points = Number(amount.value);
    const note_ = note.value.trim();
    const message =
      typeof to === 'string'
        ? to
        : !Number.isSafeInteger(points) || points < POINTS_GRANT_LIMITS.min || points > POINTS_GRANT_LIMITS.max
          ? `点数需要是 ${POINTS_GRANT_LIMITS.min}–${POINTS_GRANT_LIMITS.max} 的整数。`
          : length(note_) > POINTS_GRANT_LIMITS.noteMax
            ? `备注最多 ${POINTS_GRANT_LIMITS.noteMax} 个字。`
            : null;
    problem.hidden = !message;
    problem.textContent = message ?? '';
    return message ? null : { to: to as PointsTarget, points, note: note_ };
  };
  const everyone = h('span', { class: 'pt-all', text: '全部注册玩家' });
  const refreshFields = () => {
    const kind = kinds.find((k) => k.input.checked)?.kind;
    everyone.hidden = kind !== 'all';
    tier.hidden = kind !== 'tier';
    number.hidden = kind !== 'player';
    email.hidden = kind !== 'email';
  };
  for (const k of kinds) k.input.addEventListener('change', refreshFields);
  refreshFields();

  const live = h('div', { class: 'points-live', attrs: { role: 'status' } });
  const liveText = (preview: PointsPreview) =>
    [
      preview.player ? lookupLine(preview.player) : null,
      `将发给 ${preview.granted} 位玩家，共 ${preview.totalPoints} 点。${skippedText(preview.skipped)}。`,
    ]
      .filter(Boolean)
      .join('\n');
  const showPreview = (preview: PointsPreview) => {
    live.textContent = liveText(preview);
  };
  // The number of players who would receive points follows the inputs (debounced); this is the same server question 发放 asks.
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  let liveSeq = 0;
  const refreshLive = () => {
    if (liveTimer !== null) clearTimeout(liveTimer);
    const seq = ++liveSeq;
    if (validate() !== null) {
      live.textContent = '';
      return;
    }
    liveTimer = setTimeout(async () => {
      liveTimer = null;
      const input = parsed();
      if (!input) return;
      try {
        const preview = await deps.preview(input.to, input.points);
        if (seq === liveSeq && !deps.disposed()) showPreview(preview);
      } catch (error) {
        if (seq === liveSeq && !deps.disposed()) live.textContent = deps.errorText?.(error) ?? '—';
      }
    }, deps.debounceMs ?? 350);
    (liveTimer as { unref?: () => void }).unref?.();
  };
  for (const input of [number, email, amount, note, tier]) {
    input.addEventListener('input', refreshLive);
    input.addEventListener('change', refreshLive);
  }
  for (const k of kinds) k.input.addEventListener('change', refreshLive);
  send.addEventListener(
    'click',
    () =>
      void deps.run(async () => {
        const input = parsed();
        if (!input) return;
        const preview = await deps.preview(input.to, input.points);
        if (deps.disposed()) return;
        showPreview(preview);
        if (preview.granted === 0) {
          deps.toast('没有可以发放的玩家。');
          return;
        }
        const ok = await deps.confirm(
          {
            title: '确认积分发放',
            message: `${preview.player ? `${lookupLine(preview.player)}。` : ''}将发给 ${preview.granted} 位玩家，共 ${preview.totalPoints} 点（每人最多 ${input.points} 点）。${skippedText(preview.skipped)}。`,
            confirmLabel: '确认发放',
          },
          confirmHost,
        );
        if (!ok || deps.disposed()) return;
        // The same request id for the same content until an answer is seen, so a retry can never give twice.
        const key = JSON.stringify([
          input.to.kind === 'email' ? 'email' : input.to,
          input.points,
          input.note,
          preview.totalPoints,
        ]);
        const done = await deps.grant({
          requestId: requestId(key),
          target: input.to,
          amount: input.points,
          note: input.note,
        });
        pending.delete(key);
        outcome.replaceChildren(
          h('strong', { text: '发放结果' }),
          h('p', { text: `已发给 ${done.granted} 位玩家，共 ${done.totalPoints} 点。${skippedText(done.skipped)}。` }),
        );
        email.value = '';
        live.textContent = '';
        deps.toast('已发放');
      }),
  );

  const resetOutcome = h('div', { class: 'system-result', attrs: { role: 'status' } });
  const resetZone = dangerZone({
    open: '重置全部额度',
    openerId: 'points-reset',
    impact: async () => {
      const preview = await deps.resetPreview();
      const cost = preview.worstCaseMicros === null ? '暂无数据' : dollars(preview.worstCaseMicros);
      return [
        { n: String(preview.affected), label: '个账号会补点' },
        { n: String(preview.totalPoints), label: '点共补发' },
        { n: cost, label: '最坏成本（最近 30 天最高每点成本）' },
      ];
    },
    note: '只补不扣：不会降低任何人的点数。',
    typeName: '重置',
    typeLabel: '输入 重置',
    confirm: '重置全部额度',
    ...(deps.holdMs ? { holdMs: deps.holdMs } : {}),
    run: async () => {
      await deps.run(async () => {
        const done = await deps.reset(requestId('reset'));
        pending.delete('reset');
        resetOutcome.replaceChildren(
          h('strong', { text: '重置结果' }),
          h('p', { text: `${done.affected} 个账号补发了 ${done.totalPoints} 点。${skippedText(done.skipped)}。` }),
        );
        deps.toast('额度已重置');
        resetZone.close();
      });
    },
  });
  const paintReset = () => {
    resetBox.hidden = !deps.isOwner();
    // Not merely hidden: for anyone but the owner the button does not exist on the page at all.
    if (!deps.isOwner()) return resetBox.replaceChildren();
    resetBox.replaceChildren(
      h('div', { class: 'pt-head' }, h('h3', { text: '重置全部额度' }), h('span', { text: '每天补充的人：加 7 天的量，不超过上限。不限量的人不变。' })),
      resetOutcome,
      resetZone.root,
    );
  };

  // Part 24c: 共创积分 (the three values). A changed value is amber until 保存; one 保存.
  const ccBox = h('section', { class: 'points-cocreation pt-cc', attrs: { id: 'points-cocreation' }, hidden: true });
  let ccRevision = 0;
  let ccBase: CocreationPointsSettings | null = null;
  type CcField = { key: keyof CocreationPointsSettings; input: HTMLInputElement; suffix: HTMLElement; tip: () => string; node: HTMLElement };
  const ccInput = (key: keyof CocreationPointsSettings, label: string, unit: string, tip: () => string): CcField => {
    const limits = COCREATION_POINTS_LIMITS[key];
    const input = h('input', {
      class: 'admin-input pt-small',
      attrs: { type: 'number', min: String(limits.min), max: String(limits.max), step: '1', id: `points-cc-${key}`, inputmode: 'numeric', 'aria-label': `${label}（${limits.min}–${limits.max}）` },
    });
    const suffix = h('span', { text: unit });
    hoverValue(suffix, '');
    return { key, input, suffix, tip, node: h('label', { class: 'pt-lb' }, label, h('span', { class: 'pt-with' }, input, suffix)) };
  };
  const num = (el: HTMLInputElement) => Number(el.value);
  const ccFields: CcField[] = [
    ccInput('notePoints', '每条留言', '点', () => `每条共创留言 ${num(ccFields[0]!.input)} 点`),
    ccInput('dailyCap', '每天最多算几条', '条', () => `今天最多 ${num(ccFields[0]!.input) * num(ccFields[1]!.input) || 0} 点`),
    ccInput('adoptPoints', '被采用', '点 · 不限次数', () => `被采用一次 ${num(ccFields[2]!.input)} 点`),
  ];
  const ccProblem = h('p', { class: 'admin-error', attrs: { role: 'alert' }, hidden: true });
  const ccSave = h('button', { text: '已保存', attrs: { type: 'button', id: 'points-cc-save' } });
  const ccPaint = () => {
    let changed = 0;
    for (const field of ccFields) {
      const dirty = ccBase !== null && String(ccBase[field.key]) !== field.input.value;
      markDirty(field.input, dirty);
      if (dirty) changed++;
      setHover(field);
    }
    ccSave.textContent = changed ? '保存' : '已保存';
    markDirty(ccSave, changed > 0);
    ccSave.dataset.changed = String(changed > 0);
  };
  const setHover = (field: CcField) => hoverValue(field.suffix, field.tip());
  for (const field of ccFields) field.input.addEventListener('input', ccPaint);
  const ccFill = (view: CocreationPointsSettings & { revision: number }) => {
    ccRevision = view.revision;
    ccBase = { notePoints: view.notePoints, dailyCap: view.dailyCap, adoptPoints: view.adoptPoints };
    for (const field of ccFields) field.input.value = String(view[field.key]);
    ccPaint();
  };
  ccSave.addEventListener(
    'click',
    () =>
      void deps.run(async () => {
        if (!deps.cocreation) return;
        const next = {
          notePoints: Number(ccFields[0]!.input.value),
          dailyCap: Number(ccFields[1]!.input.value),
          adoptPoints: Number(ccFields[2]!.input.value),
        };
        if (!cocreationPointsOk(next)) {
          ccProblem.textContent = '请填整数，并在括号里的范围内。';
          ccProblem.hidden = false;
          return;
        }
        ccProblem.hidden = true;
        ccFill(await deps.cocreation.save({ ...next, expectedRevision: ccRevision }));
        deps.toast('共创点数已保存');
      }),
  );
  ccBox.replaceChildren(
    h('div', { class: 'pt-head' }, h('h3', { text: '共创积分' }), hoverValue(h('span', { text: '玩家写共创留言得到的点数' }), '写给制作组的留言不算')),
    ...ccFields.map((field) => field.node),
    ccProblem,
    ccSave,
  );

  const kindSwitch = h('span', { class: 'pt-seg', attrs: { role: 'group', 'aria-label': '发给谁' } }, ...kinds.map((k) => k.node));
  const field = h('div', { class: 'pt-lb pt-field' }, h('span', { text: '对象' }), h('span', { class: 'pt-with' }, everyone, tier, number, email));
  const label = (text: string, control: HTMLElement) => h('label', { class: 'pt-lb' }, text, control);

  root.replaceChildren(
    pageHead('积分发放'),
    h(
      'form',
      { class: 'points-form pt-give', attrs: { id: 'points-form', autocomplete: 'off' } },
      h(
        'div',
        { class: 'pt-bar' },
        h('div', { class: 'pt-lb' }, h('span', { text: '发给谁' }), kindSwitch),
        field,
        label('点数', amount),
        label('备注', note),
        send,
      ),
      live,
      problem,
      confirmHost,
      outcome,
    ),
    ccBox,
    resetBox,
  );
  amount.setAttribute('placeholder', '1–10000');
  paintReset();
  return {
    /** The page needs nothing from the server to open; only the owner's section depends on the role. */
    load: async () => {
      paintReset();
      if (!deps.cocreation) return;
      try {
        ccFill(await deps.cocreation.read());
        ccBox.hidden = false;
      } catch {
        /* Without migration 131 (or without the permission) the form is simply not there. */
        ccBox.hidden = true;
      }
    },
    clear() {
      pending.clear();
      email.value = '';
      number.value = '';
      amount.value = '';
      note.value = '';
      if (liveTimer !== null) clearTimeout(liveTimer);
      liveSeq++;
      live.textContent = '';
      outcome.replaceChildren();
      resetOutcome.replaceChildren();
      problem.hidden = true;
    },
  };
}
