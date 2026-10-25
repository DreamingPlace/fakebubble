import type { InviteBatch, InviteBatchCode, NewInviteBatch } from '../../services/account-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { statusBadge } from './ui/status-badge.ts';

/** Limits the server enforces (BATCH_LIMITS in invites/web-invite-tiers.ts); the form only mirrors them. */
export const TIER_FORM = Object.freeze({
  maxCodes: 500,
  amountMax: 100_000,
  capMax: 10_000_000,
  durationMax: 3650,
  defaultAmount: 50,
  defaultCap: 1000,
});

const two = (n: number) => String(n).padStart(2, '0');
/** UTC calendar date, 'YYYY-MM-DD' - the same day for every administrator. */
export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
/** UTC date and time, 'YYYY-MM-DD HH:MM:SS' - the same text the exported table carries. */
export const utcDateTime = (at: number) => {
  const d = new Date(at);
  return `${utcDay(at)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
};

export const tierText = (batch: Pick<InviteBatch, 'tier' | 'dailyAmount' | 'cap'>) =>
  batch.tier === 'unlimited' ? '不限量' : `每天 +${batch.dailyAmount} 点 · 上限 ${batch.cap} 点`;

/** 状态: 未使用 / 已兑换 / 已撤销 (an ended entitlement is a revoked code; an expired one was redeemed; the date column says when). */
const STATE_LABEL: Record<InviteBatchCode['state'], string> = {
  unused: '未使用',
  redeemed: '已兑换',
  revoked: '已撤销',
  ended: '已撤销',
  expired: '已兑换',
};
export const MASKED_CODE = '********';
export const LEGACY_CODE_TEXT = '旧邀请码无法再次查看';

/** The CSV a batch's codes are downloaded as: a `code` column and nothing else (no batch name, no player, no date). */
export const codesCsv = (codes: readonly string[]) => `code\r\n${codes.join('\r\n')}\r\n`;

/** The text of the owner's confirmation: it names the change and how many players hold the batch. */
export function editConfirmation(batch: InviteBatch, dailyAmount: number, cap: number) {
  return [
    `「${batch.name}」`,
    `每天补充：+${batch.dailyAmount} 点 → +${dailyAmount} 点`,
    `总上限：${batch.cap} 点 → ${cap} 点`,
    `目前有 ${batch.holders} 位玩家持有这批邀请，从各自的下一次每日补充起生效。`,
    '调低上限不会收回玩家已有的点数，这些玩家只是在低于上限之前不再补充。',
  ].join('\n');
}

export interface InviteTiersDeps {
  port: {
    inviteBatches?: () => Promise<InviteBatch[]>;
    inviteBatchDetail?: (batchId: string) => Promise<InviteBatchCode[]>;
    /** 导出表格: the server builds the CSV (BOM included) under the same masking rule as the detail. */
    exportInviteBatch?: (batchId: string) => Promise<{ csv: string; rows: number }>;
    createInviteBatch?: (
      input: NewInviteBatch,
    ) => Promise<{ batchId: string; duplicate: boolean; codes: string[] | null }>;
    editInviteBatch?: (input: {
      requestId: string;
      batchId: string;
      dailyAmount: number;
      cap: number;
    }) => Promise<unknown>;
    revokeInviteBatch?: (batchId: string) => Promise<unknown>;
    revokeTierCode?: (id: string) => Promise<unknown>;
    revokeEntitlement?: (id: string) => Promise<unknown>;
  };
  /** Editing N and cap is the owner's alone. */
  isOwner: () => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  confirm: (options: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
  toast: (text: string) => void;
  newRequestId: () => string;
  disposed: () => boolean;
  /** Hands a file to the browser; replaced in tests. */
  download?: (filename: string, text: string) => void;
  /** Copies text to the clipboard; replaced in tests. A rejection is reported to the administrator. */
  copy?: (text: string) => Promise<void>;
}

/** The browser's own "save as": a Blob link clicked once. Nothing is uploaded and the object URL is revoked at once. */
export function browserDownload(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * 玩家 → 邀请与额度. Create a batch (name, how many codes, the tier it grants, an optional entitlement length and redeem-by
 * date); the codes are shown ONCE with a CSV download; then the list of batches with their counts. Per batch: its codes by serial
 * number (state, when, the holder's 玩家编号 - never an email or id), revoke an unused code, a whole batch, or a redeemed
 * code's entitlement; and, for the owner only, change N and the cap behind a confirmation. Counts only, no player identity.
 */
export function inviteTiersView(root: HTMLElement, deps: InviteTiersDeps) {
  const { port } = deps;
  let batches: InviteBatch[] = [];
  /** `fresh`: the batch was created a moment ago - the detail says so, and the codes returned at creation back up each 复制. */
  let open: { batch: InviteBatch; codes: InviteBatchCode[]; fresh: string[] | null } | null = null;
  const copied = new Set<string>();
  let editing: string | null = null;
  // A creation or an edit whose outcome was never seen is retried under the same request id, so it never applies twice.
  let createPending: { id: string; signature: string } | null = null;
  let editPending: { id: string; signature: string } | null = null;
  const download = deps.download ?? browserDownload;
  const copy = deps.copy ?? ((text: string) => navigator.clipboard.writeText(text));

  // ---- the form ---------------------------------------------------------------------------------------------------------
  const field = (id: string, label: string, input: HTMLElement) =>
    h('div', { class: 'tiers-field' }, h('label', { text: label, attrs: { for: id } }), input);
  const num = (id: string, min: number, max: number, value = '') => {
    const input = h('input', {
      attrs: { id, type: 'number', inputmode: 'numeric', min: String(min), max: String(max), step: '1' },
    });
    input.value = value;
    return input;
  };
  const name = h('input', { attrs: { id: 'tiers-name', maxlength: '128', autocomplete: 'off' } });
  const count = num('tiers-count', 1, TIER_FORM.maxCodes, '10');
  const kindUnlimited = h('input', {
    attrs: { type: 'radio', name: 'tiers-kind', id: 'tiers-kind-unlimited', value: 'unlimited' },
  });
  const kindRefill = h('input', {
    attrs: { type: 'radio', name: 'tiers-kind', id: 'tiers-kind-refill', value: 'daily_refill' },
  });
  kindRefill.checked = true;
  const amount = num('tiers-amount', 1, TIER_FORM.amountMax, String(TIER_FORM.defaultAmount));
  const cap = num('tiers-cap', 1, TIER_FORM.capMax, String(TIER_FORM.defaultCap));
  const duration = num('tiers-duration', 1, TIER_FORM.durationMax);
  const redeemBy = h('input', { attrs: { id: 'tiers-redeem-by', type: 'date' } });
  // Part 22d: a test batch (测试组) is marked here, at creation, and never changed afterwards.
  const testBox = h('input', { attrs: { type: 'checkbox', id: 'tiers-test' } });
  const testField = h(
    'div',
    { class: 'tiers-field tiers-test' },
    h('label', { attrs: { for: 'tiers-test', title: '兑换这批码的玩家算测试组；创建后不能再改' } }, testBox, ' 测试'),
  );
  const problem = h('p', { class: 'admin-hint tiers-problem', attrs: { role: 'alert' }, hidden: true });
  const create = h('button', { text: '生成邀请码', attrs: { type: 'submit', id: 'tiers-create' } });
  const cancel = h('button', { class: 'admin-secondary', text: '取消', attrs: { type: 'button', id: 'tiers-cancel' } });
  const refillFields = h(
    'div',
    { class: 'tiers-refill' },
    field('tiers-amount', '每天补充（点）', amount),
    field('tiers-cap', '总上限（点）', cap),
  );
  const form = h(
    'form',
    { class: 'tiers-form', attrs: { id: 'admin-tiers-create', novalidate: 'novalidate' } },
    field('tiers-name', '批次名称', name),
    field('tiers-count', '邀请码数量（1–500）', count),
    h(
      'div',
      { class: 'tiers-field tiers-kind-field' },
      h('span', { class: 'tiers-label', text: '额度类型', attrs: { id: 'tiers-kind-label' } }),
      h(
        'div',
        { class: 'tiers-kind', attrs: { role: 'radiogroup', 'aria-labelledby': 'tiers-kind-label' } },
        h('label', {}, kindUnlimited, h('span', { text: '不限量' })),
        h('label', {}, kindRefill, h('span', { text: '每天补充' })),
      ),
    ),
    refillFields,
    field('tiers-duration', '额度有效天数（可选，不填为长期）', duration),
    field('tiers-redeem-by', '兑换截止日期（UTC，可选）', redeemBy),
    testField,
    problem,
    h('div', { class: 'tiers-form-actions' }, cancel, create),
  );

  const shownTitle = h('strong', { text: '邀请码（现在显示；之后可在批次的“查看”里再次查看）' });
  const shownList = h('textarea', {
    class: 'tiers-codes',
    attrs: { readonly: 'readonly', rows: '3', 'aria-label': '邀请码' },
  });
  const shownCopy = h('button', { text: '复制', attrs: { type: 'button', id: 'tiers-copy' } });
  const shownDownload = h('button', { text: '下载 CSV', attrs: { type: 'button', id: 'tiers-download' } });
  const shownClose = h('button', {
    class: 'admin-secondary',
    text: '已保存，清除显示',
    attrs: { type: 'button', id: 'tiers-shown-close' },
  });
  const shown = h(
    'section',
    { class: 'tiers-shown invite-admin-result', attrs: { id: 'tiers-shown' }, hidden: true },
    shownTitle,
    shownList,
    h('div', { class: 'tiers-shown-actions' }, shownCopy, shownDownload, shownClose),
  );
  let shownCodes: string[] = [];
  let shownName = '';
  const clearShown = () => {
    shownCodes = [];
    shownList.value = '';
    shown.hidden = true;
  };
  shownClose.addEventListener('click', clearShown);
  shownCopy.addEventListener('click', () => {
    if (shownCodes.length) void copyText(shownCodes.join('\n'));
  });
  shownDownload.addEventListener('click', () => {
    if (shownCodes.length) download(`${shownName || 'invites'}.csv`, codesCsv(shownCodes));
  });

  // ---- the list ---------------------------------------------------------------------------------------------------------
  const body = h('tbody');
  const table = h(
    'table',
    { class: 'admin-table tiers-table', attrs: { 'aria-label': '邀请批次' } },
    h('caption', { text: '邀请批次' }),
    h(
      'colgroup',
      {},
      ...['name', 'tier', 'created', 'num', 'num', 'num', 'num', 'actions'].map((c) =>
        h('col', { class: `tiers-col-${c}` }),
      ),
    ),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...['批次', '类型', '创建', '邀请码', '已兑换', '已撤销', '持有中', '操作'].map((label) =>
          h('th', { text: label, attrs: { scope: 'col' } }),
        ),
      ),
    ),
    body,
  );
  const empty = h('p', { class: 'admin-hint', text: '还没有邀请批次。', hidden: true });
  const detail = h('section', { class: 'tiers-detail', hidden: true });
  const reload = h('button', { class: 'admin-secondary', text: '刷新', attrs: { type: 'button' } });

  // 新建批次 opens the form with a slide; closed, it is inert (not focusable) as well as hidden.
  const newBatch = h('button', {
    class: 'tiers-new',
    text: '新建批次',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'admin-tiers-create' },
  });
  const createWrap = h(
    'div',
    { class: 'tiers-create-wrap', attrs: { 'data-open': 'false', inert: '' } },
    h('div', { class: 'tiers-create-inner' }, form),
  );
  let createOpen = false;
  function setCreateOpen(on: boolean) {
    createOpen = on;
    createWrap.setAttribute('data-open', String(on));
    newBatch.setAttribute('aria-expanded', String(on));
    if (on) createWrap.removeAttribute('inert');
    else createWrap.setAttribute('inert', '');
  }
  newBatch.addEventListener('click', () => setCreateOpen(!createOpen));
  cancel.addEventListener('click', () => setCreateOpen(false));
  const summary = h('span', { class: 'tiers-summary' });
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h2', { text: '邀请与额度' }), newBatch),
    createWrap,
    shown,
    h('div', { class: 'tiers-list-head' }, h('h3', { text: '批次' }), summary, reload),
    empty,
    h('div', { class: 'admin-table-region' }, h('div', { class: 'admin-table-wrap' }, table)),
    detail,
  );

  /** Copy to the clipboard and say so; a refusal (no permission, no secure context) is told, never silent. */
  async function copyText(text: string): Promise<boolean> {
    try {
      await copy(text);
      deps.toast('已复制');
      return true;
    } catch {
      deps.toast('复制没有成功，请手动选取文字');
      return false;
    }
  }
  const cell = (label: string, ...children: (Node | string)[]) =>
    h('td', { attrs: { 'data-label': label } }, ...children);
  const button = (text: string, onClick: () => void, className = 'admin-secondary') => {
    const node = h('button', { class: className, text, attrs: { type: 'button' } });
    node.addEventListener('click', onClick);
    return node;
  };

  function paintList() {
    body.replaceChildren(
      ...batches
        .map((batch) => {
          const actions = h(
            'div',
            { class: 'tiers-actions' },
            button('查看', () => void deps.run(() => show(batch))),
            batch.tier === 'daily_refill' && deps.isOwner()
              ? button('修改额度', () => {
                  editing = batch.id;
                  paintList();
                })
              : null,
            button('撤销整批', () => void deps.run(() => revokeBatch(batch)), 'admin-secondary tiers-danger'),
          );
          const rows: HTMLElement[] = [
            h(
              'tr',
              { attrs: { 'data-batch': batch.id } },
              h(
                'th',
                { attrs: { scope: 'row' } },
                h('span', { class: 'tiers-name', text: batch.name }),
                batch.test ? h('span', { class: 'tiers-test-badge', text: '测试' }) : null,
              ),
              cell('类型', tierText(batch), batch.durationDays ? ` · ${batch.durationDays} 天` : ''),
              cell('创建', utcDay(batch.createdAt)),
              cell('邀请码', String(batch.codes)),
              cell('已兑换', String(batch.redeemed)),
              cell('已撤销', String(batch.revoked)),
              cell('持有中', String(batch.holders)),
              cell('操作', actions),
            ),
          ];
          if (editing === batch.id) rows.push(editorRow(batch));
          return rows;
        })
        .flat(),
    );
    empty.hidden = batches.length > 0;
    table.hidden = batches.length === 0;
    const held = (tier: InviteBatch['tier']) =>
      batches.filter((b) => b.tier === tier).reduce((n, b) => n + b.holders, 0);
    summary.textContent = batches.length
      ? `持有中 ${held('unlimited') + held('daily_refill')} 人 · 不限量 ${held('unlimited')} · 每天补充 ${held('daily_refill')}`
      : '';
  }

  function editorRow(batch: InviteBatch) {
    const n = num('tiers-edit-amount', 1, TIER_FORM.amountMax, String(batch.dailyAmount ?? ''));
    const c = num('tiers-edit-cap', 1, TIER_FORM.capMax, String(batch.cap ?? ''));
    const message = h('span', { class: 'admin-hint', attrs: { role: 'alert' } });
    const save = button(
      '保存',
      () => {
        const nextN = Number(n.value),
          nextCap = Number(c.value);
        if (
          !Number.isSafeInteger(nextN) ||
          !Number.isSafeInteger(nextCap) ||
          nextN < 1 ||
          nextN > TIER_FORM.amountMax ||
          nextCap < nextN ||
          nextCap > TIER_FORM.capMax
        ) {
          message.textContent = '每天补充需要是正整数，总上限不能低于每天补充。';
          return;
        }
        if (nextN === batch.dailyAmount && nextCap === batch.cap) {
          message.textContent = '没有改动。';
          return;
        }
        void deps.run(async () => {
          const ok = await deps.confirm({
            title: '确认修改额度',
            message: editConfirmation(batch, nextN, nextCap),
            confirmLabel: '确认修改',
          });
          if (!ok || deps.disposed()) return;
          const signature = `${batch.id}:${nextN}:${nextCap}`;
          if (!editPending || editPending.signature !== signature) editPending = { id: deps.newRequestId(), signature };
          await port.editInviteBatch!({
            requestId: editPending.id,
            batchId: batch.id,
            dailyAmount: nextN,
            cap: nextCap,
          });
          editPending = null;
          editing = null;
          deps.toast('额度已修改');
          await load();
        });
      },
      'tiers-save',
    );
    const cancel = button('取消', () => {
      editing = null;
      paintList();
    });
    return h(
      'tr',
      { class: 'tiers-edit-row', attrs: { 'data-edit': batch.id } },
      h(
        'td',
        { attrs: { colspan: '8' } },
        h(
          'div',
          { class: 'tiers-edit' },
          field('tiers-edit-amount', '每天补充（点）', n),
          field('tiers-edit-cap', '总上限（点）', c),
          save,
          cancel,
          message,
        ),
      ),
    );
  }

  async function show(batch: InviteBatch, fresh: string[] | null = null) {
    const codes = await port.inviteBatchDetail!(batch.id);
    if (deps.disposed()) return;
    if (open?.batch.id !== batch.id) copied.clear();
    open = { batch, codes, fresh: fresh ?? (open?.batch.id === batch.id ? open.fresh : null) };
    paintDetail();
  }
  /** The code to copy for this row: what the server sent in the clear, else - for a batch made a moment ago - what creation returned. */
  const plainOf = (code: InviteBatchCode): string | null => {
    if (code.codeView === 'plain' && typeof code.code === 'string') return code.code;
    if (code.codeView === undefined && open?.fresh) return open.fresh[code.serial - 1] ?? null;
    return null;
  };
  /** The 邀请码 cell: the code with its own 复制 (plain), the mask, or the notice for a code that was never kept. */
  function codeCell(code: InviteBatchCode) {
    const plain = plainOf(code);
    if (plain !== null) {
      const done = copied.has(code.id);
      const copyButton = button(done ? '已复制' : '复制', () => {}, 'admin-secondary tiers-copy');
      copyButton.setAttribute('aria-label', `复制邀请码 #${code.serial}`);
      copyButton.setAttribute('aria-pressed', String(done));
      copyButton.addEventListener('click', () => {
        void copyText(plain).then((ok) => {
          if (!ok) return;
          copied.add(code.id);
          copyButton.textContent = '已复制';
          copyButton.setAttribute('aria-pressed', 'true');
        });
      });
      return cell(
        '邀请码',
        h('div', { class: 'tiers-code-cell' }, h('code', { class: 'tiers-code-text', text: plain }), copyButton),
      );
    }
    return cell(
      '邀请码',
      h('span', {
        class: 'tiers-code-hidden',
        text: code.codeView === 'masked' ? MASKED_CODE : LEGACY_CODE_TEXT,
      }),
    );
  }
  async function exportTable(batch: InviteBatch) {
    if (!port.exportInviteBatch) throw new Error('ADMIN_INVITES_UNAVAILABLE');
    const { csv } = await port.exportInviteBatch(batch.id);
    if (deps.disposed()) return;
    download(`${batch.name}-邀请码.csv`, csv);
    deps.toast('已导出');
  }
  function paintDetail() {
    if (!open) {
      detail.hidden = true;
      return;
    }
    const { batch, codes, fresh } = open;
    detail.hidden = false;
    const masked = codes.some((code) => code.codeView === 'masked');
    const unusedPlain = codes
      .filter((code) => code.state === 'unused')
      .map(plainOf)
      .filter((c): c is string => c !== null);
    const copyAll = button(
      '复制全部未使用',
      () => void copyText(unusedPlain.join('\n')).then((ok) => ok && (copyAll.textContent = '已复制全部未使用')),
      'admin-secondary tiers-copy-all',
    );
    detail.replaceChildren(
      ...(fresh
        ? [
            h(
              'p',
              { class: 'tiers-fresh', attrs: { role: 'status' } },
              `已生成 ${batch.codes} 个邀请码。每个都能单独复制，以后也能回到这里再看。`,
            ),
          ]
        : []),
      h(
        'div',
        { class: 'tiers-detail-head' },
        h('h3', { text: `${batch.name} · ${tierText(batch)}` }),
        h(
          'span',
          { class: 'tiers-chips' },
          batch.durationDays ? h('span', { text: `${batch.durationDays} 天` }) : h('span', { text: '长期' }),
          h('span', { class: 'tiers-chip-date', text: utcDay(batch.createdAt) }),
          batch.test ? h('span', { class: 'tiers-test-badge', text: '测试' }) : null,
        ),
      ),
      ...(masked
        ? [
            h('p', {
              class: 'admin-hint tiers-masked-note',
              text: '这批邀请码由其他管理员创建，邀请码已隐藏；批次信息和兑换情况仍然可见。',
            }),
          ]
        : []),
      h(
        'div',
        { class: 'admin-table-region' },
        h(
          'div',
          { class: 'admin-table-wrap' },
          h(
            'table',
            { class: 'admin-table tiers-codes-table', attrs: { 'aria-label': '邀请码' } },
            h(
              'colgroup',
              {},
              ...['serial', 'code', 'state', 'at', 'player', 'until', 'action'].map((c) =>
                h('col', { class: `tiers-dcol-${c}` }),
              ),
            ),
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ...['序号', '邀请码', '状态', '兑换时间 (UTC)', '玩家编号', '额度到期', '操作'].map((label) =>
                  h('th', { text: label, attrs: { scope: 'col' } }),
                ),
              ),
            ),
            h(
              'tbody',
              {},
              ...codes.map((code) =>
                h(
                  'tr',
                  { attrs: { 'data-code': code.id, 'data-state': code.state } },
                  h('th', { text: `#${code.serial}`, attrs: { scope: 'row' } }),
                  codeCell(code),
                  cell(
                    '状态',
                    statusBadge(
                      STATE_LABEL[code.state],
                      code.state === 'redeemed' || code.state === 'expired'
                        ? 'ok'
                        : code.state === 'unused'
                          ? 'neutral'
                          : 'warn',
                    ),
                  ),
                  cell('兑换时间 (UTC)', code.redeemedAt === null ? '' : utcDateTime(code.redeemedAt)),
                  cell('玩家编号', code.playerNumber ?? (code.redeemedAt === null ? '' : '旧邀请')),
                  cell('额度到期', code.expiresAt === null ? '' : utcDateTime(code.expiresAt)),
                  cell(
                    '操作',
                    code.state === 'unused'
                      ? button('撤销该码', () => void deps.run(() => revokeCode(code)))
                      : code.state === 'redeemed'
                        ? button('结束额度', () => void deps.run(() => revokeEntitlement(code)))
                        : '',
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'tiers-detail-actions' },
        unusedPlain.length ? copyAll : null,
        button('导出表格', () => void deps.run(() => exportTable(batch)), 'admin-secondary tiers-export'),
        button('收起', () => {
          open = null;
          paintDetail();
        }),
      ),
    );
  }

  async function refreshOpen() {
    if (!open) return;
    const batch = batches.find((entry) => entry.id === open!.batch.id);
    if (!batch) {
      open = null;
      paintDetail();
      return;
    }
    await show(batch);
  }
  async function revokeCode(code: InviteBatchCode) {
    const ok = await deps.confirm({
      title: '撤销邀请码',
      message: `撤销 #${code.serial}：这个邀请码不能再被兑换。`,
      confirmLabel: '确认撤销',
    });
    if (!ok || deps.disposed()) return;
    await port.revokeTierCode!(code.id);
    deps.toast('已撤销');
    await load();
  }
  async function revokeEntitlement(code: InviteBatchCode) {
    const ok = await deps.confirm({
      title: '结束额度',
      message: `结束 #${code.serial} 的额度：持有它的玩家（玩家编号 ${code.playerNumber ?? '—'}）立即变回普通注册玩家，保留现有点数。`,
      confirmLabel: '确认结束',
    });
    if (!ok || deps.disposed()) return;
    await port.revokeEntitlement!(code.id);
    deps.toast('额度已结束');
    await load();
  }
  async function revokeBatch(batch: InviteBatch) {
    const ok = await deps.confirm({
      title: '撤销整批',
      message: `撤销「${batch.name}」：这一批所有还没兑换的邀请码都不能再用。已经兑换的玩家不受影响。`,
      confirmLabel: '确认撤销整批',
    });
    if (!ok || deps.disposed()) return;
    await port.revokeInviteBatch!(batch.id);
    deps.toast('已撤销整批');
    await load();
  }

  async function load() {
    if (!port.inviteBatches) throw new Error('ADMIN_INVITES_UNAVAILABLE');
    const next = await port.inviteBatches();
    if (deps.disposed()) return;
    batches = next;
    paintList();
    await refreshOpen();
  }

  // ---- creating ---------------------------------------------------------------------------------------------------------
  const refill = () => kindRefill.checked;
  const syncKind = () => {
    refillFields.hidden = !refill();
  };
  kindUnlimited.addEventListener('change', syncKind);
  kindRefill.addEventListener('change', syncKind);
  syncKind();

  function read(): NewInviteBatch | string {
    const label = name.value.trim();
    if (!label) return '请填写批次名称。';
    const n = Number(count.value);
    if (!Number.isSafeInteger(n) || n < 1 || n > TIER_FORM.maxCodes)
      return `邀请码数量需要是 1–${TIER_FORM.maxCodes}。`;
    let tier: NewInviteBatch['tier'] = { kind: 'unlimited' };
    if (refill()) {
      const a = Number(amount.value),
        k = Number(cap.value);
      if (!Number.isSafeInteger(a) || a < 1 || a > TIER_FORM.amountMax) return '每天补充需要是正整数。';
      if (!Number.isSafeInteger(k) || k < a || k > TIER_FORM.capMax) return '总上限不能低于每天补充。';
      tier = { kind: 'daily_refill', dailyAmount: a, cap: k };
    }
    let days: number | null = null;
    if (duration.value.trim() !== '') {
      days = Number(duration.value);
      if (!Number.isSafeInteger(days) || days < 1 || days > TIER_FORM.durationMax)
        return `有效天数需要是 1–${TIER_FORM.durationMax}。`;
    }
    let by: number | null = null;
    if (redeemBy.value) {
      by = Date.parse(`${redeemBy.value}T23:59:59.999Z`);
      if (!Number.isSafeInteger(by) || by <= Date.now()) return '兑换截止日期需要是今天之后。';
    }
    return {
      requestId: '',
      name: label,
      count: n,
      tier,
      durationDays: days,
      redeemBy: by,
      ...(testBox.checked ? { test: true } : {}),
    };
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = read();
    problem.hidden = typeof input !== 'string';
    problem.textContent = typeof input === 'string' ? input : '';
    if (typeof input === 'string') return;
    void deps.run(async () => {
      const signature = JSON.stringify({ ...input, requestId: '' });
      if (!createPending || createPending.signature !== signature)
        createPending = { id: deps.newRequestId(), signature };
      const result = await port.createInviteBatch!({ ...input, requestId: createPending.id });
      createPending = null;
      if (deps.disposed()) return;
      if (result.codes) {
        shownCodes = result.codes;
        shownName = input.name;
        shownList.value = result.codes.join('\n');
        shown.hidden = false;
      }
      name.value = '';
      duration.value = '';
      redeemBy.value = '';
      amount.value = String(TIER_FORM.defaultAmount);
      cap.value = String(TIER_FORM.defaultCap);
      count.value = '10';
      kindRefill.checked = true;
      testBox.checked = false;
      syncKind();
      setCreateOpen(false);
      deps.toast(result.codes ? '已生成' : '这个批次已经生成过了');
      await load();
      // Right away: the new batch's codes, each with its own 复制.
      const made = batches.find((entry) => entry.id === result.batchId);
      if (made && port.inviteBatchDetail) await show(made, result.codes);
    });
  });
  reload.addEventListener('click', () => void deps.run(load));

  return {
    load,
    /** The codes shown once are wiped (logout, a new session, leaving the page). */
    clearSecrets: clearShown,
    clear() {
      batches = [];
      open = null;
      editing = null;
      createPending = null;
      editPending = null;
      clearShown();
      body.replaceChildren();
      detail.replaceChildren();
      detail.hidden = true;
    },
  };
}
