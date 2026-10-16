/**
 * Part 17g. What a failed purge step may say about itself: fixed labels, an error class name, an error message with every
 * value taken out, one `file:line`, and counts. Never an id, an address, an IP hash, a nickname or any chat text.
 */

/** The call that threw. 'archive' is the review-archive sweep that opens every sweep. */
export type RetentionPhase = 'markExpired' | 'clearDatabase' | 'eraseAudio' | 'archive';
export type AgeBucket = '<1d' | '1-7d' | '7-30d' | '>30d';

const DAY_MS = 24 * 60 * 60_000;
export const ageBucket = (ageMs: number): AgeBucket =>
  ageMs < DAY_MS ? '<1d' : ageMs < 7 * DAY_MS ? '1-7d' : ageMs < 30 * DAY_MS ? '7-30d' : '>30d';
const BUCKETS: readonly AgeBucket[] = ['<1d', '1-7d', '7-30d', '>30d'];
export const olderBucket = (a: AgeBucket | undefined, b: AgeBucket) =>
  a === undefined || BUCKETS.indexOf(b) > BUCKETS.indexOf(a) ? b : a;

/** Words an SQLite / JavaScript message uses that are 8+ letters long but carry no value. */
const VOCABULARY = new Set([
  'constraint',
  'violation',
  'immutable',
  'readonly',
  'database',
  'integrity',
  'datatype',
  'mismatch',
  'argument',
  'function',
  'property',
  'undefined',
  'transaction',
  'statement',
  'exceeded',
  'overflow',
  'required',
  'abort',
]);
const SNAKE = /^[a-z]+(?:_[a-z]+)+$/;
const UPPER_SNAKE = /^[A-Z]+(?:_[A-Z]+)+$/;
const MESSAGE_LIMIT = 160;

/**
 * The error message with every value replaced by a placeholder: quoted strings (<q>), e-mail-like text (<email>), tokens
 * of 8+ [A-Za-z0-9_-] that are not plain vocabulary or a snake_case identifier (<tok>), numbers (<n>) and any non-ASCII
 * text (<u>), then cut to 160 characters. `schemaNames` (the database's own table names) are kept as they are. "FOREIGN KEY constraint failed" and "no such table: web_points_events" survive.
 */
export function messageShape(message: unknown, schemaNames: ReadonlySet<string> = new Set()): string {
  let text = typeof message === 'string' ? message : '';
  text = text
    .replace(/"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/gu, '<q>')
    .replace(/[^\s<>"'@]+@[^\s<>"'@]+/gu, '<email>')
    .replace(/[A-Za-z0-9_-]{8,}/g, (token) =>
      schemaNames.has(token) ||
      (SNAKE.test(token) && token.length <= 48) ||
      UPPER_SNAKE.test(token) ||
      VOCABULARY.has(token.toLowerCase())
        ? token
        : '<tok>',
    )
    .replace(/\d+(?:\.\d+)*/g, '<n>')
    .replace(/[^\x20-\x7e]+/g, '<u>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

/** The error's constructor name (TypeError, Error, SqliteError, ...), or a fixed word for a thrown non-error. */
export function errorName(error: unknown): string {
  if (error === null || error === undefined) return 'Nothing';
  const name =
    typeof error === 'object' ? (error as { constructor?: { name?: unknown } }).constructor?.name : undefined;
  if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)) return name;
  return typeof error === 'object' ? 'Object' : typeof error;
}

/** The first stack frame inside our code as `file-basename:line`; nothing else of the path or the stack. */
export function firstFrame(error: unknown): string | undefined {
  const stack = error instanceof Error ? error.stack : undefined;
  if (typeof stack !== 'string') return undefined;
  for (const line of stack.split('\n').slice(1)) {
    // The helpers that build an error (errors.ts: DomainError, ensure) are not where it came from.
    if (/node_modules|node:|cloudflare:|workerd|internal\/|[/\\]errors\.(ts|js)/.test(line)) continue;
    const match = /([^/\\\s()]+\.(?:ts|mts|js|mjs|cjs)):(\d+)(?::\d+)?\)?\s*$/.exec(line);
    if (match) return `${match[1]}:${match[2]}`;
  }
  return undefined;
}

/** Per-principal retry delay after the n-th failure in a row: 1 min, 5 min, 30 min, then every 6 h. */
export const BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000];
export const BACKOFF_CAP_MS = 6 * 60 * 60_000;
export const backoffDelay = (failures: number) => (failures <= 0 ? 0 : (BACKOFF_MS[failures - 1] ?? BACKOFF_CAP_MS));
