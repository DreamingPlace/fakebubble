import type { WebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
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

/**
 * One in-memory intent survives dialog dismissal. A redemption is idempotent on its requestId (an entitlement is added once;
 * the same request answers `duplicate`), so an uncertain one is settled by asking again with the SAME request, never a new one.
 */
export class ProviderInviteController {
  private phase: Phase = 'entry';
  private errorCode: string | null = null;
  private intent: { code: string; requestId: string; source: Scope } | null = null;
  private readonly api: Pick<ProviderApi, 'bootstrap' | 'redeemInvite'>;
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
  /** An entitlement changes nothing about who the player is - same principal, same session. Take the new access. */
  private async accept() {
    const view = await this.api.bootstrap();
    this.check(view);
    this.install(view);
    this.intent = null;
    this.set('accepted');
    return true;
  }
  private failed(error: unknown) {
    const code = error instanceof ProviderApiError ? error.code : 'NETWORK';
    // A lost answer does not prove that the request failed.
    this.set(
      ['IDENTITY_CHANGED', 'CATALOG_CHANGED'].includes(code) ? 'blocked' : 'uncertain',
      code,
    );
    return false;
  }
  async redeem(code: string) {
    if (this.phase !== 'entry') return false;
    const view = this.current();
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
      this.set('entry', 'INVALID_CODE');
      return false;
    }
    this.intent = { code, requestId: this.requestId(), source: scope(view) };
    this.set('submitting');
    return this.send();
  }
  private async send() {
    const intent = this.intent!;
    try {
      await this.api.redeemInvite({ code: intent.code, requestId: intent.requestId });
    } catch (error) {
      // Only an explicit transactional rejection permits editing a new intent. A guest's code is refused before it is looked
      // at (PLAYER_LOGIN_REQUIRED): nothing was consumed, so the player may sign up and enter it again.
      if (
        error instanceof ProviderApiError &&
        error.status === 409 &&
        ['WEB_INVITE_UNAVAILABLE', 'WEB_INVITE_UNUSABLE', 'PLAYER_LOGIN_REQUIRED'].includes(error.code)
      ) {
        this.intent = null;
        this.set('entry', error.code);
        return false;
      }
      return this.failed(error);
    }
    try {
      return await this.accept();
    } catch (error) {
      return this.failed(error);
    }
  }
  /** Settles an uncertain redemption: the same request again, which the server answers without a second redemption. */
  async recover() {
    if (this.phase !== 'uncertain' || !this.intent) return false;
    this.set('recovering');
    try {
      this.check(this.current());
    } catch (error) {
      return this.failed(error);
    }
    return this.send();
  }
}
