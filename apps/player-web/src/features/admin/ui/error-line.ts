import { h } from '../../cocreation/h.ts';
import { ERROR_SENTENCES } from '../error-sentences.ts';
import { hoverValue } from './hover-value.ts';

/**
 * Part 24b-7d: an error code is never part of the visible text. The admin reads the sentence from features/admin/error-sentences.ts;
 * the code is on hover and behind a small 复制代码 action, so it can still be passed to a developer.
 */
export const UNNAMED_FAILURE = '失败，没有更多信息。';
/** The sentence for a code (or the given fallback when the code has none). Never the code itself. */
export const sentenceOf = (code: string | null | undefined, fallback = UNNAMED_FAILURE): string =>
  (code ? ERROR_SENTENCES[code] : undefined) ?? fallback;

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
/** The small 复制代码 action: copies the code, says 已复制 for a moment. */
export function copyCodeButton(code: string): HTMLButtonElement {
  const button = h('button', {
    class: 'admin-copy-code',
    text: '复制代码',
    attrs: { type: 'button', 'aria-label': '复制错误代码（交给开发时使用）', 'data-code': code },
  });
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const ok = await copyText(code);
    button.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => {
      button.textContent = '复制代码';
    }, 1500);
  });
  return button;
}
/**
 * The sentence for a code, the code on hover, and 复制代码 beside it. `sentence` may override the text (a fixed sentence for a
 * code this console words differently, e.g. a table cell); the code is still the one on hover and in the copy action.
 */
export function errorLine(
  code: string | null | undefined,
  options: { class?: string; sentence?: string } = {},
): HTMLElement {
  const text = options.sentence ?? sentenceOf(code);
  const line = h('span', { class: `admin-error-line${options.class ? ` ${options.class}` : ''}` });
  const words = h('span', { class: 'admin-error-text', text });
  line.append(words);
  if (code) {
    hoverValue(words, `代码：${code}`);
    line.append(' ', copyCodeButton(code));
  }
  return line;
}
