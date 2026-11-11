/** The error every admin API call throws on a non-2xx answer (the class name is kept: the admin pages and their tests match on it). */
export class InviteLocalApiError extends Error {
    status;
    code;
    /** The server's structured detail (the cast's CAST_INVALID issues, for one), when it sent any. Codes and paths only. */
    detail;
    constructor(status, code, detail) {
        super(code);
        this.detail = detail;
        this.name = 'InviteLocalApiError';
        this.status = status;
        this.code = code;
    }
}
