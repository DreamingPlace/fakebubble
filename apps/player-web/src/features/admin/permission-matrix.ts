import {
  ADMIN_PERMISSION_PRESETS,
  dependentItems,
  itemPermission,
  requiredItems,
  type AdminPermission,
  type AdminPermissionItem,
} from '../../../../../packages/contracts/web-admin-permissions.ts';
import { h } from '../cocreation/h.ts';

type ItemInfo = { item: AdminPermissionItem; name: string; help: string };
type Group = { id: string; title: string; items: readonly ItemInfo[] };
/** Permissions grouped by the area they belong to. The dependencies themselves live in packages/contracts. */
export const PERMISSION_GROUPS: readonly Group[] = [
  {
    id: 'characters',
    title: '角色资料',
    items: [
      { item: 'characters.read', name: '查看角色', help: '打开角色目录和资料。其他角色功能都以它为前提。' },
      { item: 'characters.create', name: '新建角色', help: '建立新的角色草稿。' },
      { item: 'characters.edit', name: '修改并保存草稿', help: '保存草稿不会改变正式角色和玩家聊天。' },
      { item: 'characters.discard', name: '放弃服务器草稿', help: '只移除未发布草稿，正式版本不变。' },
      { item: 'characters.delete', name: '删除角色', help: '删除时仍须确认该角色旧聊天的清理范围。' },
    ],
  },
  {
    id: 'publication',
    title: '预演与发布',
    items: [
      { item: 'characters.preview', name: '预演测试', help: '文字预演会产生供应商费用，不主动推送人物消息。' },
      { item: 'characters.publish', name: '发布', help: '把预演通过的草稿发布给玩家；需要预演测试。' },
    ],
  },
  {
    id: 'materials',
    title: '声音成品',
    items: [
      { item: 'characters.materials', name: '上传与试听成品音频', help: '不自动上传原始声音，不创建或克隆音色。' },
      { item: 'characters.approve-materials', name: '批准成品音频', help: '批准后才能随草稿发布。' },
    ],
  },
  {
    id: 'invites',
    title: '玩家邀请',
    items: [
      { item: 'invites.read', name: '查看邀请记录', help: '只看邀请码与授权的元数据。' },
      { item: 'invites.issue', name: '生成邀请码', help: '邀请码仅在生成时显示一次。' },
      { item: 'invites.revoke-code', name: '撤销邀请码', help: '该码不再能兑换，已兑换的授权不受影响。' },
      { item: 'invites.revoke-access', name: '撤销体验授权', help: '对应玩家不能继续体验；账号和聊天保留。' },
    ],
  },
  {
    id: 'cocreation',
    title: '共创收件箱',
    items: [
      { item: 'cocreation.read', name: '查看', help: '阅读玩家为官方角色写下的想法；只显示匿名代号和邀请批次。' },
      {
        item: 'cocreation.manage',
        name: '处理',
        help: '标记已处理／归档、加星、写备注、标记“已采用”。把内容加入角色草稿另需“修改并保存草稿”。',
      },
    ],
  },
  {
    id: 'conversations',
    title: '测试对话',
    items: [
      {
        item: 'conversations.read',
        name: '查看测试对话',
        help: '阅读玩家与角色的聊天全文（只显示匿名编号，不显示邮箱和昵称）。默认只有主管理员；需要打开 CHAT_REVIEW_ENABLED。',
      },
    ],
  },
];
const NAMES = new Map(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => [i.item, i.name] as const)));
const named = (items: readonly AdminPermissionItem[]) => items.map((i) => `「${NAMES.get(i) ?? i}」`).join('、');

/** Old coarse grants stay readable: each shows as the items it contains. */
const CATEGORY_ITEMS: Record<string, readonly AdminPermissionItem[]> = {
  'category.characters': [
    'characters.read',
    'characters.create',
    'characters.edit',
    'characters.discard',
    'characters.delete',
  ],
  'category.publication': ['characters.read', 'characters.preview', 'characters.publish'],
  'category.materials': ['characters.read', 'characters.materials', 'characters.approve-materials'],
  'category.invites': ['invites.read', 'invites.issue', 'invites.revoke-code', 'invites.revoke-access'],
  'invites.revoke': ['invites.revoke-code', 'invites.revoke-access'],
};
const KNOWN = new Set<string>(NAMES.keys());
function decompose(initial: readonly AdminPermission[]) {
  const items = new Set<AdminPermissionItem>(),
    legacy: AdminPermission[] = [];
  for (const permission of initial) {
    const whole = /^(characters\.[a-z-]+):\*$/.exec(permission)?.[1];
    if (CATEGORY_ITEMS[permission]) for (const item of CATEGORY_ITEMS[permission]!) items.add(item);
    else if (whole && KNOWN.has(whole)) items.add(whole as AdminPermissionItem);
    else if (KNOWN.has(permission)) items.add(permission as AdminPermissionItem);
    else legacy.push(permission); // granted for one specific role (or unknown): kept until explicitly unticked
  }
  return { items, legacy };
}
const sameSet = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) => a.size === b.size && [...a].every((v) => b.has(v));

/**
 * The permission editor: grouped by area, with 共生项 (ticking an item ticks what it needs; unticking a requirement
 * unticks what depends on it, and says so) and quick presets. An untouched set is returned exactly as it was loaded,
 * so opening and saving never silently rewrites an old grant.
 */
export function permissionMatrixEditor(
  root: HTMLElement,
  initial: readonly AdminPermission[],
  options: { cocreation?: boolean; conversations?: boolean } = {},
) {
  const base = decompose(initial);
  const state = new Set<AdminPermissionItem>(base.items);
  const shown = (item: AdminPermissionItem) =>
    (options.cocreation !== false || !item.startsWith('cocreation.')) &&
    (options.conversations === true || !item.startsWith('conversations.'));
  const boxes = new Map<AdminPermissionItem, HTMLInputElement>();
  const legacyBoxes = new Map<AdminPermission, HTMLInputElement>();
  let touched = false;
  const note = h('p', { class: 'permission-note', attrs: { role: 'status', 'aria-live': 'polite' } });
  const group = h('fieldset', { class: 'permission-matrix' }, h('legend', { text: '功能权限' }));
  root.append(group);

  const presets = h('div', { class: 'permission-presets' }, h('span', { text: '快速设置：' }));
  for (const preset of ADMIN_PERMISSION_PRESETS) {
    const button = h('button', {
      class: 'admin-secondary',
      text: preset.label,
      attrs: { type: 'button', 'data-preset': preset.id },
    });
    button.addEventListener('click', () => {
      touched = true;
      state.clear();
      for (const item of preset.items) if (shown(item)) state.add(item);
      note.textContent = `已套用「${preset.label}」：${named([...state])}。可继续微调。`;
      paint();
    });
    presets.append(button);
  }
  group.append(presets);

  for (const area of PERMISSION_GROUPS) {
    const items = area.items.filter((i) => shown(i.item));
    if (!items.length) continue;
    const section = h(
      'div',
      { class: 'permission-group', attrs: { 'data-area': area.id } },
      h('h4', { text: area.title }),
    );
    for (const { item, name, help } of items) {
      const input = h('input');
      input.type = 'checkbox';
      input.setAttribute('data-permission', item);
      boxes.set(item, input);
      section.append(
        h('label', { class: 'permission-item' }, input, h('span', { text: name })),
        h('p', { class: 'permission-help', text: help }),
      );
      input.addEventListener('change', () => {
        touched = true;
        if (input.checked) {
          const added = requiredItems(item).filter((r) => !state.has(r));
          state.add(item);
          for (const r of added) state.add(r);
          note.textContent = added.length ? `「${name}」需要先有 ${named(added)}，已一并勾选。` : '';
        } else {
          const removed = dependentItems(item).filter((d) => state.has(d));
          state.delete(item);
          for (const d of removed) state.delete(d);
          note.textContent = removed.length ? `${named(removed)}依赖「${name}」，已一并取消。` : '';
        }
        paint();
      });
    }
    group.append(section);
  }
  if (base.legacy.length) {
    const section = h(
      'div',
      { class: 'permission-group', attrs: { 'data-area': 'legacy' } },
      h('h4', { text: '按具体角色授予的旧授权' }),
      h('p', { class: 'permission-help', text: '保存时原样保留；取消勾选即收回。' }),
    );
    for (const permission of base.legacy) {
      const input = h('input');
      input.type = 'checkbox';
      input.checked = true;
      legacyBoxes.set(permission, input);
      input.addEventListener('change', () => (touched = true));
      section.append(h('label', { class: 'permission-item' }, input, h('span', { text: permission })));
    }
    group.append(section);
  }
  group.append(note);
  const paint = () => {
    for (const [item, input] of boxes) input.checked = state.has(item);
  };
  paint();

  return {
    value: (): AdminPermission[] => {
      const unchanged =
        !touched || (sameSet(state, base.items) && [...legacyBoxes.values()].every((input) => input.checked));
      if (unchanged) return [...initial].sort();
      const result = new Set<AdminPermission>();
      for (const item of state) result.add(itemPermission(item));
      for (const [permission, input] of legacyBoxes) if (input.checked) result.add(permission);
      return [...result].sort();
    },
    setDisabled: (disabled: boolean) => {
      for (const input of [...boxes.values(), ...legacyBoxes.values()]) input.disabled = disabled;
      for (const button of presets.children) (button as HTMLButtonElement).disabled = disabled;
    },
  };
}
