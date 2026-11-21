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
  /** The one place the bootstrap may start from: right after the first paint (or after the grace below if the catalog is slow). */
  afterPaint?: (run: () => void) => void;
  /** How long the first paint may hold the background session back (a slow catalog must not delay the session as well). */
  graceMs?: number;
  /** The page for a failure that is not a retry case (a signed-out player, an expired guest, a refused session). */
  fail?: (error: unknown) => void;
}

/**
 * The player page's start: the cards first, the session behind them. Returns nothing; everything it does is visible on the page.
 *   1. the public catalog is read (no session, no cookie) and the real cards are drawn from it;
 *   2. right after that the session starts in the background (bootstrap, Turnstile when asked);
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
  let started = false;
  const begin = () => {
    if (started) return;
    started = true;
    (boot.afterPaint ?? ((run) => requestAnimationFrame(() => setTimeout(run, 0))))(() => gate.start());
  };
  // A slow catalog must not hold the session back as well.
  const grace = setTimeout(begin, boot.graceMs ?? 800);
  boot.api.publicCatalog().then(
    (catalog) => {
      clearTimeout(grace);
      if (!arrived) shell = startFirstPaint(root, publicPeople(catalog), deferred);
      begin();
    },
    () => {
      clearTimeout(grace);
      begin();
      // No cards to show: the sheet (widget, one line, retry) is the way forward, at once.
      if (!arrived) void sheet.request().catch(() => {});
    },
  );
}
