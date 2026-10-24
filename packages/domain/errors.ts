export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
/** A refusal that also carries a small detail object for the caller: counts, revisions, issue paths - never content. */
export class DetailedError extends DomainError {
  readonly detail: Record<string, unknown>;
  constructor(code: string, detail: Record<string, unknown>) {
    super(code);
    this.name = 'DetailedError';
    this.detail = detail;
  }
}
/** A refusal that tells the caller when the same request can succeed. */
export class RetryAfterError extends DomainError {
  readonly retryAfterMs: number;
  constructor(code: string, retryAfterMs: number) {
    super(code);
    this.name = 'RetryAfterError';
    this.retryAfterMs = retryAfterMs;
  }
}
export function ensure(condition: unknown, code: string, message?: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
