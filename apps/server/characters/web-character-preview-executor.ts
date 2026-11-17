import { WebCharacterPreviewRunner } from './web-character-preview-runner.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

/**
 * Driven by the owner's existing timer/DO alarm, never a second alarm owner.
 * Part 40: several claims may be in flight at once (the columns of a 多轮预演); how many is decided by the runner's own gates, so
 * every claim is taken inside the capacity tickets and budget reservations of its call. A claim that finishes wakes the owner again.
 */
export class WebCharacterPreviewExecutor {
  private readonly runner: WebCharacterPreviewRunner;
  private readonly activity: { hold(task: Promise<void>): void; settled(): Promise<void> } | undefined;
  private filling: Promise<void> | null = null;
  private readonly flight = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  lastError: string | null = null;
  constructor(
    runner: WebCharacterPreviewRunner,
    activity?: { hold(task: Promise<void>): void; settled(): Promise<void> },
  ) {
    this.runner = runner;
    this.activity = activity;
  }
  kick() {
    if (this.filling || this.controller.signal.aborted || this.runner.nextDue() === null) return;
    const fill = this.fill()
      .catch((error) => {
        this.lastError = error instanceof DomainError ? error.code : 'PREVIEW_WORKER_FAILED';
      })
      .finally(() => {
        this.filling = null;
      });
    this.filling = fill;
    this.activity?.hold(fill);
  }
  private async fill() {
    const recovered = (await this.runner.recoverBills()) > 0;
    let started = 0;
    while (!this.controller.signal.aborted) {
      const claim = this.runner.claim();
      if (!claim) break;
      started++;
      const job: Promise<void> = this.runner
        .run(claim, AbortSignal.any([this.controller.signal, AbortSignal.timeout(140_000)]))
        .then(() => {
          this.lastError = null;
        })
        .catch((error) => {
          this.lastError = error instanceof DomainError ? error.code : 'PREVIEW_WORKER_FAILED';
        })
        .finally(async () => {
          this.flight.delete(job);
          try {
            await this.activity?.settled();
          } catch {
            this.lastError = 'PREVIEW_WAKE_FAILED';
          }
        });
      this.flight.add(job);
      this.activity?.hold(job);
    }
    if (recovered && started === 0) await this.activity?.settled();
  }
  nextDue() {
    return this.runner.nextDue();
  }
  async close() {
    this.controller.abort();
    await this.filling;
    await Promise.all([...this.flight]);
  }
}
