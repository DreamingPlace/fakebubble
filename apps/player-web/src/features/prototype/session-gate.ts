import { ProviderApi, ProviderApiError } from '../../services/provider-api.ts';
import type { TurnstilePhase } from '../../services/turnstile-widget.ts';
import { isSignedOutError } from './provider-start-error.ts';
import { LiveBinding } from './provider-binding.ts';

/**
 * Part 48: the session, in the background.
 *
 * The home cards no longer wait for the session: they are drawn from the public catalog, and this gate makes the session (bootstrap,
 * with Turnstile when the server asks for it) right after the first paint. Everything that needs a session (open a chat, send, voice,
 * a co-creation submit, share) calls `require()` first and waits here. The security policy is unchanged: a new guest is made only by a
 * bootstrap that carries a passed challenge when the server demands one, nothing is sent before a session exists, and a failure is
 * shown (the verification sheet) with a retry, never swallowed.
 *
 *   idle -> connecting -> ready
 *                 \-> interactive (the widget wants a click) -> ready
 *                 \-> failed (retry) -> connecting ...
 */
export type GateState = 'idle' | 'connecting' | 'interactive' | 'failed' | 'ready';
/** Hard failures (an expired guest, a signed-out player, a refused session) replace the page as they always did. */
export const isRetryable = (error: unknown) =>
  !isSignedOutError(error) &&
  (error instanceof ProviderApiError
    ? error.code.startsWith('TURNSTILE_') ||
      error.status === 0 ||
      error.status >= 500 ||
      error.status === 429 ||
      error.code === 'RATE_LIMITED'
    : true);

export class SessionGate {
  private current: GateState = 'idle';
  private failure: unknown = null;
  private binding: LiveBinding | null = null;
  private attempt: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private waiting: { resolve: (binding: LiveBinding) => void; reject: (error: unknown) => void }[] = [];
  private readonly api: ProviderApi;
  private readonly connect: (api: ProviderApi) => Promise<LiveBinding>;
  /** Called with a failure that is not a retry case (signed out, expired guest): the page shows its own page for it. */
  private hard: ((error: unknown) => void) | null = null;
  constructor(api: ProviderApi, connect: (api: ProviderApi) => Promise<LiveBinding> = (a) => LiveBinding.connect(a)) {
    this.api = api;
    this.connect = connect;
  }
  get state() {
    return this.current;
  }
  get error() {
    return this.failure;
  }
  get live() {
    return this.binding;
  }
  /** The Turnstile widget reports its phase: a click is wanted. */
  phase(phase: TurnstilePhase) {
    if (this.current === 'connecting' && phase === 'interactive') this.set('interactive');
    else if (this.current === 'interactive' && phase !== 'interactive') this.set('connecting');
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onHardFailure(handler: (error: unknown) => void) {
    this.hard = handler;
  }
  private set(state: GateState) {
    if (this.current === state) return;
    this.current = state;
    for (const listener of [...this.listeners]) listener();
  }
  /** Starts (or restarts after a failure) the one background attempt. Idempotent while one is running or the session is ready. */
  start() {
    if (this.attempt || this.current === 'ready') return;
    this.failure = null;
    this.set('connecting');
    this.attempt = this.connect(this.api)
      .then((binding) => {
        this.binding = binding;
        this.attempt = null;
        this.set('ready');
        const waiting = this.waiting;
        this.waiting = [];
        for (const entry of waiting) entry.resolve(binding);
      })
      .catch((error: unknown) => {
        this.attempt = null;
        this.failure = error;
        if (isRetryable(error)) this.set('failed');
        else {
          this.set('failed');
          this.hard?.(error);
        }
      });
  }
  retry() {
    if (this.current === 'failed') this.start();
  }
  /** Resolves with the session once there is one. Pending actions continue by themselves when it arrives; `cancel()` drops them. */
  require(): Promise<LiveBinding> {
    if (this.binding) return Promise.resolve(this.binding);
    // A failed attempt is retried only by the player (the sheet's 重试), never silently by another tap.
    if (this.current === 'idle') this.start();
    return new Promise<LiveBinding>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  /** Drops every action that is waiting for the session (the player closed the verification sheet). */
  cancel() {
    const waiting = this.waiting;
    this.waiting = [];
    for (const entry of waiting) entry.reject(new Error('SESSION_WAIT_CANCELLED'));
  }
  get pending() {
    return this.waiting.length;
  }
}
