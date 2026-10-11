import { h } from '../../cocreation/h.ts';
import type { EvalItem, EvalSet, PreviewAdminClient } from '../../../services/preview-admin-api.ts';
import { confirmDialog } from '../ui/confirm-dialog.ts';
import { drawer } from '../ui/drawer.ts';

export const EVAL_LINE_MAX = 50;
export const EVAL_TEXT_MAX = 4000;
export const EVAL_NOTE_MAX = 300;
/** One input per line. An optional note/expectation follows a tab (pasted from a sheet) or “ || ”. */
export function parseEvalLines(text: string): EvalItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.search(/\t| \|\| /);
      if (at < 0) return { text: line, note: null };
      const note = line
        .slice(at)
        .replace(/^\t| \|\| /, '')
        .trim();
      return { text: line.slice(0, at).trim(), note: note || null };
    });
}
export const formatEvalLines = (items: readonly EvalItem[]) =>
  items.map((item) => (item.note ? `${item.text} || ${item.note}` : item.text)).join('\n');
export function evalLineProblem(items: readonly EvalItem[]): string {
  if (!items.length) return '至少需要一行输入。';
  if (items.length > EVAL_LINE_MAX) return `最多 ${EVAL_LINE_MAX} 行，当前 ${items.length} 行。`;
  const long = items.findIndex((i) => [...i.text].length > EVAL_TEXT_MAX);
  if (long >= 0) return `第 ${long + 1} 行超过 ${EVAL_TEXT_MAX} 字。`;
  const note = items.findIndex((i) => i.note !== null && [...i.note].length > EVAL_NOTE_MAX);
  if (note >= 0) return `第 ${note + 1} 行的备注超过 ${EVAL_NOTE_MAX} 字。`;
  if (items.some((i) => !i.text)) return '有一行只有备注，没有输入。';
  return '';
}

type Host = {
  api: Pick<PreviewAdminClient, 'evalSets' | 'saveEvalSet' | 'deleteEvalSet'>;
  canWrite: () => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
  /** Called after any change so the picker in the toolbar can refresh. */
  changed: (sets: EvalSet[]) => void;
  confirmParent: () => HTMLElement;
};
/** The 评测集 editor: a drawer with the saved sets on the left and a one-line-per-input editor on the right. */
export function evalSetEditor(parent: HTMLElement, host: Host) {
  const panel = drawer(parent, { title: '评测集' });
  let sets: EvalSet[] = [];
  let current: EvalSet | null = null;
  const list = h('div', { class: 'pw-eval-list' });
  const name = h('input', {
    attrs: { type: 'text', maxlength: '60', placeholder: '评测集名称（≤60 字）', 'aria-label': '评测集名称' },
  });
  const lines = h('textarea', {
    attrs: {
      rows: '14',
      'aria-label': '评测输入，每行一条',
      placeholder: '每行一条输入。可在输入后用 Tab 或 “ || ” 追加期望/备注（≤300 字）。',
    },
  });
  const note = h('p', { class: 'admin-hint' });
  const save = h('button', { text: '保存（生成新版本）', attrs: { type: 'button' } });
  const remove = h('button', { class: 'admin-danger', text: '删除', attrs: { type: 'button' } });
  const fresh = h('button', { class: 'admin-secondary', text: '新建评测集', attrs: { type: 'button' } });
  const form = h(
    'div',
    { class: 'pw-eval-form' },
    h('label', {}, h('span', { text: '名称' }), name),
    h('label', {}, h('span', { text: '输入（每行一条，最多 50 行）' }), lines),
    note,
    h('div', { class: 'admin-dialog-actions' }, remove, save),
  );
  panel.body.append(h('div', { class: 'pw-eval' }, h('div', {}, fresh, list), form));

  const problem = () => evalLineProblem(parseEvalLines(lines.value)) || (name.value.trim() ? '' : '请填写名称。');
  const paintNote = () => {
    const items = parseEvalLines(lines.value);
    const bad = problem();
    note.textContent = `${items.length} 行${current ? ` · 当前版本 v${current.version}` : ' · 新评测集'}${bad ? ` · ${bad}` : ''}`;
    save.disabled = !host.canWrite() || !!bad;
    remove.disabled = !host.canWrite() || !current;
    remove.hidden = !current;
  };
  const load = (set: EvalSet | null) => {
    current = set;
    name.value = set?.name ?? '';
    lines.value = set ? formatEvalLines(set.items) : '';
    paintNote();
    paintList();
  };
  function paintList() {
    list.replaceChildren(
      ...sets.map((set) => {
        const button = h('button', {
          class: 'admin-pick',
          text: `${set.name} · v${set.version} · ${set.items.length} 行`,
          attrs: {
            type: 'button',
            'data-eval-set': set.id,
            ...(set.id === current?.id ? { 'aria-current': 'true' } : {}),
          },
        });
        button.addEventListener('click', () => load(set));
        return button;
      }),
    );
    if (!sets.length) list.append(h('p', { class: 'admin-empty', text: '还没有评测集。' }));
  }
  const reload = (next: EvalSet[]) => {
    sets = next;
    host.changed(next);
    paintList();
  };
  name.addEventListener('input', paintNote);
  lines.addEventListener('input', paintNote);
  fresh.addEventListener('click', () => load(null));
  save.addEventListener('click', () => {
    if (save.disabled) return;
    void host.run(async () => {
      const saved = await host.api.saveEvalSet({
        id: current?.id ?? null,
        expectedVersion: current?.version ?? null,
        name: name.value.trim(),
        items: parseEvalLines(lines.value),
      });
      reload(await host.api.evalSets());
      load(sets.find((s) => s.id === saved.id) ?? saved);
      host.toast(`已保存：${saved.name} v${saved.version}`, 'ok');
    });
  });
  remove.addEventListener('click', () => {
    const target = current;
    if (!target || remove.disabled) return;
    void host.run(async () => {
      const yes = await confirmDialog(host.confirmParent(), {
        title: '删除评测集',
        message: `删除“${target.name}”及其全部版本？已运行的结果不受影响。`,
        confirmLabel: '删除',
        danger: true,
      });
      if (!yes) return;
      await host.api.deleteEvalSet(target.id, target.version);
      reload(await host.api.evalSets());
      load(null);
      host.toast('评测集已删除。', 'ok');
    });
  });
  return {
    open(next: EvalSet[]) {
      reload(next);
      load(current ? (next.find((s) => s.id === current!.id) ?? null) : null);
      panel.open();
    },
    setSets: reload,
    dispose: () => panel.dispose(),
    panel,
  };
}
