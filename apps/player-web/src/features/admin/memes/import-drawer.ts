import {
  MEME_IMPORT_ROWS_MAX,
  type MemeImportPreview,
  type MemeImportRow,
} from '../../../../../../packages/contracts/web-memes.ts';
import type { MemeUploadPayload } from '../../../services/cast-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { errorLine } from '../ui/error-line.ts';
import { hoverValue } from '../ui/hover-value.ts';
import {
  ROW_PROBLEM_TEXT,
  ROW_STATUS_TEXT,
  codeOf,
  count,
  fnv,
  lazyDrawer,
  requestIds,
  type MemesDeps,
} from './memes-shared.ts';

type Hooks = {
  /** The rows that passed are in the 待审 queue now: the page switches to it. */
  onQueued: (queued: number) => Promise<void> | void;
};

const ORDER: Record<MemeImportRow['status'], number> = {
  invalid: 0,
  revive: 1,
  update: 2,
  ok: 3,
  queued: 4,
  unchanged: 5,
};

/** A .xlsx is read on the server; the browser only sends its bytes (base64). */
function toBase64(bytes: ArrayBuffer) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * 上传导入: a CSV or .xlsx (columns 词 / 释义 / 分类, any other column is ignored) or pasted rows. 预览 shows EVERY row with its status or
 * its reason; 放入待审 puts the rows that passed into the 待审 queue (source 上传). Nothing goes straight into the library. A row whose
 * term exists shows the current entry and the new version side by side; a row whose term the owner deleted says 曾删除.
 */
export function importDrawer(parent: HTMLElement, deps: MemesDeps, hooks: Hooks) {
  const panel = lazyDrawer(parent, { wide: true });
  const ids = requestIds(deps.newRequestId);
  let upload: MemeUploadPayload | null = null;
  let preview: MemeImportPreview | null = null;
  let busy = false;

  const file = h('input', { attrs: { type: 'file', accept: '.csv,.xlsx,text/csv', 'aria-label': '选择文件' } });
  const paste = h('textarea', {
    attrs: { rows: '5', 'aria-label': '粘贴多行', placeholder: '词\t释义\t分类\n松弛感\t遇事不慌的状态\t心情' },
  });
  const fileName = h('span', { class: 'mm-file-name' });
  const previewButton = h('button', { class: 'admin-secondary', text: '预览', attrs: { type: 'button' } });
  const queueButton = h('button', { class: 'admin-primary', text: '放入待审', attrs: { type: 'button' } });
  const error = h('div', { class: 'mm-error', attrs: { role: 'alert' }, hidden: true });
  const summary = h('div', { class: 'mm-import-summary', hidden: true });
  const result = h('div', { class: 'mm-import-result', hidden: true });
  hoverValue(file, `CSV 或 .xlsx，第一行写明 词、释义、分类；最多 ${count(MEME_IMPORT_ROWS_MAX)} 行`);
  hoverValue(paste, '直接从表格里复制几行粘贴进来也行');
  hoverValue(queueButton, '通过的行进入待审，由你在待审里逐条确认后才会进词库');
  hoverValue(previewButton, '只检查，不保存');

  const setUpload = (next: MemeUploadPayload | null) => {
    upload = next;
    preview = null;
    ids.clear();
    summary.hidden = result.hidden = true;
    queueButton.disabled = true;
    previewButton.disabled = next === null;
  };
  const fail = (caught: unknown) => {
    if (deps.disposed()) return;
    error.replaceChildren(errorLine(codeOf(caught)));
    error.hidden = false;
  };
  file.addEventListener('change', async () => {
    error.hidden = true;
    const picked = file.files?.[0];
    if (!picked) return setUpload(null);
    paste.value = '';
    fileName.textContent = picked.name;
    try {
      setUpload(
        /\.xlsx$/iu.test(picked.name)
          ? { kind: 'xlsx', base64: toBase64(await picked.arrayBuffer()) }
          : { kind: 'text', text: await picked.text() },
      );
    } catch (caught) {
      fail(caught);
    }
  });
  paste.addEventListener('input', () => {
    error.hidden = true;
    if (paste.value.trim() !== '') {
      file.value = '';
      fileName.textContent = '';
    }
    setUpload(paste.value.trim() === '' ? null : { kind: 'text', text: paste.value });
  });

  const chip = (row: MemeImportRow) =>
    h('span', { class: `mm-chip mm-chip-${row.status}`, text: ROW_STATUS_TEXT[row.status] });
  const paintRow = (row: MemeImportRow) => {
    const detail = h('td', { class: 'mm-import-detail' });
    if (row.problem) detail.append(h('span', { class: 'mm-problem', text: ROW_PROBLEM_TEXT[row.problem] }));
    else if (row.existing && (row.status === 'update' || row.status === 'revive'))
      detail.append(
        h(
          'div',
          { class: 'mm-compare' },
          h(
            'div',
            { class: 'mm-compare-side' },
            h('b', { text: '现有' }),
            h('p', { text: row.existing.meaning }),
            h('i', { text: row.existing.category }),
          ),
          h(
            'div',
            { class: 'mm-compare-side mm-compare-new' },
            h('b', { text: '新' }),
            h('p', { text: row.meaning }),
            h('i', { text: row.category }),
          ),
        ),
      );
    else if (row.status === 'unchanged' || row.status === 'queued')
      detail.append(h('span', { class: 'mm-muted', text: row.meaning }));
    else detail.append(h('span', { text: row.meaning }), h('i', { class: 'mm-muted', text: ` · ${row.category}` }));
    return h(
      'tr',
      { class: `mm-import-row mm-import-${row.status}` },
      h('td', { text: String(row.row) }),
      h('td', { class: 'mm-term', text: row.term || '（空）' }),
      h('td', {}, chip(row)),
      detail,
    );
  };
  function paintPreview(view: MemeImportPreview) {
    const c = view.counts;
    summary.replaceChildren(
      ...[
        h('span', { text: `共 ${count(view.rows.length)} 行` }),
        h('span', { class: 'mm-ok', text: `可放入待审 ${count(c.ok + c.update + c.revive)} 行` }),
        c.invalid ? h('span', { class: 'mm-problem', text: `不能导入 ${count(c.invalid)} 行` }) : null,
        c.unchanged ? h('span', { class: 'mm-muted', text: `没有变化 ${count(c.unchanged)} 行` }) : null,
        c.queued ? h('span', { class: 'mm-muted', text: `已在待审 ${count(c.queued)} 行` }) : null,
      ].filter((node): node is HTMLSpanElement => node !== null),
    );
    summary.hidden = false;
    const rows = [...view.rows].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.row - b.row);
    result.replaceChildren(
      h(
        'table',
        { class: 'admin-table mm-import-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { text: '行' }),
            h('th', { text: '词' }),
            h('th', { text: '结果' }),
            h('th', { text: '内容 / 原因' }),
          ),
        ),
        h('tbody', {}, ...rows.map(paintRow)),
      ),
    );
    result.hidden = false;
    queueButton.disabled = !deps.canEdit() || c.ok + c.update + c.revive === 0;
    queueButton.textContent = `放入待审（${count(c.ok + c.update + c.revive)} 行）`;
  }
  previewButton.addEventListener('click', async () => {
    if (busy || !upload) return;
    busy = true;
    error.hidden = true;
    try {
      preview = await deps.api.memesImportPreview(upload);
      paintPreview(preview);
    } catch (caught) {
      preview = null;
      summary.hidden = result.hidden = true;
      queueButton.disabled = true;
      fail(caught);
    } finally {
      busy = false;
    }
  });
  queueButton.addEventListener('click', async () => {
    if (busy || !upload || !preview || !deps.canEdit()) return;
    busy = true;
    error.hidden = true;
    try {
      const signature = `import:${upload.kind}:${fnv(upload.kind === 'text' ? upload.text : upload.base64)}`;
      const done = await deps.api.memesImport(ids.of(signature), upload);
      ids.done(signature);
      panel.close();
      await hooks.onQueued(done.queued);
    } catch (caught) {
      fail(caught);
    } finally {
      busy = false;
    }
  });

  const body = h(
    'div',
    { class: 'mm-form mm-import' },
    h(
      'div',
      { class: 'mm-import-pick' },
      h('label', { class: 'mm-file' }, h('span', { class: 'mm-field-label', text: '文件' }), file, fileName),
      h('label', { class: 'mm-field' }, h('span', { class: 'mm-field-label', text: '或粘贴多行' }), paste),
    ),
    h('div', { class: 'mm-form-actions' }, previewButton, queueButton),
    error,
    summary,
    result,
  );
  setUpload(null);

  return {
    open() {
      if (!deps.canEdit()) return;
      file.value = '';
      paste.value = '';
      fileName.textContent = '';
      error.hidden = true;
      setUpload(null);
      panel.open('上传导入', body);
    },
    close: () => panel.close(),
    dispose: () => panel.dispose(),
  };
}
