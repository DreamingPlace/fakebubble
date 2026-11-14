import type { AvatarInfo } from '../../../services/character-admin-api.ts';
import { h } from '../../cocreation/h.ts';

/** The limits the server enforces (packages/imaging/avatar.ts); the page checks the cheap ones first and says why in one line. */
export const AVATAR_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const avatarCopy = {
  heading: '头像',
  choose: '上传头像',
  replace: '替换头像',
  clear: '清除头像',
  note: 'PNG、JPEG 或 WebP，不超过 2 MB。居中裁成正方形，发布后显示为圆形。',
  hint: (file: string) => `资料里的头像文件：${file}`,
  unsaved: '已更换，保存草稿后发布生效。',
  uploading: '正在处理…',
  tooBig: '文件超过 2 MB。',
  type: '只支持 PNG、JPEG 或 WebP。',
  failed: '头像没有上传。',
};
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export type AvatarHost = {
  characterId: string | null;
  /** The file name an imported profile recorded (a hint beside the upload). */
  fileHint: string | null;
  upload: (base64: string) => Promise<AvatarInfo>;
  read: (avatarId: string) => Promise<string>;
  /** The initials the circle shows until there is a picture. */
  initial: () => string;
  colour: () => string | null;
};

const toBase64 = (buffer: ArrayBuffer) => {
  let text = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return globalThis.btoa(text);
};

/**
 * Part 31 (25e), 身份与网页展示 → 头像. A circle (the shape players see), one button, one line of limits and, when a profile import
 * recorded a file name, that name as a hint. Choosing a file uploads it at once (the server re-encodes it); the draft then names the
 * new picture and the usual 保存草稿 / 发布 apply. A picture needs no 预演.
 */
export function avatarField(
  parent: HTMLElement,
  current: { id: string } | undefined,
  host: AvatarHost | null,
  onChange: () => void,
) {
  let value: { id: string } | null = current ?? null;
  let saved = current?.id ?? null;
  const circle = h('div', { class: 'av-circle', attrs: { role: 'img', 'aria-label': avatarCopy.heading } });
  const input = h('input', { attrs: { type: 'file', accept: TYPES.join(','), hidden: '' } });
  const button = h('button', { class: 'admin-secondary av-pick', text: avatarCopy.choose, attrs: { type: 'button' } });
  const clear = h('button', {
    class: 'admin-secondary av-clear',
    text: avatarCopy.clear,
    attrs: { type: 'button' },
    hidden: true,
  });
  const line = h('p', { class: 'av-line', attrs: { role: 'status', 'aria-live': 'polite' } });
  const note = h('p', { class: 'admin-hint av-note', text: avatarCopy.note });
  const hint = host?.fileHint ? h('p', { class: 'admin-hint av-hint', text: avatarCopy.hint(host.fileHint) }) : null;
  const row = h(
    'div',
    { class: 'av-row' },
    circle,
    h('div', { class: 'av-side' }, h('div', { class: 'av-actions' }, button, clear, input), line, note, hint),
  );
  const fieldset = h('div', { class: 'av-field' }, row);
  parent.append(fieldset);
  const initials = () => ((host?.initial() ?? '').trim().slice(0, 1) || '·').toUpperCase();
  const paint = async () => {
    clear.hidden = !value;
    button.textContent = value ? avatarCopy.replace : avatarCopy.choose;
    circle.style?.setProperty('--av-colour', host?.colour() ?? '');
    circle.dataset.empty = String(!value);
    if (!value || !host) {
      circle.style?.removeProperty?.('background-image');
      circle.textContent = initials();
      return;
    }
    circle.textContent = '';
    try {
      circle.style?.setProperty?.('background-image', `url("${await host.read(value.id)}")`);
    } catch {
      circle.style?.removeProperty?.('background-image');
      circle.textContent = initials();
    }
  };
  const say = (text: string, tone: 'info' | 'warn' = 'info') => {
    line.textContent = text;
    line.dataset.tone = tone;
  };
  void paint();
  if (!host) {
    button.disabled = true;
    return { node: fieldset, read: () => value ?? undefined, refresh: () => {} };
  }
  button.addEventListener('click', () => input.click());
  clear.addEventListener('click', () => {
    value = null;
    say(saved ? avatarCopy.unsaved : '');
    void paint();
    onChange();
  });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > AVATAR_PAGE_MAX_BYTES) return say(avatarCopy.tooBig, 'warn');
    if (file.type && !TYPES.includes(file.type)) return say(avatarCopy.type, 'warn');
    say(avatarCopy.uploading);
    button.disabled = true;
    try {
      const info = await host.upload(toBase64(await file.arrayBuffer()));
      value = { id: info.id };
      say(info.id === saved ? '' : avatarCopy.unsaved);
      await paint();
      onChange();
    } catch (error) {
      say(avatarMessage(error), 'warn');
    } finally {
      button.disabled = false;
    }
  });
  return {
    node: fieldset,
    read: () => value ?? undefined,
    /** After a save: what the draft now holds is the saved picture. */
    markSaved: () => {
      saved = value?.id ?? null;
      say('');
    },
    refresh: () => void paint(),
  };
}
export const AVATAR_ERRORS: Record<string, string> = {
  AVATAR_TOO_LARGE: avatarCopy.tooBig,
  AVATAR_FORMAT: avatarCopy.type,
  AVATAR_INVALID: '这个文件无法读取，请换一张图片。',
  AVATAR_DIMENSIONS: '图片尺寸不合适：至少 64×64，最长边不超过 4096，总像素不超过 800 万。',
  AVATAR_UNAVAILABLE: '这个环境还不支持头像。',
  CHARACTER_DELETED: '角色已被删除。',
};
const avatarMessage = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code ?? '';
  return AVATAR_ERRORS[code] ?? avatarCopy.failed;
};
