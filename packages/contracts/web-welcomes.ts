/**
 * Part 24k-2: a character's 欢迎词 is an ordered list of weighted lines, `presentation.welcomes`.
 * Pure and dependency-free (the admin page and the server both use it).
 *
 * Old profiles carry `presentation.welcome = {text, version}`. They are upgraded IN MEMORY only, losslessly: one line, the same
 * text, weight 100, an id derived from the text. Nothing stored is ever rewritten.
 */
export const WELCOME_LIMITS = Object.freeze({ minLines: 1, maxLines: 8, text: 200, defaultLines: 3, context: 200 });

/**
 * `context` (Part 37a-2, 情境): an optional admin-written note of what was happening when the character sent this line. It is part of
 * the draft and the publication like the line, but it is NEVER spoken (no clip, no manifest slot) and never shown to a player: only
 * the v8 writer reads it. The key is absent, not empty, when there is no note, so a profile without one hashes as it always did.
 */
export type WelcomeLine = { id: string; text: string; weight: number; context?: string };

/** A located problem: which line (1-based, or 0 for the whole list) and what is wrong. */
export type WelcomeProblem = {
  line: number;
  field: 'lines' | 'id' | 'text' | 'context' | 'weight' | 'total';
  message: string;
};

const LEGACY_PREFIX = 'w-';
/** 64-bit FNV-1a over the UTF-16 code units, as 16 hex digits: stable, sync, no dependency (also runs in the browser). */
function fnv64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
/** The stable id of an old single welcome: the same text always gives the same id. */
export const legacyWelcomeId = (text: string) => `${LEGACY_PREFIX}${fnv64(text)}`;

const hasControl = (text: string) => /[\u0000-\u001f\u007f]/.test(text);
/** The text rules every line shares (today's welcome rules, with the cap at 200). */
export const welcomeTextProblem = (text: unknown): string | null => {
  if (typeof text !== 'string') return '欢迎词必须是文字';
  if (!text.trim()) return '欢迎词不能为空';
  if ([...text].length > WELCOME_LIMITS.text) return `欢迎词最多 ${WELCOME_LIMITS.text} 字`;
  if (hasControl(text)) return '欢迎词里不能有控制字符';
  return null;
};

/** Why a 情境 note is refused (null: fine, including no note). */
export const welcomeContextProblem = (context: unknown): string | null => {
  if (context === undefined) return null;
  if (typeof context !== 'string') return '情境必须是文字';
  if ([...context].length > WELCOME_LIMITS.context) return `情境最多 ${WELCOME_LIMITS.context} 字`;
  if (hasControl(context)) return '情境里不能有控制字符';
  return null;
};

/** Every problem of a candidate list, located. Empty = valid. */
export function welcomeProblems(value: unknown): WelcomeProblem[] {
  const out: WelcomeProblem[] = [];
  if (!Array.isArray(value)) return [{ line: 0, field: 'lines', message: '欢迎词需要 1–8 条' }];
  if (value.length < WELCOME_LIMITS.minLines || value.length > WELCOME_LIMITS.maxLines)
    out.push({ line: 0, field: 'lines', message: '欢迎词需要 1–8 条' });
  const seen = new Set<string>();
  let total = 0;
  let complete = true;
  value.forEach((entry, index) => {
    const n = index + 1;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      out.push({ line: n, field: 'text', message: `第 ${n} 条格式不对` });
      complete = false;
      return;
    }
    const line = entry as Record<string, unknown>;
    if (typeof line.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(line.id) || seen.has(line.id))
      out.push({ line: n, field: 'id', message: `第 ${n} 条的标识不对或重复` });
    else seen.add(line.id);
    const text = welcomeTextProblem(line.text);
    if (text) out.push({ line: n, field: 'text', message: `第 ${n} 条：${text}` });
    const context = welcomeContextProblem(line.context);
    if (context) out.push({ line: n, field: 'context', message: `第 ${n} 条：${context}` });
    if (typeof line.weight !== 'number' || !Number.isInteger(line.weight) || line.weight < 1 || line.weight > 100) {
      out.push({ line: n, field: 'weight', message: `第 ${n} 条的比例要是 1–100 的整数` });
      complete = false;
    } else total += line.weight;
  });
  if (complete && value.length > 0 && total !== 100)
    out.push({ line: 0, field: 'total', message: `比例合计要是 100%，现在是 ${total}%` });
  return out;
}

/** Whole percents that sum to exactly 100, as even as possible, the earlier lines taking the extra points: 3 → 34 / 33 / 33. */
export function evenWeights(count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  const base = Math.floor(100 / n),
    extra = 100 - base * n;
  return Array.from({ length: n }, (_, index) => base + (index < extra ? 1 : 0));
}

/** The in-memory upgrade of a stored presentation's welcome(s): never writes anything. */
export function upgradeWelcomes(presentation: { welcome?: unknown; welcomes?: unknown }): WelcomeLine[] {
  if (Array.isArray(presentation.welcomes)) return presentation.welcomes as WelcomeLine[];
  const old = presentation.welcome as { text?: unknown } | undefined;
  const text = typeof old?.text === 'string' ? old.text : '';
  return [{ id: legacyWelcomeId(text), text, weight: 100 }];
}

type PresentationLike = { welcome?: unknown; welcomes?: unknown };
/** A profile with `welcomes` and no `welcome` (a copy; the input is not touched). Anything else in the profile is kept as is. */
export function upgradeProfile<T extends { presentation: PresentationLike }>(
  profile: T,
): Omit<T, 'presentation'> & { presentation: Omit<T['presentation'], 'welcome'> & { welcomes: WelcomeLine[] } } {
  const { welcome: _old, welcomes: _new, ...rest } = profile.presentation as PresentationLike & Record<string, unknown>;
  const welcomes = upgradeWelcomes(profile.presentation).map((line) => ({ ...line }));
  return { ...profile, presentation: { ...rest, welcomes } } as never;
}

/** Choose one line by weight with `unit` in [0, 1). The caller supplies the randomness (the server uses a crypto draw). */
export function pickWelcome(lines: readonly WelcomeLine[], unit: number): WelcomeLine {
  const total = lines.reduce((sum, line) => sum + line.weight, 0);
  let at = Math.min(Math.max(unit, 0), 0.999999999999) * total;
  for (const line of lines) {
    if (at < line.weight) return line;
    at -= line.weight;
  }
  return lines[lines.length - 1]!;
}
