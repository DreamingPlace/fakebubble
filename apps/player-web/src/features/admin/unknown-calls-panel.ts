import type { UnknownCallsView, UnknownResolveResult } from '../../../../../packages/contracts/web-system.ts';
import { h } from '../cocreation/h.ts';
import { ageText } from './system-format.ts';
import type { ConfirmInPlace } from './ui/inline-confirm.ts';

const stageLabel = { draft: '文字初稿', review: '文字审核', speech: '语音' } as const;
/** Micro-dollars with six places: a held amount is a bound, and the owner may enter what the bill says. */
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(6)}`;
/** What the owner typed, as micro-dollars (at most six decimals), or null when it is not an amount. */
export function parseBillAmount(text: string): number | null {
  const match = /^\s*\$?(\d{1,4})(?:\.(\d{1,6}))?\s*$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
}

/**
 * 未确认的调用 (Part 54): each call whose result is not known keeps its money held and is never retried. The owner settles each
 * one after checking the provider's bill: at the held amount, or at a lower amount from the bill. Nothing happens by itself.
 * Shown: a short code, provider, model, stage, the held amount, its age and the error code. Nothing that identifies a person.
 */
export function unknownCallsPanel(deps: {
  load: () => Promise<UnknownCallsView>;
  resolve: (input: {
    requestId: string;
    code: string;
    settledMicros: number | 'held';
  }) => Promise<UnknownResolveResult>;
  isOwner: () => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  confirm: ConfirmInPlace;
  toast: (text: string) => void;
  newRequestId: () => string;
  disposed: () => boolean;
}) {
  const root = h('section', { class: 'system-section sys-unknown-calls' });
  const host = h('div', { class: 'sys-confirm' });
  const result = h('div', { class: 'system-result', attrs: { role: 'status' } });
  // An action whose outcome was never seen is retried under the same request id, so it can never apply twice.
  const pending = new Map<string, string>();
  const requestId = (key: string) => {
    const held = pending.get(key) ?? deps.newRequestId();
    pending.set(key, held);
    return held;
  };
  const head = h('h3', {
    text: '未确认的调用',
    attrs: {
      title:
        '调用可能已经发出，但没有收到明确结果。预留的额度一直保留，不会重发也不会自动释放。请对照供应商账单逐条核对。',
    },
  });
  async function paint(view: UnknownCallsView) {
    const rows = view.calls.map((call) => {
      const amount = h('input', {
        attrs: {
          type: 'text',
          inputmode: 'decimal',
          value: (call.heldMicros / 1_000_000).toFixed(6),
          'aria-label': `${call.code} 账单金额（美元，不超过预留）`,
          'data-code': call.code,
        },
      });
      const go = h('button', { text: '已按账单核对', attrs: { type: 'button', 'data-code': call.code } });
      go.addEventListener(
        'click',
        () =>
          void deps.run(async () => {
            const micros = parseBillAmount(amount.value);
            if (micros === null || micros > call.heldMicros) {
              deps.toast(`金额需要是 0 到 ${usd(call.heldMicros)} 之间的美元数（最多六位小数）。`);
              return;
            }
            const ok = await deps.confirm(
              {
                title: '确认已按账单核对',
                message: `把 ${call.code} 按 ${usd(micros)} 结算（预留 ${usd(call.heldMicros)}）。结算后不能撤销，也不会重发这次调用。`,
                confirmLabel: '确认结算',
              },
              host,
            );
            if (!ok || deps.disposed()) return;
            const key = `${call.code}:${micros}`;
            const done = await deps.resolve({
              requestId: requestId(key),
              code: call.code,
              settledMicros: micros === call.heldMicros ? 'held' : micros,
            });
            pending.delete(key);
            result.replaceChildren(
              h('strong', { text: '核对结果' }),
              h('p', { text: `${done.code}：已按 ${usd(done.settledMicros)} 结算（预留 ${usd(done.heldMicros)}）。` }),
            );
            deps.toast('已按账单核对');
            await load();
          }),
      );
      return h(
        'tr',
        { attrs: { 'data-code': call.code } },
        h('td', { class: 'is-mono admin-dev', text: call.code }),
        h('td', { class: 'is-mono admin-dev', text: call.provider }),
        h('td', { class: 'is-mono admin-dev', text: call.model }),
        h('td', { text: stageLabel[call.stage] }),
        h('td', { class: 'is-end', text: usd(call.heldMicros) }),
        h('td', { text: ageText(call.ageMs) }),
        h('td', { class: 'is-mono admin-dev sys-uc-code', text: call.errorCode }),
        h('td', { class: 'sys-uc-settle' }, ...(deps.isOwner() ? [amount, go] : [])),
      );
    });
    const table = h(
      'table',
      { class: 'admin-table', attrs: { 'aria-label': '未确认的调用' } },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['编号', '供应商', '模型', '阶段', '预留金额', '已过', '错误码', deps.isOwner() ? '核对' : ''].map(
            (text) => h('th', { text, class: text === '预留金额' ? 'is-end' : '' }),
          ),
        ),
      ),
      h('tbody', {}, ...rows),
    );
    // Part 24b-7f round 3: the table scrolls inside its own card (never the page), like the other tables of 系统状态
    const region = h('div', { class: 'admin-table-region' }, h('div', { class: 'admin-table-wrap' }, table));
    root.replaceChildren(
      head,
      view.calls.length
        ? region
        : h('p', { class: 'admin-hint', text: '没有未确认的调用。', attrs: { 'data-empty': 'true' } }),
      ...(view.other.embed > 0
        ? [
            h('p', {
              class: 'admin-hint',
              text: `另有 ${view.other.embed} 条记忆向量化调用结果未知（不在这里核对）。`,
              attrs: { 'data-reason': 'true' },
            }),
          ]
        : []),
      h('p', { class: 'admin-hint', text: `已核对 ${view.resolved} 条。`, attrs: { 'data-reason': 'true' } }),
      host,
      result,
    );
  }
  async function load() {
    const view = await deps.load();
    if (deps.disposed()) return;
    await paint(view);
  }
  return {
    element: root,
    load,
    clear() {
      pending.clear();
      root.replaceChildren();
    },
  };
}
