import type { LocalScope } from '../session/local-session.ts';

export type PendingState = 'stored' | 'network_uncertain' | 'accepted';
export type PendingOperation = { scope: LocalScope; characterId: string; requestId: string;
  text: string; delivery: 'voice'; state: PendingState; operationId: string | null };
export interface PendingStore {
  put(item: PendingOperation): Promise<void>;
  get(scope: LocalScope, requestId: string): Promise<PendingOperation | null>;
  list(scope: LocalScope): Promise<PendingOperation[]>;
  purgeScope?(scope: LocalScope): Promise<void>;
}

export function scopeKey(scope: LocalScope) {
  // Durable partition is identity, not this page's volatile stale-callback generation.
  return [scope.instanceId, scope.recoveryEpoch, scope.principalId, scope.worldId].join('\u001f');
}

/** IDB transaction completion, not request success, is the durability boundary before POST. */
export class IndexedDbPendingStore implements PendingStore {
  private database: Promise<IDBDatabase> | null = null;
  private readonly indexed: IDBFactory;
  private readonly now: () => number;
  constructor(indexed: IDBFactory = indexedDB, now: () => number = Date.now) {
    this.indexed = indexed; this.now = now;
  }
  private expired(scope: LocalScope) {
    return scope.contractVersion === 'web-v1-local-2' && scope.accessKind === 'guest' &&
      (scope.retentionState === 'expired' || scope.guestExpiresAt !== null &&
        scope.guestExpiresAt !== undefined && this.now() >= scope.guestExpiresAt);
  }
  private open(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise((resolve, reject) => {
      const request = this.indexed.open('fake-bubble-web-local-pending', 2);
      request.onupgradeneeded = event => {
        const oldVersion = event?.oldVersion ?? 0;
        const store = oldVersion === 0 ? request.result.createObjectStore('operations') :
          request.transaction!.objectStore('operations');
        if (oldVersion === 1) {
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            const item = row.value as PendingOperation;
            if (valid(item) && typeof row.key === 'string') {
              const key = this.key(item.scope, item.requestId);
              if (key !== row.key) { store.put(item, key); row.delete(); }
            }
            row.continue();
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.database;
  }
  private key(scope: LocalScope, requestId: string) { return `${scopeKey(scope)}\u001f${requestId}`; }
  async put(item: PendingOperation): Promise<void> {
    if (this.expired(item.scope)) throw new Error('TRIAL_EXPIRED');
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite');
      tx.objectStore('operations').put(item, this.key(item.scope, item.requestId));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('pending transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('pending transaction failed'));
    });
  }
  async get(scope: LocalScope, requestId: string): Promise<PendingOperation | null> {
    if (this.expired(scope)) { await this.purgeScope(scope); return null; }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readonly');
      const request = tx.objectStore('operations').get(this.key(scope, requestId));
      request.onsuccess = () => {
        const item: unknown = request.result;
        resolve(valid(item) && scopeKey(item.scope) === scopeKey(scope) && item.requestId === requestId ? item : null);
      };
      request.onerror = () => reject(request.error);
    });
  }
  async list(scope: LocalScope): Promise<PendingOperation[]> {
    if (this.expired(scope)) { await this.purgeScope(scope); return []; }
    const db = await this.open(), prefix = `${scopeKey(scope)}\u001f`;
    return new Promise((resolve, reject) => {
      const items: PendingOperation[] = [];
      const tx = db.transaction('operations', 'readonly');
      const cursor = tx.objectStore('operations').openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        const item: unknown = row.value;
        if (valid(item) && item.state !== 'accepted' && scopeKey(item.scope) === scopeKey(scope)) items.push(item);
        if (items.length < 100) row.continue();
      };
      tx.oncomplete = () => resolve(items);
      tx.onabort = () => reject(tx.error ?? new Error('pending read aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('pending read failed'));
    });
  }
  async purgeScope(scope: LocalScope): Promise<void> {
    const db = await this.open(), prefix = `${scopeKey(scope)}\u001f`;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite');
      const cursor = tx.objectStore('operations').openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('pending purge aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('pending purge failed'));
    });
  }
}

function valid(value: unknown): value is PendingOperation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PendingOperation>;
  const scope = item.scope as Partial<LocalScope> | undefined;
  return !!scope && [scope.instanceId, scope.recoveryEpoch, scope.principalId, scope.worldId,
    item.characterId, item.requestId, item.text].every(value => typeof value === 'string') &&
    typeof scope.generation === 'number' && item.delivery === 'voice' &&
    ['stored', 'network_uncertain', 'accepted'].includes(String(item.state)) &&
    (item.operationId === null || typeof item.operationId === 'string');
}
