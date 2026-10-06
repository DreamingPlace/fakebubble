import type { WebLocalOperation } from '../../../../packages/contracts/web-local.ts';
import { LocalApi, LocalApiError } from '../services/local-api.ts';
import { LocalSession, type LocalScope } from '../session/local-session.ts';
import { scopeKey, type PendingOperation, type PendingStore } from './pending-operations.ts';

export type SendResult =
  | { kind: 'accepted'; operation: WebLocalOperation }
  | { kind: 'network_uncertain'; requestId: string }
  | { kind: 'stale_generation' };

export class LocalSendController {
  private readonly inflight = new Map<string, Promise<SendResult>>();
  lastPurgeError: unknown = null;
  private readonly api: LocalApi;
  private readonly session: LocalSession;
  private readonly store: PendingStore;
  private readonly id: () => string;
  constructor(api: LocalApi, session: LocalSession, store: PendingStore, id: () => string = () => crypto.randomUUID()) {
    this.api = api;
    this.session = session;
    this.store = store;
    this.id = id;
    session.onContentExpired((scope) => {
      void store.purgeScope?.(scope).catch((error) => {
        this.lastPurgeError = error;
      });
    });
  }
  /** A simultaneous second click shares one intent. After settlement a new explicit send gets a new ID. */
  send(characterId: string, text: string): Promise<SendResult> {
    const scope = this.session.scope;
    if (!scope) return Promise.reject(new Error('no authenticated local session'));
    if (!this.session.contentAvailable(scope)) {
      this.session.denyContent();
      return Promise.reject(new LocalApiError(410, 'TRIAL_EXPIRED'));
    }
    const key = `${scopeKey(scope)}\u001f${scope.generation}\u001f${characterId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending: PendingOperation = {
      scope,
      characterId,
      requestId: this.id(),
      text,
      delivery: 'voice',
      state: 'stored',
      operationId: null,
    };
    const result = this.execute(pending);
    this.inflight.set(key, result);
    void result
      .finally(() => {
        if (this.inflight.get(key) === result) this.inflight.delete(key);
      })
      .catch(() => {});
    return result;
  }
  private async execute(item: PendingOperation): Promise<SendResult> {
    if (!this.session.isCurrent(item.scope)) return { kind: 'stale_generation' };
    if (!this.session.contentAvailable(item.scope)) {
      this.session.denyContent();
      throw new LocalApiError(410, 'TRIAL_EXPIRED');
    }
    await this.store.put(item); // A failed commit MUST prevent network dispatch.
    if (!this.session.contentAvailable(item.scope)) return { kind: 'stale_generation' };
    let operation: WebLocalOperation;
    try {
      operation = await this.api.send(
        item.characterId,
        item.requestId,
        item.text,
        this.session.signal,
        this.session.currentInviteView?.bootstrap.csrf,
      );
    } catch (error) {
      if (!this.session.isCurrent(item.scope)) return { kind: 'stale_generation' };
      if (error instanceof LocalApiError && error.code === 'TRIAL_EXPIRED') this.session.denyContent();
      if (error instanceof LocalApiError && error.status < 500) throw error;
      // A server failure after admission may still have lost its success receipt.
      item.state = 'network_uncertain';
      await this.store.put(item);
      return this.lookup(item);
    }
    return this.accept(item, operation);
  }
  async lookup(item: PendingOperation): Promise<SendResult> {
    if (!this.session.isCurrent(item.scope)) return { kind: 'stale_generation' };
    if (!this.session.contentAvailable(item.scope)) {
      this.session.denyContent();
      throw new LocalApiError(410, 'TRIAL_EXPIRED');
    }
    let operation: WebLocalOperation;
    try {
      operation = await this.api.byRequest(item.requestId, this.session.signal);
    } catch (error) {
      if (!this.session.isCurrent(item.scope)) return { kind: 'stale_generation' };
      if (error instanceof LocalApiError && error.code === 'TRIAL_EXPIRED') this.session.denyContent();
      if (error instanceof LocalApiError && error.status !== 404) throw error;
      item.state = 'network_uncertain';
      await this.store.put(item);
      if (!this.session.isCurrent(item.scope)) return { kind: 'stale_generation' };
      return { kind: 'network_uncertain', requestId: item.requestId }; // 404 is not non-admission proof.
    }
    return this.accept(item, operation);
  }
  /** After trusted bootstrap, discover durable intents in only this identity partition; query, never resend. */
  async recoverPending(): Promise<SendResult[]> {
    const scope = this.session.scope;
    if (!scope) throw new Error('no authenticated local session');
    if (!this.session.contentAvailable(scope)) {
      this.session.denyContent();
      return [];
    }
    const saved = await this.store.list(scope);
    if (!this.session.isCurrent(scope)) return [{ kind: 'stale_generation' }];
    const view = this.session.currentInviteView ?? this.session.currentView;
    if (!view) return [{ kind: 'stale_generation' }];
    const characters = new Set(view.bootstrap.characters.map((row) => row.characterId));
    const results: SendResult[] = [];
    for (const item of saved) {
      if (!this.session.isCurrent(scope)) return [{ kind: 'stale_generation' }];
      if (scopeKey(item.scope) !== scopeKey(scope) || !characters.has(item.characterId)) continue;
      results.push(await this.lookup({ ...item, scope }));
      if (!this.session.isCurrent(scope)) return [{ kind: 'stale_generation' }];
    }
    if (!this.session.isCurrent(scope)) return [{ kind: 'stale_generation' }];
    return results;
  }
  /** Explicit user retry only; never invoked by lookup, reconnect or timer. */
  retrySame(item: PendingOperation): Promise<SendResult> {
    const active = this.session.scope;
    if (!active || scopeKey(active) !== scopeKey(item.scope)) return Promise.resolve({ kind: 'stale_generation' });
    if (!this.session.contentAvailable(active)) {
      this.session.denyContent();
      return Promise.reject(new LocalApiError(410, 'TRIAL_EXPIRED'));
    }
    return this.store.get(active, item.requestId).then((saved) => {
      if (!this.session.isCurrent(active)) return { kind: 'stale_generation' } as SendResult;
      if (
        !saved ||
        scopeKey(saved.scope) !== scopeKey(active) ||
        saved.text !== item.text ||
        saved.characterId !== item.characterId ||
        saved.delivery !== 'voice' ||
        !(this.session.currentInviteView ?? this.session.currentView)?.bootstrap.characters.some(
          (row) => row.characterId === saved.characterId,
        )
      )
        throw new Error('pending intent mismatch');
      const current = { ...saved, scope: active };
      if (saved.state === 'accepted') return this.lookup(current);
      return this.execute(current);
    });
  }
  private async accept(item: PendingOperation, operation: WebLocalOperation): Promise<SendResult> {
    if (!this.session.isCurrent(item.scope)) return { kind: 'stale_generation' };
    if (operation.requestId !== item.requestId) throw new Error('requestId mismatch');
    item.state = 'accepted';
    item.operationId = operation.operationId;
    await this.store.put(item);
    if (!this.session.isCurrent(item.scope)) return { kind: 'stale_generation' };
    return { kind: 'accepted', operation };
  }
}
