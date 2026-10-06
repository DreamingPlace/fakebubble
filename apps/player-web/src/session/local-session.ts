import {
  parseBootstrap,
  WebLocalProtocolError,
  type LocalAccess,
  type LocalView,
} from '../../../../packages/contracts/web-local-client.ts';
import {
  parseWebInviteAccess,
  type WebInviteAccess,
  type WebInviteView,
} from '../../../../packages/contracts/web-local-invite.ts';

type SessionView = LocalView | WebInviteView;
const isInviteView = (view: SessionView | null): view is WebInviteView =>
  view?.bootstrap.contractVersion === 'web-v1-local-3';

export type LocalScope = {
  instanceId: string;
  recoveryEpoch: string;
  principalId: string;
  worldId: string;
  generation: number;
  contractVersion?: 'web-v1-local-1' | 'web-v1-local-2' | 'web-v1-local-3';
  guestExpiresAt?: number | null;
  accessKind?: 'guest' | 'account' | 'invite';
  inviteExpiresAt?: number | null;
  inviteStatus?: 'active' | 'expired' | 'revoked';
  retentionState?: 'unstarted' | 'active' | 'expired' | 'protected' | undefined;
};

/** Generation is independent of principal/world: in-place registration still invalidates old UI work. */
export class LocalSession {
  private generation = 0;
  private controller = new AbortController();
  private view: SessionView | null = null;
  private identityTicket = 0;
  private accessTicket = 0;
  private readonly cleanups = new Set<() => void>();
  private readonly expiryCleanups = new Set<(scope: LocalScope) => void>();
  private readonly installCleanups = new Set<(scope: LocalScope) => void>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private contentDenied = false;
  lastExpiryError: unknown = null;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  get signal() {
    return this.controller.signal;
  }
  get currentView(): LocalView | null {
    return isInviteView(this.view) ? null : this.view;
  }
  get currentInviteView(): WebInviteView | null {
    return isInviteView(this.view) ? this.view : null;
  }
  get scope(): LocalScope | null {
    const b = this.view?.bootstrap;
    return b
      ? {
          instanceId: b.instanceId,
          recoveryEpoch: b.recoveryEpoch,
          principalId: b.access.principalId,
          worldId: b.access.worldId,
          generation: this.generation,
          contractVersion: b.contractVersion,
          accessKind: b.access.kind,
          retentionState: b.access.retentionState,
          ...(b.access.kind === 'invite' ? { inviteExpiresAt: b.access.expiresAt, inviteStatus: b.access.status } : {}),
          guestExpiresAt:
            b.contractVersion === 'web-v1-local-2' && b.access.kind === 'guest'
              ? (b.access.trialExpiresAt ?? null)
              : null,
        }
      : null;
  }
  isCurrent(scope: LocalScope): boolean {
    const now = this.scope;
    return (
      now !== null &&
      scope.instanceId === now.instanceId &&
      scope.recoveryEpoch === now.recoveryEpoch &&
      scope.principalId === now.principalId &&
      scope.worldId === now.worldId &&
      scope.generation === now.generation
    );
  }
  onInvalidate(cleanup: () => void) {
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }
  onContentExpired(cleanup: (scope: LocalScope) => void) {
    this.expiryCleanups.add(cleanup);
    return () => this.expiryCleanups.delete(cleanup);
  }
  onInstall(cleanup: (scope: LocalScope) => void) {
    this.installCleanups.add(cleanup);
    return () => this.installCleanups.delete(cleanup);
  }
  contentAvailable(scope: LocalScope | null = this.scope) {
    if (!scope || !this.isCurrent(scope) || this.contentDenied) return false;
    const access = this.view!.bootstrap.access;
    if (access.kind === 'invite')
      return access.status === 'active' && (access.expiresAt === null || this.now() < access.expiresAt);
    return (
      this.view!.bootstrap.contractVersion !== 'web-v1-local-2' ||
      access.kind === 'account' ||
      access.retentionState === 'unstarted' ||
      (access.retentionState === 'active' &&
        access.trialExpiresAt !== null &&
        access.trialExpiresAt !== undefined &&
        this.now() < access.trialExpiresAt)
    );
  }
  private clearExpiryTimer() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }
  private expire(scope: LocalScope) {
    if (!this.isCurrent(scope) || this.contentAvailable(scope)) return;
    this.contentDenied = true;
    if (isInviteView(this.view)) {
      const view = this.view,
        bootstrap = view.bootstrap;
      const status: WebInviteAccess['status'] = bootstrap.access.status === 'revoked' ? 'revoked' : 'expired';
      this.view = {
        ...view,
        bootstrap: {
          ...bootstrap,
          access: { ...bootstrap.access, canSend: false, status },
          conversations: [],
          activeOperations: [],
        },
      };
    } else if (
      this.view?.bootstrap.contractVersion === 'web-v1-local-2' &&
      this.view.bootstrap.access.kind === 'guest'
    ) {
      const view = this.view,
        bootstrap = view.bootstrap;
      this.view = {
        ...view,
        bootstrap: {
          ...bootstrap,
          access: { ...bootstrap.access, canSend: false, retentionState: 'expired' as const },
          conversations: [],
          activeOperations: [],
        },
      };
    }
    this.controller.abort();
    for (const cleanup of this.cleanups) {
      try {
        cleanup();
      } catch (error) {
        this.lastExpiryError = error;
      }
    }
    for (const cleanup of this.expiryCleanups) {
      try {
        cleanup(scope);
      } catch (error) {
        this.lastExpiryError = error;
      }
    }
    this.controller = new AbortController();
    this.generation++;
  }
  /** Server 410 wins over a stale client clock or access snapshot. */
  denyContent() {
    if (this.contentDenied) return;
    const scope = this.scope;
    if (!scope) return;
    this.contentDenied = true;
    this.expire(scope);
  }
  /** Identity HTTP requests outlive the old fetch signal, but only the latest live ticket may apply. */
  beginIdentityTransition() {
    const scope = this.scope;
    if (!scope) throw new Error('no authenticated local session');
    const ticket = ++this.identityTicket;
    return () => ticket === this.identityTicket && this.isCurrent(scope);
  }
  /** Only the access controller should apply a fresh /access response to this exact session. */
  beginAccessRefresh(scope: LocalScope): (access: LocalAccess) => boolean {
    if (!this.isCurrent(scope)) return () => false;
    const ticket = ++this.accessTicket;
    return (access) => {
      if (ticket !== this.accessTicket || !this.isCurrent(scope) || this.contentDenied) return false;
      const view = this.view!;
      if (isInviteView(view)) throw new WebLocalProtocolError('access refresh requires local-2');
      const bootstrap = view.bootstrap;
      if (bootstrap.contractVersion !== 'web-v1-local-2')
        throw new WebLocalProtocolError('access refresh requires local-2');
      const next = parseBootstrap({ ...bootstrap, access }).bootstrap.access;
      const old = bootstrap.access;
      if (
        next.principalId !== old.principalId ||
        next.playerId !== old.playerId ||
        next.worldId !== old.worldId ||
        next.kind !== old.kind
      )
        throw new WebLocalProtocolError('identity change requires bootstrap');
      if (next.revision < old.revision) throw new WebLocalProtocolError('stale access revision');
      if (next.kind === 'guest') {
        if (old.trialCharacterId !== null && next.trialCharacterId !== old.trialCharacterId)
          throw new WebLocalProtocolError('trial character changed');
        if (old.retentionState === 'active' || old.retentionState === 'expired') {
          if (
            next.trialExpiresAt !== old.trialExpiresAt ||
            (next.retentionState !== 'active' && next.retentionState !== 'expired')
          )
            throw new WebLocalProtocolError('trial expiry changed');
        } else if (
          next.retentionState !== 'unstarted' &&
          next.retentionState !== 'active' &&
          next.retentionState !== 'expired'
        )
          throw new WebLocalProtocolError('trial state changed');
        if (old.retentionState === 'unstarted' && next.retentionState !== 'unstarted' && next.revision === old.revision)
          throw new WebLocalProtocolError('trial start revision missing');
        if (next.canSend !== (next.retentionState !== 'expired' && next.trialRemaining! > 0))
          throw new WebLocalProtocolError('trial access inconsistent');
      }
      if (
        next.revision === old.revision &&
        (next.trialReserved !== old.trialReserved || next.trialCharacterId !== old.trialCharacterId)
      )
        throw new WebLocalProtocolError('same-revision access changed');
      this.view = { ...view, bootstrap: { ...bootstrap, access: next } };
      this.clearExpiryTimer();
      if (next.kind === 'guest') {
        if (
          next.retentionState === 'expired' ||
          (next.trialExpiresAt !== null && next.trialExpiresAt !== undefined && next.trialExpiresAt <= this.now())
        )
          this.expire(scope);
        else if (next.trialExpiresAt !== null && next.trialExpiresAt !== undefined)
          this.expiryTimer = setTimeout(() => this.expire(scope), next.trialExpiresAt! - this.now());
      }
      return true;
    };
  }
  beginInviteAccessRefresh(scope: LocalScope): (access: WebInviteAccess) => boolean {
    if (!this.isCurrent(scope) || !isInviteView(this.view)) return () => false;
    const ticket = ++this.accessTicket;
    return (access) => {
      if (ticket !== this.accessTicket || !this.isCurrent(scope) || this.contentDenied || !isInviteView(this.view))
        return false;
      const view = this.view;
      const next = parseWebInviteAccess(access),
        old = view.bootstrap.access;
      if (
        next.principalId !== old.principalId ||
        next.playerId !== old.playerId ||
        next.worldId !== old.worldId ||
        next.grantId !== old.grantId ||
        next.revision < old.revision ||
        next.expiresAt !== old.expiresAt ||
        (old.status !== 'active' && next.status === 'active')
      )
        throw new WebLocalProtocolError('invite access scope changed');
      this.view = { ...view, bootstrap: { ...view.bootstrap, access: next } };
      this.clearExpiryTimer();
      if (next.status !== 'active' || (next.expiresAt !== null && next.expiresAt <= this.now())) this.expire(scope);
      else if (next.expiresAt !== null)
        this.expiryTimer = setTimeout(() => this.expire(scope), next.expiresAt! - this.now());
      return true;
    };
  }
  /** Call only after a trusted identity receipt/bootstrap; never abort the identity request itself. */
  install(view: SessionView) {
    this.clearExpiryTimer();
    this.identityTicket++;
    this.accessTicket++;
    this.controller.abort();
    for (const cleanup of this.cleanups) cleanup();
    this.controller = new AbortController();
    this.generation++;
    this.view = view;
    this.contentDenied = false;
    const scope = this.scope!;
    for (const cleanup of this.installCleanups) cleanup(scope);
    if (isInviteView(view)) {
      const access = view.bootstrap.access;
      if (access.status !== 'active' || (access.expiresAt !== null && access.expiresAt <= this.now()))
        this.expire(scope);
      else if (access.expiresAt !== null)
        this.expiryTimer = setTimeout(() => this.expire(scope), access.expiresAt! - this.now());
    } else if (view.bootstrap.contractVersion === 'web-v1-local-2' && view.bootstrap.access.kind === 'guest') {
      const expiry = view.bootstrap.access.trialExpiresAt;
      if (expiry !== null && expiry !== undefined) {
        if (expiry <= this.now()) this.expire(scope);
        else this.expiryTimer = setTimeout(() => this.expire(scope), expiry - this.now());
      } else if (view.bootstrap.access.retentionState === 'expired') this.expire(scope);
    }
    return this.scope!;
  }
  invalidate() {
    this.clearExpiryTimer();
    this.identityTicket++;
    this.accessTicket++;
    this.controller.abort();
    for (const cleanup of this.cleanups) cleanup();
    this.controller = new AbortController();
    this.generation++;
    this.view = null;
    this.contentDenied = false;
  }
}
