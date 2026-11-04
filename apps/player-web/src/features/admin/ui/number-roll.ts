/**
 * Part 24b-6 motion token "数字变化": a number rolls to its new value in 300 ms (the first paint just sets it). With
 * prefers-reduced-motion, or without animation frames, it simply changes.
 */
const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches === true;

export function rollNumber(node: HTMLElement, to: number, format: (value: number) => string, ms = 300) {
  const from = Number(node.dataset.rolled);
  node.dataset.rolled = String(to);
  const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number }).requestAnimationFrame;
  if (!Number.isFinite(from) || from === to || !raf || reduced()) {
    node.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    if (node.dataset.rolled !== String(to)) return;
    node.textContent = format(t >= 1 ? to : from + (to - from) * eased);
    if (t < 1) raf(step);
  };
  raf(step);
}
