import {
  ADMIN_PERMISSION_CATEGORIES,
  permissionCategory,
  type AdminPermission,
  type AdminPermissionCategory,
} from '../../../../../packages/contracts/web-admin-permissions.ts';
const labels: Record<AdminPermissionCategory, [string, string]> = {
  'category.characters': [
    '角色资料',
    '查看、新增、修改、放弃草稿和删除角色。删除时仍须确认该角色旧聊天的清理范围；不包含发布。',
  ],
  'category.publication': [
    '角色预览与发布',
    '查看角色资料，预演并发布修改后的版本。文字预演会产生供应商费用，不主动推送人物消息。',
  ],
  'category.materials': ['声音成品', '查看、上传、试听和批准角色成品音频。不自动上传原始声音，不创建或克隆音色。'],
  'category.invites': ['玩家邀请', '查看、生成和撤销玩家邀请码及已兑换的体验授权。不删除账号和聊天。'],
};
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Four product categories; an untouched legacy grant is preserved rather than silently broadened. */
export function permissionEditor(root: HTMLElement, initial: readonly AdminPermission[]) {
  const choices = new Map<AdminPermissionCategory, { input: HTMLInputElement; changed: boolean }>();
  const group = el('fieldset');
  group.append(el('legend', '功能权限'));
  root.append(group);
  for (const category of ADMIN_PERMISSION_CATEGORIES) {
    const [name, help] = labels[category],
      label = el('label'),
      input = el('input'),
      legacy = initial.filter((p) => permissionCategory(p) === category && p !== category);
    input.type = 'checkbox';
    input.checked = initial.includes(category) || legacy.length > 0;
    input.indeterminate = !initial.includes(category) && legacy.length > 0;
    input.setAttribute('data-permission-category', category);
    label.append(input, el('span', name));
    group.append(label, el('p', help));
    const entry = { input, changed: false };
    choices.set(category, entry);
    if (input.indeterminate) group.append(el('p', '此类保留原部分授权；取消可收回，重新勾选才授予整类。'));
    input.addEventListener('change', () => {
      entry.changed = true;
      input.indeterminate = false;
    });
  }
  root.append(
    el(
      'p',
      '仅按以上四类授权，角色类功能适用于网页全部角色。成员授权只属于主管理员，不在此转授。取消勾选不退出对方账号或会话。',
    ),
  );
  return {
    value: () => {
      const result: AdminPermission[] = [];
      for (const [category, { input, changed }] of choices) {
        if (!changed) result.push(...initial.filter((p) => permissionCategory(p) === category));
        else if (input.checked) result.push(category);
      }
      return [...new Set(result)].sort();
    },
    setDisabled: (disabled: boolean) => {
      for (const { input } of choices.values()) input.disabled = disabled;
    },
  };
}
