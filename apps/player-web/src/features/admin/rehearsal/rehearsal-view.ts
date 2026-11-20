import type { OwnerAdminClient } from '../../../services/owner-admin-api.ts';
import { previewManage } from '../owner/preview-manage.ts';
import type { ConfirmInPlace } from '../ui/inline-confirm.ts';
import { bindTip } from '../ui/tooltip.ts';
import {
  REHEARSAL_TURNS_MAX,
  REHEARSAL_TURNS_MIN,
  rehearsalTurnsMin,
  REHEARSAL_TURN_CHARS,
  REHEARSAL_ITEMS_MAX,
  REHEARSAL_SET_LABELS,
  REHEARSAL_COLUMN_KEYS,
  REHEARSAL_WRITER_LABELS,
  charLength,
  rehearsalColumnKey,
  parseRehearsalColumn,
  type RehearsalCell,
  type RehearsalCounts,
  type RehearsalStyle,
  type RehearsalEstimate,
  type RehearsalItems,
  type RehearsalLibrary,
  type RehearsalMemeCell,
  type RehearsalRunDetail,
  type RehearsalRunInfo,
  type RehearsalSet,
  type RehearsalSource,
} from '../../../../../../packages/contracts/web-rehearsal.ts';
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
  /** Part 31b: the live published version, which a run uses when there is no saved draft. null = never published. */
  live?: () => number | null;
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
  /** Part 31b: a place in the page for the view (the 预演 tab's second half, desktop). Absent = the wide drawer as before. */
  inline?: HTMLElement;
  newId?: () => string;
  /** Part 31b (owner): 整理 of the run records. Absent = nothing of it is drawn. */
  owner?: Record<'deleteRehearsals', OwnerAdminClient['deleteRehearsals']>;
  confirm?: ConfirmInPlace;
  isOwner?: () => boolean;
  poll?: { setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (handle: unknown) => void };
};
type Pick = { kind: 'set'; set: RehearsalSet } | { kind: 'memes' } | { kind: 'script'; id: string } | { kind: 'new' };
const POLL_MS = 2500;
const POLL_MAX_MS = 20_000;
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

/** The drawer's small surface (a body, open, isOpen, dispose) on a node that lives in the page: no overlay, nothing to close. */
function inlinePanel(host: HTMLElement) {
  const body = h('div', { class: 'rh-inline' });
  host.append(body);
  let open = false;
  return {
    body,
    isOpen: () => open,
    open() {
      open = true;
    },
    dispose() {
      open = false;
      body.remove();
    },
  };
}

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
    // Part 37a: the chosen COLUMNS, (model, writer) keys: `deepseek` is DeepSeek·旧, `deepseek-v8` DeepSeek·新.
    models = new Set<string>(['deepseek']),
    withCast = false,
    judgeStyle = false,
    castTouched = false,
    estimate: RehearsalEstimate | null = null,
    estimating = false,
    estimateFault = '',
    runs: RehearsalRunInfo[] = [],
    current: string | null = null,
    detail: RehearsalRunDetail | null = null,
    tab: 'chat' | 'counts' | 'memes' = 'chat',
    timer: unknown = null,
    // Part 40: what the result area shows right now, so a poll can change only what changed (see updateResult).
    painted: {
      runId: string;
      tab: string;
      shape: string;
      cells: Map<string, { el: HTMLElement; sig: string }>;
      head: HTMLElement;
      pane: HTMLElement;
      chips: HTMLElement | null;
      chipsSig: string;
      paneSig: string;
      table: HTMLElement | null;
    } | null = null,
    lastSig = '',
    idle = 0,
    seq = 0,
    pending: { id: string; sig: string } | null = null;
  const setTimer = host.poll?.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = host.poll?.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const newId = host.newId ?? (() => crypto.randomUUID());
  const gone = () => disposed || host.disposed();

  const panel = host.inline
    ? inlinePanel(host.inline)
    : drawer(host.modalParent(), { title: '多轮预演', wide: true, onClose: () => stopPoll() });
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
  /** What a run is frozen on: the saved draft; with none, the live published version. Only an unsaved edit blocks. */
  const base = () => {
    const d = host.draft();
    if (d) return { draftRevision: d.revision, profileHash: d.hash };
    const live = host.live?.() ?? null;
    return live === null ? null : { liveVersion: live };
  };
  const why = (): string => {
    if (!host.canStart()) return '没有预演权限';
    if (host.unsaved()) return '有未保存的修改';
    if (!base()) return '先保存草稿';
    if (pick.kind === 'new') return '先保存脚本';
    if (models.size === 0) return '选一个模型';
    const n = turnCount();
    if (pick.kind === 'memes' && (chosenItems.size < 2 || chosenItems.size > REHEARSAL_ITEMS_MAX))
      return `选 2–${REHEARSAL_ITEMS_MAX} 项`;
    const min = rehearsalTurnsMin(pick.kind === 'set' ? pick.set : undefined);
    if (n < min || n > REHEARSAL_TURNS_MAX) return `${min}–${REHEARSAL_TURNS_MAX} 轮`;
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
  // Part 37a-3: also have the judge read how each column talks (one more call per column, shown in the estimate).
  const styleBox = h('button', {
    class: 'rh-toggle',
    text: '评估说话方式',
    attrs: { type: 'button', 'aria-pressed': 'false' },
  });
  const styleTip = h('span', {
    class: 'rh-sentence',
    text: '让评审读每一列的回复：说了自己的事、主动起话题、情绪起伏。每列多一次评审调用，费用已计入。',
  });
  styleBox.append(styleTip);
  styleBox.setAttribute('tabindex', '0');
  bindTip(styleBox, styleTip, styleBox);
  styleBox.addEventListener('click', () => {
    judgeStyle = !judgeStyle;
    styleBox.setAttribute('aria-pressed', String(judgeStyle));
    refreshEstimate();
  });
  const settings = h('div', { class: 'rh-settings' }, modelBox, castBox, styleBox, send.root);
  const editor = h('div', { class: 'rh-editor' });
  // The toggles are built once per library and only re-pressed afterwards, so a press animates instead of being redrawn.
  let modelsBuiltFor: RehearsalLibrary | null = null;
  const paintModels = () => {
    if (modelsBuiltFor === library && modelBox.childElementCount > 0) {
      for (const b of modelBox.querySelectorAll('button'))
        b.setAttribute('aria-pressed', String(models.has(b.dataset.model ?? '')));
      return;
    }
    modelsBuiltFor = library;
    modelBox.replaceChildren();
    // One row per model with its two writers: 旧 (the writer every reply has today) and 新.
    for (const m of library?.models ?? []) {
      const group = h(
        'div',
        { class: 'rh-model', attrs: { role: 'group', 'aria-label': m.label } },
        h('span', { class: 'rh-model-name', text: m.label }),
      );
      for (const writer of ['v7', 'v8'] as const) {
        const key = rehearsalColumnKey(m.id, writer);
        const b = h('button', {
          class: 'rh-toggle',
          text: REHEARSAL_WRITER_LABELS[writer],
          attrs: { type: 'button', 'aria-pressed': String(models.has(key)), 'data-model': key },
        });
        b.disabled = !m.available;
        if (!m.available) hoverValue(b, '此环境未配置');
        b.addEventListener('click', () => {
          if (models.has(key)) models.delete(key);
          else models.add(key);
          paintSetup();
          refreshEstimate();
        });
        group.append(b);
      }
      modelBox.append(group);
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
    const d = base(),
      src = source(),
      id = host.characterId();
    if (!d || !src || !id || models.size === 0 || host.unsaved()) return send.refresh();
    if (
      turnCount() < rehearsalTurnsMin(pick.kind === 'set' ? pick.set : undefined) ||
      turnCount() > REHEARSAL_TURNS_MAX
    )
      return send.refresh();
    estimating = true;
    send.refresh();
    host.api
      .estimate(id, {
        ...d,
        source: src,
        models: REHEARSAL_COLUMN_KEYS.filter((m) => models.has(m)),
        withCast,
        style: judgeStyle,
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
    const d = base(),
      src = source(),
      id = host.characterId();
    if (!d || !src || !id || !estimate || busy) return;
    const body = {
      ...d,
      source: src,
      models: REHEARSAL_COLUMN_KEYS.filter((m) => models.has(m)),
      withCast,
      ...(judgeStyle ? { style: true } : {}),
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
        lastSig = '';
        idle = 0;
        painted = null;
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
    let changed = true;
    try {
      const d = await host.api.detail(id, mine);
      if (gone() || mine !== current) return;
      const sig = JSON.stringify(d);
      changed = sig !== lastSig;
      lastSig = sig;
      detail = d;
      runs = runs.map((r) => (r.runId === mine ? d.run : r));
      if (changed || !painted) updateResult();
    } catch {
      /* the next poll asks again */
    }
    stopPoll();
    // Part 40: nothing new = the next look comes later (2.5 s, then 4, 6.4 ... up to 20 s); a change starts over; a finished run stops.
    idle = changed ? 0 : Math.min(idle + 1, 8);
    if (!gone() && panel.isOpen() && detail?.run.status === 'running')
      timer = setTimer(() => void load(), Math.min(POLL_MS * 1.6 ** idle, POLL_MAX_MS));
  }
  const cellSig = (cell: RehearsalCell) => JSON.stringify([cell.state, cell.errorCode, cell.bubbles, cell.answered]);
  const bubbleList = (cell: RehearsalCell, key = '') => {
    const box = h('div', {
      class: 'rh-cell',
      attrs: { 'data-state': cell.state, ...(key ? { 'data-cell': key } : {}) },
    });
    if (cell.state === 'done' && cell.bubbles) {
      for (const b of cell.bubbles) box.append(h('p', { class: 'rh-bubble', text: b }));
      if (cell.answered === false) box.append(statusBadge('未答全', 'warn'));
    } else {
      const tone = cell.state === 'unconfirmed' ? 'warn' : cell.state === 'failed' ? 'danger' : 'neutral';
      const chip =
        cell.state === 'running' || cell.state === 'pending'
          ? h('span', { class: 'rh-wait', text: CELL_TEXT[cell.state] })
          : statusBadge(CELL_TEXT[cell.state], tone);
      if (cell.errorCode) hoverValue(chip, errorText(cell.errorCode), true);
      box.append(chip);
    }
    return box;
  };
  /**
   * Part 44: every result table scrolls sideways inside its own box (wheel, trackpad, keyboard, or the bar below). The box's own
   * scrollbar would sit under the LAST row, out of sight on a long table, so it is hidden and `.rh-hbar` stands in for it: a plain
   * scrollbar, sticky at the bottom of the panel while any of the table is on screen, kept in step with the box both ways.
   */
  const scrollBox = (inner: HTMLElement) => {
    const box = h(
      'div',
      { class: 'rh-scroll', attrs: { tabindex: '0', role: 'region', 'aria-label': '结果表' } },
      inner,
    );
    const fill = h('i');
    const bar = h('div', { class: 'rh-hbar', attrs: { 'aria-hidden': 'true' } }, fill);
    let from: 'box' | 'bar' | null = null;
    const sync = (source: 'box' | 'bar', a: HTMLElement, b: HTMLElement) => () => {
      if (from && from !== source) return;
      from = source;
      b.scrollLeft = a.scrollLeft;
      requestAnimationFrame(() => {
        from = null;
      });
    };
    box.addEventListener('scroll', sync('box', box, bar));
    bar.addEventListener('scroll', sync('bar', bar, box));
    const size = () => {
      // the same distance to scroll on both: the bar is a little wider than the box (the box has a border)
      fill.style.setProperty('--rh-fill', `${bar.clientWidth + box.scrollWidth - box.clientWidth}px`);
      bar.hidden = box.scrollWidth <= box.clientWidth + 1;
    };
    if (typeof ResizeObserver !== 'undefined') {
      const watch = new ResizeObserver(size);
      watch.observe(box);
      watch.observe(inner);
    }
    return h('div', { class: 'rh-scrollwrap' }, box, bar);
  };
  const conversation = (d: RehearsalRunDetail) => {
    const grid = h('div', { class: 'rh-grid', attrs: { role: 'table' } });
    grid.style.setProperty('--rh-cols', String(d.columns.length));
    grid.append(h('div', { class: 'rh-head rh-corner', text: '玩家' }));
    for (const c of d.columns)
      grid.append(h('div', { class: 'rh-head', text: c.label, attrs: { 'data-model': c.key } }));
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
      for (const c of d.columns) row.append(bubbleList(c.cells[i]!, `${i}:${c.key}`));
      grid.append(row);
    });
    return scrollBox(grid);
  };
  type Column = RehearsalRunDetail['columns'][number];
  /** One row of the counts table: its label, an optional note under it, and per column the shown text and the number that rolls. */
  interface CountRow {
    label: string;
    note?: string;
    value: (c: Column) => { text: string; n: number | null; over?: boolean; state?: RehearsalStyle['state'] };
  }
  const plain = (text: (c: RehearsalCounts) => string, num: (c: RehearsalCounts) => number | null) => (c: Column) => ({
    text: text(c.counts),
    n: num(c.counts),
  });
  /** Part 37a-3: the three counts the judge reads; only a run that has a 新 column judges them. */
  const styleValue = (pick: (s: RehearsalStyle) => number | null) => (c: Column) => ({
    text: pick(c.style) === null ? '—' : `${pick(c.style)} / ${c.counts.replies}`,
    n: pick(c.style),
    state: c.style.state,
  });
  /** The target for 以问句结尾: about one reply in three, or fewer. */
  const QUESTION_TARGET = 1 / 3;
  const COUNT_ROWS: CountRow[] = [
    {
      label: '答全每条',
      value: plain(
        (c) => (c.answeredAll === null ? '—' : `${c.answeredAll} / ${c.replies}`),
        (c) => c.answeredAll,
      ),
    },
    {
      label: '没问的建议',
      value: plain(
        (c) => String(c.unaskedAdvice),
        (c) => c.unaskedAdvice,
      ),
    },
    { label: '说了自己的事', note: '自己的生活或看法', value: styleValue((s) => s.sharedOwn) },
    { label: '主动起话题', note: '起了话题或转了话题', value: styleValue((s) => s.startedTopic) },
    { label: '情绪起伏', note: '情绪露在用词里', value: styleValue((s) => s.showedEmotion) },
    {
      label: '以问句结尾',
      note: '目标：约三条里不超过一条',
      value: (c) => ({
        text: `${c.counts.endsWithQuestion} / ${c.counts.replies}`,
        n: c.counts.endsWithQuestion,
        over: c.counts.replies > 0 && c.counts.endsWithQuestion / c.counts.replies > QUESTION_TARGET,
      }),
    },
    {
      label: '平均字数',
      value: plain(
        (c) => (c.avgChars === null ? '—' : String(c.avgChars)),
        (c) => c.avgChars,
      ),
    },
    {
      label: '平均气泡',
      value: plain(
        (c) => (c.avgBubbles === null ? '—' : String(c.avgBubbles)),
        (c) => c.avgBubbles,
      ),
    },
    {
      label: '客服腔',
      value: plain(
        (c) => String(c.customerService),
        (c) => c.customerService,
      ),
    },
    {
      label: '重复',
      value: plain(
        (c) => String(c.repeated),
        (c) => c.repeated,
      ),
    },
    {
      label: '未确认',
      value: plain(
        (c) => String(c.unconfirmed),
        (c) => c.unconfirmed,
      ),
    },
  ];
  const STYLE_LABELS = new Set(['说了自己的事', '主动起话题', '情绪起伏']);
  const countsTable = (d: RehearsalRunDetail) => {
    const table = h('table', { class: 'rh-counts' });
    table.style.setProperty('--rh-cols', String(d.columns.length));
    table.append(
      h('thead', {}, h('tr', {}, h('th', { text: '' }), ...d.columns.map((c) => h('th', { text: c.label })))),
    );
    const body = h('tbody');
    const judgesStyle = d.columns.some((c) => c.style.state !== 'none');
    for (const row of COUNT_ROWS) {
      if (!judgesStyle && STYLE_LABELS.has(row.label)) continue;
      const head = h('th', { attrs: { scope: 'row' } }, h('span', { text: row.label }));
      if (row.note) head.append(h('span', { class: 'rh-note', text: row.note }));
      const tr = h('tr', {}, head);
      for (const c of d.columns) {
        const td = h('td');
        const { text, n, over, state } = row.value(c);
        if (over) td.classList.add('rh-over');
        if (n === null) {
          // A judged row with no number says why: still waiting, not sure, or the judge's answer did not hold.
          if (state === 'unconfirmed') td.append(statusBadge('未确认', 'warn'));
          else if (state === 'failed' || state === 'skipped')
            td.append(h('span', { class: 'rh-wait', text: '未得出' }));
          else if (state === 'pending') td.append(h('span', { class: 'rh-wait', text: '等待' }));
          else td.textContent = '—';
        } else {
          const span = h('span', { class: 'rh-num' });
          // The value rolls only when it is a plain number.
          if (/^[\d.]+$/.test(text))
            rollNumber(span, n, (v) => (Number.isInteger(n) ? String(Math.round(v)) : v.toFixed(1)));
          else span.textContent = text;
          td.append(span);
          if (over) td.append(h('span', { class: 'rh-over-mark', text: '偏多' }));
        }
        tr.append(td);
      }
      body.append(tr);
    }
    // Part 40: the codes behind the failed, unconfirmed and unsent cells, counted per code.
    if (d.columns.some((c) => Object.keys(c.counts.codes).length > 0)) {
      const tr = h('tr', { attrs: { 'data-row': 'codes' } }, h('th', { text: '代码', attrs: { scope: 'row' } }));
      for (const c of d.columns) {
        const td = h('td');
        for (const [code, n] of Object.entries(c.counts.codes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
          td.append(h('div', { class: 'rh-code', text: `${code} × ${n}` }));
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
    table.style.setProperty('--rh-cols', String(d.columns.length));
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
              row.played ? markCell(row.models[c.key], getter, good) : h('span', { class: 'rh-wait', text: '—' }),
            ),
          );
        body.append(tr);
      });
    }
    table.append(body);
    return table;
  };
  /** The nearest ancestor that scrolls, so a full repaint puts the page back where it was. */
  const scroller = () => {
    for (let el: HTMLElement | null = result; el; el = el.parentElement)
      if (el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
    return document.scrollingElement as HTMLElement | null;
  };
  const shapeOf = (d: RehearsalRunDetail) =>
    `${d.turns.length}|${d.columns.map((c) => c.key).join(',')}|${d.memes ? 1 : 0}`;
  const runBadge = (d: RehearsalRunDetail) =>
    statusBadge(
      d.run.status === 'running' ? '进行中' : d.run.status === 'done' ? '完成' : '失败',
      d.run.status === 'done' ? 'ok' : d.run.status === 'failed' ? 'danger' : 'info',
    );
  const progress = (d: RehearsalRunDetail) => {
    const total = d.turns.length * d.columns.length;
    const done = d.columns.reduce(
      (n, c) => n + c.cells.filter((x) => !['pending', 'running'].includes(x.state)).length,
      0,
    );
    return { total, done };
  };
  const chipsOf = () => {
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
        painted = null;
        lastSig = '';
        idle = 0;
        paintResult();
        void load();
      });
      chips.append(h('div', { class: 'rh-run-wrap', attrs: { 'data-run': r.runId } }, b));
    }
    return chips;
  };
  const chipsSigOf = () => JSON.stringify([current, runs.map((r) => [r.runId, r.scriptName, r.createdAt])]);
  /** Counts and the hit / miss table are replaced as one piece, and only when their numbers changed. */
  const paneTable = (d: RehearsalRunDetail) =>
    tab === 'counts' ? scrollBox(countsTable(d)) : tab === 'memes' ? scrollBox(memeTable(d)) : null;
  const paneSigOf = (d: RehearsalRunDetail) =>
    tab === 'counts'
      ? JSON.stringify(d.columns.map((c) => [c.label, c.counts]))
      : tab === 'memes'
        ? JSON.stringify([d.columns.map((c) => c.label), d.memes])
        : '';
  /** A whole repaint: a first look, another run, another tab. */
  const paintResult = () => {
    const bar0 = scroller(),
      keep = bar0?.scrollTop ?? 0;
    result.replaceChildren();
    const chips = chipsOf();
    if (runs.length) result.append(chips);
    manage?.sync();
    if (!detail) {
      painted = null;
      if (!runs.length) result.append(h('p', { class: 'rh-empty', text: '还没有运行。' }));
      return;
    }
    const d = detail;
    const { total, done } = progress(d);
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
    const count = h('span', { class: 'rh-meta rh-progress', text: `${done} / ${total}` });
    const head = h(
      'div',
      { class: 'rh-runhead' },
      h('strong', { text: d.run.scriptName }),
      runBadge(d),
      ...(d.run.liveVersion === null ? [] : [h('span', { class: 'rh-meta', text: `线上 v${d.run.liveVersion}` })]),
      count,
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
    const cells = new Map<string, { el: HTMLElement; sig: string }>();
    let table: HTMLElement | null = null;
    if (tab === 'chat') {
      const grid = conversation(d);
      pane.append(grid);
      for (const el of grid.querySelectorAll<HTMLElement>('[data-cell]')) {
        const [i, key] = el.dataset.cell!.split(/:(.*)/s);
        const column = d.columns.find((c) => c.key === key)!;
        cells.set(el.dataset.cell!, { el, sig: cellSig(column.cells[Number(i)]!) });
      }
    } else {
      table = paneTable(d);
      pane.append(table!);
      if (tab === 'counts') pane.append(phraseEditor());
    }
    result.append(head, seg.root, pane);
    painted = {
      runId: d.run.runId,
      tab,
      shape: shapeOf(d),
      cells,
      head,
      pane,
      chips: runs.length ? chips : null,
      chipsSig: chipsSigOf(),
      paneSig: paneSigOf(d),
      table,
    };
    if (bar0) bar0.scrollTop = keep;
  };
  /**
   * Part 40: a poll that brought news. Only what changed is touched: a reply that landed replaces its own cell, the progress line,
   * the bar and the cost change in place, a table is replaced only when its numbers changed. Nothing around them is rebuilt, so the
   * scroll position, the tab, an open 词表 and the focus stay where they are.
   */
  const updateResult = () => {
    const d = detail;
    if (!d || !painted || painted.runId !== d.run.runId || painted.tab !== tab || painted.shape !== shapeOf(d))
      return paintResult();
    if (painted.chipsSig !== chipsSigOf()) {
      const fresh = chipsOf();
      if (painted.chips) painted.chips.replaceWith(fresh);
      else result.prepend(fresh);
      painted.chips = fresh;
      painted.chipsSig = chipsSigOf();
      manage?.sync();
    }
    const { total, done } = progress(d);
    const head = painted.head;
    const badge = head.querySelector<HTMLElement>('.admin-badge')!;
    const nextBadge = runBadge(d);
    if (badge.textContent !== nextBadge.textContent) badge.replaceWith(nextBadge);
    const count = head.querySelector<HTMLElement>('.rh-progress');
    if (count) count.textContent = `${done} / ${total}`;
    const bar = head.querySelector<HTMLElement>('.rh-bar');
    if (bar) {
      bar.setAttribute('aria-valuenow', String(done));
      (bar.firstChild as HTMLElement).style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    }
    const cost = head.querySelector<HTMLElement>('.rh-cost');
    if (cost) rollNumber(cost, d.run.chargedMicros, (v) => dollars(Math.round(v)));
    if (tab === 'chat') {
      d.turns.forEach((_turn, i) => {
        for (const c of d.columns) {
          const key = `${i}:${c.key}`,
            known = painted!.cells.get(key),
            sig = cellSig(c.cells[i]!);
          if (!known || known.sig === sig) continue;
          const el = bubbleList(c.cells[i]!, key);
          known.el.replaceWith(el);
          painted!.cells.set(key, { el, sig });
        }
      });
      return;
    }
    const sig = paneSigOf(d);
    if (sig !== painted.paneSig && painted.table) {
      const fresh = paneTable(d)!;
      painted.table.replaceWith(fresh);
      painted.table = fresh;
      painted.paneSig = sig;
    }
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
    models = new Set([...models].filter((m) => usable.includes(parseRehearsalColumn(m)!.model)));
    if (models.size === 0 && usable[0]) models.add(rehearsalColumnKey(usable[0], 'v7'));
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
