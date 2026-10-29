import { ensure } from '../../../packages/domain/errors.ts';
import type { WebAccountAdmin } from './web-account-admin.ts';
import type { WebInviteRequest, WebInviteResult } from '../invites/web-invite-routes.ts';
import type { WebCharacterAdmin } from '../characters/web-character-admin.ts';
import type { WebCocreation } from '../cocreation/web-cocreation.ts';
import type { WebChatReviewAdmin } from '../review/web-chat-review-admin.ts';
import type { WebSystemAdmin } from './web-system-admin.ts';
import type { WebCastAdmin } from './web-cast-admin.ts';

export async function routeWebAccountAdmin(
  admin: WebAccountAdmin,
  req: WebInviteRequest,
  characters?: WebCharacterAdmin,
  cocreation?: WebCocreation,
  chatReview?: WebChatReviewAdmin | null,
  system?: WebSystemAdmin | null,
  cast?: WebCastAdmin | null,
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
  // Part 19 (CHAT_REVIEW_ENABLED): with the flag off these paths are not routes at all - they fall through like any unknown path.
  if (chatReview && path.startsWith(`${base}/conversations/`)) {
    auth();
    const actor = { cookie: req.adminCookie, csrf: req.csrf, origin: req.origin };
    const action = path.slice(`${base}/conversations/`.length);
    if (action === 'list')
      return { status: 200, body: chatReview.list(actor, body(['characterId', 'scope', 'page']) as never) };
    if (action === 'detail')
      return {
        status: 200,
        body: chatReview.detail(actor, body(['characterId', 'code', 'archived', 'page']) as never),
      };
    if (action === 'export')
      return { status: 200, body: chatReview.export(actor, body(['characterId', 'code', 'archived']) as never) };
    ensure(false, 'NOT_FOUND');
  }
  // Part 22b: 概览, 系统状态 and 积分发放 (Part 22c adds 玩家统计 and 消耗表 under stats/). The body goes to the handler unread: each checks its permission before it looks at the body.
  if (
    path.startsWith(`${base}/overview/`) ||
    path.startsWith(`${base}/system/`) ||
    path.startsWith(`${base}/points/`) ||
    path.startsWith(`${base}/stats/`)
  ) {
    auth();
    ensure(system, 'NOT_FOUND');
    const actor = { cookie: req.adminCookie, csrf: req.csrf, origin: req.origin };
    const action = path.slice(base.length + 1);
    if (action === 'overview/read') {
      body([]);
      return { status: 200, body: await system.overview(actor) };
    }
    if (action === 'system/status') {
      body([]);
      return { status: 200, body: await system.status(actor) };
    }
    if (action === 'system/renew-prices') return { status: 200, body: system.renewPrices(actor, req.body) };
    if (action === 'system/budget-topup') return { status: 200, body: await system.budgetTopUp(actor, req.body) };
    if (action === 'points/preview')
      return { status: 200, body: system.pointsPreview(actor, req.body, req.trustedIpHash) };
    if (action === 'points/grant') return { status: 200, body: system.pointsGrant(actor, req.body, req.trustedIpHash) };
    // Part 24c: the three numbers of points for co-creation notes (owner or points.grant).
    if (action === 'points/cocreation') return { status: 200, body: system.cocreationPoints(actor, req.body) };
    if (action === 'points/cocreation-save') return { status: 200, body: system.saveCocreationPoints(actor, req.body) };
    if (action === 'points/reset-preview') return { status: 200, body: system.resetPreview(actor, req.body) };
    if (action === 'points/reset') return { status: 200, body: system.resetPoints(actor, req.body) };
    // Part 22c: 玩家统计 and 消耗表, each with its 导出表格. The permission is checked before the body is read.
    if (action === 'stats/players') return { status: 200, body: system.playerStats(actor, req.body) };
    if (action === 'stats/players-export') return { status: 200, body: system.exportPlayerStats(actor, req.body) };
    if (action === 'stats/costs') return { status: 200, body: system.costs(actor, req.body) };
    // Part 22d: the data of 总览's chart and of the 消耗表 by user type (no page yet).
    if (action === 'stats/chart') return { status: 200, body: system.chart(actor, req.body) };
    if (action === 'stats/spend-by-type') return { status: 200, body: system.spendByType(actor, req.body) };
    if (action === 'stats/costs-export') return { status: 200, body: system.exportCosts(actor, req.body) };
    ensure(false, 'NOT_FOUND');
  }
  // Part 24a: the cast (no console yet). Every call checks its permission before it looks at the body.
  if (path.startsWith(`${base}/cast/`)) {
    auth();
    ensure(cast, 'NOT_FOUND');
    const actor = { cookie: req.adminCookie, csrf: req.csrf, origin: req.origin };
    const action = path.slice(`${base}/cast/`.length);
    if (action === 'draft') return { status: 200, body: cast.draft(actor, req.body) };
    if (action === 'versions') return { status: 200, body: cast.versions(actor, req.body) };
    if (action === 'validate') return { status: 200, body: cast.validate(actor, req.body) };
    if (action === 'compile-preview') return { status: 200, body: cast.compilePreview(actor, req.body) };
    if (action === 'save') return { status: 200, body: cast.save(actor, req.body) };
    if (action === 'publish') return { status: 200, body: cast.publish(actor, req.body) };
    if (action === 'rollback') return { status: 200, body: cast.rollback(actor, req.body) };
    if (action === 'import-legacy') return { status: 200, body: cast.importLegacy(actor, req.body) };
    // Part 24b-5: the cast file. Export is a read; the preview saves nothing; the import is the one write.
    if (action === 'export') return { status: 200, body: cast.exportFile(actor, req.body) };
    if (action === 'import-preview') return { status: 200, body: cast.importPreview(actor, req.body) };
    if (action === 'import-file') return { status: 200, body: cast.importFile(actor, req.body) };
    ensure(false, 'NOT_FOUND');
  }
  if (path.startsWith(`${base}/cocreation/`)) {
    auth();
    ensure(cocreation, 'NOT_FOUND');
    const actor = { cookie: req.adminCookie, csrf: req.csrf, origin: req.origin };
    const action = path.slice(`${base}/cocreation/`.length);
    if (action === 'counts') {
      body([]);
      return { status: 200, body: cocreation.counts(actor) };
    }
    if (action === 'list')
      return {
        status: 200,
        body: cocreation.list(actor, body(['characterId', 'status', 'starred', 'query', 'before']) as never),
      };
    if (action === 'detail') return { status: 200, body: cocreation.detail(actor, body(['id']).id) };
    if (action === 'set-status') {
      const value = body(['ids', 'status']);
      return { status: 200, body: cocreation.setStatus(actor, value.ids, value.status) };
    }
    if (action === 'star') {
      const value = body(['id', 'starred']);
      return { status: 200, body: cocreation.star(actor, value.id, value.starred) };
    }
    if (action === 'note') {
      const value = body(['id', 'note']);
      return { status: 200, body: cocreation.note(actor, value.id, value.note) };
    }
    if (action === 'adopt') {
      const value = body(['id', 'ordinal']);
      return { status: 200, body: cocreation.markAdopted(actor, value.id, value.ordinal) };
    }
    if (action === 'unadopt') {
      const value = body(['id', 'ordinal']);
      return { status: 200, body: cocreation.unadopt(actor, value.id, value.ordinal) };
    }
    // Part 24c: 加入关系与故事 - a pair note becomes a story of the cast draft (compare-and-swap on its revision; never publishes).
    if (action === 'cast-story') {
      const value = body(['id', 'ordinal', 'expectedRevision']);
      return { status: 200, body: cocreation.addToCastStory(actor, value.id, value.ordinal, value.expectedRevision) };
    }
    ensure(false, 'NOT_FOUND');
  }
  if (path.startsWith(`${base}/eval-sets/`)) {
    auth();
    ensure(characters, 'NOT_FOUND');
    const actor = { cookie: req.adminCookie, csrf: req.csrf, origin: req.origin };
    const action = path.slice(`${base}/eval-sets/`.length);
    if (action === 'list') {
      body([]);
      return { status: 200, body: characters.evalSetList(actor) };
    }
    if (action === 'save')
      return { status: 200, body: characters.evalSetSave(actor, body(['id', 'expectedVersion', 'name', 'items'])) };
    if (action === 'delete') {
      const value = body(['id', 'expectedVersion']);
      return { status: 200, body: characters.evalSetDelete(actor, value.id, value.expectedVersion) };
    }
    ensure(false, 'NOT_FOUND');
  }
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
        `^${base}/characters/([A-Za-z0-9_-]{1,128})/(detail|save|discard|preview|publish|review-start|review-status|run-start|run-list|run-detail|preview-detail|previews-status|material-list|material-prepare|material-upload|material-audio|material-approve|delete-preview|delete-start|delete-status)$`,
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
            'acknowledgeReview',
            // A colour-only change names no 预演 (the business object decides whether the draft really is one).
            ...(req.body && Object.hasOwn(req.body, 'previewId') ? ['previewId'] : []),
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
          body([
            'requestId',
            'draftRevision',
            'profileHash',
            'relationship',
            'message',
            ...(req.body && Object.hasOwn(req.body, 'simulatedTime') ? ['simulatedTime'] : []),
            ...(req.body && Object.hasOwn(req.body, 'castSource') ? ['castSource'] : []),
          ]),
        ),
      };
    if (match[2] === 'run-start')
      return {
        status: 202,
        body: characters.startRun(
          actor,
          id,
          body([
            'requestId',
            'draftRevision',
            'profileHash',
            'relationship',
            ...(req.body && Object.hasOwn(req.body, 'label') ? ['label'] : []),
            ...(req.body && Object.hasOwn(req.body, 'simulatedTime') ? ['simulatedTime'] : []),
            ...(req.body && Object.hasOwn(req.body, 'castSource') ? ['castSource'] : []),
            ...(req.body && Object.hasOwn(req.body, 'evalSetId') ? ['evalSetId'] : ['inputs']),
          ]),
        ),
      };
    if (match[2] === 'run-list') {
      body([]);
      return { status: 200, body: characters.runList(actor, id) };
    }
    if (match[2] === 'run-detail') return { status: 200, body: characters.runDetail(actor, id, body(['runId']).runId) };
    if (match[2] === 'preview-detail')
      return { status: 200, body: characters.previewDetail(actor, id, body(['previewId']).previewId) };
    if (match[2] === 'previews-status')
      return { status: 200, body: characters.previewsStatus(actor, id, body(['runId']).runId ?? null) };
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
  if (path === `${base}/metrics/stage-latency`) {
    auth();
    const value = body(['days']);
    return { status: 200, body: admin.stageLatency(req.adminCookie, req.csrf, req.origin, value.days) };
  }
  if (path === `${base}/models/read`) {
    auth();
    body([]);
    return { status: 200, body: admin.modelSettings(req.adminCookie, req.csrf, req.origin) };
  }
  if (path === `${base}/models/save`) {
    auth();
    ensure(req.body && typeof req.body === 'object' && !Array.isArray(req.body), 'INVALID_REQUEST');
    return { status: 200, body: admin.saveModelSettings(req.adminCookie, req.csrf, req.origin, req.body) };
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
