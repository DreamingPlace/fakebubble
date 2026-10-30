import {
  ADMIN_PERMISSION_PRESETS,
  itemPermission,
  type AdminPermission,
} from '../../../../../packages/contracts/web-admin-permissions.ts';
import type { AccountAdminApi } from '../../services/account-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { dateTimeText } from './system-format.ts';
import { dangerZone } from './ui/danger-zone.ts';
import { openTable } from './ui/open-table.ts';
import { fillStatus } from './ui/page-head.ts';
import { unsavedText } from './ui/unsaved.ts';

type MembersResult = Awaited<ReturnType<AccountAdminApi['members']>>;
type Member = MembersResult['members'][number];

/** Part 24b-6 (Members3): one fixed mark colour per administrator, by member order, from this palette. (A colour picker is a later Part.) */
export const MARK_COLOURS = [
  '#5B4FC4',
  '#0E7490',
  '#B45309',
  '#9D174D',
  '#4D7C0F',
  '#1D4ED8',
  '#C2410C',
  '#6D28D9',
] as const;
export const markColour = (index: number) => MARK_COLOURS[index % MARK_COLOURS.length]!;

export type MembersViewOptions = {
  /** The title row host (the page keeps its own heading element, the view fills the right side). */
  head: HTMLElement;
  /** The add bar's preset buttons, and the table / detail hosts of the page. */
  presetHost: HTMLElement;
  table: HTMLElement;
  list: HTMLElement;
  /** Items the preset buttons may grant on this page (the same filter as the grid). */
  shown: (item: string) => boolean;
  permissionControls: (
    host: HTMLElement,
    initial: readonly AdminPermission[],
    onChange: (dirty: number) => void,
  ) => { value(): AdminPermission[]; setDisabled(disabled: boolean): void; dirty(): number };
  run: (work: () => Promise<void>) => Promise<void> | void;
  busy: () => boolean;
  api: Pick<AccountAdminApi, 'members' | 'issueMember' | 'setPermissions' | 'revokeCredential'>;
  showSecret: (label: string, token: string | null) => void;
  status: (text: string) => void;
  disposed: () => boolean;
  permissionLimit: number;
  totalPermissions: number;
};

/**
 * 管理员与权限 (Members3). An add bar on top; the people table below, a row opens the permission grid BELOW it (seven groups in one
 * row); each administrator carries a fixed mark colour (the square). Save, reissue and revoke use the same server calls as before.
 */
export function membersView(options: MembersViewOptions) {
  let result: MembersResult | null = null;
  let chosen: string | null = null;
  let unknownIssue = false;
  const reissueUnknown = new Set<string>();
  let preset = ADMIN_PERMISSION_PRESETS[0]!.id;
  let dirty = 0;
  const headStatus = h('span', { class: 'head-status' });
  options.head.replaceChildren(headStatus);

  // ---- add bar ----
  const presetButtons = new Map<string, HTMLButtonElement>();
  const paintPresets = () => {
    for (const [id, button] of presetButtons) button.setAttribute('aria-pressed', String(id === preset));
  };
  for (const item of ADMIN_PERMISSION_PRESETS) {
    const button = h('button', {
      class: 'mb-preset',
      text: item.label,
      attrs: { type: 'button', 'aria-pressed': 'false' },
    });
    button.addEventListener('click', () => {
      preset = item.id;
      paintPresets();
    });
    presetButtons.set(item.id, button);
    options.presetHost.append(button);
  }
  paintPresets();
  const presetPermissions = (): AdminPermission[] => {
    const chosenPreset = ADMIN_PERMISSION_PRESETS.find((p) => p.id === preset) ?? ADMIN_PERMISSION_PRESETS[0]!;
    return chosenPreset.items
      .filter((item) => options.shown(item))
      .map(itemPermission)
      .sort();
  };
  const issuePermissions = () => presetPermissions();

  const paintHead = () => {
    if (!result) return;
    fillStatus(
      headStatus,
      `${result.members.length} 位管理员`,
      dirty > 0 ? h('span', { class: 'is-warn', text: unsavedText(dirty) }) : null,
    );
  };

  // ---- table ----
  const table = openTable<Member>({
    label: '管理员',
    rowKey: (member) => member.id,
    emptyText: '还没有管理员。',
    columns: [
      {
        key: 'mark',
        label: '色',
        width: '32px',
        headTip: '改动标记的颜色',
        cell: (member) => {
          const index = result?.members.findIndex((m) => m.id === member.id) ?? 0;
          const mark = h('b', { class: 'mb-mark', text: [...member.label][0] ?? '·' });
          mark.style?.setProperty('--mark', markColour(index));
          return mark;
        },
      },
      {
        key: 'name',
        label: '名称',
        width: 'minmax(0, 1.2fr)',
        cell: (member) => {
          const cell = h('span', { class: 'mb-name' }, h('span', { text: member.label }));
          if (member.email) cell.append(h('span', { class: 'members-mail', text: member.email }));
          return cell;
        },
      },
      { key: 'role', label: '角色', cell: (member) => (member.role === 'owner' ? '主管理员' : '管理员') },
      {
        key: 'perm',
        label: '权限',
        mono: true,
        cell: (member) => (member.role === 'owner' ? '全部' : String(member.permissions.length)),
        tip: (member) =>
          member.role === 'owner'
            ? `主管理员总是全部 ${options.totalPermissions} 项`
            : `${member.permissions.length} / ${options.totalPermissions} 项`,
      },
      {
        key: 'last',
        label: '最近登录 UTC',
        mono: true,
        width: 'minmax(0, 1.2fr)',
        cell: (member) => (member.lastSignInAt ? dateTimeText(member.lastSignInAt).replace(' UTC', '') : '—'),
        tip: (member) => (member.lastSignInAt ? dateTimeText(member.lastSignInAt) : null),
      },
    ],
    detail: (member) => {
      chosen = member.id;
      dirty = 0;
      paintHead();
      paintDetail(member);
      return options.list;
    },
    onToggle: (key) => {
      chosen = key;
      if (!key) {
        dirty = 0;
        paintHead();
      }
    },
  });
  options.table.replaceChildren(table.root);

  // ---- the open person ----
  const paintDetail = (member: Member) => {
    options.list.replaceChildren();
    const item = h('div', { class: 'admin-member' });
    const heading = h('h3', {
      class: 'admin-member-head',
      text: `${member.label} · ${member.role === 'owner' ? '主管理员' : `已分配 ${member.permissions.length} 项授权`}${member.email ? ` · ${member.email}` : ''}`,
    });
    item.append(heading);
    if (member.role === 'owner') {
      item.append(h('p', { text: '主管理员保留所有功能权限，不能在此撤权。' }));
      options.list.append(item);
      return;
    }
    const controls = h('div', { class: 'mb-grid' });
    item.append(controls);
    const editor = options.permissionControls(controls, member.permissions, (count) => {
      dirty = count;
      paintHead();
    });
    const save = h('button', {
      class: 'admin-primary',
      text: `保存 ${member.label} 的权限`,
      attrs: { type: 'button' },
    });
    save.addEventListener('click', () => {
      void options.run(async () => {
        const selected = editor.value();
        if (selected.length > options.permissionLimit) {
          options.status('原授权数据异常，请重新读取后处理。');
          return;
        }
        await options.api.setPermissions(member.id, selected, member.permissions);
        await load();
        if (!options.disposed()) options.status('权限已更新，对方账号和登录会话保持不变。');
      });
    });
    const reissue = h('button', {
      text: reissueUnknown.has(member.id) ? '上次签发结果未确认，请核对未用凭据' : '签发新登录凭据',
      attrs: { type: 'button' },
    });
    reissue.dataset.locked = String(reissueUnknown.has(member.id));
    reissue.addEventListener('click', () => {
      if (reissueUnknown.has(member.id)) return;
      void options.run(async () => {
        reissueUnknown.add(member.id);
        reissue.dataset.locked = 'true';
        let issued: Awaited<ReturnType<typeof options.api.issueMember>>;
        try {
          issued = await options.api.issueMember({
            requestId: crypto.randomUUID(),
            label: member.label,
            memberId: member.id,
            permissions: member.permissions,
          });
        } catch (error) {
          // An unconfirmed issue is shown at once (the button stays locked) instead of waiting for a reload.
          paintDetail(member);
          throw error;
        }
        reissueUnknown.delete(member.id);
        options.showSecret('管理员一次性登录凭据 · 权限保持原样', issued.token);
        await load();
      });
    });
    // The buttons are direct children of the person's block (a flex row after the grid), the danger zone last.
    item.append(save, reissue);
    for (const grant of result?.grants.filter(
      (g) => g.memberId === member.id && !g.consumed && g.revokedAt === null && g.expiresAt > Date.now(),
    ) ?? []) {
      const revoke = h('button', {
        text: `撤销未用登录凭据 · ${dateTimeText(grant.expiresAt)} 到期`,
        attrs: { type: 'button' },
      });
      revoke.addEventListener('click', () => {
        void options.run(async () => {
          await options.api.revokeCredential(grant.id);
          await load();
        });
      });
      item.append(revoke);
    }
    const zone = dangerZone({
      open: '收回全部功能权限',
      impact: () => [{ n: String(member.permissions.length), label: '项功能权限' }],
      note: '只收回管理功能。此账号仍可登录，所有会话、邮箱和玩家聊天保持不变。',
      confirm: '确认收回',
      busy: options.busy,
      run: async () => {
        await options.run(async () => {
          await options.api.setPermissions(member.id, [], member.permissions);
          await load();
          if (!options.disposed()) options.status('已收回全部管理功能权限，账号及登录会话保留。');
        });
      },
    });
    item.append(zone.root);
    options.list.append(item);
  };

  // ---- add form ----
  const issue = async (label: string) => {
    if (unknownIssue) return;
    try {
      const issued = await options.api.issueMember({
        requestId: crypto.randomUUID(),
        label,
        memberId: null,
        permissions: issuePermissions(),
      });
      options.showSecret('管理员一次性登录凭据 · 1 小时内使用', issued.token);
      await load();
    } catch (error) {
      unknownIssue = true;
      throw error;
    }
  };

  const load = async () => {
    const next = await options.api.members();
    if (options.disposed()) return;
    result = next;
    const keep = chosen && next.members.some((m) => m.id === chosen) ? chosen : null;
    chosen = keep ?? (next.members.find((m) => m.role !== 'owner') ?? next.members[0])?.id ?? null;
    // The people table is set first, then the person who was open (or the first administrator) opens below their row.
    table.setRows(next.members);
    if (chosen) table.open(chosen);
    paintHead();
  };
  return {
    load,
    issue,
    /** The add bar's lock: an unconfirmed issue stays locked until the page is reopened. */
    get issueLocked() {
      return unknownIssue;
    },
    clear() {
      options.table.replaceChildren();
      options.list.replaceChildren();
      result = null;
      chosen = null;
      dirty = 0;
    },
    get loaded() {
      return result !== null;
    },
  };
}
