/**
 * Part 59: the owner's own UNSAVED admin edits, kept in this browser (localStorage) so a reload, a logout, a Cloudflare challenge or
 * a failed save never loses them. One key per page + character + section + draft revision; written while the owner edits, removed
 * by a successful save, a deliberate 放弃, and sign-out. It holds only what the owner typed into an editor (the draft's own fields):
 * no player data, no token, no session. Every access is guarded: a private window or a full disk simply keeps nothing.
 */
const PREFIX = 'fb-admin-edits:v1:';
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const store = (): Store | null => {
  try {
    const s = (globalThis as { localStorage?: Store }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
};
export interface EditScope {
  /** The admin page (characters, cast, memes, cocreation, …). */
  page: string;
  /** The character the edit is about (or a fixed word for a page-wide editor). */
  character: string;
  /** A section of the page that has its own buffer (speech, adopt-box, …); '' for the page's one. */
  section?: string;
  /** The revision of the draft the edit started from (null: there was no draft). */
  revision: number | string | null;
}
export interface KeptEdit<T> {
  value: T;
  /** When the owner last changed it (ms since epoch, the browser's clock). */
  at: number;
  revision: number | string | null;
  /** How many changes the buffer holds, as the editor counted them (for the one line the owner reads). */
  changes: number;
}
const stem = (scope: EditScope) => `${PREFIX}${enc(scope.page)}:${enc(scope.character)}:${enc(scope.section ?? '')}:`;
const enc = (value: string) => encodeURIComponent(value);

export function editKeeper<T>(scope: EditScope) {
  const key = `${stem(scope)}${enc(String(scope.revision ?? 'none'))}`;
  return {
    key,
    /** Keeps the current edits (replaces the buffer of this revision). Returns false when the browser would not keep them. */
    put(value: T, changes = 1): boolean {
      const s = store();
      if (!s) return false;
      try {
        s.setItem(key, JSON.stringify({ value, at: Date.now(), revision: scope.revision ?? null, changes }));
        return true;
      } catch {
        return false;
      }
    },
    /** The newest buffer of this page + character + section, whatever draft revision it started from. */
    find(): KeptEdit<T> | null {
      const s = store();
      if (!s) return null;
      let best: KeptEdit<T> | null = null;
      try {
        const prefix = stem(scope);
        for (let i = 0; i < s.length; i += 1) {
          const name = s.key(i);
          if (!name?.startsWith(prefix)) continue;
          const row = parse<T>(s.getItem(name));
          if (!row || Date.now() - row.at > MAX_AGE_MS) continue;
          if (!best || row.at > best.at) best = row;
        }
      } catch {
        return null;
      }
      return best;
    },
    /** Removes every buffer of this page + character + section (a save succeeded, or the owner gave the edits up). */
    clear() {
      const s = store();
      if (!s) return;
      try {
        const prefix = stem(scope),
          drop: string[] = [];
        for (let i = 0; i < s.length; i += 1) {
          const name = s.key(i);
          if (name?.startsWith(prefix)) drop.push(name);
        }
        for (const name of drop) s.removeItem(name);
      } catch {
        /* nothing kept, nothing to remove */
      }
    },
  };
}
function parse<T>(raw: string | null): KeptEdit<T> | null {
  if (!raw) return null;
  try {
    const row = JSON.parse(raw) as Partial<KeptEdit<T>>;
    if (!row || typeof row !== 'object' || typeof row.at !== 'number' || !('value' in row)) return null;
    return {
      value: row.value as T,
      at: row.at,
      revision: row.revision ?? null,
      changes: typeof row.changes === 'number' ? row.changes : 1,
    };
  } catch {
    return null;
  }
}
/** Sign-out (and a different member signing in) removes every kept edit: the next person on this browser never sees them. */
export function clearAllKeptEdits() {
  const s = store();
  if (!s) return;
  try {
    const drop: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const name = s.key(i);
      if (name?.startsWith(PREFIX)) drop.push(name);
    }
    for (const name of drop) s.removeItem(name);
  } catch {
    /* nothing to remove */
  }
}
export const hasKeptEdits = () => {
  const s = store();
  if (!s) return false;
  try {
    for (let i = 0; i < s.length; i += 1) if (s.key(i)?.startsWith(PREFIX)) return true;
  } catch {
    /* none */
  }
  return false;
};

/** A debounced writer: `schedule` after every change, `flush` when the page hides or unloads. */
export function keepWhileEditing(write: () => void, wait = 300) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      write();
    } catch {
      /* never break the editor for the sake of the copy */
    }
  };
  const onHide = () => {
    if ((globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden') flush();
  };
  (globalThis as { addEventListener?: Window['addEventListener'] }).addEventListener?.('pagehide', flush);
  (globalThis as { document?: Document }).document?.addEventListener?.('visibilitychange', onHide);
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, wait);
      (timer as { unref?: () => void }).unref?.();
    },
    flush,
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      (globalThis as { removeEventListener?: Window['removeEventListener'] }).removeEventListener?.('pagehide', flush);
      (globalThis as { document?: Document }).document?.removeEventListener?.('visibilitychange', onHide);
    },
  };
}

/** 「恢复未保存的修改」: the bar an editor shows when a kept buffer exists. `restore` puts the edits back; `discard` gives them up. */
export function restoreBar(
  kept: { at: number; changes: number },
  actions: { restore: () => void; discard: () => void },
  make: (tag: 'div' | 'span' | 'button', text?: string) => HTMLElement,
) {
  const bar = make('div');
  bar.className = 'wb-restore';
  bar.setAttribute('role', 'status');
  const when = new Date(kept.at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const restore = make('button', '恢复未保存的修改') as HTMLButtonElement;
  const discard = make('button', '放弃这些修改') as HTMLButtonElement;
  restore.type = 'button';
  discard.type = 'button';
  restore.className = 'admin-primary';
  discard.className = 'admin-secondary';
  restore.addEventListener('click', () => {
    bar.remove();
    actions.restore();
  });
  discard.addEventListener('click', () => {
    bar.remove();
    actions.discard();
  });
  bar.append(make('span', `这个浏览器里留着 ${stamp} 没保存的修改（${kept.changes} 处）`), restore, discard);
  return bar;
}

/**
 * Restoring edits onto a draft that has MOVED ON since they were made (another save, an adoption): only the fields the owner
 * actually changed (`edited` differs from the `base` they started from) are laid over the current draft, so nothing newer is
 * overwritten by the stale rest of the buffer. Plain objects are walked down to `depth`; lists and values are taken whole.
 */
export function overlayEdits<T extends object>(current: T, base: T, edited: T, depth = 4): T {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const walk = (now: unknown, was: unknown, mine: unknown, level: number): unknown => {
    if (isObject(now) && isObject(was) && isObject(mine) && level > 0) {
      const out: Record<string, unknown> = { ...now };
      for (const key of new Set([...Object.keys(was), ...Object.keys(mine)])) {
        const next = walk(now[key], was[key], mine[key], level - 1);
        if (next === undefined) delete out[key];
        else out[key] = next;
      }
      return out;
    }
    return JSON.stringify(mine) === JSON.stringify(was) ? now : structuredClone(mine);
  };
  return walk(current, base, edited, depth) as T;
}

/**
 * Keeps the typed values of a panel whose controls have a FIXED structure (说话档案, the adopt box, 网络梗's editors): every text
 * control, checkbox and select inside `panel` by its position. It writes only while a value differs from what the panel opened with,
 * and removes the buffer when they are equal again. `bar()` is the 「恢复未保存的修改」 line when a buffer from an earlier visit
 * exists (null otherwise); restoring refuses a buffer whose number of controls no longer matches (the panel changed shape).
 */
export function panelKeeper(
  panel: HTMLElement,
  scope: EditScope,
  make: (tag: 'div' | 'span' | 'button', text?: string) => HTMLElement,
  afterRestore: () => void = () => {},
) {
  const keeper = editKeeper<string[]>(scope);
  const controls = () =>
    [
      ...panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select'),
    ].filter((c) => !['file', 'password', 'button', 'submit', 'hidden'].includes((c as HTMLInputElement).type));
  const valueOf = (c: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) =>
    (c as HTMLInputElement).type === 'checkbox' || (c as HTMLInputElement).type === 'radio'
      ? String((c as HTMLInputElement).checked)
      : c.value;
  let opened = controls().map(valueOf);
  const keepNow = () => {
    const now = controls().map(valueOf);
    const changes = now.filter((v, i) => v !== opened[i]).length;
    if (now.length !== opened.length || changes === 0) return keeper.clear();
    keeper.put(now, changes);
  };
  const writer = keepWhileEditing(keepNow);
  const onEdit = () => writer.schedule();
  panel.addEventListener('input', onEdit);
  panel.addEventListener('change', onEdit);
  return {
    keepNow,
    /** The panel was saved or given up: what it shows now is the new "unchanged". */
    saved() {
      keeper.clear();
      opened = controls().map(valueOf);
    },
    /** The line to offer, or null. */
    bar(): HTMLElement | null {
      const kept = keeper.find();
      if (!kept || kept.value.length !== opened.length) return null;
      return restoreBar(
        kept,
        {
          restore: () => {
            controls().forEach((c, i) => {
              const v = kept.value[i]!;
              if ((c as HTMLInputElement).type === 'checkbox' || (c as HTMLInputElement).type === 'radio')
                (c as HTMLInputElement).checked = v === 'true';
              else c.value = v;
              c.dispatchEvent(new Event('input', { bubbles: true }));
              c.dispatchEvent(new Event('change', { bubbles: true }));
            });
            afterRestore();
          },
          discard: () => keeper.clear(),
        },
        make,
      );
    },
    /** The panel goes away (re-rendered after a save, or left): nothing is written now, or a save's cleanup would be undone. */
    stop() {
      writer.stop();
      panel.removeEventListener('input', onEdit);
      panel.removeEventListener('change', onEdit);
    },
  };
}

/** A plain element maker for `restoreBar` / `panelKeeper` where the caller has no `h` of its own. */
export const plainEl = (tag: 'div' | 'span' | 'button', text?: string): HTMLElement => {
  const node = globalThis.document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
