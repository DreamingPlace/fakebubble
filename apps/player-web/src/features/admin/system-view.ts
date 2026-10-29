import type {
  BudgetTopUpResult,
  RenewPricesResult,
  SystemBudgetRow,
  SystemPriceRow,
} from '../../../../../packages/contracts/web-system.ts';
import { BUDGET_TOPUP_LIMITS } from '../../../../../packages/contracts/web-system.ts';
import type { StageLatencyDay, SystemStatusView } from '../../services/account-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { opsView } from './ops-view.ts';
import { warningLine } from './overview-view.ts';
import { PROVIDER_LABELS, ageText, dateText, dateTimeText, dollars } from './system-format.ts';
import { hoverValue } from './ui/hover-value.ts';
import type { ConfirmInPlace } from './ui/inline-confirm.ts';
import { keyValuePanel } from './ui/key-value-panel.ts';
import { statusBadge } from './ui/status-badge.ts';
import { pageHead } from './ui/page-head.ts';

const onOff = (value: boolean) => statusBadge(value ? '开' : '关', value ? 'ok' : 'neutral');
const yesNo = (value: boolean) => statusBadge(value ? '有' : '无', value ? 'ok' : 'neutral');
const UNIT = { token: '令牌', byte: '字节', call: '次' } as Record<string, string>;
const KIND_LABELS = { webProvider: '供应商调用', external: '外部调用', embed: '记忆向量化' } as const;
const BUCKETS = { '<1d': '不到 1 天', '1-7d': '1–7 天', '7-30d': '7–30 天', '>30d': '超过 30 天' } as const;

const priceLabel = (row: SystemPriceRow) => `${row.provider} / ${row.model} / ${row.phase}`;
/** The words of the 预算充值 confirmation: provider, amount and what will remain. */
const topUpMessage = (row: SystemBudgetRow, amount: number) =>
  `向 ${PROVIDER_LABELS[row.provider]} 的预算增加 $${amount}。充值后剩余 ${dollars((row.remainingMicros ?? 0) + amount * 1_000_000)}。`;

/**
 * 系统 → 系统状态. One server call (`load`); read-only for the owner and for administrators holding system.read. The two buttons
 * (续期价格, 预算充值) exist for the owner only, and the server refuses everyone else whatever this page shows. Counts, times and
 * prices only: no id, email, nickname or content is ever on this page.
 */
export function systemView(
  root: HTMLElement,
  deps: {
    load: () => Promise<SystemStatusView>;
    renewPrices: (requestId: string) => Promise<RenewPricesResult>;
    topUp: (input: { requestId: string; provider: 'deepseek' | 'fish'; dollars: number }) => Promise<BudgetTopUpResult>;
    isOwner: () => boolean;
    run: (work: () => Promise<void>) => Promise<void>;
    /** 续期 and 预算充值 confirm in place, inside the host they are given (no dialog). */
    confirm: ConfirmInPlace;
    toast: (text: string) => void;
    newRequestId: () => string;
    disposed: () => boolean;
  },
) {
  let view: SystemStatusView | null = null;
  // An action whose outcome was never seen is retried under the same request id, so it can never apply twice.
  const pending = new Map<string, string>();
  const requestId = (key: string) => {
    const held = pending.get(key) ?? deps.newRequestId();
    pending.set(key, held);
    return held;
  };
  const sections = h('div', { class: 'system-sections' });
  const result = h('div', { class: 'system-result', attrs: { role: 'status' } });
  const metricsHost = h('div', { class: 'system-metrics' });
  const metrics = opsView(metricsHost, {
    title: '技术指标',
    // The numbers come with the one status call; changing the range or pressing 刷新 asks for that call again.
    load: async (days) => {
      await refresh();
      return (view?.metrics ?? []).slice(0, days);
    },
    run: (work) => deps.run(work),
    disposed: deps.disposed,
  });
  // The overall verdict sits in the header: green, or the same one-line summary 总览 shows.
  const overall = h('p', { class: 'ov-status sys-overall', attrs: { role: 'status' } });
  root.replaceChildren(pageHead('系统状态', overall), sections, result);
  /** Sections laid out in a row: `top` is the three-up row with the version card, `pair` two side by side, `wide` one full row. */
  const row = (kind: 'top' | 'pair' | 'wide', ...children: (Node | null)[]) =>
    h('div', { class: `sys-row sys-${kind}` }, ...children);

  const section = (title: string, ...children: (Node | null)[]) =>
    h('section', { class: 'system-section' }, h('h3', { text: title }), ...children);
  const table = (headers: string[], rows: (Node | string)[][], caption: string, marked: boolean[] = []) =>
    h(
      'div',
      { class: 'admin-table-region' },
      h(
        'div',
        { class: 'admin-table-wrap' },
        h(
          'table',
          { class: 'admin-table', attrs: { 'aria-label': caption } },
          h('caption', { text: caption }),
          h('thead', {}, h('tr', {}, ...headers.map((label) => h('th', { text: label, attrs: { scope: 'col' } })))),
          h(
            'tbody',
            {},
            ...rows.map((cells, index) =>
              h(
                'tr',
                marked[index] ? { attrs: { 'data-expiring': 'true' } } : {},
                ...cells.map((cell) => h('td', {}, cell)),
              ),
            ),
          ),
        ),
      ),
    );

  const priceSection = (v: SystemStatusView) => {
    const renew = h('button', { class: 'sys-renew', text: '续期价格', attrs: { type: 'button', id: 'system-renew' } });
    const renewHost = h('div', { class: 'sys-confirm' });
    renew.addEventListener(
      'click',
      () =>
        void deps.run(async () => {
          const due = v.prices.filter((row) => row.expiring).length;
          const ok = await deps.confirm(
            {
              title: '确认续期价格',
              message: `将运行与运维命令 renew-prices 相同的续期：现有 ${due} 项价格在 60 天内到期或已过期，会各追加一条新的 90 天价格；其余保持不变。重复点击不会产生重复价格。`,
              confirmLabel: '确认续期',
            },
            renewHost,
          );
          if (!ok || deps.disposed()) return;
          const renewed = await deps.renewPrices(requestId('renew'));
          pending.delete('renew');
          showRenewal(renewed);
          deps.toast('价格已续期');
          await refresh();
        }),
    );
    return section(
      '价格',
      table(
        ['供应商 / 模型 / 阶段', '微美元 / 单位', '版本', '到期（UTC）', '状态'],
        v.prices.map((row) => [
          priceLabel(row),
          `${row.upperMicrosPerUnit} µ$ / ${UNIT[row.unit] ?? row.unit}`,
          `v${row.version}`,
          dateText(row.validUntil),
          row.state === 'expired'
            ? statusBadge('已过期', 'danger')
            : row.expiring
              ? statusBadge(`${row.daysLeft} 天后到期`, 'warn')
              : statusBadge('有效', 'ok'),
        ]),
        '价格',
        v.prices.map((row) => row.expiring),
      ),
      deps.isOwner() ? renew : null,
      deps.isOwner() ? renewHost : null,
    );
  };
  const showRenewal = (renewal: RenewPricesResult) =>
    result.replaceChildren(
      h('strong', { text: '续期结果' }),
      table(
        ['供应商 / 模型 / 阶段', '结果', '价格', '版本', '到期（UTC）'],
        renewal.rows.map((row) => [
          `${row.provider} / ${row.model} / ${row.phase}`,
          row.result === 'renewed' ? '已续期' : row.result === 'not-due' ? '未到期' : '已存在',
          `${row.upperMicrosPerUnit} µ$`,
          `v${row.version}`,
          dateText(row.validUntil),
        ]),
        '续期结果',
      ),
    );

  const budgetSection = (v: SystemStatusView) => {
    if (!v.budget.available)
      return section('预算', h('p', { class: 'admin-hint', text: `暂时读不到预算服务（${v.budget.error}）。` }));
    const rows = v.budget.rows;
    return section(
      '预算',
      ...rows.map((row) => {
        const limited = row.policy !== 'unlimited' && row.remainingMicros !== null;
        const cap = row.spentMicros + row.heldMicros + (row.remainingMicros ?? 0);
        const share = (value: number) => `${cap > 0 ? Math.min(100, (value / cap) * 100).toFixed(1) : 0}%`;
        const used = h('i', { class: 'is-used' });
        const held = h('i', { class: 'is-held' });
        const bar = h('span', { class: 'sys-bar' }, used, held);
        if (limited) {
          used.style?.setProperty('--w', share(row.spentMicros));
          held.style?.setProperty('--w', share(row.heldMicros));
          hoverValue(bar, `已用 ${dollars(row.spentMicros)} · 占用中 ${dollars(row.heldMicros)} · 剩余 ${dollars(row.remainingMicros!)}`);
        }
        return h(
          'div',
          { class: 'sys-budget' },
          h(
            'span',
            { class: 'sys-budget-line' },
            h('span', { text: PROVIDER_LABELS[row.provider] }),
            limited
              ? h('span', { class: 'sys-budget-left' }, '剩余 ', h('b', { text: dollars(row.remainingMicros!) }), ` / ${dollars(cap)}`)
              : statusBadge('不限额', 'info'),
          ),
          limited ? bar : null,
          limited ? h('span', { class: 'sys-budget-used', text: `已用 ${dollars(row.spentMicros)} · 占用中 ${dollars(row.heldMicros)}` }) : null,
          limited && deps.isOwner() ? topUpControls(row) : null,
        );
      }),
      topUpHost,
    );
  };
  const topUpHost = h('div', { class: 'sys-confirm' });
  const topUpControls = (row: SystemBudgetRow) => {
    const amount = h('input', {
      attrs: {
        type: 'number',
        inputmode: 'numeric',
        min: String(BUDGET_TOPUP_LIMITS.minDollars),
        max: String(BUDGET_TOPUP_LIMITS.maxDollars),
        step: '1',
        value: '5',
        'aria-label': `${PROVIDER_LABELS[row.provider]} 充值金额（美元，1–50）`,
        'data-provider': row.provider,
      },
    });
    const go = h('button', { text: '预算充值', attrs: { type: 'button', 'data-provider': row.provider } });
    go.addEventListener(
      'click',
      () =>
        void deps.run(async () => {
          const dollarsValue = Number(amount.value);
          if (
            !Number.isSafeInteger(dollarsValue) ||
            dollarsValue < BUDGET_TOPUP_LIMITS.minDollars ||
            dollarsValue > BUDGET_TOPUP_LIMITS.maxDollars
          ) {
            deps.toast(`充值金额需要是 $${BUDGET_TOPUP_LIMITS.minDollars}–$${BUDGET_TOPUP_LIMITS.maxDollars} 的整数。`);
            return;
          }
          const ok = await deps.confirm(
            { title: '确认预算充值', message: topUpMessage(row, dollarsValue), confirmLabel: '确认充值' },
            topUpHost,
          );
          if (!ok || deps.disposed()) return;
          const key = `topup:${row.provider}:${dollarsValue}`;
          const done = await deps.topUp({ requestId: requestId(key), provider: row.provider, dollars: dollarsValue });
          pending.delete(key);
          result.replaceChildren(
            h('strong', { text: '充值结果' }),
            h('p', {
              text: `${PROVIDER_LABELS[row.provider]}：已增加 $${dollarsValue}，额度 ${dollars(done.allowanceMicros)}，剩余 ${dollars(done.remainingMicros)}。`,
            }),
          );
          deps.toast('预算已充值');
          await refresh();
        }),
    );
    return h('span', { class: 'system-topup' }, amount, go);
  };

  function paint(v: SystemStatusView) {
    const flags = v.flags;
    const note = warningLine(v.warnings);
    overall.setAttribute('data-tone', note ? 'warn' : 'ok');
    overall.replaceChildren(statusBadge(note ? '需要留意' : '全部正常', note ? 'warn' : 'ok'), ' ', note ?? '');
    // The owner accepts every deploy on this card: the build, the migration steps and whether they match, the database version.
    const version = section(
      '运行版本',
      keyValuePanel([
        ['构建提交', v.version.commit === 'unbuilt' ? '未标记（本地构建）' : v.version.commit],
        [
          '迁移',
          h(
            'span',
            {},
            `${v.version.migrationSteps} 步 `,
            v.version.matches === null
              ? statusBadge('无法核对', 'neutral')
              : v.version.matches
                ? hoverValue(statusBadge('与预期一致', 'ok'), 'matches: true')
                : hoverValue(statusBadge('与预期不一致', 'danger'), 'matches: false'),
          ),
        ],
        ['数据库版本', v.version.schemaVersion === null ? null : String(v.version.schemaVersion)],
      ]),
    );
    version.classList.add('sys-version');
    const unknown = section(
      'UNKNOWN',
      table(
        ['类别', '数量', '最早的已过'],
        v.unknown.map((kind) => [KIND_LABELS[kind.kind], String(kind.count), ageText(kind.oldestAgeMs)]),
        'UNKNOWN 调用',
      ),
    );
    const security = section(
      '安全',
      keyValuePanel([
        ['Turnstile', onOff(v.security.turnstile)],
        ['今天未通过（UTC）', String(v.security.failuresToday)],
        ['最近 7 天未通过', String(v.security.failuresLast7Days)],
        ['今天无法验证（Turnstile 服务不可达）', String(v.security.unavailableToday)],
        ['最近 7 天无法验证', String(v.security.unavailableLast7Days)],
      ]),
    );
    const cleanup = v.retention
      ? keyValuePanel([
          ['清理 · 上次成功', dateTimeText(v.retention.lastSuccessAt)],
          [
            '清理失败',
            v.retention.failing > 0 ? statusBadge(`${v.retention.failing} 位`, 'danger') : statusBadge('0', 'ok'),
          ],
          ['最早一条已过', v.retention.oldestAgeBucket ? BUCKETS[v.retention.oldestAgeBucket] : '—'],
          ['正在清理', String(v.retention.purging)],
        ])
      : h('p', { class: 'admin-hint', text: '这个环境没有提供清理状态。' });
    const failures =
      v.retention && v.retention.failures.length > 0
        ? table(
            ['阶段 phase', '语句组 sub', '错误类 errorName', '信息形状 messageShape', '连续失败'],
            v.retention.failures.map((f) => [f.phase, f.sub, f.errorName, f.messageShape, `${f.count} 次`]),
            '清理失败明细（不含任何 id）',
          )
        : null;
    /** A switch as a pill: its plain name and state, the environment variable on hover. */
    const pill = (name: string, key: string, value: string, tone: 'on' | 'off' | 'plain') => {
      const node = h('span', { class: `sys-pill is-${tone}` }, h('i'), `${name} · ${value}`);
      return hoverValue(node, key);
    };
    const on = (value: boolean) => (value ? '开' : '关');
    const have = (value: boolean) => (value ? '有' : '无');
    const tone = (value: boolean) => (value ? 'on' : 'off') as 'on' | 'off';
    const switches = flags
      ? h(
          'div',
          { class: 'sys-flags' },
          pill('注册赠点', 'SIGNUP_BONUS_ENABLED', on(flags.signupBonus), tone(flags.signupBonus)),
          pill('玩家选模型', 'PLAYER_MODEL_CHOICE_ENABLED', on(flags.playerModelChoice), tone(flags.playerModelChoice)),
          pill('可选文字模型', 'PLAYER_TEXT_MODELS', flags.playerTextModels ? flags.playerTextModels.join('、') : '未启用', 'plain'),
          pill('语音模型', 'FISH_VOICE_MODEL', flags.fishVoiceModel, 'plain'),
          pill('测试对话', 'CHAT_REVIEW_ENABLED', on(flags.chatReview), tone(flags.chatReview)),
          pill('Turnstile', 'Turnstile', on(flags.turnstile), tone(flags.turnstile)),
          pill('告警', 'ALERTS', on(flags.alerts), tone(flags.alerts)),
          pill('告警邮件绑定', 'ALERT_MAIL_BINDING', have(flags.alertMailBindingPresent), tone(flags.alertMailBindingPresent)),
          pill('告警收件人', 'ALERT_RECIPIENT', have(flags.alertRecipientSet), tone(flags.alertRecipientSet)),
        )
      : h('p', { class: 'admin-hint', text: '这个环境没有提供开关信息。' });
    const cleanupCard = section('清理与开关', cleanup, failures, switches);
    cleanupCard.classList.add('sys-switches');
    sections.replaceChildren(
      row('top', version, unknown, security),
      row('wide', priceSection(v)),
      row('pair', budgetSection(v), cleanupCard),
      row('wide', section('技术指标', metricsHost)),
    );
    metrics.show(v.metrics.slice(0, 14) as StageLatencyDay[]);
  }

  async function refresh() {
    const next = await deps.load();
    if (deps.disposed()) return;
    view = next;
    paint(next);
  }
  return {
    load: refresh,
    clear() {
      view = null;
      pending.clear();
      sections.replaceChildren();
      result.replaceChildren();
      metrics.clear();
    },
  };
}
