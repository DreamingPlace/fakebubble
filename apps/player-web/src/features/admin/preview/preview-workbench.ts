import { plain, withoutIds } from '../history/readable.ts';
import { h } from '../../cocreation/h.ts';
import type { AdminMember } from '../../../services/account-admin-api.ts';
import type { CharacterAdminClient, CharacterDetail } from '../../../services/character-admin-api.ts';
import { segmented } from '../ui/segmented.ts';
import type {
  Bubble,
  EvalSet,
  PreviewAdminClient,
  PreviewCastSource,
  PreviewDetail,
  PreviewRow,
  RunDetail,
  RunSummary,
} from '../../../services/preview-admin-api.ts';
import { hasCharacterPermission } from '../../../../../../packages/contracts/web-admin-permissions.ts';
import { dataTable } from '../ui/data-table.ts';
import type { OwnerAdminClient } from '../../../services/owner-admin-api.ts';
import { previewManage } from '../owner/preview-manage.ts';
import type { ConfirmInPlace } from '../ui/inline-confirm.ts';
import { exactCount, hoverValue } from '../ui/hover-value.ts';
import { copyCodeButton, errorLine, sentenceOf } from '../ui/error-line.ts';
import { keyValuePanel } from '../ui/key-value-panel.ts';
import { paidButton } from '../ui/paid-button.ts';
import { statusBadge, type BadgeTone } from '../ui/status-badge.ts';
import { compareRuns } from './compare.ts';
import {
  COVERAGE_LABEL,
  SETTLEMENT_LABEL,
  SETTLEMENT_TONE,
  STATUS_LABEL,
  errorText,
  micros,
  seconds,
  settlementCopy,
  when,
  zoneLabel,
} from './copy.ts';
import { diffBubbles } from './diff.ts';
import { evalSetEditor } from './eval-set-editor.ts';
import { listenBar } from './listen.ts';
import { downloadText, exportName, runToCsv, runToJson } from './export.ts';
import { previewPoller, type PollerHost } from './poller.ts';
import { disclosureButton, disclosureDetails } from '../ui/disclosure.ts';
import { growBox } from '../ui/grow-box.ts';
import { reviewCompareView } from './review-compare-view.ts';
import { rehearsalView } from '../rehearsal/rehearsal-view.ts';
import { STAGE_LABEL, isFinished, progressText, stageOf, type Stage } from './stage.ts';

export const RUN_MAX = 50;
const INPUT_MAX = 4000;
export type PreviewToastAction = { label: string; run: () => void };
export type PreviewWorkbenchHost = {
  api: PreviewAdminClient;
  characters: Pick<CharacterAdminClient, 'detail'>;
  member: () => AdminMember | null;
  run: (work: () => Promise<void>) => Promise<void>;
  status: (text: string) => void;
  disposed: () => boolean;
  /** `action` is the toast's 查看: it jumps to the row the toast is about. */
  toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger', action?: PreviewToastAction) => void;
  /** Kept for the page wiring; 预演 itself opens no dialog and no drawer. */
  modalParent: () => HTMLElement;
  /** A 预演 changed state (finished, failed, was submitted): the editor beside this panel re-reads the proofs it offers. */
  changed?: () => void;
  /** Part 24b-6c: the editor beside this panel holds unsaved changes (a preview would send the saved draft, not these). */
  draftUnsaved?: () => boolean;
  /** Part 24b-6c: saves the draft (the reason line's 保存草稿 link). */
  saveDraft?: () => void;
  /** Injected in tests: timer, visibility, download and request ids. */
  poll?: Partial<Pick<PollerHost, 'setTimer' | 'clearTimer' | 'hidden' | 'onVisible'>>;
  download?: (name: string, text: string, type: string) => void;
  newId?: () => string;
  /** Part 31 (owner): deleting 预演 records. Absent (any other administrator, or a page without it) = nothing of it is drawn. */
  owner?: Pick<OwnerAdminClient, 'deletePreviews'>;
  confirm?: ConfirmInPlace;
};
const defaultHidden = () => (globalThis as { document?: { hidden?: boolean } }).document?.hidden === true;
const defaultOnVisible = (fn: () => void) => {
  document.addEventListener('visibilitychange', fn);
  return () => document.removeEventListener('visibilitychange', fn);
};
const FILTER_STATUSES: ReadonlyArray<readonly [string, string]> = [
  ['', '全部状态'],
  ['queued', STATUS_LABEL.queued],
  ['generating', STATUS_LABEL.generating],
  ['succeeded', STATUS_LABEL.succeeded],
  ['failed', STATUS_LABEL.failed],
];
const STAGE_TONE: Record<Stage, BadgeTone> = {
  queued: 'neutral',
  draft: 'info',
  review: 'info',
  done: 'ok',
  failed: 'danger',
};
const bubbleList = (bubbles: readonly Bubble[]) => {
  const list = h('div', { class: 'pw-bubbles' });
  for (const b of bubbles)
    list.append(
      h(
        'div',
        { class: 'pw-bubble' },
        h('span', { text: b.text }),
        b.expression
          ? h('span', { class: 'admin-badge', text: b.expression, attrs: { 'data-tone': 'neutral' } })
          : null,
      ),
    );
  return list;
};
const coverageText = (p: PreviewRow) =>
  p.final?.coverage.length ? p.final.coverage.map((c) => COVERAGE_LABEL[c.status]).join('、') : '—';
const signature = (p: Pick<PreviewRow, 'status' | 'settlement' | 'errorCode'>) =>
  `${p.status}|${p.settlement}|${p.errorCode}`;
const TITLE_MARK = /^\((进行中|完成)\) /;

/** One line of the results: a real preview row, or a submitted line the server has not answered yet (shown at once as 排队中). */
type Line = { key: string; previewId: string | null; ordinal: number | null; input: string; row: PreviewRow | null };
/** A submission that has been sent and not answered yet: its lines are on screen already. */
type Pending = { key: string; kind: 'single' | 'run'; label: string | null; at: number; inputs: string[] };
type LineEntry = {
  key: string;
  el: HTMLElement;
  row: HTMLElement;
  panel: HTMLElement;
  inner: HTMLElement;
  chip: HTMLElement;
  input: HTMLElement;
  result: HTMLElement;
  cost: HTMLElement;
  time: HTMLElement;
  sig: string;
  line: Line;
};
type RunEntry = {
  key: string;
  el: HTMLElement;
  head: HTMLElement;
  /** The open/close button of the run header (it holds aria-expanded; the checkbox is its sibling). */
  toggle: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  count: HTMLElement;
  bar: HTMLElement;
  body: HTMLElement;
  panel: HTMLElement;
  inner: HTMLElement;
  lines: HTMLElement;
  tick: HTMLInputElement | null;
  filter: HTMLSelectElement;
  rows: Map<string, LineEntry>;
};
/** Puts `desired` under `parent` in that order, moving only what is out of place (so running animations are not restarted). */
function reconcile(parent: HTMLElement, desired: HTMLElement[]) {
  const children = Array.from(parent.children);
  if (children.length === desired.length && desired.every((node, index) => children[index] === node)) return;
  // A stub DOM (the component tests) has no insertBefore: it simply takes the whole list.
  if (typeof parent.insertBefore !== 'function') {
    parent.replaceChildren(...desired);
    return;
  }
  desired.forEach((node, index) => {
    const at = parent.children[index];
    if (at !== node) parent.insertBefore(node, at ?? null);
  });
  for (const extra of Array.from(parent.children).slice(desired.length)) extra.remove();
}

/**
 * 预演测试. One working column, like a chat (Part 24b-6c): the settings in one summary line, one box to type in (one line = one
 * preview, several lines = one run), the send button that says what it will cost and asks again before any paid call, and the
 * results directly below it, newest first, each line with its own live state. A result opens BELOW its row. It only ever sends
 * the character's saved draft and the admin's own synthetic inputs; the one timer is the batched status poller, which backs
 * off, stops when nothing is queued or running and sleeps while the tab is hidden.
 */
export function previewWorkbench(root: HTMLElement, host: PreviewWorkbenchHost) {
  let disposed = false,
    busy = false,
    id: string | null = null,
    detail: CharacterDetail | null = null,
    view = 0,
    settingsOpen = false;
  let runs: RunSummary[] = [],
    singles: PreviewRow[] = [],
    sets: EvalSet[] = [];
  const loaded = new Map<string, RunDetail>();
  const pending: Pending[] = [];
  /** Things submitted from this page that have not been announced yet: the toast says when they finish. */
  const watching = new Map<string, { kind: 'single' | 'run'; label: string | null }>();
  /** The run to open once the feed has it (a run just submitted, or the newest on open). */
  let wantOpen: string | null = null;
  let openRunKey: string | null = null;
  let openLineKey: string | null = null;
  const chosen: string[] = [];
  const known = new Map<string, string>();
  const gone = () => disposed || host.disposed();
  const can = (action: 'preview' | 'read') => {
    const m = host.member();
    return !!m && (m.role === 'owner' || hasCharacterPermission(m.permissions, action, id ?? ''));
  };
  const nextId = host.newId ?? (() => crypto.randomUUID());
  let localSeq = 0;
  const reduceMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches === true;

  // ---- the page frame -------------------------------------------------------------------------------------------
  const settingsHost = h('div', { class: 'pw-settings' });
  const composeHost = h('div', { class: 'pw-composer' });
  const compareHost = h('div', { class: 'pw-compare-bar' });
  const feed = h('div', {
    class: 'pw-feed',
    attrs: { role: 'region', 'aria-label': '预演结果', 'aria-live': 'polite' },
  });
  const empty = h('p', { class: 'pw-empty', text: '还没有预演。' });
  // Part 26b: 审核对比 (V4 Pro against V4.1 Flash) is a section of 预演; it loads when it is opened.
  const reviewApi = host.api.reviewCompare;
  const reviewHost = h('div', { class: 'pw-review-compare' });
  const reviewSection = reviewApi
    ? h('details', { class: 'pw-review-section', attrs: { 'data-section': 'review-compare' } })
    : null;
  if (reviewSection) {
    disclosureDetails(reviewSection, '审核对比（V4 Pro / V4.1 Flash）');
    reviewSection.append(reviewHost);
  }
  // Part 35: 多轮预演 opens its own wide panel (a script on up to three models, side by side).
  const rehearsalApi = host.api.rehearsal;
  const rehearsal = rehearsalApi
    ? rehearsalView({
        api: rehearsalApi,
        characterId: () => id,
        draft: () => (detail?.draft ? { revision: detail.draft.revision, hash: detail.draft.contentHash } : null),
        unsaved: () => host.draftUnsaved?.() === true,
        canStart: () => can('preview'),
        canEdit: () => {
          const m = host.member();
          return !!m && (m.role === 'owner' || hasCharacterPermission(m.permissions, 'preview', '*'));
        },
        run: host.run,
        toast: host.toast,
        disposed: () => disposed || host.disposed(),
        modalParent: host.modalParent,
        ...(host.newId ? { newId: host.newId } : {}),
        ...(host.poll?.setTimer || host.poll?.clearTimer
          ? {
              poll: {
                ...(host.poll.setTimer ? { setTimer: host.poll.setTimer } : {}),
                ...(host.poll.clearTimer ? { clearTimer: host.poll.clearTimer } : {}),
              },
            }
          : {}),
      })
    : null;
  const rehearsalOpen = rehearsalApi
    ? h('button', {
        class: 'admin-secondary pw-rehearse',
        text: '多轮预演',
        attrs: { type: 'button', 'data-pw-rehearsal': '' },
      })
    : null;
  rehearsalOpen?.addEventListener('click', () => rehearsal?.open());
  // Part 31: the owner's 整理预演 bar (only when the host can delete; for anyone else the page is exactly as before).
  const manageHost = host.owner && host.confirm ? h('div', { class: 'pw-manage' }) : null;
  const page = h(
    'div',
    { class: 'pw' },
    settingsHost,
    composeHost,
    rehearsalOpen,
    compareHost,
    manageHost,
    feed,
    empty,
    reviewSection,
  );
  root.append(page);
  const reviewCompare = reviewApi
    ? reviewCompareView(reviewHost, {
        api: reviewApi,
        canStart: () => {
          const m = host.member();
          return !!m && (m.role === 'owner' || hasCharacterPermission(m.permissions, 'preview', '*'));
        },
        run: host.run,
        toast: host.toast,
        disposed: () => disposed || host.disposed(),
        modalParent: host.modalParent,
        ...(host.newId ? { newId: host.newId } : {}),
        ...(host.download ? { download: host.download } : {}),
        ...(host.poll ? { poll: host.poll } : {}),
      })
    : null;
  let reviewOpened = false;
  reviewSection?.addEventListener('toggle', () => {
    if ((reviewSection as HTMLDetailsElement).open && !reviewOpened) {
      reviewOpened = true;
      void reviewCompare?.open();
    }
  });

  // ---- settings: one summary line, the controls under it ----------------------------------------------------------
  let pendingRun: { sig: string; body: Parameters<PreviewAdminClient['startRun']>[1] } | null = null;
  let pendingSingle: { sig: string; body: Parameters<PreviewAdminClient['startSingle']>[1] } | null = null;
  const simMode = h('select', { attrs: { 'aria-label': '模拟时间' } });
  simMode.append(
    h('option', { text: '使用真实时间', attrs: { value: 'none' } }),
    h('option', { text: '指定时间', attrs: { value: 'set' } }),
  );
  const simTime = h('input', { attrs: { type: 'time', value: '05:50', 'aria-label': '模拟的当地时间' } });
  simTime.value = '05:50';
  // The character's own time zone: its name is the visible text, the id and "cannot be changed" are the hover tip.
  const simZoneText = h('span');
  const simZone = h('span', { class: 'admin-hint pw-zone' }, simZoneText);
  hoverValue(simZone, '');
  // 关系与故事 for this 预演 (Part 24a castSource): the cast draft is how the owner tests it before CAST_CONTEXT_ENABLED is on.
  // Always sent, so what is tested is what is shown on the chip, not whatever the server defaults to.
  let castSource: PreviewCastSource = 'none';
  const castSwitch = segmented<PreviewCastSource>(
    '关系与故事',
    [
      { id: 'none', label: '不用' },
      { id: 'published', label: '已发布' },
      { id: 'draft', label: '草稿' },
    ],
    castSource,
    (next) => {
      castSource = next;
      paintAll();
    },
  );
  const setPicker = h('select', { attrs: { 'aria-label': '评测集' } });
  const editSets = h('button', { class: 'admin-secondary', text: '编辑评测集', attrs: { type: 'button' } });
  const summary = h('button', {
    class: 'pw-summary',
    attrs: { type: 'button', 'aria-expanded': 'false', 'data-pw-summary': '' },
  });
  const summaryText = h('span', { class: 'pw-summary-text' });
  disclosureButton(summary, summaryText, false);
  const controls = h(
    'div',
    { class: 'pw-set-row' },
    h(
      'div',
      { class: 'admin-filter pw-sim' },
      h('span', { text: '模拟时间' }),
      h('span', { class: 'pw-sim-row' }, simMode, simTime),
      simZone,
    ),
    h('div', { class: 'admin-filter' }, h('span', { text: '关系与故事' }), castSwitch.root),
    h(
      'div',
      { class: 'admin-filter pw-sets' },
      h('span', { text: '评测集' }),
      h('span', { class: 'pw-sim-row' }, setPicker, editSets),
    ),
  );
  const editorHost = h('div', { class: 'pw-eval-host' });
  const settingsInner = h('div', { class: 'ot-inner' }, controls, editorHost);
  const settingsPanel = h(
    'div',
    { class: 'ot-panel pw-settings-panel', attrs: { 'data-state': 'closed' } },
    settingsInner,
  );
  settingsHost.append(summary, settingsPanel);
  const paintSettings = () => {
    summary.setAttribute('aria-expanded', String(settingsOpen));
    settingsPanel.dataset.state = settingsOpen ? 'open' : 'closed';
    settingsPanel.dataset.settled = 'false';
    if (settingsOpen)
      setTimeout(() => {
        if (settingsOpen) settingsPanel.dataset.settled = 'true';
      }, 280);
  };
  summary.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    paintSettings();
  });
  const editor = evalSetEditor(editorHost, {
    api: host.api,
    canWrite: () => {
      const m = host.member();
      return !!m && (m.role === 'owner' || hasCharacterPermission(m.permissions, 'preview', '*'));
    },
    run: host.run,
    toast: host.toast,
    changed: (next) => {
      sets = next;
      paintSetPicker();
    },
  });
  editSets.addEventListener('click', () => {
    settingsOpen = true;
    paintSettings();
    if (editor.isOpen()) editor.close();
    else editor.open(sets);
  });

  // ---- the box and the one send button ---------------------------------------------------------------------------
  // one line per input, so the box keeps its Enter; it starts at four lines and grows with what is typed
  const input = growBox(
    h('textarea', { attrs: { placeholder: '输入（一行一条）', 'aria-label': '预演输入', 'data-pw-input': '' } }),
    'para',
    { multiline: true },
  );
  const label = h('input', {
    attrs: { type: 'text', maxlength: '60', placeholder: '运行备注（可选）', 'aria-label': '运行备注' },
  });
  const lines = () =>
    input.value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((text) => ({ text, note: null }));
  const simulated = () => (simMode.value === 'set' && /^\d\d:\d\d$/.test(simTime.value) ? simTime.value : undefined);
  const zone = () => detail?.draft?.profile.template.schedule.timeZone ?? '';
  const selectedSet = () => sets.find((s) => s.id === setPicker.value) ?? null;
  const calls = (n: number) => n * 2;
  type Plan = { kind: 'single' | 'run' | 'set'; n: number; calls: number; set: EvalSet | null };
  /** What a send would do now: typed lines win; with an empty box the chosen eval set runs. */
  const plan = (): Plan | null => {
    const typed = lines();
    if (typed.length === 1) return { kind: 'single', n: 1, calls: calls(1), set: null };
    if (typed.length > 1) return { kind: 'run', n: typed.length, calls: calls(typed.length), set: null };
    const set = selectedSet();
    return set ? { kind: 'set', n: set.items.length, calls: calls(set.items.length), set } : null;
  };
  // One node for the whole life of the panel, so the link keeps its identity while the line is repainted.
  const unsavedLine = (() => {
    const link = h('button', { class: 'pw-link', text: '保存草稿', attrs: { type: 'button' } });
    link.addEventListener('click', () => host.saveDraft?.());
    return h('span', {}, '草稿未保存 · ', link);
  })();
  /** Why nothing can be sent right now: one short line next to the button, or '' when sending is possible. */
  const reason = (): string | Node => {
    if (!can('preview')) return '你没有预演权限';
    if (!detail) return '正在读取';
    if (!detail.previewAvailable) return '预演暂不可用';
    if (!detail.draft) return '没有草稿';
    if (host.draftUnsaved?.()) return unsavedLine;
    const typed = lines();
    const long = typed.findIndex((l) => [...l.text].length > INPUT_MAX);
    if (long >= 0) return `第 ${long + 1} 行过长`;
    if (typed.length > RUN_MAX) return `超过 ${RUN_MAX} 条`;
    if (busy) return '正在提交';
    if (!plan()) return '没有输入';
    return '';
  };
  const idleLabel = () => {
    const p = plan();
    if (!p) return '预演';
    if (p.kind === 'single') return `预演 1 条 · ${p.calls} 次付费调用`;
    if (p.kind === 'run') return `运行 ${p.n} 条 · ${p.calls} 次付费调用`;
    return `运行评测集「${p.set!.name}」v${p.set!.version} · ${p.calls} 次付费调用`;
  };
  const send = paidButton({
    name: 'preview',
    label: idleLabel,
    confirmLabel: () => `确认付费 · ${plan()?.calls ?? 0} 次`,
    reason,
    onConfirm: () => sendNow(),
    ...(host.poll?.setTimer ? { setTimer: host.poll.setTimer } : {}),
    ...(host.poll?.clearTimer ? { clearTimer: host.poll.clearTimer } : {}),
  });
  const compose = h(
    'div',
    { class: 'pw-compose-main' },
    h('div', { class: 'pw-compose-fields' }, input, label),
    send.root,
  );
  composeHost.append(compose);
  input.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.isComposing) {
      e.preventDefault?.();
      send.button.click();
    }
  });

  const summaryLine = () => {
    const set = selectedSet();
    return [
      simulated() ? `模拟 ${simulated()}` : '真实时间',
      castSource === 'none' ? '不用关系与故事' : `关系与故事 ${castSource === 'draft' ? '草稿' : '已发布'}`,
      set ? `评测集 ${set.name} v${set.version}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const paintAll = () => {
    simTime.disabled = simMode.value !== 'set';
    editSets.disabled = busy;
    simZoneText.textContent = zone() ? zoneLabel(zone()) : '';
    hoverValue(simZone, zone() ? `角色时区 ${zone()}，不可更改` : '');
    summaryText.textContent = summaryLine();
    send.root.dataset.kind = plan()?.kind ?? 'none';
    const p = plan();
    send.button.setAttribute(
      'title',
      p ? `每条含草稿与审核两个阶段，共 ${p.calls} 次付费调用；单次最多 ${RUN_MAX} 条` : '',
    );
    send.refresh();
  };
  const lock = paintAll;
  function paintSetPicker() {
    const keep = setPicker.value;
    setPicker.replaceChildren(h('option', { text: sets.length ? '不用评测集' : '尚无评测集', attrs: { value: '' } }));
    for (const s of sets)
      setPicker.append(
        h('option', { text: `${s.name} · v${s.version} · ${s.items.length} 条`, attrs: { value: s.id } }),
      );
    if (sets.some((s) => s.id === keep)) setPicker.value = keep;
    paintAll();
  }
  for (const control of [simMode, simTime, setPicker, input, label]) {
    control.addEventListener('input', paintAll);
    control.addEventListener('change', paintAll);
  }

  // ---- submitting ------------------------------------------------------------------------------------------------
  const submit = (work: () => Promise<void>) => {
    if (busy || gone()) return;
    busy = true;
    paintAll();
    void host.run(work).finally(() => {
      busy = false;
      paintAll();
    });
  };
  const draftBody = () => {
    const d = detail!.draft!;
    return { draftRevision: d.revision, profileHash: d.contentHash };
  };
  const afterSend = () => {
    // The settings fold into their summary line once a send has used them.
    settingsOpen = false;
    editor.close();
    paintSettings();
  };
  function sendNow() {
    const p = plan();
    if (!p || reason() !== '') return;
    if (p.kind === 'single') startSingleNow(lines()[0]!.text);
    else startRun(p.kind === 'run' ? lines() : null, p.set?.id ?? null, p.set ? p.set.items.map((i) => i.text) : null);
  }
  const startRun = (inputs: ReturnType<typeof lines> | null, setId: string | null, setTexts: string[] | null) => {
    const d = detail?.draft;
    if (!d || !id) return;
    const characterId = id;
    const time = simulated();
    const body = {
      ...draftBody(),
      castSource,
      ...(label.value.trim() ? { label: label.value.trim() } : {}),
      ...(time ? { simulatedTime: time } : {}),
    };
    const sig = JSON.stringify([characterId, body, inputs, setId]);
    // The same submission is retried with the same requestId, so a lost reply can never queue a second run.
    if (pendingRun?.sig !== sig)
      pendingRun = {
        sig,
        body: { requestId: nextId(), ...body, ...(setId ? { evalSetId: setId } : { inputs: inputs! }) } as never,
      };
    const request = pendingRun.body;
    const mine: Pending = {
      key: `local-${++localSeq}`,
      kind: 'run',
      label: label.value.trim() || null,
      at: Date.now(),
      inputs: inputs ? inputs.map((l) => l.text) : (setTexts ?? []),
    };
    submit(async () => {
      showPending(mine);
      let result: Awaited<ReturnType<PreviewAdminClient['startRun']>>;
      try {
        result = await host.api.startRun(characterId, request);
      } catch (error) {
        dropPending(mine);
        throw error;
      }
      pendingRun = null;
      if (gone() || characterId !== id) return;
      input.value = '';
      label.value = '';
      wantOpen = result.runId;
      watching.set(result.runId, { kind: 'run', label: null });
      host.status('已提交一次运行；各条按顺序排队，不会自动重发。');
      afterSend();
      await refresh([result.runId], mine);
      poller.kick();
    });
  };
  function startSingleNow(message: string) {
    const d = detail?.draft;
    if (!d || !id) return;
    const characterId = id,
      time = simulated();
    const body = { ...draftBody(), castSource, message, ...(time ? { simulatedTime: time } : {}) };
    const sig = JSON.stringify([characterId, body]);
    if (pendingSingle?.sig !== sig) pendingSingle = { sig, body: { requestId: nextId(), ...body } };
    const request = pendingSingle.body;
    const mine: Pending = {
      key: `local-${++localSeq}`,
      kind: 'single',
      label: null,
      at: Date.now(),
      inputs: [message],
    };
    submit(async () => {
      showPending(mine);
      let row: PreviewRow;
      try {
        row = await host.api.startSingle(characterId, request);
      } catch (error) {
        dropPending(mine);
        throw error;
      }
      pendingSingle = null;
      if (gone() || characterId !== id) return;
      input.value = '';
      singles = [row, ...singles.filter((s) => s.previewId !== row.previewId)];
      known.set(row.previewId, signature(row));
      watching.set(row.previewId, { kind: 'single', label: null });
      seenKeys.add(row.previewId);
      afterSend();
      removePending(mine);
      syncFeed();
      poller.kick();
    });
  }

  // ---- the results ------------------------------------------------------------------------------------------------
  const lineEntries = new Map<string, LineEntry>();
  const runEntries = new Map<string, RunEntry>();
  /** Keys that have already entered: a replaced local row does not enter a second time. */
  const seenKeys = new Set<string>();
  const runTitle = (run: RunSummary, index: number) => run.label ?? `运行 ${runs.length - index}`;
  const detailPanel = () => {
    const inner = h('div', { class: 'ot-inner' });
    const panel = h('div', { class: 'ot-panel pw-panel', attrs: { 'data-state': 'closed' } }, inner);
    return { inner, panel };
  };
  const setPanel = (panel: HTMLElement, open: boolean) => {
    panel.dataset.state = open ? 'open' : 'closed';
    panel.dataset.settled = 'false';
    if (open)
      setTimeout(() => {
        if (panel.dataset.state === 'open') panel.dataset.settled = 'true';
      }, 280);
  };
  const resultCell = (line: Line) => {
    const p = line.row;
    if (!p) return h('span', { class: 'admin-hint', text: '—' });
    if (p.final) return h('span', { text: p.final.bubbles.map((b) => b.text).join(' / ') });
    if (p.status === 'failed') {
      const cell = errorLine(p.errorCode, { class: 'pw-fail', sentence: errorText(p.errorCode) });
      if (p.settlement) cell.append(' ', statusBadge(SETTLEMENT_LABEL[p.settlement], SETTLEMENT_TONE[p.settlement]));
      return cell;
    }
    return h('span', { class: 'admin-hint', text: '—' });
  };
  const hovered = (text: string, tip: string) => {
    const cell = h('span', { text });
    hoverValue(cell, tip);
    return cell;
  };
  const stageOfLine = (line: Line): Stage => (line.row ? stageOf(line.row) : 'queued');
  function makeLine(line: Line): LineEntry {
    const chip = h('span', { class: 'pw-state' });
    const inputCell = h('span', { class: 'pw-input' });
    const result = h('span', { class: 'pw-result' });
    const cost = h('span', { class: 'pw-num' });
    const time = h('span', { class: 'pw-num' });
    const row = h(
      'div',
      { class: 'pw-row', attrs: { role: 'button', tabindex: '0', 'aria-expanded': 'false' } },
      chip,
      inputCell,
      result,
      cost,
      time,
    );
    const { inner, panel } = detailPanel();
    const el = h('div', { class: 'pw-item pw-line', attrs: { 'data-key': line.key } }, row, panel);
    const entry: LineEntry = {
      key: line.key,
      el,
      row,
      panel,
      inner,
      chip,
      input: inputCell,
      result,
      cost,
      time,
      sig: '',
      line,
    };
    const open = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('button, a, input, select, textarea, .ad-tip')) return;
      void toggleLine(entry);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if ((key === 'Enter' || key === ' ') && event.target === row) {
        event.preventDefault();
        void toggleLine(entry);
      }
    });
    if (!seenKeys.has(line.key)) {
      seenKeys.add(line.key);
      el.dataset.enter = 'true';
    }
    return entry;
  }
  function paintLine(entry: LineEntry, line: Line) {
    entry.line = line;
    const stage = stageOfLine(line);
    const p = line.row;
    const sig = `${stage}|${p ? signature(p) : ''}|${p?.final ? 'f' : ''}|${p?.cost.chargedMicros ?? ''}|${p?.latency.draftMs ?? ''}|${p?.latency.reviewMs ?? ''}`;
    entry.row.dataset.state = stage;
    entry.row.dataset.key = line.key;
    if (entry.sig === sig && entry.input.textContent === line.input) return;
    entry.sig = sig;
    entry.chip.replaceChildren(statusBadge(STAGE_LABEL[stage], STAGE_TONE[stage]));
    entry.input.textContent = `${line.ordinal ? `${line.ordinal}  ` : ''}${line.input}`;
    entry.result.replaceChildren(resultCell(line));
    entry.cost.replaceChildren(
      p
        ? hovered(
            micros(p.cost.chargedMicros),
            `实收 ${micros(p.cost.chargedMicros)} · 仍保留 ${micros(p.cost.heldMicros)}`,
          )
        : '',
    );
    entry.time.replaceChildren(
      p && (p.latency.draftMs !== null || p.latency.reviewMs !== null)
        ? hovered(
            seconds((p.latency.draftMs ?? 0) + (p.latency.reviewMs ?? 0)),
            `草稿 ${seconds(p.latency.draftMs)} · 审核 ${seconds(p.latency.reviewMs)}`,
          )
        : '',
    );
  }
  const closeLine = (entry: LineEntry) => {
    for (const bar of listeners.splice(0)) bar.dispose();
    entry.row.setAttribute('aria-expanded', 'false');
    entry.el.dataset.open = 'false';
    setPanel(entry.panel, false);
    setTimeout(() => {
      if (entry.panel.dataset.state === 'closed') entry.inner.replaceChildren();
    }, 280);
  };
  async function toggleLine(entry: LineEntry) {
    const characterId = id;
    if (!characterId) return;
    if (openLineKey === entry.key) {
      openLineKey = null;
      closeLine(entry);
      return;
    }
    const previewId = entry.line.previewId;
    if (!previewId) return;
    if (openLineKey) {
      const previous = lineEntries.get(openLineKey);
      if (previous) closeLine(previous);
    }
    openLineKey = entry.key;
    entry.row.setAttribute('aria-expanded', 'true');
    entry.el.dataset.open = 'true';
    entry.inner.replaceChildren(h('p', { class: 'admin-hint pw-reading', text: '正在读取…' }));
    setPanel(entry.panel, true);
    await host.run(async () => {
      const full = await host.api.detail(characterId, previewId);
      if (gone() || characterId !== id || openLineKey !== entry.key) return;
      entry.inner.replaceChildren(renderDetail(full));
    });
  }
  /** The 试听 bars of the rows that were opened: their object URLs and players go when the row closes or the page does. */
  const listeners: { dispose: () => void }[] = [];
  function renderDetail(p: PreviewDetail) {
    const body = h('div', { class: 'pw-detail' });
    const section = (title: string, ...nodes: Node[]) =>
      body.append(h('section', { class: 'pw-section' }, h('h4', { text: title }), ...nodes));
    section(
      '输入',
      h('pre', { class: 'pw-pre', text: p.input ?? '' }),
      p.note ? h('p', { class: 'admin-hint', text: `备注：${p.note}` }) : (null as never),
    );
    const draftTexts = p.draft?.bubbles?.map((b) => b.text) ?? [];
    const finalTexts = p.final?.bubbles.map((b) => b.text) ?? [];
    if (p.final) {
      const diff = h('div', { class: 'pw-diff' });
      for (const row of diffBubbles(draftTexts, finalTexts)) {
        const line = h('div', { class: 'pw-diff-row' });
        for (const piece of row.pieces)
          line.append(
            h('span', {
              class: piece.kind === 'same' ? '' : piece.kind === 'del' ? 'pw-del' : 'pw-add',
              text: piece.text,
            }),
          );
        diff.append(line);
      }
      section(
        p.final?.reviewChanged
          ? `草稿与最终气泡（审核改动已标出${p.final.reviewDecisionNormalized ? '；审核写了 reject 但给出了可发布的替代气泡，已按 accept 处理' : ''}）`
          : '草稿与最终气泡（审核未改动）',
        h(
          'div',
          { class: 'pw-sides' },
          h(
            'div',
            {},
            h('h5', { text: '草稿' }),
            p.draft?.bubbles ? bubbleList(p.draft.bubbles) : h('p', { class: 'admin-hint', text: '—' }),
          ),
          h(
            'div',
            {},
            h('h5', { text: '最终' }),
            p.final ? bubbleList(p.final.bubbles) : h('p', { class: 'admin-hint', text: '—' }),
          ),
        ),
        diff,
      );
      if (p.status === 'succeeded' && detail?.speech?.available === true) {
        const bar = listenBar({
          api: host.api,
          characterId: p.characterId,
          previewId: p.previewId,
          available: () => detail?.speech?.available === true,
          hasVoice: () => detail?.speech?.hasVoice === true,
          allowed: () => can('preview'),
          run: host.run,
          newId: nextId,
          disposed: gone,
          ...(host.poll?.setTimer ? { setTimer: host.poll.setTimer } : {}),
          ...(host.poll?.clearTimer ? { clearTimer: host.poll.clearTimer } : {}),
        });
        listeners.push(bar);
        section('试听', bar.root);
      }
    }
    if (p.review?.coverage) {
      const list = h('ul', { class: 'pw-coverage' });
      // The place is the message's number in this preview (第 N 条), never the message's id.
      Object.values(p.review.coverage).forEach((item, index) =>
        list.append(
          h(
            'li',
            {},
            h('span', { class: 'pw-place', text: `第 ${index + 1} 条` }),
            statusBadge(
              COVERAGE_LABEL[item.status as keyof typeof COVERAGE_LABEL] ?? item.status,
              item.status === 'answered' ? 'ok' : 'warn',
            ),
            h('span', { text: item.supportQuote ? ` 引用：“${item.supportQuote}”` : '' }),
            item.missingInformation ? h('span', { text: ` 缺少：${item.missingInformation}` }) : null,
          ),
        ),
      );
      section('覆盖与引用', list);
    }
    const topics = p.final?.topics ?? p.review?.topics ?? [];
    const factOps = p.final?.factOps ?? p.review?.factOps ?? [];
    if (topics.length || factOps.length)
      section('话题 / 事实', h('pre', { class: 'pw-pre', text: plain(withoutIds({ topics, factOps })) }));
    if (p.status === 'failed') {
      const parts: Node[] = [
        h('p', {}, errorLine(p.errorCode, { class: 'pw-fail', sentence: errorText(p.errorCode) })),
      ];
      for (const r of p.rejected)
        parts.push(
          h(
            'h5',
            {
              text: `${r.phase === 'draft' ? '草稿' : '审核'}阶段被拒收的模型输出（${sentenceOf(r.errorCode, '原因未知').replace(/。$/, '')}${r.truncated ? `，已截断，原文 ${exactCount(r.rawBytes)} 字节` : ''}）`,
            },
            ' ',
            copyCodeButton(r.errorCode),
          ),
          h('pre', { class: 'pw-pre pw-raw', text: r.rawOutput }),
        );
      if (!p.rejected.length)
        parts.push(
          h('p', { class: 'admin-hint', text: '没有保留模型输出（失败发生在返回完整响应之前，或在此功能启用之前）。' }),
        );
      section('失败', ...parts);
    }
    section(
      '结算',
      p.settlement ? statusBadge(SETTLEMENT_LABEL[p.settlement], SETTLEMENT_TONE[p.settlement]) : (null as never),
      h('p', { class: 'pw-settlement', text: settlementCopy(p) }),
      keyValuePanel([
        [
          '草稿阶段',
          p.cost.draft
            ? `${p.cost.draft.model} · 实收 ${micros(p.cost.draft.chargedMicros)} · 预留 ${micros(p.cost.draft.reservedMicros)} · ${seconds(p.cost.draft.wallMs)}`
            : null,
        ],
        [
          '审核阶段',
          p.cost.review
            ? `${p.cost.review.model} · 实收 ${micros(p.cost.review.chargedMicros)} · 预留 ${micros(p.cost.review.reservedMicros)} · ${seconds(p.cost.review.wallMs)}`
            : null,
        ],
        ['合计', `实收 ${micros(p.cost.chargedMicros)} · 仍保留 ${micros(p.cost.heldMicros)}`],
      ]),
    );
    section(
      // Part 24b-7: no id string in an admin view (the preview, run, budget and provider-request ids are not shown).
      '预演条件',
      keyValuePanel([
        ['草稿修订', String(p.draftRevision)],
        [
          '模拟时间',
          p.simulatedTime
            ? `${zoneLabel(p.simulatedTime.timeZone)} ${p.simulatedTime.time}（${p.simulatedTime.timeZone}）`
            : '真实时间',
        ],
        ['提交时间', when(p.createdAt)],
      ]),
    );
    return body;
  }

  /** The lines of a run (or of a submission that is still on its way). */
  const rowLine = (p: PreviewRow): Line => ({
    key: p.previewId,
    previewId: p.previewId,
    ordinal: p.ordinal,
    input: p.input ?? '',
    row: p,
  });
  function syncLines(entries: Map<string, LineEntry>, host_: HTMLElement, wanted: Line[]) {
    const nodes: HTMLElement[] = [];
    const keep = new Set<string>();
    for (const line of wanted) {
      keep.add(line.key);
      let entry = entries.get(line.key) ?? lineEntries.get(line.key);
      if (!entry) entry = makeLine(line);
      entries.set(line.key, entry);
      lineEntries.set(line.key, entry);
      paintLine(entry, line);
      nodes.push(entry.el);
    }
    for (const key of [...entries.keys()])
      if (!keep.has(key)) {
        entries.delete(key);
        lineEntries.delete(key);
      }
    reconcile(host_, nodes);
  }
  function makeRun(key: string): RunEntry {
    const tick = h('input', { attrs: { type: 'checkbox', 'aria-label': '选择此运行用于对比' } });
    const title = h('span', { class: 'pw-run-title' });
    const meta = h('span', { class: 'pw-run-meta' });
    const count = h('span', { class: 'pw-count' });
    const barFill = h('i');
    const bar = h('span', { class: 'pw-progress', attrs: { role: 'progressbar', 'aria-valuemin': '0' } }, barFill);
    // Part 24b-7: the checkbox and the open/close control are two elements, each with its own label and keys (a role=button
    // never holds a checkbox). The button carries aria-expanded; a click on the empty part of the row still opens it (mouse).
    const toggle = h(
      'button',
      { class: 'pw-run-toggle', attrs: { type: 'button', 'aria-expanded': 'false' } },
      h('i', { class: 'pw-chev', attrs: { 'aria-hidden': 'true' } }),
      title,
      meta,
      h('span', { class: 'pw-run-count' }, count, bar),
    );
    const head = h('div', { class: 'pw-run-head' }, h('label', { class: 'pw-tick' }, tick), toggle);
    const filter = h('select', { attrs: { 'aria-label': '状态' } });
    for (const [value, text] of FILTER_STATUSES) filter.append(h('option', { text, attrs: { value } }));
    const exportButtons = (['json', 'csv'] as const).map((kind) => {
      const button = h('button', {
        class: 'admin-secondary',
        text: kind === 'json' ? '导出 JSON' : '导出 CSV',
        attrs: { type: 'button', 'data-export': kind },
      });
      button.addEventListener(
        'click',
        () =>
          void host.run(async () => {
            const full = await ensureRun(key, true);
            const save = host.download ?? downloadText;
            if (kind === 'json') save(exportName(full.run, 'json'), runToJson(full), 'application/json');
            else save(exportName(full.run, 'csv'), runToCsv(full), 'text/csv');
          }),
      );
      return button;
    });
    const linesHost = h('div', { class: 'pw-lines', attrs: { role: 'rowgroup' } });
    const body = h(
      'div',
      { class: 'pw-run-body', attrs: { 'data-run': key } },
      h('div', { class: 'pw-run-tools' }, filter, ...exportButtons),
      linesHost,
    );
    const { inner, panel } = detailPanel();
    inner.append(body);
    const el = h('div', { class: 'pw-item pw-batch', attrs: { 'data-key': key } }, head, panel);
    const entry: RunEntry = {
      key,
      el,
      head,
      toggle,
      title,
      meta,
      count,
      bar,
      body,
      panel,
      inner,
      lines: linesHost,
      tick,
      filter,
      rows: new Map(),
    };
    // The button is the control (Enter / Space are the browser's own); the row's empty part opens it for the mouse.
    toggle.addEventListener('click', () => toggleRun(entry));
    head.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('button, a, input, select, textarea, label, .ad-tip')) return;
      toggleRun(entry);
    });
    tick.addEventListener('click', (event) => event.stopPropagation());
    tick.addEventListener('change', () => {
      const at = chosen.indexOf(key);
      if (tick.checked) {
        if (chosen.length >= 2) {
          tick.checked = false;
          return;
        }
        if (at < 0) chosen.push(key);
      } else if (at >= 0) chosen.splice(at, 1);
      paintCompare();
    });
    filter.addEventListener('change', () => paintRunLines(entry));
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      el.dataset.enter = 'true';
    }
    return entry;
  }
  function paintRunHead(
    entry: RunEntry,
    run: RunSummary,
    index: number,
    finished: number,
    total: number,
    failed: number,
  ) {
    entry.title.textContent = runTitle(run, index);
    entry.tick?.setAttribute('aria-label', `选择“${runTitle(run, index)}”用于对比`);
    entry.meta.textContent = [
      when(run.createdAt),
      run.simulatedTime ? `模拟 ${zoneLabel(run.timeZone)} ${run.simulatedTime.time}` : '真实时间',
      `草稿 ${run.draftRevision}`,
      run.evalSet ? `评测集 v${run.evalSet.version}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    paintRunCount(entry, finished, total, failed);
  }
  function paintRunCount(entry: RunEntry, finished: number, total: number, failed: number) {
    entry.count.textContent = progressText(finished, total, failed);
    entry.bar.setAttribute('aria-valuemax', String(total));
    entry.bar.setAttribute('aria-valuenow', String(finished));
    entry.bar.style?.setProperty('--pw-p', `${total ? Math.round((finished / total) * 100) : 0}%`);
    entry.el.dataset.done = String(total > 0 && finished === total);
  }
  function runLinesOf(run: RunSummary): Line[] {
    return (loaded.get(run.runId)?.previews ?? []).map(rowLine);
  }
  function paintRunLines(entry: RunEntry) {
    const wanted = entry.filter.value;
    const run = runs.find((r) => r.runId === entry.key);
    const all = (loaded.get(entry.key)?.previews ?? []).filter((p) => !wanted || p.status === wanted);
    void run;
    syncLines(entry.rows, entry.lines, all.map(rowLine));
  }
  function toggleRun(entry: RunEntry) {
    const isOpen = openRunKey === entry.key;
    if (isOpen) {
      openRunKey = null;
      closeRun(entry);
      return;
    }
    if (openRunKey) {
      const previous = runEntries.get(openRunKey);
      if (previous) closeRun(previous);
    }
    openRunKey = entry.key;
    void openRun(entry);
  }
  async function openRun(entry: RunEntry) {
    entry.toggle.setAttribute('aria-expanded', 'true');
    entry.el.dataset.open = 'true';
    if (!loaded.has(entry.key)) await host.run(async () => void (await ensureRun(entry.key, false)));
    if (gone() || openRunKey !== entry.key) return;
    paintRunLines(entry);
    setPanel(entry.panel, true);
  }
  function closeRun(entry: RunEntry) {
    entry.toggle.setAttribute('aria-expanded', 'false');
    entry.el.dataset.open = 'false';
    setPanel(entry.panel, false);
  }
  /** A submission whose answer has not come back: every line is on screen as 排队中. */
  function makePendingRun(p: Pending): RunEntry {
    const entry = makeRun(p.key);
    entry.tick?.parentElement?.setAttribute('hidden', '');
    return entry;
  }

  type Item =
    | { kind: 'pending'; at: number; pending: Pending }
    | { kind: 'run'; at: number; run: RunSummary; index: number }
    | { kind: 'single'; at: number; row: PreviewRow };
  function syncFeed() {
    if (gone()) return;
    const items: Item[] = [
      ...pending.map((p): Item => ({ kind: 'pending', at: p.at + 1e15, pending: p })),
      ...runs.map((run, index): Item => ({ kind: 'run', at: run.createdAt, run, index })),
      ...singles.map((row): Item => ({ kind: 'single', at: row.createdAt, row })),
    ].sort((a, b) => b.at - a.at);
    const nodes: HTMLElement[] = [];
    const liveRuns = new Set<string>();
    const liveSingles = new Set<string>();
    for (const item of items) {
      if (item.kind === 'single') {
        const line = rowLine(item.row);
        let entry = lineEntries.get(line.key);
        if (!entry) entry = makeLine(line);
        lineEntries.set(line.key, entry);
        liveSingles.add(line.key);
        paintLine(entry, line);
        nodes.push(entry.el);
      } else if (item.kind === 'pending') {
        const p = item.pending;
        if (p.kind === 'single') {
          const line: Line = { key: p.key, previewId: null, ordinal: null, input: p.inputs[0] ?? '', row: null };
          let entry = lineEntries.get(line.key);
          if (!entry) entry = makeLine(line);
          lineEntries.set(line.key, entry);
          liveSingles.add(line.key);
          paintLine(entry, line);
          nodes.push(entry.el);
        } else {
          let entry = runEntries.get(p.key);
          if (!entry) {
            entry = makePendingRun(p);
            runEntries.set(p.key, entry);
            if (openRunKey) {
              const previous = runEntries.get(openRunKey);
              if (previous) closeRun(previous);
            }
            openRunKey = p.key;
            entry.toggle.setAttribute('aria-expanded', 'true');
            entry.el.dataset.open = 'true';
            setPanel(entry.panel, true);
          }
          liveRuns.add(p.key);
          entry.title.textContent = p.label ?? '运行中';
          entry.meta.textContent = '提交中';
          paintRunCount(entry, 0, p.inputs.length, 0);
          syncLines(
            entry.rows,
            entry.lines,
            p.inputs.map((text, i) => ({
              key: `${p.key}:${i}`,
              previewId: null,
              ordinal: i + 1,
              input: text,
              row: null,
            })),
          );
          nodes.push(entry.el);
        }
      } else {
        const run = item.run;
        let entry = runEntries.get(run.runId);
        if (!entry) {
          entry = makeRun(run.runId);
          runEntries.set(run.runId, entry);
        }
        liveRuns.add(run.runId);
        const rows = loaded.get(run.runId)?.previews;
        const finished = rows ? rows.filter(isFinished).length : run.counts.succeeded + run.counts.failed;
        const failed = rows ? rows.filter((p) => p.status === 'failed').length : run.counts.failed;
        paintRunHead(entry, run, item.index, finished, run.itemCount, failed);
        if (openRunKey === run.runId && loaded.has(run.runId)) paintRunLines(entry);
        nodes.push(entry.el);
      }
    }
    for (const key of [...runEntries.keys()])
      if (!liveRuns.has(key)) {
        runEntries.delete(key);
        if (openRunKey === key) openRunKey = null;
      }
    for (const [key, entry] of [...lineEntries])
      if (liveSingles.has(key) || [...runEntries.values()].some((r) => r.rows.has(key))) continue;
      else if (!entry.el.parentElement || entry.el.parentElement === feed) lineEntries.delete(key);
    reconcile(feed, nodes);
    manage?.sync();
    empty.hidden = nodes.length > 0;
    if (wantOpen && runEntries.has(wantOpen) && !pending.length) {
      const entry = runEntries.get(wantOpen)!;
      wantOpen = null;
      if (openRunKey !== entry.key) {
        if (openRunKey) {
          const previous = runEntries.get(openRunKey);
          if (previous) closeRun(previous);
        }
        openRunKey = entry.key;
        void openRun(entry);
      }
    }
    paintCompare();
    announce();
  }
  const isActive = () =>
    pending.length > 0 ||
    singles.some((p) => !isFinished(p)) ||
    runs.some((r) => r.counts.queued + r.counts.generating > 0);

  // ---- being told: toast and the tab title ------------------------------------------------------------------------
  const name = () => detail?.draft?.profile?.presentation?.displayName || id || '';
  function announce() {
    for (const [key, item] of [...watching]) {
      if (item.kind === 'single') {
        const row = singles.find((p) => p.previewId === key);
        if (!row || !isFinished(row)) continue;
        watching.delete(key);
        host.toast(
          `${name()} 预演${row.status === 'failed' ? '失败' : '完成'}`,
          row.status === 'failed' ? 'danger' : 'ok',
          { label: '查看', run: () => reveal(key, false) },
        );
      } else {
        const run = runs.find((r) => r.runId === key);
        if (!run || run.counts.queued + run.counts.generating > 0) continue;
        watching.delete(key);
        const failed = run.counts.failed;
        host.toast(
          `${name()} 预演${failed === run.itemCount ? '失败' : '完成'} · ${run.itemCount} 条${failed ? `，${failed} 条失败` : ''}`,
          failed ? 'warn' : 'ok',
          { label: '查看', run: () => reveal(key, true) },
        );
      }
    }
    mark();
  }
  function reveal(key: string, isRun: boolean) {
    const entry = isRun ? runEntries.get(key) : lineEntries.get(key);
    if (!entry) return;
    if (isRun && openRunKey !== key) toggleRun(entry as RunEntry);
    entry.el.scrollIntoView?.({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }
  const doc = (globalThis as { document?: Document }).document;
  let phase: 'idle' | 'running' | 'done' = 'idle';
  let attended: (() => void) | null = null;
  const baseTitle = () => (doc?.title ?? '').replace(TITLE_MARK, '');
  const setTitle = (text: string) => {
    if (doc) doc.title = text ? `(${text}) ${baseTitle()}` : baseTitle();
  };
  const unattend = () => {
    if (!attended) return;
    globalThis.removeEventListener?.('focus', attended);
    doc?.removeEventListener?.('visibilitychange', attended);
    doc?.removeEventListener?.('pointerdown', attended);
    doc?.removeEventListener?.('keydown', attended);
    attended = null;
  };
  function mark() {
    if (!doc) return;
    const running = isActive();
    if (running && phase !== 'running') {
      phase = 'running';
      unattend();
      setTitle('进行中');
    } else if (!running && phase === 'running') {
      phase = 'done';
      setTitle('完成');
      // "(完成)" stays until the tab is next looked at: focused, shown again, clicked or typed in.
      attended = () => {
        if (doc.hidden) return;
        unattend();
        phase = 'idle';
        setTitle('');
      };
      globalThis.addEventListener?.('focus', attended);
      doc.addEventListener?.('visibilitychange', attended);
      doc.addEventListener?.('pointerdown', attended);
      doc.addEventListener?.('keydown', attended);
    }
  }
  const resetTitle = () => {
    unattend();
    if (phase !== 'idle') setTitle('');
    phase = 'idle';
  };

  // ---- pending (the lines on screen before the server has answered) -----------------------------------------------
  function showPending(p: Pending) {
    pending.unshift(p);
    syncFeed();
    // The new row is brought into view when it is not visible (the sticky save bar covers the bottom edge).
    const el = p.kind === 'single' ? lineEntries.get(p.key)?.el : runEntries.get(p.key)?.el;
    if (el?.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > (globalThis.innerHeight ?? 0) - 72)
        el.scrollIntoView?.({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
    }
  }
  function removePending(p: Pending) {
    const at = pending.indexOf(p);
    if (at >= 0) pending.splice(at, 1);
  }
  function dropPending(p: Pending) {
    removePending(p);
    syncFeed();
  }

  // ---- compare ----------------------------------------------------------------------------------------------------
  function paintCompare() {
    if (gone()) return;
    if (compareHost.querySelector?.('.pw-compare-result')) return;
    compareHost.replaceChildren();
    if (chosen.length !== 2) return;
    const go = h('button', { text: '对比所选 2 次', attrs: { type: 'button', 'data-compare-go': '' } });
    go.addEventListener('click', () => void showCompare());
    compareHost.append(h('div', { class: 'admin-bar' }, go));
  }
  async function showCompare() {
    const [a, b] = chosen;
    if (!a || !b) return;
    await host.run(async () => {
      const [left, right] = await Promise.all([ensureRun(a, false), ensureRun(b, false)]);
      const nameOf = (r: RunDetail) => r.run.label ?? when(r.run.createdAt);
      const sideName = (r: RunDetail) => `${nameOf(r)}${r.run.simulatedTime ? ` · ${r.run.simulatedTime.time}` : ''}`;
      const resultText = (p: PreviewRow) =>
        p.final
          ? p.final.bubbles.map((x) => x.text).join(' / ')
          : p.status === 'failed'
            ? errorText(p.errorCode)
            : STAGE_LABEL[stageOf(p)];
      const table = dataTable<ReturnType<typeof compareRuns>[number]>({
        columns: [
          { key: 'input', label: '输入', render: (r) => r.input },
          { key: 'a', label: `A：${sideName(left)}`, render: (r) => (r.a ? resultText(r.a) : '—') },
          { key: 'b', label: `B：${sideName(right)}`, render: (r) => (r.b ? resultText(r.b) : '—') },
          {
            key: 'status',
            label: '状态 A / B',
            render: (r) => `${r.a ? STAGE_LABEL[stageOf(r.a)] : '—'} / ${r.b ? STAGE_LABEL[stageOf(r.b)] : '—'}`,
          },
          {
            key: 'changed',
            label: '审核改动 A / B',
            render: (r) =>
              `${r.a?.final ? (r.a.final.reviewChanged ? '是' : '否') : '—'} / ${r.b?.final ? (r.b.final.reviewChanged ? '是' : '否') : '—'}`,
          },
          {
            key: 'coverage',
            label: '覆盖 A / B',
            render: (r) => `${r.a ? coverageText(r.a) : '—'} / ${r.b ? coverageText(r.b) : '—'}`,
          },
          {
            key: 'cost',
            label: '费用 A / B',
            align: 'end',
            render: (r) =>
              `${r.a ? micros(r.a.cost.chargedMicros) : '—'} / ${r.b ? micros(r.b.cost.chargedMicros) : '—'}`,
          },
        ],
        rowKey: (r) => `${r.a?.previewId ?? '-'}:${r.b?.previewId ?? '-'}`,
        emptyText: '两次运行都没有预演。',
      });
      table.setRows(compareRuns(left.previews, right.previews));
      const close = h('button', { class: 'admin-secondary', text: '关闭对比', attrs: { type: 'button' } });
      close.addEventListener('click', () => {
        compareHost.replaceChildren();
        paintCompare();
      });
      compareHost.replaceChildren(
        h(
          'div',
          { class: 'pw-compare-result', attrs: { 'aria-label': '运行对比' } },
          h('div', { class: 'admin-bar' }, close),
          table.root,
        ),
      );
    });
  }

  // ---- data -------------------------------------------------------------------------------------------------------
  async function ensureRun(runId: string, force: boolean) {
    const characterId = id!;
    const cached = loaded.get(runId);
    if (cached && !force) return cached;
    const full = await host.api.run(characterId, runId);
    if (!gone() && characterId === id) {
      loaded.set(runId, full);
      for (const p of full.previews) known.set(p.previewId, signature(p));
    }
    return full;
  }
  async function refresh(runIds: string[], settled?: Pending) {
    const characterId = id;
    if (!characterId) return;
    const next = await host.api.list(characterId);
    if (gone() || characterId !== id) return;
    runs = next.runs;
    singles = next.singles;
    for (const row of singles) known.set(row.previewId, signature(row));
    const wanted = new Set([
      ...runIds,
      ...(openRunKey && runs.some((r) => r.runId === openRunKey) ? [openRunKey] : []),
      // A run that is still working is read again, so its lines show 生成草稿 / 审核中 and the count moves.
      ...runs.filter((r) => r.counts.queued + r.counts.generating > 0).map((r) => r.runId),
    ]);
    for (const runId of wanted) if (runs.some((r) => r.runId === runId)) await ensureRun(runId, true);
    if (gone() || characterId !== id) return;
    if (settled) removePending(settled);
    syncFeed();
  }
  /** Rows still in the draft stage can change stage without the coarse status changing: they are read again on the poll. */
  const inDraft = () =>
    singles.some((p) => p.status === 'generating' && p.latency.draftMs === null) ||
    [...loaded.values()].some((r) => r.previews.some((p) => p.status === 'generating' && p.latency.draftMs === null));
  const stageSignature = () =>
    [...singles, ...[...loaded.values()].flatMap((r) => r.previews)]
      .map((p) => `${p.previewId}:${stageOf(p)}`)
      .join(',');

  const poller = previewPoller({
    tick: async () => {
      const characterId = id;
      if (!characterId) return { active: 0, changed: false };
      const result = await host.api.status(characterId, null);
      if (gone() || characterId !== id) return { active: 0, changed: false };
      const touched = new Set<string>();
      let changed = false;
      for (const p of result.previews) {
        if (known.get(p.previewId) !== signature(p)) {
          changed = true;
          known.set(p.previewId, signature(p));
          if (p.runId) touched.add(p.runId);
        }
      }
      if (changed) {
        await refresh([...touched]);
        host.changed?.();
      } else if (result.active > 0 && inDraft()) {
        const before = stageSignature();
        await refresh([]);
        changed = stageSignature() !== before;
      }
      return { active: result.active, changed };
    },
    hidden: host.poll?.hidden ?? defaultHidden,
    onVisible: host.poll?.onVisible ?? defaultOnVisible,
    ...(host.poll?.setTimer ? { setTimer: host.poll.setTimer } : {}),
    ...(host.poll?.clearTimer ? { clearTimer: host.poll.clearTimer } : {}),
    onGiveUp: () => host.toast('状态刷新连续失败，已暂停。点击“刷新”重试。', 'warn'),
  });

  const manage =
    manageHost && host.owner && host.confirm
      ? previewManage(manageHost, {
          api: host.owner,
          confirm: host.confirm,
          run: host.run,
          toast: host.toast,
          disposed: gone,
          isOwner: () => host.member()?.role === 'owner',
          reload: async () => {
            if (id) await openCharacter(id);
          },
          targets: () => [
            ...runs.flatMap((r) => {
              const entry = runEntries.get(r.runId);
              return entry
                ? [
                    {
                      key: r.runId,
                      el: entry.el,
                      slot: entry.el,
                      previews: r.itemCount,
                      busy: r.counts.queued + r.counts.generating > 0,
                      isRun: true,
                    },
                  ]
                : [];
            }),
            ...singles.flatMap((p) => {
              const entry = lineEntries.get(p.previewId);
              return entry
                ? [
                    {
                      key: p.previewId,
                      el: entry.el,
                      slot: entry.el,
                      previews: 1,
                      busy: p.status === 'queued' || p.status === 'generating',
                      isRun: false,
                    },
                  ]
                : [];
            }),
          ],
        })
      : null;

  // ---- lifecycle --------------------------------------------------------------------------------------------------
  const reset = () => {
    runs = [];
    singles = [];
    loaded.clear();
    pending.length = 0;
    watching.clear();
    wantOpen = null;
    openRunKey = null;
    openLineKey = null;
    chosen.length = 0;
    known.clear();
    pendingRun = null;
    pendingSingle = null;
    lineEntries.clear();
    runEntries.clear();
    seenKeys.clear();
    feed.replaceChildren();
    compareHost.replaceChildren();
    editor.close();
    resetTitle();
    poller.stop();
  };
  async function openCharacter(characterId: string) {
    const token = ++view;
    id = characterId;
    reset();
    settingsOpen = false;
    paintSettings();
    const [d, list, setList] = await Promise.all([
      host.characters.detail(characterId),
      host.api.list(characterId),
      host.api.evalSets().catch(() => [] as EvalSet[]),
    ]);
    if (gone() || token !== view) return;
    detail = d;
    runs = list.runs;
    singles = list.singles;
    sets = setList;
    for (const row of singles) known.set(row.previewId, signature(row));
    if (runs[0]) wantOpen = runs[0].runId;
    paintSetPicker();
    // The newest run opens at once; its lines come with it.
    if (runs[0]) await ensureRun(runs[0].runId, false).catch(() => undefined);
    if (gone() || token !== view) return;
    syncFeed();
    paintAll();
    if (isActive()) poller.kick();
  }
  const focusInput = () => {
    paintSettings();
    input.focus?.();
    page.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  };
  root.addEventListener('pw-focus', focusInput);
  return {
    open: openCharacter,
    update(next: boolean) {
      busy = next;
      paintAll();
    },
    /** The editor beside this panel changed (saved / unsaved): the reason line follows. */
    refresh: () => {
      paintAll();
      rehearsal?.refresh();
    },
    focusInput,
    clear() {
      view++;
      id = null;
      detail = null;
      reset();
      empty.hidden = false;
    },
    dispose() {
      disposed = true;
      resetTitle();
      poller.dispose();
      send.dispose();
      for (const bar of listeners.splice(0)) bar.dispose();
      editor.dispose();
      reviewCompare?.dispose();
      rehearsal?.dispose();
    },
    /** Test seam: the poller's state. */
    poller,
  };
}
