import type { WebLocalMessage } from '../../../../packages/contracts/web-local.ts';
import { parseMessage } from '../../../../packages/contracts/web-local-client.ts';
import type { LocalScope } from '../session/local-session.ts';
import { LocalSession } from '../session/local-session.ts';
import { scopeKey } from './pending-operations.ts';

export function draftKey(scope: LocalScope, characterId: string) {
  return `draft\u001f${scopeKey(scope)}\u001f${characterId}`;
}
export function messageKey(scope: LocalScope, message: WebLocalMessage) {
  return `message\u001f${scopeKey(scope)}\u001f${message.conversationId}\u001f${message.messageId}`;
}

/** Best-effort local display cache; server remains authority for history and permissions. */
export class IndexedDbLocalCache {
  private database: Promise<IDBDatabase> | null = null;
  private readonly indexed: IDBFactory;
  private readonly session: LocalSession | undefined;
  lastPurgeError: unknown = null;
  constructor(indexed: IDBFactory = indexedDB, session?: LocalSession) {
    this.indexed = indexed;
    this.session = session;
    const purgePrivate = (scope: LocalScope) => {
      if (
        (scope.contractVersion === 'web-v1-local-2' && scope.accessKind === 'guest') ||
        (scope.contractVersion === 'web-v1-local-3' && scope.accessKind === 'invite')
      )
        void this.purgeScope(scope).catch((error) => {
          this.lastPurgeError = error;
        });
    };
    session?.onInstall((scope) => {
      if (scope.accessKind === 'guest') purgePrivate(scope);
    });
    session?.onContentExpired(purgePrivate);
  }
  private unavailable(scope: LocalScope) {
    return (
      (scope.contractVersion === 'web-v1-local-2' && scope.accessKind === 'guest') ||
      (scope.contractVersion === 'web-v1-local-3' &&
        scope.accessKind === 'invite' &&
        (!this.session || !this.session.contentAvailable(scope)))
    );
  }
  private open(): Promise<IDBDatabase> {
    if (!this.database)
      this.database = new Promise((resolve, reject) => {
        const request = this.indexed.open('fake-bubble-web-local-cache', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('entries');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    return this.database;
  }
  async putDraft(scope: LocalScope, characterId: string, text: string) {
    if (this.unavailable(scope)) return;
    await this.write(draftKey(scope, characterId), text);
  }
  async draft(scope: LocalScope, characterId: string): Promise<string | null> {
    if (this.unavailable(scope)) return null;
    const value = await this.read(draftKey(scope, characterId));
    return typeof value === 'string' ? value : null;
  }
  async putMessages(scope: LocalScope, messages: WebLocalMessage[]) {
    if (this.unavailable(scope)) return;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('entries', 'readwrite');
      for (const message of messages) tx.objectStore('entries').put(message, messageKey(scope, message));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('cache transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('cache transaction failed'));
    });
  }
  async message(scope: LocalScope, conversationId: string, messageId: string): Promise<WebLocalMessage | null> {
    if (this.unavailable(scope)) return null;
    const value = await this.read(`message\u001f${scopeKey(scope)}\u001f${conversationId}\u001f${messageId}`);
    if (value === undefined) return null;
    const message = parseMessage(value);
    return message.conversationId === conversationId && message.messageId === messageId ? message : null;
  }
  async purgeScope(scope: LocalScope) {
    const db = await this.open(),
      key = scopeKey(scope);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('entries', 'readwrite');
      for (const prefix of [`draft\u001f${key}\u001f`, `message\u001f${key}\u001f`]) {
        const cursor = tx.objectStore('entries').openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        cursor.onsuccess = () => {
          if (cursor.result) {
            cursor.result.delete();
            cursor.result.continue();
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('cache purge aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('cache purge failed'));
    });
  }
  private async write(key: string, value: unknown) {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('entries', 'readwrite');
      tx.objectStore('entries').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('cache transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('cache transaction failed'));
    });
  }
  private async read(key: string): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('entries', 'readonly').objectStore('entries').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
