import type {
  WebInviteReceipt,
  WebInviteStatus,
  WebInviteView,
} from '../../../../packages/contracts/web-local-invite.ts';
import { InviteLocalApi, InviteLocalApiError } from '../services/invite-local-api.ts';
import { StaleLocalIdentityError } from '../services/local-api.ts';
import { LocalSession, type LocalScope } from './local-session.ts';

/** Installs an invite only after a trusted local-3 bootstrap confirms the old world and grant. */
export class LocalInviteController {
  private readonly api: InviteLocalApi;
  private readonly session: LocalSession;
  constructor(api: InviteLocalApi, session: LocalSession) {
    this.api = api;
    this.session = session;
  }

  private source(recoverExisting: boolean) {
    const scope = this.session.scope,
      view = this.session.currentView;
    if (!scope || scope.accessKind !== 'guest' || !view || (!recoverExisting && !this.session.contentAvailable(scope)))
      throw new Error('WEB_INVITE_GUEST_REQUIRED');
    return {
      scope: { ...scope, playerId: view.bootstrap.access.playerId },
      csrf: view.bootstrap.csrf,
      current: this.session.beginIdentityTransition(),
    };
  }

  private install(
    source: LocalScope & { playerId: string },
    status: WebInviteStatus,
    view: WebInviteView,
    current: () => boolean,
  ) {
    if (!current()) throw new StaleLocalIdentityError();
    const access = view.bootstrap.access;
    if (
      access.status !== 'active' ||
      view.bootstrap.instanceId !== source.instanceId ||
      view.bootstrap.recoveryEpoch !== source.recoveryEpoch ||
      access.principalId !== source.principalId ||
      access.playerId !== source.playerId ||
      access.worldId !== source.worldId ||
      access.grantId !== status.grantId ||
      access.principalId !== status.principalId ||
      access.expiresAt !== status.expiresAt
    )
      throw new Error('WEB_INVITE_SCOPE_MISMATCH');
    this.session.install(view);
    return { principalId: access.principalId, grantId: access.grantId };
  }

  async redeem(code: string, requestId: string) {
    const { scope, csrf, current } = this.source(false);
    const receipt = await this.api.redeem(code, requestId, csrf);
    if (!current()) throw new StaleLocalIdentityError();
    const view = await this.api.bootstrap();
    return this.install(scope, receipt, view, current);
  }

  /** Explicit response-loss recovery; never sends a second redeem. */
  async recover(code: string, requestId: string) {
    const { scope, current } = this.source(true);
    let view: WebInviteView, status: WebInviteStatus | WebInviteReceipt;
    try {
      view = await this.api.bootstrap();
      if (!current()) throw new StaleLocalIdentityError();
      status = await this.api.receiptStatus(requestId, view.bootstrap.csrf);
    } catch (error) {
      if (!current()) throw new StaleLocalIdentityError();
      if (
        !(error instanceof InviteLocalApiError) ||
        !['SESSION_ROTATED_RECOVERABLE', 'SESSION_EXPIRED'].includes(error.code)
      )
        throw error;
      const csrf = await this.api.receiptChallenge();
      if (!current()) throw new StaleLocalIdentityError();
      status = await this.api.recoverRedemption(code, requestId, csrf);
      if (!current()) throw new StaleLocalIdentityError();
      view = await this.api.bootstrap();
    }
    return this.install(scope, status, view, current);
  }
}
