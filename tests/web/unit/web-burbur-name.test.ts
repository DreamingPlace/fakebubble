import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cloudAdminMailer } from '../../../apps/server/cloudflare/web-admin-mail.ts';

// Part 24b-5: the product and the operator are called Burbur everywhere a person reads a name.
const read = (path: string) => readFileSync(path, 'utf8');

test('administrator emails carry Burbur in the subject', async () => {
  const subjects: string[] = [];
  const mailer = cloudAdminMailer(
    {
      send: async (message) => {
        subjects.push(message.subject);
        return { messageId: 'sent' };
      },
    },
    'no-reply@mail.example.com',
    () => {},
  );
  for (const purpose of ['bind', 'reset'] as const)
    await mailer.send({ id: purpose, to: 'admin@example.com', purpose, code: '123456', expiresAt: 0 });
  assert.deepEqual(subjects, ['Burbur · 管理员邮箱验证', 'Burbur · 管理员密码重置']);
});

test('legal pages, apex footer, console title and README use Burbur and no longer the old name', () => {
  for (const name of ['privacy.html', 'terms.html'])
    assert.ok(
      read(`apps/player-web/src/legal/${name}`).includes('Burbur 开源项目（个人维护，非公司主体）'),
      `${name} operator`,
    );
  assert.ok(read('workers/apex-site/public/index.html').includes('<p>Burbur · AI 角色聊天</p>'));
  assert.ok(
    read('apps/player-web/src/features/admin/account-admin-page.ts').includes('<h1 tabindex="-1">Burbur 管理</h1>'),
  );
  for (const path of [
    'apps/player-web/src/legal/privacy.html',
    'apps/player-web/src/legal/terms.html',
    'workers/apex-site/public/index.html',
    'apps/player-web/src/features/admin/account-admin-page.ts',
    'apps/server/cloudflare/web-admin-mail.ts',
    'README.md',
  ])
    assert.doesNotMatch(read(path), /FAKE *泡泡|FAKE Bubble/, path);
});
