import type {
  PointsGrantResult,
  PointsLookup,
  PointsPreview,
  PointsResetResult,
  PointsSkipped,
  PointsTarget,
} from '../../../../../packages/contracts/web-system.ts';
import { POINTS_GRANT_LIMITS } from '../../../../../packages/contracts/web-system.ts';
import { h, length } from '../cocreation/h.ts';
import { dollars } from './system-format.ts';

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
    isOwner: () => boolean;
    run: (work: () => Promise<void>) => Promise<void>;
    confirm: (options: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
    toast: (text: string) => void;
    newRequestId: () => string;
    disposed: () => boolean;
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
      placeholder: '完整邮箱地址（不能搜索，也没有列表）',
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
      'aria-label': '备注（可选，最多 100 字）',
    },
  });
  const lookup = h('button', {
    class: 'admin-secondary',
    text: '核对',
    attrs: { type: 'button', id: 'points-lookup' },
  });
  const send = h('button', { text: '发放', attrs: { type: 'button', id: 'points-send' } });
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
  const refreshFields = () => {
    const kind = kinds.find((k) => k.input.checked)?.kind;
    tier.hidden = kind !== 'tier';
    number.hidden = kind !== 'player';
    email.hidden = kind !== 'email';
  };
  for (const k of kinds) k.input.addEventListener('change', refreshFields);
  refreshFields();

  const showPreview = (preview: PointsPreview) =>
    outcome.replaceChildren(
      h('strong', { text: '核对结果' }),
      ...(preview.player ? [h('p', { text: lookupLine(preview.player) })] : []),
      h('p', {
        text: `将发给 ${preview.granted} 位玩家，共 ${preview.totalPoints} 点。${skippedText(preview.skipped)}。`,
      }),
    );
  lookup.addEventListener(
    'click',
    () =>
      void deps.run(async () => {
        const input = parsed();
        if (!input) return;
        const preview = await deps.preview(input.to, input.points);
        if (!deps.disposed()) showPreview(preview);
      }),
  );
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
        const ok = await deps.confirm({
          title: '确认积分发放',
          message: `${preview.player ? `${lookupLine(preview.player)}。` : ''}将发给 ${preview.granted} 位玩家，共 ${preview.totalPoints} 点（每人最多 ${input.points} 点）。${skippedText(preview.skipped)}。`,
          confirmLabel: '确认发放',
        });
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
        deps.toast('已发放');
      }),
  );

  const resetButton = h('button', {
    class: 'admin-danger',
    text: '重置全部额度',
    attrs: { type: 'button', id: 'points-reset' },
  });
  const resetOutcome = h('div', { class: 'system-result', attrs: { role: 'status' } });
  resetButton.addEventListener(
    'click',
    () =>
      void deps.run(async () => {
        const preview = await deps.resetPreview();
        if (deps.disposed()) return;
        const cost = preview.worstCaseMicros === null ? '暂无数据' : dollars(preview.worstCaseMicros);
        const ok = await deps.confirm({
          title: '确认重置全部额度',
          message: `影响 ${preview.affected} 个账号，共补发 ${preview.totalPoints} 点；按最近 30 天最高的每点成本估算，最坏成本 ${cost}。${skippedText(preview.skipped)}。只补不扣：不会降低任何人的点数。`,
          confirmLabel: '确认重置',
        });
        if (!ok || deps.disposed()) return;
        const done = await deps.reset(requestId('reset'));
        pending.delete('reset');
        resetOutcome.replaceChildren(
          h('strong', { text: '重置结果' }),
          h('p', { text: `${done.affected} 个账号补发了 ${done.totalPoints} 点。${skippedText(done.skipped)}。` }),
        );
        deps.toast('额度已重置');
      }),
  );
  const paintReset = () => {
    resetBox.hidden = !deps.isOwner();
    // Not merely hidden: for anyone but the owner the button does not exist on the page at all.
    if (!deps.isOwner()) return resetBox.replaceChildren();
    resetBox.replaceChildren(
      h('h3', { text: '重置全部额度' }),
      h('p', {
        class: 'admin-hint',
        text: '仅主管理员。注册玩家补到 100 点；每日补充的玩家加 7 天的每日额度（不超过上限）；不限量的不动；访客不在内；只补不扣。',
      }),
      resetButton,
      resetOutcome,
    );
  };

  root.replaceChildren(
    h('h2', { text: '积分发放' }),
    h('p', {
      class: 'admin-hint',
      text: '给玩家发点数。玩家在“消费记录”里看到“管理员发放”。每日补充的玩家不会超过自己的上限；不限量的和访客会被跳过。',
    }),
    h(
      'form',
      { class: 'points-form', attrs: { id: 'points-form', autocomplete: 'off' } },
      h('fieldset', {}, h('legend', { text: '发给谁' }), ...kinds.map((k) => k.node), tier, number, email),
      h('label', { text: '点数（1–10000）', attrs: { for: 'points-amount' } }),
      amount,
      h('label', { text: '备注（可选，最多 100 字）', attrs: { for: 'points-note' } }),
      note,
      problem,
      h('div', { class: 'models-actions' }, lookup, send),
    ),
    outcome,
    resetBox,
  );
  paintReset();
  return {
    /** The page needs nothing from the server to open; only the owner's section depends on the role. */
    load: async () => paintReset(),
    clear() {
      pending.clear();
      email.value = '';
      number.value = '';
      amount.value = '';
      note.value = '';
      outcome.replaceChildren();
      resetOutcome.replaceChildren();
      problem.hidden = true;
    },
  };
}
