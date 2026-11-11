import { REFUSAL_STATUS } from './web-refusal-status.ts';
import { DetailedError, DomainError, RetryAfterError } from '../../../packages/domain/errors.ts';

/** Codes that reached the transport without a row in REFUSAL_STATUS (answered 400). Counted, never expected. */
let unknownRefusals = 0;
export const unknownRefusalCount = () => unknownRefusals;

/** Same redacted failure contract for Node and Cloudflare transports. */
export function webProviderHTTPError(error: unknown) {
  const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
  const publicCode =
    (
      {
        WEB_USER_QUEUE_FULL: 'QUEUE_FULL',
        WEB_DAILY_LIMIT_REACHED: 'WEB_DAILY_LIMIT_REACHED',
        WEB_CHARACTER_UNAVAILABLE: 'NOT_FOUND',
        WEB_GUEST_RATE_LIMITED: 'RATE_LIMITED',
        WEB_STREAM_LIMITED: 'RATE_LIMITED',
        WEB_INVITE_RATE_LIMITED: 'RATE_LIMITED',
        WEB_IDENTITY_RATE_LIMITED: 'RATE_LIMITED',
        WEB_INVITE_UNAVAILABLE: 'WEB_INVITE_UNAVAILABLE',
        WEB_INVITE_ALREADY_REDEEMED: 'WEB_INVITE_ALREADY_REDEEMED',
        WEB_INVITE_TERMS_REQUIRED: 'WEB_INVITE_TERMS_REQUIRED',
        WEB_INVITE_UNUSABLE: 'WEB_INVITE_UNUSABLE',
        WEB_INVITE_POINTS_REQUIRED: 'WEB_INVITE_POINTS_REQUIRED',
        WEB_GUEST_REQUIRED: 'WEB_GUEST_REQUIRED',
        ADMIN_UNAUTHORIZED: 'ADMIN_UNAUTHORIZED',
        ADMIN_INVALID_GRANT: 'ADMIN_INVALID_GRANT',
        ADMIN_CSRF_REQUIRED: 'ADMIN_CSRF_REQUIRED',
        WEB_ADMISSION_ENTITLEMENT_REQUIRED: 'AUTH_REQUIRED',
        WEB_OPERATION_NOT_FOUND: 'NOT_FOUND',
      } as Record<string, string>
    )[code] ?? (code.startsWith('WEB_') ? 'INTERNAL_ERROR' : code);
  const known = Object.hasOwn(REFUSAL_STATUS, publicCode);
  if (!known) unknownRefusals++;
  const status = known ? REFUSAL_STATUS[publicCode]! : 400;
  const retryAfterMs = error instanceof RetryAfterError ? error.retryAfterMs : null;
  return {
    status,
    known,
    body: {
      error: {
        code: publicCode,
        requestId: null,
        retryAfterMs,
        ...(error instanceof DetailedError ? { detail: error.detail } : {}),
      },
    },
  };
}
