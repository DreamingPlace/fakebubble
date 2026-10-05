import { LocalApi, LocalApiError, StaleLocalIdentityError } from '../services/local-api.ts';
import { LocalSession } from './local-session.ts';

/** Password remains only in the caller's memory; requestId is non-secret receipt evidence. */
export class LocalIdentityController {
  private readonly api: LocalApi; private readonly session: LocalSession;
  constructor(api: LocalApi, session: LocalSession) { this.api = api; this.session = session; }
  async register(requestId: string, username: string, password: string) {
    const previous = this.session.scope;
    if (!previous) throw new Error('no session');
    const current = this.session.beginIdentityTransition();
    await this.api.register(requestId, username, password, current); // Do not pass old abort signal.
    if (!current()) throw new StaleLocalIdentityError();
    const next = await this.api.bootstrap(undefined, current);
    if (!current()) throw new StaleLocalIdentityError();
    if (next.bootstrap.access.kind !== 'account' ||
        next.bootstrap.access.principalId !== previous.principalId ||
        next.bootstrap.access.worldId !== previous.worldId)
      throw new Error('identity scope mismatch');
    this.session.install(next);
    return next;
  }
  /** Explicit recovery after a lost register response. Never repeats registration automatically. */
  async recoverRegister(requestId: string, username: string, password: string) {
    const previous = this.session.scope;
    if (!previous) throw new Error('no session');
    const current = this.session.beginIdentityTransition();
    let next;
    let receipt;
    try {
      next = await this.api.bootstrap(undefined, current); // New cookie may already be installed.
      if (!current()) throw new StaleLocalIdentityError();
      receipt = await this.api.receiptStatus(requestId);
    } catch (error) {
      if (!current()) throw new StaleLocalIdentityError();
      if (!(error instanceof LocalApiError) || error.code !== 'SESSION_ROTATED_RECOVERABLE') throw error;
      await this.api.receiptChallenge(current);
      if (!current()) throw new StaleLocalIdentityError();
      receipt = await this.api.recoverRegister(requestId, username, password, current);
      if (!current()) throw new StaleLocalIdentityError();
      next = await this.api.bootstrap(undefined, current);
    }
    if (!current()) throw new StaleLocalIdentityError();
    if (next.bootstrap.access.kind !== 'account' ||
        receipt.principalId !== previous.principalId || receipt.principalId !== next.bootstrap.access.principalId ||
        next.bootstrap.access.worldId !== previous.worldId) throw new Error('identity recovery mismatch');
    this.session.install(next);
    return next;
  }
}
