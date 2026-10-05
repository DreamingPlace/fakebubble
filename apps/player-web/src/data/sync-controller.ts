import { parseSync, WebLocalProtocolError } from '../../../../packages/contracts/web-local-client.ts';
import type { WebLocalOperation, WebLocalSyncEvent } from '../../../../packages/contracts/web-local.ts';
import { LocalApi, LocalApiError } from '../services/local-api.ts';
import { LocalSession, type LocalScope } from '../session/local-session.ts';

export type SyncSink = {
  apply(event: WebLocalSyncEvent, scope: LocalScope): Promise<void>;
  refreshAccess(scope: LocalScope): Promise<void>;
  refetchOperation(operationId: string, scope: LocalScope): Promise<WebLocalOperation>;
  cursor(cursor: string, scope: LocalScope): Promise<void>;
  onError?(error: unknown): void;
};
export type EventStream = { close(): void; onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null };

/** One stream, ordered durable-page application, and no bootstrap polling. */
export class LocalSyncController {
  private stream: EventStream | null = null;
  private cursorValue = '';
  private seen = new Set<string>();
  private revisions = new Map<string, { revision: number; normalized: string }>();
  private scope: LocalScope | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private shown = true;
  private processing: Promise<void> = Promise.resolve();
  private retryCount = 0;
  private catchup: Promise<void> | null = null;
  private catchupScope: LocalScope | null = null;
  private readonly api: LocalApi; private readonly session: LocalSession;
  private readonly sink: SyncSink; private readonly source: (url: string) => EventStream;
  constructor(api: LocalApi, session: LocalSession, sink: SyncSink,
    source: (url: string) => EventStream = url => new EventSource(url)) {
    this.api = api; this.session = session; this.sink = sink; this.source = source;
    session.onInvalidate(() => this.stop());
  }
  async start(cursor: string) {
    this.stop();
    const scope = this.session.scope;
    if (!scope) throw new Error('no session');
    if (!this.session.contentAvailable(scope)) { this.session.denyContent(); return; }
    this.scope = scope; this.cursorValue = cursor; this.seen.clear(); this.revisions.clear();
    this.retryCount = 0;
    await this.catchUp(scope);
    if (this.scope === scope && this.session.contentAvailable(scope)) this.subscribe(scope);
  }
  stop() {
    this.stream?.close(); this.stream = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null; this.scope = null;
  }
  /** Host calls on visibility change; hidden pages do not reconnect indefinitely. */
  async visible(visible: boolean) {
    this.shown = visible;
    if (!visible) {
      this.stream?.close(); this.stream = null;
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      return;
    }
    if (this.busy) return;
    this.retryCount = 0;
    const scope = this.scope;
    if (scope && this.session.isCurrent(scope) && !this.session.contentAvailable(scope)) {
      this.session.denyContent(); return;
    }
    if (scope && !this.stream && this.session.contentAvailable(scope)) {
      await this.processing;
      if (this.scope !== scope || !this.shown) return;
      await this.catchUp(scope); this.subscribe(scope);
    }
  }
  private catchUp(scope: LocalScope): Promise<void> {
    if (this.catchup && this.catchupScope === scope) return this.catchup;
    const task = this.catchUpPages(scope).catch(error => {
      if (error instanceof LocalApiError && error.code === 'TRIAL_EXPIRED') this.session.denyContent();
      throw error;
    });
    this.catchup = task; this.catchupScope = scope;
    void task.finally(() => {
      if (this.catchup === task) { this.catchup = null; this.catchupScope = null; }
    }).catch(() => {});
    return task;
  }
  private async catchUpPages(scope: LocalScope) {
    for (let pageCount = 0; pageCount < 1000; pageCount++) {
      if (this.scope !== scope || !this.session.contentAvailable(scope)) return;
      const page = await this.api.sync(this.cursorValue, this.session.signal);
      for (const event of page.events) await this.apply(event, scope);
      if (this.scope !== scope || !this.session.contentAvailable(scope)) return;
      await this.sink.cursor(page.cursor, scope); // sink writes the old scope only, never the visible new scope
      if (this.scope !== scope || !this.session.contentAvailable(scope)) return;
      this.cursorValue = page.cursor;
      if (!page.hasMore) return;
      if (!page.events.length) throw new WebLocalProtocolError('empty non-final sync page');
    }
    throw new WebLocalProtocolError('sync page limit');
  }
  private subscribe(scope: LocalScope) {
    if (this.stream || !this.shown || this.scope !== scope || !this.session.contentAvailable(scope)) return;
    const stream = this.source(this.api.eventUrl(this.cursorValue));
    this.stream = stream;
    stream.onmessage = message => {
      this.processing = this.processing.then(async () => {
        if (this.stream !== stream || this.scope !== scope || !this.session.contentAvailable(scope)) return;
        const raw: unknown = JSON.parse(message.data as string);
        const parsed = parseSync({ events: [raw], cursor: message.lastEventId, hasMore: false });
        const event = parsed.events[0]!;
        if (event.eventId !== message.lastEventId) throw new WebLocalProtocolError('SSE ID mismatch');
        await this.apply(event, scope);
        if (this.stream !== stream || this.scope !== scope || !this.session.contentAvailable(scope)) return;
        await this.sink.cursor(event.eventId, scope);
        if (this.stream !== stream || this.scope !== scope || !this.session.contentAvailable(scope)) return;
        this.cursorValue = event.eventId;
      }).catch(async error => { this.sink.onError?.(error); await this.reconnect(scope); });
    };
    stream.onerror = () => {
      this.processing = this.processing.then(() => this.reconnect(scope)).catch(error => {
        this.sink.onError?.(error);
      });
    };
  }
  private async reconnect(scope: LocalScope) {
    if (this.busy || this.scope !== scope || !this.session.contentAvailable(scope)) return;
    this.busy = true; this.stream?.close(); this.stream = null;
    try { await this.catchUp(scope); }
    catch (error) { this.sink.onError?.(error); /* cursor remains last committed */ }
    finally {
      this.busy = false;
      if (this.shown && this.session.contentAvailable(scope) && this.scope === scope && ++this.retryCount <= 5) {
        this.retry = setTimeout(() => {
          this.retry = null;
          if (!this.shown || this.scope !== scope) return;
          void this.catchUp(scope).then(() => this.subscribe(scope)).catch(error => {
            this.sink.onError?.(error); void this.reconnect(scope);
          });
        }, Math.min(1500 * this.retryCount, 7500));
      }
    }
  }
  private async apply(event: WebLocalSyncEvent, scope: LocalScope) {
    if (this.scope !== scope || !this.session.contentAvailable(scope) || this.seen.has(event.eventId)) return;
    if (event.kind === 'access') await this.sink.refreshAccess(scope);
    if (event.kind === 'operation') {
      const id = event.payload.operationId;
      if (typeof id !== 'string') throw new WebLocalProtocolError('operation event without ID');
      const normalized = stable(event.payload);
      const prior = this.revisions.get(id);
      if (prior && event.revision < prior.revision) { this.seen.add(event.eventId); return; }
      if (prior && event.revision === prior.revision && normalized !== prior.normalized) {
        await this.sink.refetchOperation(id, scope);
        throw new WebLocalProtocolError('conflicting operation revision');
      }
      this.revisions.set(id, { revision: event.revision, normalized });
    }
    if (this.scope !== scope || !this.session.contentAvailable(scope)) return;
    await this.sink.apply(event, scope);
    this.seen.add(event.eventId);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
