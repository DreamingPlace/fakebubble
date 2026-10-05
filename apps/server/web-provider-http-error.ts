import { DomainError } from '../../packages/domain/errors.ts';

/** Same redacted failure contract for Node and Cloudflare transports. */
export function webProviderHTTPError(error: unknown) {
  const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
  const publicCode = ({ WEB_USER_QUEUE_FULL: 'QUEUE_FULL', WEB_CHARACTER_UNAVAILABLE: 'NOT_FOUND',
        WEB_GUEST_RATE_LIMITED: 'RATE_LIMITED', WEB_STREAM_LIMITED: 'RATE_LIMITED',
        WEB_INVITE_RATE_LIMITED: 'RATE_LIMITED', WEB_IDENTITY_RATE_LIMITED: 'RATE_LIMITED',
        WEB_INVITE_ACCESS_REQUIRED: 'WEB_INVITE_ACCESS_REQUIRED',
        WEB_INVITE_UNAVAILABLE: 'WEB_INVITE_UNAVAILABLE',
        WEB_INVITE_RECOVERY_UNAVAILABLE: 'WEB_INVITE_RECOVERY_UNAVAILABLE',
        WEB_GUEST_REQUIRED: 'WEB_GUEST_REQUIRED',
        ADMIN_UNAUTHORIZED: 'ADMIN_UNAUTHORIZED', ADMIN_INVALID_GRANT: 'ADMIN_INVALID_GRANT',
        ADMIN_CSRF_REQUIRED: 'ADMIN_CSRF_REQUIRED',
        WEB_ADMISSION_ENTITLEMENT_REQUIRED: 'AUTH_REQUIRED', WEB_OPERATION_NOT_FOUND: 'NOT_FOUND' } as Record<string, string>)[code] ??
        (code.startsWith('WEB_') ? 'INTERNAL_ERROR' : code);
  const status = publicCode === 'ADMIN_EMAIL_UNAVAILABLE' ? 503 :
        publicCode === 'TRIAL_EXPIRED' || publicCode === 'WEB_INVITE_ACCESS_REQUIRED' ? 410 :
        publicCode === 'NOT_FOUND' ? 404 :
        publicCode === 'AUTH_REQUIRED' || publicCode === 'SESSION_EXPIRED' || publicCode === 'GUEST_SESSION_EXPIRED' ||
          publicCode === 'ADMIN_UNAUTHORIZED' || publicCode === 'ADMIN_LOGIN_INVALID' ? 401 :
          publicCode === 'CSRF_INVALID' || publicCode === 'ORIGIN_INVALID' ||
            publicCode === 'TRIAL_EXHAUSTED' || publicCode === 'TRIAL_CHARACTER_LOCKED' ||
            publicCode === 'ADMIN_INVALID_GRANT' || publicCode === 'ADMIN_CSRF_REQUIRED' ||
            publicCode === 'ADMIN_PERMISSION_REQUIRED' || publicCode === 'ADMIN_OWNER_REQUIRED' || publicCode === 'ADMIN_OWNER_PROTECTED' ? 403 :
            publicCode === 'INVALID_CURSOR' || publicCode === 'INVALID_REQUEST' ||
              publicCode === 'INVALID_TEXT' || publicCode === 'ADMIN_EMAIL_INVALID' || publicCode === 'ADMIN_PASSWORD_INVALID' ||
              publicCode === 'ADMIN_CODE_INVALID' ? 400 :
              publicCode === 'QUEUE_FULL' || publicCode === 'RATE_LIMITED' ? 429 :
                publicCode === 'INTERNAL_ERROR' ? 500 : 409;
  return { status, body: { error: { code: publicCode, requestId: null, retryAfterMs: null } } };
}
