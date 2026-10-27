/** The error every admin API call throws on a non-2xx answer (the class name is kept: the admin pages and their tests match on it). */
export class InviteLocalApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The server's structured detail (the cast's CAST_INVALID issues, for one), when it sent any. Codes and paths only. */
  readonly detail: unknown;
  constructor(status: number, code: string, detail?: unknown) {
    super(code);
    this.detail = detail;
    this.name = 'InviteLocalApiError';
    this.status = status;
    this.code = code;
  }
}
