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
    confirm: (options: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
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
    const renew = h('button', { text: '续期价格', attrs: { type: 'button', id: 'system-renew' } });
    renew.addEventListener(
      'click',
      () =>
        void deps.run(async () => {
          const due = v.prices.filter((row) => row.expiring).length;
          const ok = await deps.confirm({
            title: '确认续期价格',
            message: `将运行与运维命令 renew-prices 相同的续期：现有 ${due} 项价格在 60 天内到期或已过期，会各追加一条新的 90 天价格；其余保持不变。重复点击不会产生重复价格。`,
            confirmLabel: '确认续期',
          });
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
      table(
        ['供应商', '策略', '已用', '占用中', '剩余', ''],
        rows.map((row) => {
          const action = h('span');
          if (row.policy === 'unlimited') action.textContent = '不限额';
          else if (deps.isOwner()) action.append(topUpControls(row));
          return [
            PROVIDER_LABELS[row.provider],
            row.policy === 'unlimited' ? statusBadge('不限额', 'info') : statusBadge('限额', 'neutral'),
            dollars(row.spentMicros),
            dollars(row.heldMicros),
            row.remainingMicros === null ? '不限额' : dollars(row.remainingMicros),
            action,
          ];
        }),
        '预算',
      ),
    );
  };
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
          const ok = await deps.confirm({
            title: '确认预算充值',
            message: topUpMessage(row, dollarsValue),
            confirmLabel: '确认充值',
          });
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
                ? statusBadge('matches: true', 'ok')
                : statusBadge('matches: false', 'danger'),
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
    const cleanup = section(
      '清理',
      v.retention
        ? keyValuePanel([
            [
              '清理失败',
              v.retention.failing > 0 ? statusBadge(`${v.retention.failing} 位`, 'danger') : statusBadge('0', 'ok'),
            ],
            ['最早一条已过', v.retention.oldestAgeBucket ? BUCKETS[v.retention.oldestAgeBucket] : '—'],
            ['上次成功', dateTimeText(v.retention.lastSuccessAt)],
            ['正在清理', String(v.retention.purging)],
          ])
        : h('p', { class: 'admin-hint', text: '这个环境没有提供清理状态。' }),
      v.retention && v.retention.failures.length > 0
        ? table(
            ['阶段 phase', '语句组 sub', '错误类 errorName', '信息形状 messageShape', '连续失败'],
            v.retention.failures.map((f) => [f.phase, f.sub, f.errorName, f.messageShape, `${f.count} 次`]),
            '清理失败明细（不含任何 id）',
          )
        : null,
    );
    const flag = (name: string, value: string | Node) =>
      h(
        'div',
        { class: 'sys-flag' },
        h('span', { class: 'sys-flag-name', text: name }),
        h('span', { class: 'sys-flag-value' }, value),
      );
    const switches = section(
      '开关',
      flags
        ? h(
            'div',
            { class: 'sys-flags' },
            flag('SIGNUP_BONUS_ENABLED', onOff(flags.signupBonus)),
            flag('PLAYER_MODEL_CHOICE_ENABLED', onOff(flags.playerModelChoice)),
            flag('PLAYER_TEXT_MODELS', flags.playerTextModels ? flags.playerTextModels.join('、') : '未启用'),
            flag('FISH_VOICE_MODEL', flags.fishVoiceModel),
            flag('CHAT_REVIEW_ENABLED', onOff(flags.chatReview)),
            flag('Turnstile', onOff(flags.turnstile)),
            flag('告警', onOff(flags.alerts)),
            flag('告警邮件绑定', yesNo(flags.alertMailBindingPresent)),
            flag('告警收件人', yesNo(flags.alertRecipientSet)),
          )
        : h('p', { class: 'admin-hint', text: '这个环境没有提供开关信息。' }),
    );
    switches.classList.add('sys-switches');
    sections.replaceChildren(
      row('top', version, unknown, security),
      row('wide', priceSection(v)),
      row('wide', budgetSection(v)),
      row('pair', cleanup, switches),
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
