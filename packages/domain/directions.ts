export interface DialogueParts {
  spokenText: string;
  directionHints: string[];
}
/** Balanced full/half-width parentheses are stage cues. Incomplete parentheses stay visible as text. */
export function dialogueParts(text: string): DialogueParts {
  const hints: string[] = [];
  let spoken = '',
    start = -1,
    depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(' || c === '（') {
      if (depth++ === 0) start = i;
    } else if ((c === ')' || c === '）') && depth > 0) {
      if (--depth === 0) {
        const hint = text.slice(start + 1, i).trim();
        if (hint) hints.push(hint);
        start = -1;
      }
    } else if (depth === 0) spoken += c;
  }
  if (start >= 0) spoken += text.slice(start);
  return { spokenText: spoken.trim(), directionHints: hints };
}
