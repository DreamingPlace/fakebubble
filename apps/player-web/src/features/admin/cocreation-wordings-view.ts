/**
 * Part 39b: 题目, the wording pool of the co-creation themes (共创收件箱 → 「题目」). For every live character, in the console's order, and
 * each of the five themes: its wordings, each editable, switched on or off, deleted, plus an add box. 「生成」 (one character) and
 * 「全部生成」 draft 6–10 wordings per theme with one budgeted text call per character; the estimate is on the button and the second click
 * confirms (the paid button). Drafts arrive SWITCHED OFF: a wording reaches players only when it is switched on.
 */
import { COCREATION_WORDING_LIMITS } from '../../../../../packages/contracts/cocreation-wordings.ts';
import type { CocreationWordingsClient, WordingEntry, WordingPool } from '../../services/cocreation-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { dot } from './cast/cast-ui.ts';
import { sentenceOf } from './ui/error-line.ts';
import { hoverValue } from './ui/hover-value.ts';
import { dollarText } from './ui/price-format.ts';
import { paidButton } from './ui/paid-button.ts';

type Deps = {
  api: Pick<CocreationWordingsClient, 'list' | 'add' | 'edit' | 'toggle' | 'remove' | 'estimate' | 'generate'> &
    Partial<Pick<CocreationWordingsClient, 'setEnabled'>>;
  nameOf: (id: string) => string;
  colour: (id: string) => string;
  canManage: () => boolean;
  newId: () => string;
  status: (text: string) => void;
};
const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';

export function wordingsView(root: HTMLElement, deps: Deps) {
  let pool: WordingPool = { themes: [], order: [], entries: [] };
  let estimate: Awaited<ReturnType<Deps['api']['estimate']>> | null = null;
  let busy = false;
  /** Part 44: the wordings ticked for 上线 / 下线 (ids of entries that exist in `pool`). */
  const picked = new Set<string>();
  const error = h('p', { class: 'cw-error', attrs: { role: 'alert' }, hidden: true });
  const showError = (caught: unknown) => {
    error.textContent = sentenceOf(codeOf(caught));
    error.hidden = false;
  };
  const guard = async (work: () => Promise<void>) => {
    error.hidden = true;
    try {
      await work();
    } catch (caught) {
      showError(caught);
    }
  };
  const micros = (value: number) => `约 ${dollarText(value / 1_000_000)}`;
  const quote = (id: string | null) => {
    if (!estimate) return '估价中…';
    if (!estimate.ok) return '';
    if (id === null) return micros(estimate.totalMicros);
    const line = estimate.items.find((item) => item.characterId === id);
    return line ? micros(line.estimateMicros) : '';
  };
  const whyNot = () => {
    if (!deps.canManage()) return '没有处理共创的权限';
    if (busy) return '正在处理…';
    if (!estimate) return '估价中…';
    if (!estimate.ok)
      return estimate.reason === 'UNAVAILABLE' ? '生成暂时不可用（站点没有接入文本模型）' : '没有生效的模型价格';
    return '';
  };

  const generateFor = async (ids: string[]) => {
    if (!estimate || !estimate.ok) return;
    const lines = estimate.items.filter((item) => ids.includes(item.characterId));
    busy = true;
    paint();
    let added = 0;
    try {
      // One budgeted call per character, in the console's order; the first refusal stops the rest (an unknown call is never resent).
      for (const line of lines)
        added += (
          await deps.api.generate({
            characterId: line.characterId,
            requestId: deps.newId(),
            acknowledgeMicros: line.estimateMicros,
          })
        ).added;
      deps.status(`生成了 ${added} 条题目，都还没有启用。`);
    } catch (caught) {
      showError(caught);
    } finally {
      busy = false;
      await reload();
    }
  };
  const all = paidButton({
    name: 'wordings-all',
    label: () => `全部生成 · ${pool.order.length} 次付费调用 · ${quote(null)}`,
    confirmLabel: () => `确认付费 · ${pool.order.length} 次`,
    reason: whyNot,
    onConfirm: () => void generateFor(pool.order),
  });

  const entryRow = (entry: WordingEntry) => {
    const manage = deps.canManage();
    const text = h('input', {
      class: 'cw-text',
      attrs: { type: 'text', maxlength: String(COCREATION_WORDING_LIMITS.text), 'aria-label': '题目' },
    });
    text.value = entry.text;
    text.disabled = !manage;
    const save = async () => {
      const next = text.value.trim();
      if (next === entry.text) return;
      await guard(async () => {
        const saved = await deps.api.edit(entry.id, next);
        entry.text = saved.text;
        text.value = saved.text;
      });
      if (!error.hidden) text.value = entry.text;
    };
    text.addEventListener('change', () => void save());
    text.addEventListener('keydown', (event) => {
      const key = event as KeyboardEvent;
      if (key.key === 'Enter' && !key.isComposing) (text as HTMLInputElement).blur();
      if (key.key === 'Escape') text.value = entry.text;
    });
    const tick = h('input', { class: 'cw-tick', attrs: { type: 'checkbox', 'aria-label': '选择这条题目' } });
    tick.checked = picked.has(entry.id);
    tick.disabled = !manage;
    tick.addEventListener('change', () => {
      if (tick.checked) picked.add(entry.id);
      else picked.delete(entry.id);
      refreshBulk();
    });
    const sw = h('button', {
      class: 'cw-switch',
      text: entry.enabled ? '已启用' : '未启用',
      attrs: { type: 'button', role: 'switch', 'aria-checked': String(entry.enabled), 'aria-label': '启用这条题目' },
    });
    sw.disabled = !manage;
    sw.addEventListener(
      'click',
      () =>
        void guard(async () => {
          const next = await deps.api.toggle(entry.id, !entry.enabled);
          entry.enabled = next.enabled;
          sw.textContent = next.enabled ? '已启用' : '未启用';
          sw.setAttribute('aria-checked', String(next.enabled));
          row.setAttribute('data-enabled', String(next.enabled));
          refreshCounts();
          refreshBulk();
        }),
    );
    const del = h('button', { class: 'cw-del', text: '删除', attrs: { type: 'button', 'aria-label': '删除这条题目' } });
    del.disabled = !manage;
    del.addEventListener(
      'click',
      () =>
        void guard(async () => {
          await deps.api.remove(entry.id);
          pool.entries = pool.entries.filter((e) => e.id !== entry.id);
          picked.delete(entry.id);
          row.remove();
          refreshCounts();
          refreshBulk();
        }),
    );
    const row = h(
      'li',
      {
        class: 'cw-row',
        attrs: { 'data-wording': entry.id, 'data-enabled': String(entry.enabled), 'data-source': entry.source },
      },
      tick,
      sw,
      text,
      entry.source === 'generated' ? h('span', { class: 'cw-badge', text: '生成' }) : null,
      del,
    );
    return row;
  };

  // ---- Part 44: 全选 and the bulk 上线 / 下线 (online status only; the wording text is never touched) ----
  const allTick = h('input', { class: 'cw-tick', attrs: { type: 'checkbox', 'aria-label': '全选' } });
  const allLabel = hoverValue(
    h('label', { class: 'cw-all' }, allTick, h('span', { text: '全选' })),
    '选中全部角色的全部题目',
  );
  const pickedCount = h('span', { class: 'cw-picked', attrs: { 'aria-live': 'polite' } });
  const bulkOn = hoverValue(
    h('button', { class: 'cw-bulk', text: '上线', attrs: { type: 'button' } }),
    '让选中的题目出现在玩家的卡片里',
  );
  const bulkOff = hoverValue(
    h('button', { class: 'cw-bulk', text: '下线', attrs: { type: 'button' } }),
    '选中的题目不再出现，已写的纸条不受影响',
  );
  const bulkBar = h(
    'div',
    { class: 'cw-bulkbar', attrs: { role: 'group', 'aria-label': '批量上线或下线' } },
    allLabel,
    pickedCount,
    bulkOn,
    bulkOff,
  );
  // the page repaints every control from its `data-locked` (account-admin-page.ts), so a control that is off says so there too
  const lock = (control: HTMLButtonElement | HTMLInputElement, off: boolean) => {
    control.disabled = off;
    control.dataset.locked = String(off);
  };
  lock(bulkOn, true);
  lock(bulkOff, true);
  const refreshBulk = () => {
    const total = pool.entries.length;
    allTick.checked = total > 0 && picked.size === total;
    allTick.indeterminate = picked.size > 0 && picked.size < total;
    pickedCount.textContent = picked.size > 0 ? `已选 ${picked.size} 条` : '';
    const can = deps.canManage() && !busy && picked.size > 0;
    lock(bulkOn, !can);
    lock(bulkOff, !can);
    lock(allTick, !deps.canManage() || total === 0);
    bulkBar.hidden = total === 0 || !deps.api.setEnabled;
  };
  allTick.addEventListener('change', () => {
    picked.clear();
    if (allTick.checked) for (const entry of pool.entries) picked.add(entry.id);
    for (const box of body.querySelectorAll<HTMLInputElement>('.cw-row .cw-tick')) box.checked = allTick.checked;
    refreshBulk();
  });
  /** Paint the rows from `pool` and `picked` without rebuilding them, so a switch animates instead of flashing. */
  const repaint = () => {
    for (const row of body.querySelectorAll<HTMLElement>('.cw-row')) {
      const entry = pool.entries.find((e) => e.id === row.dataset.wording);
      if (!entry) continue;
      row.setAttribute('data-enabled', String(entry.enabled));
      const sw = row.querySelector<HTMLElement>('.cw-switch')!;
      sw.textContent = entry.enabled ? '已启用' : '未启用';
      sw.setAttribute('aria-checked', String(entry.enabled));
      row.querySelector<HTMLInputElement>('.cw-tick')!.checked = picked.has(entry.id);
    }
    refreshCounts();
    refreshBulk();
  };
  const bulk = (enabled: boolean) => {
    if (busy || picked.size === 0) return;
    const ids = [...picked];
    busy = true;
    refreshBulk();
    void guard(async () => {
      const done = await deps.api.setEnabled!(ids, enabled);
      const word = enabled ? '上线' : '下线';
      // Never a silent half-success: whatever did not switch is named (its text), and stays ticked so it can be tried again.
      const textOf = (id: string) => pool.entries.find((e) => e.id === id)?.text ?? '（已不存在）';
      for (const entry of pool.entries) if (done.switched.includes(entry.id)) entry.enabled = enabled;
      picked.clear();
      for (const f of done.failed) picked.add(f.id);
      if (done.failed.length > 0) {
        error.textContent = `${done.failed.length} 条没有${word}：${done.failed.map((f) => `「${textOf(f.id)}」`).join('')}`;
        error.hidden = false;
      }
      deps.status(
        `${done.switched.length} 条已${word}${done.unchanged.length ? `，${done.unchanged.length} 条本来就是` : ''}。`,
      );
      repaint();
    }).finally(() => {
      busy = false;
      refreshBulk();
    });
  };
  bulkOn.addEventListener('click', () => bulk(true));
  bulkOff.addEventListener('click', () => bulk(false));

  const countNodes = new Map<string, HTMLElement>();
  const refreshCounts = () => {
    for (const [id, node] of countNodes) {
      const mine = pool.entries.filter((e) => e.characterId === id);
      node.textContent = `${mine.length} 条 · 启用 ${mine.filter((e) => e.enabled).length}`;
    }
  };

  const themeBlock = (characterId: string, theme: { id: string; label: string }) => {
    const entries = pool.entries.filter((e) => e.characterId === characterId && e.themeId === theme.id);
    const list = h('ul', { class: 'cw-list' }, ...entries.map(entryRow));
    const input = h('input', {
      class: 'cw-new',
      attrs: {
        type: 'text',
        maxlength: String(COCREATION_WORDING_LIMITS.text),
        placeholder: '新的题目，{name} 会换成角色名',
        'aria-label': `${theme.label}：新的题目`,
      },
    });
    const addButton = h('button', { class: 'cw-add', text: '添加', attrs: { type: 'button' } });
    const manage = deps.canManage();
    input.disabled = addButton.disabled = !manage;
    const add = () =>
      void guard(async () => {
        const text = input.value.trim();
        if (text === '') return;
        const saved = await deps.api.add({
          characterId,
          themeId: theme.id,
          text,
          enabled: true,
          requestId: deps.newId(),
        });
        pool.entries.push(saved);
        list.append(entryRow(saved));
        input.value = '';
        refreshCounts();
      });
    addButton.addEventListener('click', add);
    input.addEventListener('keydown', (event) => {
      const key = event as KeyboardEvent;
      if (key.key === 'Enter' && !key.isComposing) add();
    });
    return h(
      'section',
      { class: 'cw-theme', attrs: { 'data-theme': theme.id } },
      h('h4', { text: theme.label }),
      list,
      h('div', { class: 'cw-add-row' }, input, addButton),
    );
  };

  const one = new Map<string, ReturnType<typeof paidButton>>();
  const characterBlock = (characterId: string, openFirst: boolean) => {
    const count = h('span', { class: 'cw-count is-mono' });
    countNodes.set(characterId, count);
    const button = paidButton({
      name: `wordings-${characterId}`,
      label: () => `生成 · 1 次付费调用 · ${quote(characterId)}`,
      confirmLabel: () => '确认付费 · 1 次',
      reason: whyNot,
      onConfirm: () => void generateFor([characterId]),
    });
    one.set(characterId, button);
    const details = h(
      'details',
      { class: 'cw-character', attrs: { 'data-character': characterId } },
      h('summary', {}, dot(deps.colour(characterId), 8), h('b', { text: deps.nameOf(characterId) }), count),
      h('div', { class: 'cw-tools' }, button.root),
      ...pool.themes.map((theme) => themeBlock(characterId, theme)),
    );
    if (openFirst) details.open = true;
    return details;
  };

  const paint = () => {
    all.refresh();
    for (const button of one.values()) button.refresh();
  };
  const body = h('div', { class: 'cw-body' });
  root.replaceChildren(h('div', { class: 'cw-head' }, all.root), bulkBar, error, body);
  const status = h('span', { class: 'head-status cw-status' });

  const reload = async () => {
    one.clear();
    countNodes.clear();
    pool = await deps.api.list();
    for (const id of [...picked]) if (!pool.entries.some((e) => e.id === id)) picked.delete(id);
    body.replaceChildren(...pool.order.map((id, at) => characterBlock(id, at === 0)));
    refreshCounts();
    refreshBulk();
    status.textContent = `${pool.order.length} 个角色 · ${pool.entries.length} 条题目`;
    estimate = null;
    paint();
    try {
      estimate = await deps.api.estimate(null);
    } catch {
      estimate = { ok: false, reason: 'UNAVAILABLE' };
    }
    paint();
  };
  return {
    status,
    async load() {
      error.hidden = true;
      await reload();
    },
  };
}
