import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { WebStore } from '../apps/server/platform/store.ts';
import { WebLocalServer } from '../apps/server/platform/web-local-server.ts';
import { WebInviteAdmin } from '../apps/server/invites/web-invite-admin.ts';
import { initLocalInstance, readLocalConfig } from '../apps/server/platform/web-local-config.ts';
import { defaultSchedule } from '../packages/domain/defaults.ts';
import { ensure } from '../packages/domain/errors.ts';

const [action, root] = process.argv.slice(2);
ensure(
  (action === 'init' ||
    action === 'migrate' ||
    action === 'serve' ||
    action === 'migrate-data-lifecycle' ||
    action === 'serve-data-lifecycle' ||
    action === 'migrate-invites' ||
    action === 'serve-invites' ||
    action === 'admin-grant') &&
    typeof root === 'string',
  'WEB_LOCAL_USAGE',
);

if (action === 'init') {
  const initialized = initLocalInstance(root);
  process.stdout.write(
    JSON.stringify({
      action: 'init',
      root: initialized.root,
      certificate: initialized.certificate,
      instanceId: initialized.instanceId,
    }) + '\n',
  );
} else {
  const config = readLocalConfig(root);
  const inviteTest = action === 'migrate-invites' || action === 'serve-invites' || action === 'admin-grant';
  const dataLifecycleTest = inviteTest || action === 'migrate-data-lifecycle' || action === 'serve-data-lifecycle';
  const store = new WebStore(root, {
    create: false,
    instanceId: config.instanceId,
    concurrency: config.concurrency,
    dailyReplyLimit: config.dailyReplyLimit,
    ...(dataLifecycleTest ? { dataLifecycleTest: true as const } : {}),
    ...(inviteTest ? { inviteTest: true as const } : {}),
  });
  if (action === 'migrate') {
    try {
      store.migrateStages();
      store.migrateAdmissionOrder();
      store.migrateIdentity(config.recoveryEpoch);
      store.migrateDispatchLedger();
      store.migrateSyntheticVoiceQueue();
      store.migrateInputSnapshot();
      store.migrateSyntheticPrivateAudio();
      store.migrateVerticalCandidate();
      store.migrateLocalTransport();
      store.run(
        'INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)',
        'synthetic-local',
        1,
        JSON.stringify({
          id: 'synthetic-local',
          name: '合成测试人物',
          version: 1,
          fictional: true,
          persona: '仅供本地离线接口测试，不是真实人物设定。',
          schedule: defaultSchedule(),
        }),
      );
      process.stdout.write(JSON.stringify({ action: 'migrate', root, schema: 109 }) + '\n');
    } finally {
      store.close();
    }
  } else if (action === 'migrate-data-lifecycle') {
    try {
      const clock = { now: () => Date.now() };
      store.migrateDataLifecycle(clock);
      process.stdout.write(JSON.stringify({ action, root, schema: 110, mode: 'synthetic-local' }) + '\n');
    } finally {
      store.close();
    }
  } else if (action === 'migrate-invites') {
    try {
      store.migrateInviteCore();
      store.migrateInviteIdentity();
      process.stdout.write(JSON.stringify({ action, root, schema: 112, mode: 'synthetic-local' }) + '\n');
    } finally {
      store.close();
    }
  } else if (action === 'admin-grant') {
    try {
      store.requireInviteTest();
      const grant = new WebInviteAdmin(store, { now: () => Date.now() }, config.origin).issueLoginGrant();
      const file = join(root, `admin-login-grant-${randomUUID()}.json`);
      writeFileSync(file, JSON.stringify(grant), { flag: 'wx', mode: 0o600, flush: true });
      process.stdout.write(JSON.stringify({ action, file, expiresAt: grant.expiresAt }) + '\n');
    } finally {
      store.close();
    }
  } else {
    if (action === 'serve-data-lifecycle') {
      try {
        ensure(
          store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 110,
          'WEB_DATA_TEST_SCHEMA_REQUIRED',
        );
      } catch (error) {
        store.close();
        throw error;
      }
    }
    if (action === 'serve-invites') {
      try {
        store.requireInviteTest();
      } catch (error) {
        store.close();
        throw error;
      }
    }
    const clock = { now: () => Date.now() };
    const app = new WebLocalServer(store, config, clock);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      store.close();
    };
    process.on('SIGINT', () => {
      void stop();
    });
    process.on('SIGTERM', () => {
      void stop();
    });
    try {
      await app.listen();
      process.stdout.write(
        JSON.stringify({
          action,
          mode: config.mode,
          origin: config.origin,
          certificate: join(root, 'local-cert.pem'),
        }) + '\n',
      );
    } catch (error) {
      store.close();
      throw error;
    }
  }
}
