// Offline fault-injection primitive only. A web adapter is required before this can verify product behavior.
export type Stage = 'text' | 'audio';
export type Outcome =
  | { kind: 'ok'; value: string }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'failed'; code: string }
  | { kind: 'unknown' };

export type Call = { operationId: string; stage: Stage; segment: number; atMs: number };
type Plan = { outcome: Outcome; release?: Promise<void> };

export class ManualClock {
  private currentMs: number;
  constructor(initialMs = 0) { this.currentMs = initialMs; }
  now(): number { return this.currentMs; }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance must be finite and nonnegative');
    this.currentMs += ms;
  }
}

export class ControlledProvider {
  readonly calls: Call[] = [];
  private readonly plans = new Map<string, Plan[]>();
  private readonly releases = new Map<string, Array<() => void>>();
  private readonly clock: ManualClock;

  constructor(clock: ManualClock) { this.clock = clock; }

  script(operationId: string, stage: Stage, segment: number, outcome: Outcome, held = false): void {
    const key = this.key(operationId, stage, segment);
    const queue = this.plans.get(key) ?? [];
    let release: Promise<void> | undefined;
    if (held) {
      release = new Promise<void>(resolve => {
        const waiters = this.releases.get(key) ?? [];
        waiters.push(resolve);
        this.releases.set(key, waiters);
      });
    }
    queue.push(release ? { outcome, release } : { outcome });
    this.plans.set(key, queue);
  }

  async invoke(operationId: string, stage: Stage, segment = 0): Promise<Outcome> {
    const key = this.key(operationId, stage, segment);
    const plan = this.plans.get(key)?.shift();
    if (!plan) throw new Error(`unscripted provider call: ${key}`);
    this.calls.push({ operationId, stage, segment, atMs: this.clock.now() });
    await plan.release;
    return plan.outcome;
  }

  release(operationId: string, stage: Stage, segment = 0): void {
    const key = this.key(operationId, stage, segment);
    const release = this.releases.get(key)?.shift();
    if (!release) throw new Error(`no held provider call: ${key}`);
    release();
  }

  count(operationId: string, stage?: Stage, segment?: number): number {
    return this.calls.filter(call => call.operationId === operationId &&
      (stage === undefined || call.stage === stage) && (segment === undefined || call.segment === segment)).length;
  }

  private key(operationId: string, stage: Stage, segment: number): string {
    if (!operationId || !Number.isSafeInteger(segment) || segment < 0) throw new RangeError('invalid call key');
    return JSON.stringify([operationId, stage, segment]);
  }
}
