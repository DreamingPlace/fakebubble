import { WebCharacterPreviewRunner } from './web-character-preview-runner.ts';
import { DomainError } from '../../packages/domain/errors.ts';

/** Driven by the owner's existing timer/DO alarm, never a second alarm owner. */
export class WebCharacterPreviewExecutor {
  private readonly runner: WebCharacterPreviewRunner;
  private readonly activity: { hold(task: Promise<void>): void; settled(): Promise<void> } | undefined;
  private active: Promise<void> | null = null;
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
    if (this.active || this.controller.signal.aborted || this.runner.nextDue() === null) return;
    let worked = false;
    const work = async () => {
      worked = (await this.runner.recoverBills()) > 0;
      if (this.controller.signal.aborted) return;
      const claim = this.runner.claim();
      if (claim) {
        worked = true;
        await this.runner.run(claim, AbortSignal.any([this.controller.signal, AbortSignal.timeout(140_000)]));
      }
    };
    this.active = work()
      .then(() => {
        this.lastError = null;
      })
      .catch((error) => {
        this.lastError = error instanceof DomainError ? error.code : 'PREVIEW_WORKER_FAILED';
      })
      .finally(async () => {
        this.active = null;
        try {
          if (worked) await this.activity?.settled();
        } catch {
          this.lastError = 'PREVIEW_WAKE_FAILED';
        }
      });
    this.activity?.hold(this.active);
  }
  nextDue() {
    return this.runner.nextDue();
  }
  async close() {
    this.controller.abort();
    await this.active;
  }
}
