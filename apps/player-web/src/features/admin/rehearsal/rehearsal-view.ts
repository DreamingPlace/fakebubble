import type { OwnerAdminClient } from '../../../services/owner-admin-api.ts';
import { previewManage } from '../owner/preview-manage.ts';
import type { ConfirmInPlace } from '../ui/inline-confirm.ts';
import { bindTip } from '../ui/tooltip.ts';
import {
  REHEARSAL_TURNS_MAX,
  REHEARSAL_TURNS_MIN,
  REHEARSAL_TURN_CHARS,
  REHEARSAL_ITEMS_MAX,
  REHEARSAL_SET_LABELS,
  charLength,
  type RehearsalCell,
  type RehearsalCounts,
  type RehearsalEstimate,
  type RehearsalItems,
  type RehearsalLibrary,
  type RehearsalMemeCell,
  type RehearsalRunDetail,
  type RehearsalRunInfo,
  type RehearsalSource,
} from '../../../../../../packages/contracts/web-rehearsal.ts';
import type { PlayerModelId } from '../../../../../../packages/contracts/player-models.ts';
import type { RehearsalAdminClient } from '../../../services/rehearsal-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { micros, when } from '../preview/copy.ts';
import { disclosureDetails } from '../ui/disclosure.ts';
import { drawer } from '../ui/drawer.ts';
import { hoverValue } from '../ui/hover-value.ts';
import { paidButton } from '../ui/paid-button.ts';
import { rollNumber } from '../ui/number-roll.ts';
import { segmented } from '../ui/segmented.ts';
import { statusBadge } from '../ui/status-badge.ts';

export type RehearsalHost = {
  api: RehearsalAdminClient;
  characterId: () => string | null;
  /** The saved draft this run would be frozen on, or null when there is none. */
  draft: () => { revision: number; hash: string } | null;
  /** The form beside holds unsaved changes (a run sends the SAVED draft). */
  unsaved: () => boolean;
  /** `preview` on this character. */
  canStart: () => boolean;
  /** `preview` on every character: scripts and word lists are shared. */
  canEdit: () => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
  disposed: () => boolean;
  modalParent: () => HTMLElement;
  newId?: () => string;
  /** Part 31b (owner): 整理 of the run records. Absent = nothing of it is drawn. */
  owner?: Record<'deleteRehearsals', OwnerAdminClient['deleteRehearsals']>;
  confirm?: ConfirmInPlace;
  isOwner?: () => boolean;
  poll?: { setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (handle: unknown) => void };
};
type Pick =
  | { kind: 'set'; set: 'chat' | 'repeat' }
  | { kind: 'memes' }
  | { kind: 'script'; id: string }
  | { kind: 'new' };
const POLL_MS = 2500;
const MODEL_ORDER: PlayerModelId[] = ['deepseek', 'gemini', 'xai'];
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
const dollars = (value: number) => micros(value);
const same = (a: Pick, b: Pick) =>
  a.kind === b.kind &&
  (a.kind !== 'set' || a.set === (b as typeof a).set) &&
  (a.kind !== 'script' || a.id === (b as typeof a).id);

const CELL_TEXT: Record<RehearsalCell['state'], string> = {
  pending: '等待',
  running: '生成中',
  done: '',
  failed: '失败',
  unconfirmed: '未确认',
  skipped: '未发送',
};
const errorText = (code: string | null) => (code ? `代码 ${code}` : '');

/**
 * 多轮预演 (Part 35): a script of 6-20 player lines run on up to three draft models side by side. One wide panel: the scripts on
 * the left, the run settings and the paid button (one total, confirmed once) above, the conversations, counts and (for 梗与故事)
 * the hit / miss table below. Nothing here shows an id; the replies are admin test data.
 */
export function rehearsalView(host: RehearsalHost) {
  let disposed = false,
    busy = false,
    library: RehearsalLibrary | null = null,
    pick: Pick = { kind: 'set', set: 'chat' },
    items: RehearsalItems = { available: false, items: [] },
    chosenItems = new Set<string>(),
    models = new Set<PlayerModelId>(['deepseek']),
    withCast = false,
    castTouched = false,
    estimate: RehearsalEstimate | null = null,
    estimating = false,
    estimateFault = '',
    runs: RehearsalRunInfo[] = [],
    current: string | null = null,
    detail: RehearsalRunDetail | null = null,
    tab: 'chat' | 'counts' | 'memes' = 'chat',
    timer: unknown = null,
    seq = 0,
    pending: { id: string; sig: string } | null = null;
  const setTimer = host.poll?.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = host.poll?.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const newId = host.newId ?? (() => crypto.randomUUID());
  const gone = () => disposed || host.disposed();

  const panel = drawer(host.modalParent(), { title: '多轮预演', wide: true, onClose: () => stopPoll() });
  panel.body.classList.add('rh');
  const rail = h('nav', { class: 'rh-rail', attrs: { 'aria-label': '脚本' } });
  const main = h('section', { class: 'rh-main' });
  panel.body.append(rail, main);
  const setup = h('div', { class: 'rh-setup' });
  const result = h('div', { class: 'rh-result' });
  const manageHost = host.owner && host.confirm ? h('div', { class: 'pw-manage rh-manage' }) : null;
  main.append(setup);
  if (manageHost) main.append(manageHost);
  main.append(result);
  const manage =
    manageHost && host.owner && host.confirm
      ? previewManage(manageHost, {
          remove: async (runIds) => (await host.owner!.deleteRehearsals(runIds)).runs,
          confirm: host.confirm,
          run: host.run,
          toast: host.toast,
          disposed: gone,
          isOwner: () => host.isOwner?.() === true,
          reload: async () => {
            current = null;
            detail = null;
            await load();
          },
          targets: () =>
            runs.flatMap((r) => {
              const wrap = result.querySelector<HTMLElement>(`[data-run="${r.runId}"]`);
              return wrap
                ? [{ key: r.runId, el: wrap, slot: wrap, previews: 1, busy: r.status === 'running', isRun: true }]
                : [];
            }),
        })
      : null;

  // ---- the rail ---------------------------------------------------------------------------------------------------------
  const railButton = (label: string, target: Pick, meta = '') => {
    const b = h(
      'button',
      { class: 'rh-pick', attrs: { type: 'button', 'aria-pressed': String(same(pick, target)) } },
      h('span', { text: label }),
    );
    if (meta) b.append(h('span', { class: 'rh-meta', text: meta }));
    b.addEventListener('click', () => choose(target));
    return b;
  };
  const paintRail = () => {
    rail.replaceChildren(h('h4', { text: '内置' }));
    for (const set of library?.sets ?? [])
      rail.append(railButton(set.label, { kind: 'set', set: set.set }, `${set.turns.length} 轮`));
    if (items.available)
      rail.append(railButton(REHEARSAL_SET_LABELS.memes, { kind: 'memes' }, `${items.items.length} 项`));
    rail.append(h('h4', { text: '我的脚本' }));
    for (const s of library?.scripts ?? [])
      rail.append(railButton(s.name, { kind: 'script', id: s.id }, `${s.turns.length} 轮`));
    if (host.canEdit()) {
      const add = h('button', { class: 'admin-secondary rh-add', text: '＋ 新脚本', attrs: { type: 'button' } });
      add.addEventListener('click', () => choose({ kind: 'new' }));
      rail.append(add);
    }
  };

  // ---- the setup ----------------------------------------------------------------------------------------------------------
  const turnsOfPick = (): string[] | null => {
    if (pick.kind === 'set') return library?.sets.find((s) => s.set === (pick as { set: string }).set)?.turns ?? null;
    if (pick.kind === 'script')
      return library?.scripts.find((s) => s.id === (pick as { id: string }).id)?.turns ?? null;
    return null;
  };
  const source = (): RehearsalSource | null => {
    if (pick.kind === 'set') return { kind: 'set', set: pick.set };
    if (pick.kind === 'script') return { kind: 'script', scriptId: pick.id };
    if (pick.kind === 'memes') return { kind: 'memes', items: [...chosenItems] };
    return null;
  };
  const turnCount = () => (pick.kind === 'memes' ? chosenItems.size * 3 : (turnsOfPick()?.length ?? 0));
  const why = (): string => {
    if (!host.canStart()) return '没有预演权限';
    if (!host.draft()) return '先保存草稿';
    if (host.unsaved()) return '先保存草稿';
    if (pick.kind === 'new') return '先保存脚本';
    if (models.size === 0) return '选一个模型';
    const n = turnCount();
    if (pick.kind === 'memes' && (chosenItems.size < 2 || chosenItems.size > REHEARSAL_ITEMS_MAX))
      return `选 2–${REHEARSAL_ITEMS_MAX} 项`;
    if (n < REHEARSAL_TURNS_MIN || n > REHEARSAL_TURNS_MAX) return `${REHEARSAL_TURNS_MIN}–${REHEARSAL_TURNS_MAX} 轮`;
    if (estimateFault) return estimateFault;
    if (!estimate || estimating) return '估算中';
    if (busy) return '运行中';
    return '';
  };
  const send = paidButton({
    name: 'rehearsal',
    label: () => (estimate ? `运行 · ${estimate.calls} 次调用 · ${dollars(estimate.totalMicros)}` : '运行'),
    confirmLabel: () => `确认付费 · ${estimate ? dollars(estimate.totalMicros) : ''}`,
    reason: why,
    onConfirm: () => void start(),
    setTimer,
    clearTimer,
  });
  const modelBox = h('div', { class: 'rh-models', attrs: { role: 'group', 'aria-label': '模型' } });
  const castBox = h('button', {
    class: 'rh-toggle',
    text: '带关系与故事',
    attrs: { type: 'button', 'aria-pressed': 'false' },
  });
  castBox.addEventListener('click', () => {
    if (pick.kind === 'memes') return;
    withCast = !withCast;
    castTouched = true;
    paintSetup();
    refreshEstimate();
  });
  const settings = h('div', { class: 'rh-settings' }, modelBox, castBox, send.root);
  const editor = h('div', { class: 'rh-editor' });
  const paintModels = () => {
    modelBox.replaceChildren();
    for (const m of library?.models ?? []) {
      const b = h('button', {
        class: 'rh-toggle',
        text: m.label,
        attrs: { type: 'button', 'aria-pressed': String(models.has(m.id)), 'data-model': m.id },
      });
      b.disabled = !m.available;
      if (!m.available) hoverValue(b, '此环境未配置');
      b.addEventListener('click', () => {
        if (models.has(m.id)) models.delete(m.id);
        else models.add(m.id);
        paintSetup();
        refreshEstimate();
      });
      modelBox.append(b);
    }
  };
  const paintEditor = () => {
    editor.replaceChildren();
    if (pick.kind === 'memes') {
      const chips = h('div', { class: 'rh-chips', attrs: { role: 'group', 'aria-label': '梗与故事' } });
      for (const it of items.items) {
        const b = h('button', {
          class: 'rh-chip',
          text: it.label,
          attrs: { type: 'button', 'aria-pressed': String(chosenItems.has(it.key)), 'data-kind': it.kind },
        });
        b.addEventListener('click', () => {
          if (chosenItems.has(it.key)) chosenItems.delete(it.key);
          else if (chosenItems.size < REHEARSAL_ITEMS_MAX) chosenItems.add(it.key);
          paintSetup();
          refreshEstimate();
        });
        chips.append(b);
      }
      editor.append(chips, h('p', { class: 'rh-note', text: `${chosenItems.size} 项 · ${chosenItems.size * 3} 轮` }));
      return;
    }
    const saved =
      pick.kind === 'script' ? library?.scripts.find((s) => s.id === (pick as { id: string }).id) : undefined;
    const editable = (pick.kind === 'new' || pick.kind === 'script') && host.canEdit();
    const turns = turnsOfPick() ?? [];
    const name = h('input', {
      attrs: { type: 'text', maxlength: '30', placeholder: '脚本名', 'aria-label': '脚本名' },
    });
    name.value = saved?.name ?? '';
    const area = h('textarea', { attrs: { rows: '8', 'aria-label': '每行一轮', placeholder: '每行一轮' } });
    area.value = turns.join('\n');
    area.readOnly = !editable;
    const count = h('span', { class: 'rh-count' });
    const save = h('button', { class: 'admin-secondary', text: '保存', attrs: { type: 'button' } });
    const del = h('button', { class: 'admin-secondary', text: '删除', attrs: { type: 'button' } });
    const copy = h('button', { class: 'admin-secondary', text: '复制为我的脚本', attrs: { type: 'button' } });
    const check = () => {
      const l = lines(area.value);
      const bad = l.some((x) => charLength(x) > REHEARSAL_TURN_CHARS);
      count.textContent = `${l.length} 轮`;
      count.dataset.bad = String(l.length < REHEARSAL_TURNS_MIN || l.length > REHEARSAL_TURNS_MAX || bad);
      save.disabled = busy || !name.value.trim() || count.dataset.bad === 'true';
    };
    area.addEventListener('input', check);
    name.addEventListener('input', check);
    save.addEventListener('click', () => {
      const body = { requestId: newId(), id: saved?.id ?? null, name: name.value.trim(), turns: lines(area.value) };
      void host.run(async () => {
        busy = true;
        try {
          const s = await host.api.saveScript(body);
          library = await host.api.library();
          pick = { kind: 'script', id: s.id };
          host.toast('已保存', 'ok');
        } finally {
          busy = false;
        }
        render();
        refreshEstimate();
      });
    });
    let armed: ReturnType<typeof setTimeout> | null = null;
    del.addEventListener('click', () => {
      if (!saved) return;
      if (!armed) {
        del.textContent = '确认删除';
        armed = setTimeout(() => {
          armed = null;
          del.textContent = '删除';
        }, 4000);
        return;
      }
      clearTimeout(armed);
      void host.run(async () => {
        await host.api.deleteScript({ requestId: newId(), id: saved.id });
        library = await host.api.library();
        pick = { kind: 'set', set: 'chat' };
        render();
        refreshEstimate();
      });
    });
    copy.addEventListener('click', () => {
      pick = { kind: 'new' };
      render();
      (editor.querySelector('textarea') as HTMLTextAreaElement).value = turns.join('\n');
      check();
    });
    editor.append(
      editable
        ? name
        : h('span', { class: 'rh-title', text: pick.kind === 'set' ? REHEARSAL_SET_LABELS[pick.set] : '' }),
      area,
    );
    const actions = h('div', { class: 'rh-actions' }, count);
    if (editable) actions.append(save, ...(saved ? [del] : []));
    else if (host.canEdit()) actions.append(copy);
    editor.append(actions);
    check();
  };
  const paintSetup = () => {
    if (pick.kind === 'memes' && !castTouched) withCast = true;
    if (pick.kind === 'memes') withCast = true;
    castBox.setAttribute('aria-pressed', String(withCast));
    castBox.disabled = pick.kind === 'memes';
    paintModels();
    send.refresh();
  };
  setup.append(editor, settings);

  // ---- the estimate ---------------------------------------------------------------------------------------------------------
  function refreshEstimate() {
    const mine = ++seq;
    estimate = null;
    estimateFault = '';
    const d = host.draft(),
      src = source(),
      id = host.characterId();
    if (!d || !src || !id || models.size === 0 || host.unsaved()) return send.refresh();
    if (turnCount() < REHEARSAL_TURNS_MIN || turnCount() > REHEARSAL_TURNS_MAX) return send.refresh();
    estimating = true;
    send.refresh();
    host.api
      .estimate(id, {
        draftRevision: d.revision,
        profileHash: d.hash,
        source: src,
        models: MODEL_ORDER.filter((m) => models.has(m)),
        withCast,
      })
      .then((e) => {
        if (mine === seq && !gone()) estimate = e;
      })
      .catch((error: unknown) => {
        if (mine === seq && !gone()) estimateFault = '无法估算';
        void error;
      })
      .finally(() => {
        if (mine === seq && !gone()) {
          estimating = false;
          send.refresh();
        }
      });
  }
  async function start() {
    const d = host.draft(),
      src = source(),
      id = host.characterId();
    if (!d || !src || !id || !estimate || busy) return;
    const body = {
      draftRevision: d.revision,
      profileHash: d.hash,
      source: src,
      models: MODEL_ORDER.filter((m) => models.has(m)),
      withCast,
      acknowledgeMicros: estimate.totalMicros,
    };
    const sig = JSON.stringify(body);
    // A retry of the SAME inputs reuses the request id, so a lost answer never starts a second run.
    if (!pending || pending.sig !== sig) pending = { id: newId(), sig };
    const requestId = pending.id;
    await host.run(async () => {
      busy = true;
      send.refresh();
      try {
        const started = await host.api.start(id, { ...body, requestId });
        pending = null;
        runs = await host.api.list(id);
        current = started.runId;
        tab = 'chat';
        await load();
        host.toast('已开始', 'info');
      } catch (error) {
        if ((error as { code?: string })?.code === 'REHEARSAL_ESTIMATE_CHANGED') {
          pending = null;
          refreshEstimate();
        }
        throw error;
      } finally {
        busy = false;
        send.refresh();
      }
    });
  }

  // ---- results ------------------------------------------------------------------------------------------------------------------
  const stopPoll = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  async function load() {
    const id = host.characterId();
    if (!id || !current || gone()) return;
    const mine = current;
    try {
      const d = await host.api.detail(id, mine);
      if (gone() || mine !== current) return;
      detail = d;
      runs = runs.map((r) => (r.runId === mine ? d.run : r));
      paintResult();
    } catch {
      /* the next poll asks again */
    }
    stopPoll();
    if (!gone() && panel.isOpen() && detail?.run.status === 'running') timer = setTimer(() => void load(), POLL_MS);
  }
  const bubbleList = (cell: RehearsalCell) => {
    const box = h('div', { class: 'rh-cell', attrs: { 'data-state': cell.state } });
    if (cell.state === 'done' && cell.bubbles) {
      for (const b of cell.bubbles) box.append(h('p', { class: 'rh-bubble', text: b }));
      if (cell.answered === false) box.append(statusBadge('未答全', 'warn'));
    } else {
      const tone = cell.state === 'unconfirmed' ? 'warn' : cell.state === 'failed' ? 'danger' : 'neutral';
      const chip =
        cell.state === 'running' || cell.state === 'pending'
          ? h('span', { class: 'rh-wait', text: CELL_TEXT[cell.state] })
          : statusBadge(CELL_TEXT[cell.state], tone);
      if (cell.errorCode) hoverValue(chip, errorText(cell.errorCode));
      box.append(chip);
    }
    return box;
  };
  const conversation = (d: RehearsalRunDetail) => {
    const grid = h('div', { class: 'rh-grid', attrs: { role: 'table' } });
    grid.style.setProperty('--rh-cols', String(d.columns.length));
    grid.append(h('div', { class: 'rh-head rh-corner', text: '玩家' }));
    for (const c of d.columns)
      grid.append(h('div', { class: 'rh-head', text: c.label, attrs: { 'data-model': c.model } }));
    d.turns.forEach((turn, i) => {
      const row = h('div', { class: 'rh-row', attrs: { role: 'row' } });
      row.style.setProperty('--rh-i', String(Math.min(i, 12)));
      const who = h(
        'div',
        { class: 'rh-player' },
        h('span', { class: 'rh-n', text: String(i + 1) }),
        h('p', { text: turn.text || '…' }),
      );
      if (turn.role)
        who.append(statusBadge(turn.role === 'hint' ? '暗示' : '相似', turn.role === 'hint' ? 'info' : 'neutral'));
      row.append(who);
      for (const c of d.columns) row.append(bubbleList(c.cells[i]!));
      grid.append(row);
    });
    return grid;
  };
  const COUNT_ROWS: Array<[string, (c: RehearsalCounts) => string, (c: RehearsalCounts) => number | null]> = [
    ['答全每条', (c) => `${c.answeredAll} / ${c.replies}`, (c) => c.answeredAll],
    ['没问的建议', (c) => String(c.unaskedAdvice), (c) => c.unaskedAdvice],
    ['以问句结尾', (c) => `${c.endsWithQuestion} / ${c.replies}`, (c) => c.endsWithQuestion],
    ['平均字数', (c) => (c.avgChars === null ? '—' : String(c.avgChars)), (c) => c.avgChars],
    ['平均气泡', (c) => (c.avgBubbles === null ? '—' : String(c.avgBubbles)), (c) => c.avgBubbles],
    ['客服腔', (c) => String(c.customerService), (c) => c.customerService],
    ['重复', (c) => String(c.repeated), (c) => c.repeated],
    ['未确认', (c) => String(c.unconfirmed), (c) => c.unconfirmed],
  ];
  const countsTable = (d: RehearsalRunDetail) => {
    const table = h('table', { class: 'rh-counts' });
    table.append(
      h('thead', {}, h('tr', {}, h('th', { text: '' }), ...d.columns.map((c) => h('th', { text: c.label })))),
    );
    const body = h('tbody');
    for (const [label, text, num] of COUNT_ROWS) {
      const tr = h('tr', {}, h('th', { text: label, attrs: { scope: 'row' } }));
      for (const c of d.columns) {
        const td = h('td');
        const n = num(c.counts);
        if (n === null) td.textContent = '—';
        else {
          const span = h('span', { class: 'rh-num' });
          const finalText = text(c.counts);
          // The value rolls only when it is a plain number.
          if (/^[\d.]+$/.test(finalText))
            rollNumber(span, n, (v) => (Number.isInteger(n) ? String(Math.round(v)) : v.toFixed(1)));
          else span.textContent = finalText;
          td.append(span);
        }
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);
    return table;
  };
  const phraseEditor = () => {
    const box = h('details', { class: 'rh-words' });
    disclosureDetails(box, '词表');
    const cs = h('textarea', { attrs: { rows: '5', 'aria-label': '客服腔' } });
    const ad = h('textarea', { attrs: { rows: '5', 'aria-label': '没问的建议' } });
    cs.value = (library?.phrases.customerService ?? []).join('\n');
    ad.value = (library?.phrases.advice ?? []).join('\n');
    const save = h('button', { class: 'admin-secondary', text: '保存词表', attrs: { type: 'button' } });
    save.disabled = !host.canEdit();
    save.addEventListener(
      'click',
      () =>
        void host.run(async () => {
          const saved = await host.api.savePhrases({
            requestId: newId(),
            customerService: lines(cs.value),
            advice: lines(ad.value),
          });
          if (library) library = { ...library, phrases: saved };
          host.toast('已保存', 'ok');
          await load();
        }),
    );
    box.append(
      h(
        'div',
        { class: 'rh-words-grid' },
        h('label', {}, h('span', { text: '客服腔' }), cs),
        h('label', {}, h('span', { text: '没问的建议' }), ad),
      ),
      save,
    );
    return box;
  };
  const markCell = (
    cell: RehearsalMemeCell | undefined,
    pick_: (c: RehearsalMemeCell) => boolean | null,
    good: boolean,
  ) => {
    if (!cell || cell.state !== 'judged') {
      const state = cell?.state ?? 'pending';
      return state === 'unconfirmed'
        ? statusBadge('未确认', 'warn')
        : h('span', { class: 'rh-wait', text: state === 'pending' ? '等待' : '—' });
    }
    const v = pick_(cell);
    if (v === null) return h('span', { class: 'rh-wait', text: '—' });
    // For hints and own side true is good; for the look-alike true is the false trigger (bad).
    return statusBadge(
      good ? (v ? '命中' : '漏') : v ? '误触' : '没误触',
      good ? (v ? 'ok' : 'danger') : v ? 'danger' : 'ok',
    );
  };
  const memeTable = (d: RehearsalRunDetail) => {
    const table = h('table', { class: 'rh-counts rh-memes' });
    table.append(
      h(
        'thead',
        {},
        h('tr', {}, h('th', { text: '' }), h('th', { text: '' }), ...d.columns.map((c) => h('th', { text: c.label }))),
      ),
    );
    const body = h('tbody');
    for (const row of d.memes ?? []) {
      // Part 31b: the sentence behind each phrasing row (on hover, focus or tap), so the owner sees which wording missed.
      const parts: Array<[string, (c: RehearsalMemeCell) => boolean | null, boolean, string | null]> = [
        ['暗示一', (c) => c.hints[0] ?? null, true, row.hints[0]],
        ['暗示二', (c) => c.hints[1] ?? null, true, row.hints[1]],
        ['相似句', (c) => c.falseTrigger, false, row.lookAlike],
        ['自己的视角', (c) => c.ownSide, true, null],
      ];
      parts.forEach(([label, getter, good, sentence], i) => {
        const tr = h('tr', { attrs: { 'data-first': String(i === 0) } });
        if (i === 0) {
          const inner = h(
            'div',
            { class: 'rh-item' },
            h('span', { text: row.label }),
            statusBadge(row.kind === 'meme' ? '梗' : '故事', 'neutral'),
          );
          if (!row.played) inner.append(statusBadge('未写出暗示', 'warn'));
          const th = h('th', { attrs: { rowspan: '4', scope: 'rowgroup' } }, inner);
          tr.append(th);
        }
        const rowHead = h('th', { text: label, attrs: { scope: 'row' } });
        if (sentence) {
          const tip = h('span', { class: 'rh-sentence', text: sentence });
          rowHead.setAttribute('tabindex', '0');
          rowHead.append(tip);
          bindTip(rowHead, tip, rowHead, true);
        }
        tr.append(rowHead);
        for (const c of d.columns)
          tr.append(
            h(
              'td',
              {},
              row.played ? markCell(row.models[c.model], getter, good) : h('span', { class: 'rh-wait', text: '—' }),
            ),
          );
        body.append(tr);
      });
    }
    table.append(body);
    return table;
  };
  const paintResult = () => {
    const keepScroll = result.scrollTop;
    result.replaceChildren();
    const chips = h('div', { class: 'rh-runs', attrs: { role: 'group', 'aria-label': '运行记录' } });
    for (const r of runs) {
      const b = h(
        'button',
        { class: 'rh-run', attrs: { type: 'button', 'aria-pressed': String(r.runId === current) } },
        h('span', { text: r.scriptName }),
        h('span', { class: 'rh-meta', text: when(r.createdAt) }),
      );
      b.addEventListener('click', () => {
        current = r.runId;
        detail = null;
        paintResult();
        void load();
      });
      chips.append(h('div', { class: 'rh-run-wrap', attrs: { 'data-run': r.runId } }, b));
    }
    if (runs.length) result.append(chips);
    manage?.sync();
    if (!detail) {
      if (!runs.length) result.append(h('p', { class: 'rh-empty', text: '还没有运行。' }));
      return;
    }
    const d = detail;
    const total = d.turns.length * d.columns.length;
    const done = d.columns.reduce(
      (n, c) => n + c.cells.filter((x) => !['pending', 'running'].includes(x.state)).length,
      0,
    );
    const bar = h(
      'span',
      {
        class: 'rh-bar',
        attrs: {
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': String(total),
          'aria-valuenow': String(done),
        },
      },
      h('i'),
    );
    (bar.firstChild as HTMLElement).style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    const cost = h('span', { class: 'rh-cost' });
    rollNumber(cost, d.run.chargedMicros, (v) => dollars(Math.round(v)));
    const head = h(
      'div',
      { class: 'rh-runhead' },
      h('strong', { text: d.run.scriptName }),
      statusBadge(
        d.run.status === 'running' ? '进行中' : d.run.status === 'done' ? '完成' : '失败',
        d.run.status === 'done' ? 'ok' : d.run.status === 'failed' ? 'danger' : 'info',
      ),
      h('span', { class: 'rh-meta', text: `${done} / ${total}` }),
      bar,
      cost,
    );
    const tabs = [
      { id: 'chat' as const, label: '对话' },
      { id: 'counts' as const, label: '统计' },
      ...(d.memes ? [{ id: 'memes' as const, label: '梗与故事' }] : []),
    ];
    if (!tabs.some((t) => t.id === tab)) tab = 'chat';
    const seg = segmented('结果', tabs, tab, (id) => {
      tab = id;
      paintResult();
    });
    const pane = h('div', { class: 'rh-pane', attrs: { 'data-tab': tab } });
    if (tab === 'chat') pane.append(conversation(d));
    else if (tab === 'counts') pane.append(countsTable(d), phraseEditor());
    else pane.append(memeTable(d));
    result.append(head, seg.root, pane);
    result.scrollTop = keepScroll;
  };

  // ---- opening ------------------------------------------------------------------------------------------------------------------------
  function render() {
    paintRail();
    paintEditor();
    paintSetup();
  }
  function choose(next: Pick) {
    pick = next;
    if (next.kind !== 'memes' && !castTouched) withCast = false;
    if (next.kind === 'memes' && chosenItems.size === 0)
      for (const it of items.items.slice(0, REHEARSAL_ITEMS_MAX)) chosenItems.add(it.key);
    render();
    refreshEstimate();
  }
  async function open() {
    const id = host.characterId();
    if (!id) return;
    panel.open();
    try {
      [library, items, runs] = await Promise.all([host.api.library(), host.api.items(id), host.api.list(id)]);
    } catch {
      host.toast('读取失败', 'danger');
      return;
    }
    if (gone()) return;
    const usable = library.models.filter((m) => m.available).map((m) => m.id);
    models = new Set([...models].filter((m) => usable.includes(m)));
    if (models.size === 0 && usable[0]) models.add(usable[0]);
    current = runs[0]?.runId ?? null;
    detail = null;
    render();
    paintResult();
    refreshEstimate();
    void load();
  }
  return {
    open: () => void open(),
    /** The draft or the form changed: the estimate is for something else now. */
    refresh: () => {
      if (panel.isOpen()) refreshEstimate();
    },
    isOpen: () => panel.isOpen(),
    dispose: () => {
      disposed = true;
      stopPoll();
      panel.dispose();
    },
  };
}
