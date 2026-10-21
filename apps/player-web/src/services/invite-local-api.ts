/** The error every admin API call throws on a non-2xx answer (the class name is kept: the admin pages and their tests match on it). */
export class InviteLocalApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'InviteLocalApiError';
    this.status = status;
    this.code = code;
  }
}
