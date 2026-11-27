import {
  MEME_SOURCE_LABELS,
  isKeptCategory,
  MEME_CATEGORIES,
  type MemeRowProblem,
  type MemeSource,
} from '../../../../../../packages/contracts/web-memes.ts';
import type { CastAdminClient } from '../../../services/cast-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { drawer } from '../ui/drawer.ts';

/** What the 网络梗 page's parts need of the page (the api, who may edit, request ids, the toast and the in-place confirm). */
export type MemesDeps = {
  api: Pick<
    CastAdminClient,
    | 'memesList'
    | 'memesSet'
    | 'memesQueue'
    | 'memesAdd'
    | 'memesEdit'
    | 'memesRestoreOriginal'
    | 'memesDelete'
    | 'memesRestore'
    | 'memesImportPreview'
    | 'memesImport'
    | 'memesApprove'
    | 'memesDismiss'
  >;
  canEdit: () => boolean;
  newRequestId: () => string;
  disposed: () => boolean;
  toast: (text: string) => void;
  /** An answer bar that opens in place (ui/inline-confirm.ts); `host` is where it grows. */
  confirm: (options: { title: string; message: string; confirmLabel?: string }, host: HTMLElement) => Promise<boolean>;
};
export const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
export const detailOf = (error: unknown): Record<string, unknown> =>
  error && typeof error === 'object' && 'detail' in error && error.detail && typeof error.detail === 'object'
    ? (error.detail as Record<string, unknown>)
    : {};
export const count = (n: number) => n.toLocaleString('en-US');

export const sourceLabel = (source: MemeSource) => MEME_SOURCE_LABELS[source];
export const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The categories an entry can be given: the five, and the one it has now when that is a drop reason (an edit may leave it). */
export const categoryChoices = (current: string | null): string[] =>
  current !== null && !isKeptCategory(current) && MEME_CATEGORIES.includes(current)
    ? [...MEME_CATEGORIES.filter(isKeptCategory), current]
    : MEME_CATEGORIES.filter(isKeptCategory);
export function categorySelect(current: string | null, label: string): HTMLSelectElement {
  const select = h('select', { attrs: { 'aria-label': label } });
  for (const category of categoryChoices(current))
    select.append(h('option', { text: category, attrs: { value: category } }));
  select.value = current ?? categoryChoices(null)[0]!;
  return select;
}

/** Why an uploaded row is not taken - one short sentence each (shown with the row, never dropped). */
export const ROW_PROBLEM_TEXT: Readonly<Record<MemeRowProblem, string>> = {
  EMPTY_TERM: '词是空的',
  EMPTY_MEANING: '释义是空的',
  TERM_TOO_LONG: '词超过 40 个字',
  TERM_TOO_SHORT: '词不到 2 个字',
  MEANING_TOO_LONG: '释义超过 200 个字',
  BAD_CATEGORY: '分类不在可选的五个里',
  DUPLICATE_IN_FILE: '这个词在文件里出现了不止一次',
};
export const ROW_STATUS_TEXT = {
  ok: '新词',
  update: '已有，通过后更新',
  revive: '曾删除',
  unchanged: '没有变化',
  queued: '已在待审',
  invalid: '不能导入',
} as const;

/** A request id per distinct request: a request whose answer was never seen is retried under the SAME id, so it can never apply twice. */
export function requestIds(next: () => string) {
  const pending = new Map<string, string>();
  return {
    of: (signature: string) => {
      if (!pending.has(signature)) pending.set(signature, next());
      return pending.get(signature)!;
    },
    done: (signature: string) => void pending.delete(signature),
    clear: () => pending.clear(),
  };
}

/** A short digest of a text (FNV-1a over its UTF-16 units): tells two uploads apart for a request id, never a secret. */
export function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16);
}

/** 「心情（98）」 in the category filter. */
export const categoryOrderLabel = (category: string, n: number) => `${category}（${count(n)}）`;

/**
 * A drawer that exists only while it is open (its nodes leave the page on close), so a closed 网络梗 page leaves no hidden dialog
 * behind for the other pages to trip over.
 */
export function lazyDrawer(parent: HTMLElement, options: { wide?: boolean } = {}) {
  let current: ReturnType<typeof drawer> | null = null;
  const api = {
    open(title: string, content: Node) {
      api.dispose();
      const panel = drawer(parent, {
        title,
        ...(options.wide ? { wide: true } : {}),
        onClose: () => queueMicrotask(api.dispose),
      });
      panel.body.replaceChildren(content);
      current = panel;
      panel.open();
    },
    close: () => current?.close(),
    isOpen: () => current?.isOpen() ?? false,
    dispose() {
      current?.dispose();
      current = null;
    },
  };
  return api;
}
