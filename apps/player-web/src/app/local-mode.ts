import { LocalApi } from '../services/local-api.ts';
import { IndexedDbLocalCache } from '../data/local-cache.ts';
import { IndexedDbPendingStore } from '../data/pending-operations.ts';
import { LocalSendController } from '../data/send-controller.ts';
import { LocalSyncController } from '../data/sync-controller.ts';
import { LocalAudioController } from '../media/audio-controller.ts';
import { LocalAccessController } from '../session/access-controller.ts';
import { LocalSession } from '../session/local-session.ts';
import { InviteLocalApi } from '../services/invite-local-api.ts';
import { LocalInviteController } from '../session/invite-controller.ts';
import { inviteFormPort } from '../session/invite-form-adapter.ts';
import { startLocalPage } from '../features/local/local-page.js';

export function startLocalMode(root: HTMLElement) {
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1') {
    root.textContent = '此入口仅供本机 HTTPS 合成业务测试；原型请使用默认页面。';
    return;
  }
  const api = new LocalApi();
  const session = new LocalSession();
  const pending = new IndexedDbPendingStore(indexedDB);
  const cache = new IndexedDbLocalCache(indexedDB, session);
  const sender = new LocalSendController(api, session, pending);
  const audio = new LocalAudioController(session);
  const access = new LocalAccessController(api, session);
  startLocalPage(root, {
    api,
    session,
    pending,
    cache,
    sender,
    audio,
    access,
    createSync: (sink) => new LocalSyncController(api, session, sink),
  });
}

/** Separate local-3 invitation route; default visual prototype and local-2 stay unchanged. */
export function startLocal3Mode(root: HTMLElement) {
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1') {
    root.textContent = '此入口仅供本机 HTTPS 合成业务测试；原型请使用默认页面。';
    return;
  }
  const api = new LocalApi();
  const inviteApi = new InviteLocalApi();
  const session = new LocalSession();
  const pending = new IndexedDbPendingStore(indexedDB);
  const cache = new IndexedDbLocalCache(indexedDB, session);
  const sender = new LocalSendController(api, session, pending);
  const audio = new LocalAudioController(session);
  const access = new LocalAccessController(api, session, inviteApi);
  startLocalPage(root, {
    api,
    session,
    pending,
    cache,
    sender,
    audio,
    access,
    mode: 'local-3',
    invitePort: inviteFormPort(new LocalInviteController(inviteApi, session)),
    createSync: (sink) => new LocalSyncController(api, session, sink),
  });
}
