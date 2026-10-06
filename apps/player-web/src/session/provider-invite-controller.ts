import type { WebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import type { WebInviteStatus } from '../../../../packages/contracts/web-local-invite.ts';
import { ProviderApi, ProviderApiError } from '../services/provider-api.ts';

type Phase = 'entry' | 'submitting' | 'uncertain' | 'recovering' | 'accepted' | 'blocked';
type Scope = Pick<WebProviderBootstrap, 'instanceId' | 'recoveryEpoch'> & {
  principalId: string;
  playerId: string;
  worldId: string;
};
const scope = (view: WebProviderBootstrap): Scope => ({
  instanceId: view.instanceId,
  recoveryEpoch: view.recoveryEpoch,
  principalId: view.access.principalId,
  playerId: view.access.playerId,
  worldId: view.access.worldId,
});
const matches = (a: Scope, b: Scope) =>
  a.instanceId === b.instanceId &&
  a.recoveryEpoch === b.recoveryEpoch &&
  a.principalId === b.principalId &&
  a.playerId === b.playerId &&
  a.worldId === b.worldId;

/** One in-memory intent survives dialog dismissal; recovery never repeats redemption. */
export class ProviderInviteController {
  private phase: Phase = 'entry';
  private errorCode: string | null = null;
  private intent: { code: string; requestId: string; source: Scope } | null = null;
  private readonly api: Pick<
    ProviderApi,
    'bootstrap' | 'redeemInvite' | 'inviteReceiptStatus' | 'inviteReceiptChallenge' | 'recoverInviteReceipt'
  >;
  private readonly current: () => WebProviderBootstrap;
  private readonly install: (view: WebProviderBootstrap) => void;
  private readonly changed: () => void;
  private readonly requestId: () => string;
  constructor(
    api: ProviderInviteController['api'],
    current: () => WebProviderBootstrap,
    install: (view: WebProviderBootstrap) => void,
    changed: () => void,
    requestId: () => string = () => crypto.randomUUID(),
  ) {
    this.api = api;
    this.current = current;
    this.install = install;
    this.changed = changed;
    this.requestId = requestId;
  }
  get state() {
    return { phase: this.phase, errorCode: this.errorCode };
  }
  get locked() {
    return this.phase !== 'entry' && this.phase !== 'accepted';
  }
  private set(phase: Phase, code: string | null = null) {
    this.phase = phase;
    this.errorCode = code;
    this.changed();
  }
  private check(view: WebProviderBootstrap) {
    if (
      !this.intent ||
      !matches(this.intent.source, scope(this.current())) ||
      !matches(this.intent.source, scope(view))
    )
      throw new ProviderApiError(0, 'IDENTITY_CHANGED');
  }
  private accept(view: WebProviderBootstrap, receipt: WebInviteStatus) {
    this.check(view);
    if (
      view.access.kind !== 'invite' ||
      view.access.status !== 'active' ||
      view.access.grantId !== receipt.grantId ||
      view.access.principalId !== receipt.principalId
    )
      throw new ProviderApiError(0, 'INVITE_SCOPE_MISMATCH');
    this.install(view);
    this.intent = null;
    this.set('accepted');
    return true;
  }
  private failed(error: unknown) {
    const code = error instanceof ProviderApiError ? error.code : 'NETWORK';
    // Even an unavailable/expired receipt does not prove that the original request failed.
    this.set(
      ['IDENTITY_CHANGED', 'INVITE_SCOPE_MISMATCH', 'CATALOG_CHANGED'].includes(code) ? 'blocked' : 'uncertain',
      code,
    );
    return false;
  }
  async redeem(code: string) {
    if (this.phase !== 'entry') return false;
    const view = this.current();
    if (view.access.kind !== 'guest') {
      this.set('blocked', 'IDENTITY_CHANGED');
      return false;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
      this.set('entry', 'INVALID_CODE');
      return false;
    }
    this.intent = { code, requestId: this.requestId(), source: scope(view) };
    this.set('submitting');
    let receipt: WebInviteStatus;
    try {
      receipt = await this.api.redeemInvite({ code, requestId: this.intent.requestId });
    } catch (error) {
      // Only this explicit transactional rejection permits editing a new intent.
      if (error instanceof ProviderApiError && error.status === 409 && error.code === 'WEB_INVITE_UNAVAILABLE') {
        this.intent = null;
        this.set('entry', error.code);
        return false;
      }
      return this.failed(error);
    }
    try {
      return this.accept(await this.api.bootstrap(), receipt);
    } catch (error) {
      return this.failed(error);
    }
  }
  async recover() {
    if (this.phase !== 'uncertain' || !this.intent) return false;
    const { code, requestId } = this.intent;
    this.set('recovering');
    try {
      this.check(this.current());
      let view: WebProviderBootstrap;
      try {
        view = await this.api.bootstrap();
      } catch (error) {
        if (
          !(error instanceof ProviderApiError) ||
          !['SESSION_ROTATED_RECOVERABLE', 'SESSION_EXPIRED'].includes(error.code)
        )
          throw error;
        // Invite rotation currently reports SESSION_EXPIRED; the challenge proves a live sealed receipt.
        const csrf = await this.api.inviteReceiptChallenge();
        this.check(this.current());
        const receipt = await this.api.recoverInviteReceipt({ code, requestId }, csrf);
        return this.accept(await this.api.bootstrap(), receipt);
      }
      this.check(view);
      return this.accept(view, await this.api.inviteReceiptStatus(requestId));
    } catch (error) {
      return this.failed(error);
    }
  }
}
