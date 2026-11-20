/**
 * Part 48: the player pages load only the styles the player pages use.
 *
 * `apps/player-web/src/styles/main.css` stays the one source of truth (many component tests read it as one file). The build derives two
 * stylesheets from it:
 *   - player CSS: every rule whose selectors can match something the player side of the source (everything except the administrator
 *     console and its API clients, the page shell and the legal pages) mentions. A rule with no class or id in it (:root, body, *,
 *     keyframes, ...) is always kept. Order is untouched.
 *   - admin CSS: the WHOLE source, in its original order. Only the administrator mode loads it (the page names it in a <meta>), so the
 *     console's cascade is exactly what it was.
 *
 * A class counts as "used by the player" when its name (or, for a class built at run time like `bl-row--${state}`, the part of the name
 * up to the last `-` / `_`, followed by a run-time part) appears in a player source file. The browser scripts of every player page are the safety net for this rule.
 */
type Chunk = { prelude: string; text: string; block?: string; statement?: boolean };

/** Splits CSS into its top-level chunks (a rule, an at-rule with a block, or a statement such as @import). Comments stay attached. */
function chunks(css: string): Chunk[] {
  const out: Chunk[] = [];
  const n = css.length;
  let i = 0;
  const skipString = (at: number, quote: string) => {
    let k = at + 1;
    while (k < n && css[k] !== quote) k += css[k] === '\\' ? 2 : 1;
    return k + 1;
  };
  const skipComment = (at: number) => {
    const end = css.indexOf('*/', at + 2);
    return end < 0 ? n : end + 2;
  };
  while (i < n) {
    const start = i;
    let j = i;
    while (j < n) {
      const c = css[j]!;
      if (c === '"' || c === "'") j = skipString(j, c);
      else if (c === '/' && css[j + 1] === '*') j = skipComment(j);
      else if (c === '{' || c === ';') break;
      else j++;
    }
    if (j >= n) {
      out.push({ prelude: css.slice(start), text: css.slice(start) });
      break;
    }
    if (css[j] === ';') {
      out.push({ prelude: css.slice(start, j), text: css.slice(start, j + 1), statement: true });
      i = j + 1;
      continue;
    }
    let depth = 1;
    let k = j + 1;
    while (k < n && depth > 0) {
      const c = css[k]!;
      if (c === '"' || c === "'") k = skipString(k, c);
      else if (c === '/' && css[k + 1] === '*') k = skipComment(k);
      else {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        k++;
      }
    }
    out.push({ prelude: css.slice(start, j), text: css.slice(start, k), block: css.slice(j + 1, k - 1) });
    i = k;
  }
  return out;
}

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level comma split (commas inside parentheses or brackets belong to the selector). */
function selectors(prelude: string) {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i]!;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(prelude.slice(last, i));
      last = i + 1;
    }
  }
  out.push(prelude.slice(last));
  return out;
}

const tokenPattern = /[.#](-?[A-Za-z_][A-Za-z0-9_-]*)/g;
/** The class and id names a selector mentions (attribute values and pseudo-class arguments' names count too: they are class names). */
function tokens(selector: string) {
  const bare = selector.replace(/"[^"]*"|'[^']*'/g, '').replace(/\[[^\]]*\]/g, '');
  return [...bare.matchAll(tokenPattern)].map((match) => match[1]!);
}

/** Whether a rule with these selectors can match something the player side uses. */
export function playerSelector(selector: string, used: (name: string) => boolean) {
  const names = tokens(selector);
  return names.every(used);
}

export function playerUsage(sources: string) {
  const memo = new Map<string, boolean>();
  return (name: string) => {
    let known = memo.get(name);
    if (known === undefined) {
      // A class built at run time (`bl-row--${state}`, `'cc-dot-' + kind`) is named in the source only up to its dynamic end.
      const stem = name.replace(/[-_][^-_]*$/, '');
      known =
        sources.includes(name) ||
        (stem.length >= 4 &&
          stem !== name &&
          [`${stem}-\${`, `${stem}--\${`, `${stem}_\${`, `${stem}-' +`, `${stem}-" +`].some((tail) =>
            sources.includes(tail),
          ));
      memo.set(name, known);
    }
    return known;
  };
}

function filterRules(css: string, used: (name: string) => boolean): string {
  const kept: string[] = [];
  for (const chunk of chunks(css)) {
    const prelude = stripComments(chunk.prelude).trim();
    if (chunk.statement || chunk.block === undefined) {
      kept.push(chunk.text);
    } else if (/^@(?:media|supports|container|layer|scope)\b/.test(prelude)) {
      const inner = filterRules(chunk.block, used);
      if (inner.trim()) kept.push(`${chunk.prelude}{${inner}}`);
    } else if (prelude.startsWith('@')) {
      // @keyframes / @font-face / @property: decided afterwards, from what the kept rules mention.
      kept.push(chunk.text);
    } else if (selectors(prelude).some((selector) => playerSelector(selector, used))) {
      kept.push(chunk.text);
    }
  }
  return kept.join('');
}

/** Drops keyframes no kept rule names (a rule mentions its animation by name, so a plain substring test is enough). */
function dropUnusedKeyframes(css: string): string {
  const parts = chunks(css);
  const named = (chunk: Chunk) =>
    /^@(?:-webkit-)?keyframes\s+([A-Za-z0-9_-]+)/.exec(stripComments(chunk.prelude).trim())?.[1];
  const rest = parts
    .filter((chunk) => !named(chunk))
    .map((chunk) => chunk.text)
    .join('');
  return parts
    .filter((chunk) => {
      const name = named(chunk);
      return !name || rest.includes(name);
    })
    .map((chunk) => chunk.text)
    .join('');
}

/** The player stylesheet derived from the whole source; `sources` is the text of every file on the player side. */
export function playerCss(css: string, sources: string): string {
  return dropUnusedKeyframes(filterRules(css, playerUsage(sources)));
}
