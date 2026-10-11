import type { AccountAdminApi } from '../../services/account-admin-api.ts';
import type { InviteAdminPermission } from '../../../../../packages/contracts/web-admin-permissions.ts';
import { h } from '../cocreation/h.ts';
import { confirmDialog } from './ui/confirm-dialog.ts';
import { dataTable } from './ui/data-table.ts';
import { statusBadge, type BadgeTone } from './ui/status-badge.ts';
import { toolbar } from './ui/toolbar.ts';

type InviteRecord = Awaited<ReturnType<AccountAdminApi['inviteRecords']>>['records'][number];
type Grant = InviteRecord & { grantId: string };
const date = (value: number | null) =>
  value === null ? '—' : new Date(value).toLocaleString('zh-CN', { hour12: false });
export const grantState = (
  grant: Grant,
  now = Date.now(),
): { key: 'active' | 'revoked' | 'expired'; label: string; tone: BadgeTone } =>
  grant.accessRevokedAt !== null
    ? { key: 'revoked', label: '已撤销', tone: 'danger' }
    : grant.accessExpiresAt !== null && grant.accessExpiresAt <= now
      ? { key: 'expired', label: '已过期', tone: 'neutral' }
      : { key: 'active', label: '有效', tone: 'ok' };

/**
 * 玩家授权: the redeemed experience grants from the invite records, with filters, single and bulk revocation.
 * Metadata only: no player identity or chat. Revoking keeps the player's account, login and chats.
 */
export function grantsView(
  root: HTMLElement,
  deps: {
    port: Pick<AccountAdminApi, 'inviteRecords' | 'revokeInvite'>;
    can: (permission: InviteAdminPermission) => boolean;
    run: (work: () => Promise<void>) => Promise<void>;
    disposed: () => boolean;
    toast: (text: string) => void;
  },
) {
  let grants: Grant[] = [];
  let cursor: string | null = null;
  let filters = { query: '', state: 'all' };
  const revokeAll = async (rows: Grant[]) => {
    const targets = rows.filter((g) => grantState(g).key === 'active');
    if (!targets.length || !deps.can('invites.revoke-access')) return;
    const ok = await confirmDialog(root, {
      title: `撤销 ${targets.length} 项体验授权`,
      message: '对应玩家将不能继续体验；账号、当前登录和已有聊天保留。此操作不是删除玩家。',
      confirmLabel: '确认撤销',
      danger: true,
    });
    if (!ok) return;
    void deps.run(async () => {
      for (const grant of targets) await deps.port.revokeInvite('grant', grant.grantId);
      deps.toast(`已撤销 ${targets.length} 项体验授权。`);
      await load();
    });
  };
  const table = dataTable<Grant>({
    columns: [
      { key: 'batch', label: '批次', sortable: true, render: (g) => g.batch },
      { key: 'grantId', label: '授权记录', render: (g) => g.grantId },
      {
        key: 'redeemedAt',
        label: '兑换时间',
        sortable: true,
        render: (g) => date(g.redeemedAt),
        sortValue: (g) => g.redeemedAt,
      },
      {
        key: 'expires',
        label: '体验截止',
        sortable: true,
        render: (g) => (g.accessExpiresAt === null ? '不限时' : date(g.accessExpiresAt)),
        sortValue: (g) => g.accessExpiresAt,
      },
      {
        key: 'state',
        label: '状态',
        render: (g) => statusBadge(grantState(g).label, grantState(g).tone),
        sortable: true,
        sortValue: (g) => grantState(g).label,
      },
      {
        key: 'action',
        label: '操作',
        render: (g) => {
          if (grantState(g).key !== 'active' || !deps.can('invites.revoke-access')) return '';
          const button = h('button', { class: 'admin-secondary', text: '撤销', attrs: { type: 'button' } });
          button.addEventListener('click', () => void revokeAll([g]));
          return button;
        },
      },
    ],
    rowKey: (g) => g.grantId,
    emptyText: '没有符合条件的体验授权。玩家兑换邀请码后，授权会显示在这里。',
    bulkActions: deps.can('invites.revoke-access') ? [{ label: '撤销所选授权', danger: true, run: revokeAll }] : [],
  });
  const more = h('button', { class: 'admin-secondary', text: '加载更多', hidden: true, attrs: { type: 'button' } });
  const paint = () => {
    const q = filters.query.trim().toLowerCase();
    table.setRows(
      grants.filter(
        (g) =>
          (filters.state === 'all' || grantState(g).key === filters.state) &&
          (!q || g.batch.toLowerCase().includes(q) || g.grantId.toLowerCase().includes(q)),
      ),
    );
    more.hidden = !cursor;
  };
  const bar = toolbar({
    title: '玩家授权',
    filters: [
      { kind: 'search', id: 'query', label: '搜索', placeholder: '批次或授权记录' },
      {
        kind: 'select',
        id: 'state',
        label: '状态',
        options: [
          ['all', '全部'],
          ['active', '有效'],
          ['revoked', '已撤销'],
          ['expired', '已过期'],
        ],
      },
    ],
    actions: [{ label: '刷新', secondary: true, run: () => void deps.run(() => load()) }],
    onChange: (values) => {
      filters = { query: values.query ?? '', state: values.state ?? 'all' };
      paint();
    },
  });
  more.addEventListener('click', () => {
    if (cursor) void deps.run(() => load(cursor));
  });
  root.replaceChildren(bar.root, table.root, more);
  async function load(before: string | null = null) {
    if (!deps.can('invites.read')) return clear();
    const result = await deps.port.inviteRecords(before);
    if (deps.disposed() || !deps.can('invites.read')) return;
    const fresh = result.records.filter((r): r is Grant => r.grantId !== null);
    grants = before === null ? fresh : [...grants, ...fresh];
    cursor = result.next;
    paint();
  }
  function clear() {
    grants = [];
    cursor = null;
    table.setRows([]);
    more.hidden = true;
  }
  paint();
  return { load, clear };
}
