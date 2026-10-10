import {
  ADMIN_PERMISSION_CATEGORIES,
  isCocreationPermission,
  permissionCategory,
  type CocreationAdminPermission,
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
/** 角色 · 共创收件箱: two explicit permissions, deliberately not part of the character categories. */
const cocreationLabels: Record<CocreationAdminPermission, [string, string]> = {
  'cocreation.read': [
    '共创收件箱 · 查看',
    '阅读玩家为官方角色写下的想法。只显示匿名代号和邀请批次，不显示邮箱或身份；不能修改状态，也不能写入草稿。',
  ],
  'cocreation.manage': [
    '共创收件箱 · 处理',
    '包含查看，并可标记已处理／归档、加星、写备注、标记“已采用”。把内容加入角色草稿，另需“角色资料”类权限。',
  ],
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
      legacy = initial.filter(
        (p) => !isCocreationPermission(p) && permissionCategory(p) === category && p !== category,
      );
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
        if (!changed)
          result.push(...initial.filter((p) => !isCocreationPermission(p) && permissionCategory(p) === category));
        else if (input.checked) result.push(category);
      }
      return [...new Set(result)].sort();
    },
    setDisabled: (disabled: boolean) => {
      for (const { input } of choices.values()) input.disabled = disabled;
    },
  };
}

/**
 * 角色 · 共创收件箱: two explicit permissions beside (not inside) the four categories. Kept as its own control so the
 * category editor still contains exactly its four categories; the page combines both values.
 */
export function cocreationPermissionEditor(root: HTMLElement, initial: readonly AdminPermission[]) {
  const boxes = new Map<CocreationAdminPermission, HTMLInputElement>();
  const group = el('fieldset');
  group.append(el('legend', '角色 · 共创收件箱'));
  root.append(group);
  for (const permission of ['cocreation.read', 'cocreation.manage'] as const) {
    const [name, help] = cocreationLabels[permission],
      label = el('label'),
      input = el('input');
    input.type = 'checkbox';
    input.checked =
      initial.includes(permission) || (permission === 'cocreation.read' && initial.includes('cocreation.manage'));
    input.setAttribute('data-permission', permission);
    label.append(input, el('span', name));
    group.append(label, el('p', help));
    boxes.set(permission, input);
  }
  // Handling includes viewing: ticking handling ticks viewing, unticking viewing unticks handling.
  boxes.get('cocreation.manage')!.addEventListener('change', () => {
    if (boxes.get('cocreation.manage')!.checked) boxes.get('cocreation.read')!.checked = true;
  });
  boxes.get('cocreation.read')!.addEventListener('change', () => {
    if (!boxes.get('cocreation.read')!.checked) boxes.get('cocreation.manage')!.checked = false;
  });
  return {
    value: (): AdminPermission[] => {
      const result: AdminPermission[] = [];
      for (const [permission, input] of boxes) if (input.checked) result.push(permission);
      return result.sort();
    },
    setDisabled: (disabled: boolean) => {
      for (const input of boxes.values()) input.disabled = disabled;
    },
  };
}
