export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
export function ensure(condition: unknown, code: string, message?: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
