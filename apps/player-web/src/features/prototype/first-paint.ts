import type { ProviderApi } from '../../services/provider-api.ts';
import { DeferredLive, publicPeople } from './deferred-live.ts';
import { renderProviderStartError } from './provider-start-error.js';
import { startFirstPaint, startPrototype, type ShellHandle } from './preview.js';
import type { SessionGate } from './session-gate.ts';
import type { VerifySheet } from './verify-sheet.ts';

export interface PlayerBoot {
  root: HTMLElement;
  api: ProviderApi;
  gate: SessionGate;
  sheet: VerifySheet;
  /** The page for a failure that is not a retry case (a signed-out player, an expired guest, a refused session). */
  fail?: (error: unknown) => void;
}

/**
 * The player page's start: the cards first, the session behind them. Returns nothing; everything it does is visible on the page.
 *   1. the public catalog is read (no session, no cookie) and the real cards are drawn from it;
 *   2. at the same moment (Part 50: not after it) the session starts in the background (bootstrap, Turnstile when asked);
 *   3. the session arrives: its data swaps into the cards that are already there, and any action the player tapped continues by itself.
 * If the session arrives first, the page is simply drawn from it. If the catalog cannot be read, the skeleton stays and the
 * verification sheet shows at once (with its retry), so the page is never left blank without a way forward.
 */
export function bootPlayer(boot: PlayerBoot) {
  const { root, gate, sheet } = boot;
  const deferred = new DeferredLive(sheet);
  let shell: ShellHandle | null = null;
  let arrived = false;
  const arrive = () => {
    const binding = gate.live;
    if (arrived || gate.state !== 'ready' || !binding) return;
    arrived = true;
    if (shell) {
      deferred.bind(binding);
      shell.adopt(binding);
    } else startPrototype(root, binding);
  };
  gate.onChange(arrive);
  gate.onHardFailure(boot.fail ?? ((error) => renderProviderStartError(root, error, undefined, boot.api)));
  // Part 50: the session starts NOW, in parallel with the catalog read (not after it): the first tap no longer waits for a check
  // that could have been running while the cards were loading. The catalog is requested first (so it is first in the queue) and its
  // answer hands over the public Turnstile site key, which spares the check a separate /account read.
  const catalogRead = boot.api.publicCatalog();
  gate.start();
  catalogRead.then(
    async (catalog) => {
      if (catalog.turnstileSiteKey) {
        // The invisible challenge starts BEFORE the cards' own drawing work, which on a slow phone holds the main thread for hundreds
        // of milliseconds (it waits for the widget to be rendered, at most a moment: Cloudflare's script is preloaded).
        await Promise.race([
          boot.api.primeHuman(catalog.turnstileSiteKey),
          new Promise<void>((resolve) => setTimeout(resolve, 120)),
        ]);
      }
      if (!arrived) shell = startFirstPaint(root, publicPeople(catalog), deferred);
    },
    () => {
      // No cards to show: the sheet (widget, one line, retry) is the way forward, at once.
      if (!arrived) void sheet.request().catch(() => {});
    },
  );
}
