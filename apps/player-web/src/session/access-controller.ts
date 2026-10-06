import { LocalApi } from '../services/local-api.ts';
import { InviteLocalApi } from '../services/invite-local-api.ts';
import { LocalSession, type LocalScope } from './local-session.ts';

/** Trusted same-identity access refresh; identity transitions still use bootstrap/install. */
export class LocalAccessController {
  private readonly api: LocalApi;
  private readonly inviteApi: InviteLocalApi;
  private readonly session: LocalSession;
  constructor(api: LocalApi, session: LocalSession, inviteApi: InviteLocalApi = new InviteLocalApi()) {
    this.api = api;
    this.session = session;
    this.inviteApi = inviteApi;
  }

  async refresh(scope: LocalScope | null = this.session.scope): Promise<boolean> {
    if (!scope || !this.session.isCurrent(scope)) return false;
    if (scope.contractVersion === 'web-v1-local-3' && scope.accessKind === 'invite') {
      const apply = this.session.beginInviteAccessRefresh(scope);
      return apply(await this.inviteApi.access());
    }
    const apply = this.session.beginAccessRefresh(scope);
    return apply(await this.api.access(this.session.signal));
  }
}
