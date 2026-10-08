import { DomainError } from '../../../packages/domain/errors.ts';

export type SafeError = { code: string } | { name: string; message: string } | { name: 'non-error' };

/**
 * Log-safe description of a thrown value. Only the domain code, or a truncated and character-restricted
 * message, ever leaves; no request data, headers, bodies, keys or environment values are read.
 */
export function safeError(error: unknown): SafeError {
  if (error instanceof DomainError) return { code: error.code };
  if (error instanceof Error) {
    return {
      name: String(error.name)
        .replace(/[^A-Za-z0-9_ .-]/g, '')
        .slice(0, 64),
      message: String(error.message)
        .slice(0, 200)
        .replace(/[^A-Za-z0-9_ .,:;()'"=<>/-]/g, ''),
    };
  }
  return { name: 'non-error' };
}
