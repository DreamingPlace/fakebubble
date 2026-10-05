import { InviteLocalApiError } from '../services/invite-local-api.ts';
import { LocalInviteController } from './invite-controller.ts';

/** Structural match for E's UI-only InviteFormPort; no E source dependency. */
export type InviteFormResult =
  | { kind: 'accepted'; principalId: string; grantId: string }
  | { kind: 'uncertain' }
  | { kind: 'rejected'; code: 'lost-session' | 'recovery-unavailable' | 'invalid-code' };

function failure(error: unknown): InviteFormResult {
  if (error instanceof InviteLocalApiError) {
    if (error.code === 'SESSION_EXPIRED' || error.code === 'AUTH_REQUIRED' ||
        error.code === 'TRIAL_EXPIRED' || error.status === 401)
      return { kind: 'rejected', code: 'lost-session' };
    if (error.code === 'RECEIPT_UNAVAILABLE' || error.code === 'WEB_INVITE_ACCESS_REQUIRED' ||
        error.code === 'WEB_INVITE_RECOVERY_UNAVAILABLE')
      return { kind: 'rejected', code: 'recovery-unavailable' };
    if (error.code === 'WEB_INVITE_UNAVAILABLE')
      return { kind: 'rejected', code: 'invalid-code' };
  }
  if (error instanceof Error && error.message === 'WEB_INVITE_GUEST_REQUIRED')
    return { kind: 'rejected', code: 'lost-session' };
  if (error instanceof Error && error.message === 'WEB_INVITE_SCOPE_MISMATCH')
    return { kind: 'rejected', code: 'recovery-unavailable' };
  // Network, 5xx and unclassified protocol outcomes may have committed remotely.
  return { kind: 'uncertain' };
}

export function inviteFormPort(controller: Pick<LocalInviteController, 'redeem' | 'recover'>) {
  return {
    async redeem(input: { code: string; requestId: string }): Promise<InviteFormResult> {
      try { return { kind: 'accepted', ...await controller.redeem(input.code, input.requestId) }; }
      catch (error) { return failure(error); }
    },
    async recover(input: { code: string; requestId: string }): Promise<InviteFormResult> {
      try { return { kind: 'accepted', ...await controller.recover(input.code, input.requestId) }; }
      catch (error) { return failure(error); }
    },
  };
}
