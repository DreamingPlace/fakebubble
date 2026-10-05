import { ensure } from '../../packages/domain/errors.ts';
import type { WebAccountAdmin } from './web-account-admin.ts';
import type { WebInviteRequest, WebInviteResult } from './web-invite-routes.ts';
import type { WebCharacterAdmin } from './web-character-admin.ts';

export async function routeWebAccountAdmin(
  admin: WebAccountAdmin,
  req: WebInviteRequest,
  characters?: WebCharacterAdmin,
): Promise<WebInviteResult | null> {
  const base = '/api/web/local/admin',
    path = req.path;
  if (!path.startsWith(base + '/')) return null;
  ensure(req.method === 'POST', 'NOT_FOUND');
  const body = (keys: string[]) => {
    ensure(
      req.body &&
        typeof req.body === 'object' &&
        !Array.isArray(req.body) &&
        Object.keys(req.body).sort().join(',') === [...keys].sort().join(','),
      'INVALID_REQUEST',
    );
    return req.body as Record<string, unknown>;
  };
  const auth = () => {
    admin.authorize(req.adminCookie, req.csrf, req.origin);
  };
  const peer = () => {
    ensure(req.trustedIpHash, 'WEB_TRUSTED_IP_REQUIRED');
    return req.trustedIpHash;
  };
  const login = (result: { cookie: string }) => {
    const { cookie, ...session } = result;
    return { status: 200, body: session, issuedAdminCookie: cookie };
  };
  if (path.startsWith(`${base}/characters/`)) {
    auth();
    ensure(characters, 'NOT_FOUND');
    const actor = { cookie: req.adminCookie, csrf: req.csrf, origin: req.origin };
    if (path === `${base}/characters/list`) {
      body([]);
      return { status: 200, body: characters.list(actor) };
    }
    const match = path.match(
      new RegExp(
        `^${base}/characters/([A-Za-z0-9_-]{1,128})/(detail|save|discard|preview|publish|review-start|review-status|material-list|material-prepare|material-upload|material-audio|material-approve|delete-preview|delete-start|delete-status)$`,
      ),
    );
    ensure(match, 'NOT_FOUND');
    const id = match[1]!;
    if (match[2] === 'delete-preview') {
      body([]);
      return { status: 200, body: characters.deletionPreview(actor, id) };
    }
    if (match[2] === 'delete-start')
      return {
        status: 202,
        body: characters.deletionStart(actor, id, body(['requestId', 'previewHash', 'acknowledgeDeleteAllChats'])),
      };
    if (match[2] === 'delete-status') {
      body([]);
      return { status: 200, body: characters.deletionStatus(actor, id) };
    }
    if (match[2] === 'detail') {
      body([]);
      return { status: 200, body: characters.detail(actor, id) };
    }
    if (match[2] === 'save')
      return { status: 200, body: characters.save(actor, id, body(['expectedRevision', 'profile'])) };
    if (match[2] === 'material-list') {
      body([]);
      return { status: 200, body: characters.materialList(actor, id) };
    }
    if (match[2] === 'material-prepare')
      return {
        status: 200,
        body: characters.materialPrepare(
          actor,
          id,
          body(['requestId', 'draftRevision', 'profileHash', 'referenceId', 'model']),
        ),
      };
    if (match[2] === 'material-upload')
      return { status: 200, body: await characters.materialUpload(actor, id, body(['materialId', 'kind', 'base64'])) };
    if (match[2] === 'material-audio')
      return { status: 200, body: await characters.materialAudio(actor, id, body(['materialId', 'kind'])) };
    if (match[2] === 'material-approve')
      return {
        status: 200,
        body: await characters.materialApprove(
          actor,
          id,
          body([
            'materialId',
            'acknowledgeRights',
            'acknowledgeWelcomeListening',
            'acknowledgeFooterListening',
            'note',
          ]),
        ),
      };
    if (match[2] === 'publish')
      return {
        status: 200,
        body: characters.publish(
          actor,
          id,
          body([
            'requestId',
            'draftRevision',
            'profileHash',
            'previewId',
            'acknowledgeReview',
            ...(req.body && Object.hasOwn(req.body, 'materialId') ? ['materialId'] : []),
          ]),
        ),
      };
    if (match[2] === 'review-start')
      return {
        status: 202,
        body: characters.startPreview(
          actor,
          id,
          body(['requestId', 'draftRevision', 'profileHash', 'relationship', 'message']),
        ),
      };
    if (match[2] === 'review-status')
      return { status: 200, body: characters.previewStatus(actor, id, body(['previewId']).previewId) };
    const value = body(['expectedRevision']);
    return {
      status: 200,
      body:
        match[2] === 'discard'
          ? characters.discard(actor, id, value.expectedRevision)
          : characters.preview(actor, id, value.expectedRevision),
    };
  }
  if (path === `${base}/login`) {
    const value = body(['token']);
    ensure(req.origin, 'ADMIN_UNAUTHORIZED');
    admin.guard('grant-login', peer());
    return login(admin.login(value.token, req.origin));
  }
  if (path === `${base}/email/login`) {
    const value = body(['email', 'password']);
    return login(await admin.emailLogin(value.email, value.password, req.origin, peer()));
  }
  if (path === `${base}/email/bind/start`) {
    auth();
    const value = body(['email']);
    return { status: 200, body: await admin.startBinding(req.adminCookie, req.csrf, req.origin, value.email) };
  }
  if (path === `${base}/email/bind/finish`) {
    auth();
    const value = body(['challengeId', 'code', 'password']);
    return login(
      await admin.finishBinding(req.adminCookie, req.csrf, req.origin, value.challengeId, value.code, value.password),
    );
  }
  if (path === `${base}/email/reset/start`) {
    const value = body(['email']);
    return { status: 200, body: await admin.startReset(value.email, req.origin, peer()) };
  }
  if (path === `${base}/email/reset/finish`) {
    const value = body(['challengeId', 'code', 'password']);
    return {
      status: 200,
      body: await admin.finishReset(req.origin, peer(), value.challengeId, value.code, value.password),
    };
  }
  if (path === `${base}/invites/list`) {
    auth();
    const value = body(['beforeId']);
    return { status: 200, body: admin.inviteRecords(req.adminCookie, req.csrf, req.origin, value.beforeId) };
  }
  if (path === `${base}/members/list`) {
    auth();
    body([]);
    return { status: 200, body: admin.list(req.adminCookie, req.csrf, req.origin) };
  }
  if (path === `${base}/members/issue`) {
    auth();
    const value = body(['requestId', 'label', 'memberId', 'permissions']);
    return {
      status: 200,
      body: admin.issueMember(req.adminCookie, req.csrf, req.origin, {
        requestId: value.requestId,
        label: value.label,
        memberId: value.memberId,
        permissions: value.permissions,
      }),
    };
  }
  if (path === `${base}/members/permissions`) {
    auth();
    const value = body([
      'memberId',
      'permissions',
      ...(req.body && Object.hasOwn(req.body, 'expectedPermissions') ? ['expectedPermissions'] : []),
    ]);
    ensure(typeof value.memberId === 'string', 'INVALID_REQUEST');
    return {
      status: 200,
      body: admin.setPermissions(
        req.adminCookie,
        req.csrf,
        req.origin,
        value.memberId,
        value.permissions,
        value.expectedPermissions,
      ),
    };
  }
  if (path === `${base}/members/revoke-credential`) {
    auth();
    const value = body(['grantId']);
    ensure(typeof value.grantId === 'string', 'INVALID_REQUEST');
    return { status: 200, body: admin.revokeGrant(req.adminCookie, req.csrf, req.origin, value.grantId) };
  }
  return null;
}
