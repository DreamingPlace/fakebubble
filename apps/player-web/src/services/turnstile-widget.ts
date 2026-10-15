import type { HumanCheck } from './provider-api.ts';

/**
 * The page side of Cloudflare Turnstile (only used when GET /account names a site key). The widget is rendered on demand
 * in "interaction-only" mode: in the normal case it solves itself in the background and the player sees nothing; only if
 * Cloudflare wants a click does a small box appear, centred in the window (desktop and phone). One widget per token, removed right after.
 * Nothing is stored; a failure becomes a rejected promise and the caller shows its short retry line.
 */
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
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

export function turnstileCheck(options: { doc?: Document; loadMs?: number; solveMs?: number } = {}): HumanCheck {
  const doc = options.doc ?? document;
  return async (siteKey, action) => {
    const api = await load(doc, options.loadMs ?? 10_000);
    const box = doc.createElement('div');
    box.className = 'human-check';
    box.setAttribute('aria-live', 'polite');
    doc.body.append(box);
    let widget: string | null = null;
    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TURNSTILE_SOLVE_TIMEOUT')), options.solveMs ?? 45_000);
        const fail = (code: string) => () => {
          clearTimeout(timer);
          reject(new Error(code));
        };
        widget = api.render(box, {
          sitekey: siteKey,
          action,
          appearance: 'interaction-only',
          retry: 'never',
          callback: (token: string) => {
            clearTimeout(timer);
            resolve(token);
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
