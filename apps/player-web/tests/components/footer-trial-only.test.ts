import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import { footerNote } from '../../src/features/prototype/legal-links.ts';
import type { AccountInfo, ProviderApi } from '../../src/services/provider-api.ts';
import { syntheticProviderBootstrap, parseWebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { installFakeDom } from './fake-dom.ts';

/** Part 21d: the chat footer says 免费体验 ("free trial") only to a trial guest, never to a player who signed up. */
const guest: AccountInfo = {
  signupEnabled: true,
  signedIn: true,
  kind: 'guest',
  hasLogin: false,
  emailMasked: null,
  nickname: null,
  features: { signupBonus: 10 },
};
const accounts: [string, AccountInfo, { freeTier: boolean; signedUp: boolean }, string][] = [
  [
    'no session yet',
    { signupEnabled: true, signedIn: false, features: { signupBonus: 10 } },
    { freeTier: true, signedUp: false },
    '免费体验 · 回复由AI生成',
  ],
  ['trial guest', guest, { freeTier: true, signedUp: false }, '免费体验 · 回复由AI生成'],
  [
    'signed-up player (email login)',
    { ...guest, hasLogin: true, emailMasked: 'p***@example.com' },
    { freeTier: false, signedUp: true },
    '回复由AI生成',
  ],
  [
    'invited player',
    { ...guest, kind: 'invite', hasLogin: false },
    { freeTier: false, signedUp: false },
    '邀请体验 · 回复由AI生成',
  ],
  ['free tier off', { ...guest, features: {} }, { freeTier: false, signedUp: false }, '邀请体验 · 回复由AI生成'],
];

for (const [name, account, expected, text] of accounts)
  test(`footer for ${name}`, async (t) => {
    installFakeDom(t);
    const boot = syntheticProviderBootstrap();
    boot.fixture = false;
    const view = parseWebProviderBootstrap(boot);
    const api = { bootstrap: async () => view, account: async () => account } as unknown as ProviderApi;
    const live = await LiveBinding.connect(api);
    assert.equal(live.freeTierEnabled, expected.freeTier);
    assert.equal(live.signedUpPlayer, expected.signedUp);
    assert.equal(footerNote(live.freeTierEnabled, live.signedUpPlayer), text);
  });
