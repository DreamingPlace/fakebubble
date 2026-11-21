import type { HumanCheck } from './provider-api.ts';

/**
 * The page side of Cloudflare Turnstile (only used when GET /account names a site key). The widget is rendered on demand
 * in "interaction-only" mode: in the normal case it solves itself in the background and the player sees nothing; only if
 * Cloudflare wants a click does a small box appear, centred in the window (desktop and phone). One widget per token, removed right after.
 * Nothing is stored; a failure becomes a rejected promise and the caller shows its short retry line.
 *
 * Part 48: the check runs in the BACKGROUND, right after the first paint, and its box lives in the verification sheet (`host`), which
 * only opens when the player does something that needs a session. Time limits: the script 10 s, the challenge 15 s (from the moment it
 * starts, and again from the moment it asks for a click), then a rejected promise and a retry button. A failure is never silent.
 */
const TURNSTILE_SCRIPT_MS = 10_000;
const TURNSTILE_SOLVE_MS = 15_000;
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export type TurnstilePhase = 'loading' | 'solving' | 'interactive';
type TurnstileApi = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;
function load(doc: Document, timeoutMs: number): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement('script');
    const timer = setTimeout(() => {
      loading = null;
      script.remove();
      reject(new Error('TURNSTILE_LOAD_TIMEOUT'));
    }, timeoutMs);
    script.src = SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      clearTimeout(timer);
      if (window.turnstile) resolve(window.turnstile);
      else {
        loading = null;
        reject(new Error('TURNSTILE_LOAD_FAILED'));
      }
    };
    script.onerror = () => {
      clearTimeout(timer);
      loading = null;
      script.remove();
      reject(new Error('TURNSTILE_LOAD_FAILED'));
    };
    doc.head.append(script);
  });
  return loading;
}

export function turnstileCheck(
  options: {
    doc?: Document;
    loadMs?: number;
    solveMs?: number;
    /** Part 48: where the widget's box goes (the verification sheet). Without it the box is the old window-centred one. */
    host?: HTMLElement;
    /** Part 48: what the check is doing, for the sheet's one line. */
    onPhase?: (phase: TurnstilePhase) => void;
  } = {},
): HumanCheck {
  const doc = options.doc ?? document;
  return async (siteKey, action) => {
    options.onPhase?.('loading');
    const api = await load(doc, options.loadMs ?? TURNSTILE_SCRIPT_MS);
    const box = doc.createElement('div');
    box.className = options.host ? 'vs-widget-box' : 'human-check';
    box.setAttribute('aria-live', 'polite');
    (options.host ?? doc.body).append(box);
    let widget: string | null = null;
    try {
      return await new Promise<string>((resolve, reject) => {
        const solveMs = options.solveMs ?? TURNSTILE_SOLVE_MS;
        let timer = setTimeout(() => reject(new Error('TURNSTILE_SOLVE_TIMEOUT')), solveMs);
        const fail = (code: string) => () => {
          clearTimeout(timer);
          reject(new Error(code));
        };
        options.onPhase?.('solving');
        widget = api.render(box, {
          sitekey: siteKey,
          action,
          appearance: 'interaction-only',
          retry: 'never',
          callback: (token: string) => {
            clearTimeout(timer);
            resolve(token);
          },
          // The widget now wants a click: the player gets the full time again from the moment it is shown.
          'before-interactive-callback': () => {
            clearTimeout(timer);
            timer = setTimeout(() => reject(new Error('TURNSTILE_SOLVE_TIMEOUT')), solveMs);
            options.onPhase?.('interactive');
          },
          'error-callback': fail('TURNSTILE_ERROR'),
          'expired-callback': fail('TURNSTILE_EXPIRED'),
          'timeout-callback': fail('TURNSTILE_TIMEOUT'),
        });
      });
    } finally {
      if (widget !== null) {
        try {
          api.remove(widget);
        } catch {
          /* already gone */
        }
      }
      box.remove();
    }
  };
}
