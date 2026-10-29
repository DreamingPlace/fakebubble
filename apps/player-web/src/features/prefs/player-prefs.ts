/**
 * Part 25b: what a player chooses about how the site looks - the theme, a frame for their own avatar and a background colour for
 * each chat. No per-player settings store exists on the server (and a migration was out of scope), so these live in this device's
 * localStorage for everyone, guests included. They carry no identity: a character id and a colour, never a nickname or a player id.
 * A storage that is off or full leaves the page working for the current visit.
 */
import { DEFAULT_FRAME, isFrameId, type FrameId } from '../brand/avatar-frame.ts';
import { parseColour } from '../brand/character-colour.ts';

export type ThemePref = 'system' | 'light' | 'dark';
export type ChatBackground = { kind: 'preset'; id: string } | { kind: 'custom'; color: string };
export type PlayerPrefsData = { theme: ThemePref; frame: FrameId; chatBg: Record<string, ChatBackground> };

export const PREFS_KEY = 'fakebubble.player-prefs.v1';
/** The soft presets of the chat background: a day tone and a night tone each. The first choice, "default", is the character's own aura. */
export const CHAT_BACKGROUNDS = [
  { id: 'peach', label: '蜜桃', day: '#FFE6DA', night: '#3A2420' },
  { id: 'lemon', label: '柠檬', day: '#FFF3C9', night: '#3A3320' },
  { id: 'mint', label: '薄荷', day: '#DDF4EA', night: '#1B3029' },
  { id: 'sky', label: '天空', day: '#DCEBFF', night: '#1B2740' },
  { id: 'lilac', label: '薰衣草', day: '#E7DFFF', night: '#2A2342' },
  { id: 'rose', label: '玫瑰', day: '#FFE0EC', night: '#3B2030' },
  { id: 'cloud', label: '云灰', day: '#ECEBF0', night: '#222029' },
] as const;

const CHARACTER_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_CHATS = 64;

const fresh = (): PlayerPrefsData => ({ theme: 'system', frame: DEFAULT_FRAME, chatBg: {} });

function backgroundOf(value: unknown): ChatBackground | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (entry.kind === 'preset' && typeof entry.id === 'string' && CHAT_BACKGROUNDS.some((p) => p.id === entry.id))
    return { kind: 'preset', id: entry.id };
  if (entry.kind === 'custom' && typeof entry.color === 'string') {
    const color = parseColour(entry.color);
    if (color) return { kind: 'custom', color };
  }
  return null;
}

/** Whatever is stored is untrusted: anything that is not exactly a known value is dropped, never repaired. */
export function parsePrefs(raw: string | null): PlayerPrefsData {
  const out = fresh();
  if (!raw) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof data !== 'object' || data === null) return out;
  const record = data as Record<string, unknown>;
  if (record.theme === 'light' || record.theme === 'dark' || record.theme === 'system') out.theme = record.theme;
  if (isFrameId(record.frame)) out.frame = record.frame;
  if (typeof record.chatBg === 'object' && record.chatBg !== null) {
    for (const [key, value] of Object.entries(record.chatBg).slice(0, MAX_CHATS)) {
      const bg = backgroundOf(value);
      if (bg && CHARACTER_KEY.test(key)) out.chatBg[key] = bg;
    }
  }
  return out;
}

export class PlayerPrefs {
  private data: PlayerPrefsData;
  private readonly listeners = new Set<() => void>();
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  constructor(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = deviceStorage()) {
    this.storage = storage;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(PREFS_KEY) ?? null;
    } catch {
      /* storage is off: the defaults are all there is */
    }
    this.data = parsePrefs(raw);
  }
  get theme() {
    return this.data.theme;
  }
  get frame() {
    return this.data.frame;
  }
  chatBackground(characterId: string): ChatBackground | null {
    return this.data.chatBg[characterId] ?? null;
  }
  setTheme(theme: ThemePref) {
    this.change(() => {
      this.data.theme = theme;
    });
  }
  setFrame(frame: FrameId) {
    this.change(() => {
      this.data.frame = frame;
    });
  }
  /** null puts the character's own aura back. A colour that does not parse is refused and nothing changes. */
  setChatBackground(characterId: string, background: ChatBackground | null) {
    if (!CHARACTER_KEY.test(characterId)) return;
    const next = background === null ? null : backgroundOf(background);
    if (background !== null && !next) return;
    this.change(() => {
      if (next) this.data.chatBg[characterId] = next;
      else delete this.data.chatBg[characterId];
    });
  }
  /** 清除本设备的体验数据 / 删除账号: nothing chosen here outlives them. */
  clear() {
    this.data = fresh();
    try {
      this.storage?.removeItem(PREFS_KEY);
    } catch {
      /* nothing to remove */
    }
    this.notify();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private change(apply: () => void) {
    apply();
    try {
      this.storage?.setItem(PREFS_KEY, JSON.stringify(this.data));
    } catch {
      /* full or blocked: this visit still has the choice */
    }
    this.notify();
  }
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}

function deviceStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let shared: PlayerPrefs | null = null;
/** The one store of the page. */
export function playerPrefs() {
  return (shared ??= new PlayerPrefs());
}
