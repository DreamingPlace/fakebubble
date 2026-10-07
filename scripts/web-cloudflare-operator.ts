import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ensure } from '../packages/domain/errors.ts';
import type { WebCloudMaterialPackage } from '../apps/server/cloudflare/web-setup.ts';
import {
  validateCloudBudgetAuthorization,
  type CloudBudgetAuthorization,
} from '../apps/server/budget/web-provider-budget-contract.ts';
import { WEB_PROVIDER_CATALOG } from '../config/web-v1.ts';

const actions = [
  'business-object-id',
  'budget-object-id',
  'initialize',
  'asset',
  'budget-initialize',
  'status',
  'inspect',
  'budget-summary',
  'admin-grant',
  'admin-recovery-grant',
  'invite-grants',
] as const;
type Action = (typeof actions)[number];
export const DEFAULT_BUSINESS_SERVICE = 'fakebubble-business';
export const DEFAULT_BUDGET_SERVICE = 'fakebubble-budget';
const serviceName = /^[a-z0-9-]{1,63}$/;
export interface WebOperatorTarget {
  businessService: string;
  budgetService: string;
}
export interface WebOperatorArguments extends WebOperatorTarget {
  action: Action;
  receiptFile: string;
  inputFile?: string;
  name?: string;
}
interface Operator {
  objectId(name: string): Promise<string>;
  initialize(value: WebCloudMaterialPackage | CloudBudgetAuthorization[]): Promise<unknown>;
  importFixed(kind: 'welcome' | 'footer', characterId: string, bytes: Uint8Array): Promise<unknown>;
  status(): Promise<unknown>;
  /** Optional only so an older binding fails closed with a clear code instead of a TypeError. */
  inspect?(): Promise<unknown>;
  summary(): Promise<unknown>;
  adminGrant(): Promise<unknown>;
  inviteGrants(inviteId: string): Promise<unknown>;
  adminRecoveryGrant(memberId: string): Promise<unknown>;
}
interface Proxy {
  env: { OPERATOR?: Operator };
  dispose(): Promise<void>;
}
type GetProxy = (options: { configPath: string; envFiles: []; persist: false; remoteBindings: true }) => Promise<Proxy>;
interface Prepared {
  args: WebOperatorArguments;
  input?: WebCloudMaterialPackage | CloudBudgetAuthorization[];
  asset?: { kind: 'welcome' | 'footer'; characterId: string; bytes: Uint8Array };
}
const budgetAction = (action: Action) => action.startsWith('budget-');
const defaultTarget: WebOperatorTarget = {
  businessService: DEFAULT_BUSINESS_SERVICE,
  budgetService: DEFAULT_BUDGET_SERVICE,
};
const target = (action: Action, services: WebOperatorTarget) =>
  budgetAction(action) ? services.budgetService : services.businessService;
function privateFile(path: string, maximum: number) {
  ensure(isAbsolute(path), 'WEB_OPERATOR_ABSOLUTE_PATH_REQUIRED');
  const stat = lstatSync(path);
  ensure(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size <= maximum,
    'WEB_OPERATOR_PRIVATE_FILE_REQUIRED',
  );
  return readFileSync(path);
}
export function webOperatorArguments(argv: string[]): WebOperatorArguments {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    ensure(
      match && !values.has(match[1]!) && !/[\u0000-\u001f\u007f]/.test(match[2]!),
      'WEB_OPERATOR_ARGUMENT_INVALID',
    );
    values.set(match[1]!, match[2]!);
  }
  const action = values.get('action') as Action;
  ensure(actions.includes(action), 'WEB_OPERATOR_ACTION_REQUIRED');
  const allowed = ['action', 'receipt-file', 'business-service', 'budget-service'];
  if (['initialize', 'asset', 'budget-initialize'].includes(action)) allowed.push('input-file');
  if (action.endsWith('-object-id') || action === 'invite-grants' || action === 'admin-recovery-grant')
    allowed.push('name');
  ensure(
    [...values.keys()].every((key) => allowed.includes(key)),
    'WEB_OPERATOR_ARGUMENT_INVALID',
  );
  const receiptFile = values.get('receipt-file');
  ensure(receiptFile && isAbsolute(receiptFile), 'WEB_OPERATOR_RECEIPT_REQUIRED');
  const businessService = values.get('business-service') ?? DEFAULT_BUSINESS_SERVICE,
    budgetService = values.get('budget-service') ?? DEFAULT_BUDGET_SERVICE;
  ensure(serviceName.test(businessService) && serviceName.test(budgetService), 'WEB_OPERATOR_SERVICE_INVALID');
  const result: WebOperatorArguments = { action, receiptFile: resolve(receiptFile), businessService, budgetService };
  if (allowed.includes('input-file')) {
    const inputFile = values.get('input-file');
    ensure(inputFile && isAbsolute(inputFile), 'WEB_OPERATOR_INPUT_REQUIRED');
    result.inputFile = resolve(inputFile);
  }
  if (allowed.includes('name')) {
    const name = values.get('name');
    ensure(name && /^[A-Za-z0-9_-]{1,128}$/.test(name), 'WEB_OPERATOR_NAME_REQUIRED');
    result.name = name;
  }
  return result;
}
export function webOperatorConfig(
  action: Action,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  services: WebOperatorTarget = defaultTarget,
) {
  ensure(
    serviceName.test(services.businessService) && serviceName.test(services.budgetService),
    'WEB_OPERATOR_SERVICE_INVALID',
  );
  ensure(typeof accountId === 'string' && /^[a-f0-9]{32}$/.test(accountId), 'WEB_OPERATOR_ACCOUNT_REQUIRED');
  return {
    name: 'fakebubble-local-operator',
    main: './operator.mjs',
    compatibility_date: '2026-07-30',
    account_id: accountId,
    workers_dev: false,
    preview_urls: false,
    routes: [],
    services: [
      {
        binding: 'OPERATOR',
        service: target(action, services),
        entrypoint: budgetAction(action) ? 'WebBudgetOperatorService' : 'WebOperatorService',
        remote: true,
      },
    ],
  };
}
export function prepareWebOperation(args: WebOperatorArguments): Prepared {
  if (!args.inputFile) return { args };
  const value = JSON.parse(privateFile(args.inputFile, 2_000_000).toString('utf8'));
  if (args.action === 'asset') {
    ensure(
      value &&
        Object.keys(value).sort().join(',') === 'byteLength,characterId,kind,path,sha256' &&
        ['welcome', 'footer'].includes(value.kind) &&
        WEB_PROVIDER_CATALOG.some((item) => item.characterId === value.characterId) &&
        typeof value.path === 'string' &&
        Number.isSafeInteger(value.byteLength) &&
        value.byteLength > 0 &&
        /^[a-f0-9]{64}$/.test(value.sha256),
      'WEB_OPERATOR_ASSET_INVALID',
    );
    const bytes = privateFile(value.path, 6_000_000);
    ensure(
      bytes.length === value.byteLength && createHash('sha256').update(bytes).digest('hex') === value.sha256,
      'WEB_OPERATOR_ASSET_INTEGRITY',
    );
    return { args, asset: { kind: value.kind, characterId: value.characterId, bytes } };
  }
  if (args.action === 'budget-initialize') {
    ensure(Array.isArray(value) && value.length === 2, 'WEB_OPERATOR_GRANTS_INVALID');
    for (const grant of value) validateCloudBudgetAuthorization(grant);
    ensure(
      new Set(value.map((g: CloudBudgetAuthorization) => g.provider)).size === 2 &&
        new Set(value.map((g: CloudBudgetAuthorization) => g.version)).size === 1,
      'WEB_OPERATOR_GRANTS_INVALID',
    );
  } else
    ensure(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Array.isArray(value.selected) &&
        Array.isArray(value.assets),
      'WEB_OPERATOR_MATERIAL_REQUIRED',
    );
  return { args, input: value };
}
/**
 * An existing receipt is never continued or overwritten (the exclusive create below still fails with EEXIST), but
 * one that was written for a different target is refused first, by name, so the operator is not pointed at the
 * wrong deployment's history. Receipts from before targets were recorded are compared by their worker name.
 */
function refuseForeignReceipt(args: WebOperatorArguments) {
  let first: { action?: unknown; worker?: unknown; target?: unknown };
  try {
    first = JSON.parse(readFileSync(args.receiptFile, 'utf8').split('\n', 1)[0]!);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw new Error('WEB_OPERATOR_RECEIPT_UNREADABLE');
  }
  const recorded = first?.target as Partial<WebOperatorTarget> | undefined;
  ensure(
    recorded
      ? recorded.businessService === args.businessService && recorded.budgetService === args.budgetService
      : first?.worker === target(args.action, args),
    'WEB_OPERATOR_RECEIPT_TARGET_MISMATCH',
  );
}
/** Authenticated service binding only; never opens a public operator HTTP route or logs RPC results. */
export async function runWebOperator(prepared: Prepared, getProxy: GetProxy, configPath: string) {
  const { args } = prepared,
    dir = lstatSync(dirname(args.receiptFile));
  ensure(
    dir.isDirectory() && !dir.isSymbolicLink() && (dir.mode & 0o077) === 0,
    'WEB_OPERATOR_PRIVATE_RECEIPT_DIRECTORY_REQUIRED',
  );
  refuseForeignReceipt(args);
  const fd = openSync(args.receiptFile, 'wx', 0o600);
  const record = (state: string, detail: unknown) => {
    writeFileSync(
      fd,
      JSON.stringify({
        state,
        action: args.action,
        worker: target(args.action, args),
        target: { businessService: args.businessService, budgetService: args.budgetService },
        detail,
      }) + '\n',
    );
    fsyncSync(fd);
  };
  let platform: Proxy | undefined;
  try {
    record('prepared', null);
    platform = await getProxy({ configPath, envFiles: [], persist: false, remoteBindings: true });
    const operator = platform.env.OPERATOR;
    ensure(operator, 'WEB_OPERATOR_BINDING_REQUIRED');
    let result: unknown;
    switch (args.action) {
      case 'business-object-id':
      case 'budget-object-id':
        result = await operator.objectId(args.name!);
        break;
      case 'initialize':
      case 'budget-initialize':
        result = await operator.initialize(prepared.input!);
        break;
      case 'asset':
        result = await operator.importFixed(prepared.asset!.kind, prepared.asset!.characterId, prepared.asset!.bytes);
        break;
      case 'status':
        result = await operator.status();
        break;
      case 'inspect':
        ensure(operator.inspect, 'WEB_OPERATOR_INSPECT_UNSUPPORTED');
        result = await operator.inspect();
        break;
      case 'budget-summary':
        result = await operator.summary();
        break;
      case 'admin-grant':
        result = await operator.adminGrant();
        break;
      case 'admin-recovery-grant':
        result = await operator.adminRecoveryGrant(args.name!);
        break;
      case 'invite-grants':
        result = await operator.inviteGrants(args.name!);
        break;
    }
    record('completed', result ?? null);
    return { action: args.action, receiptFile: args.receiptFile };
  } catch (error) {
    // Bounded diagnostics stay in the exclusive local receipt, not stdout or the deployment package.
    record('unknown', { error: error instanceof Error ? error.message.slice(0, 2048) : 'WEB_OPERATOR_FAILED' });
    throw new Error('WEB_OPERATOR_FAILED');
  } finally {
    try {
      await platform?.dispose();
    } catch {
      record('unknown', { error: 'WEB_OPERATOR_DISPOSE_FAILED' });
      throw new Error('WEB_OPERATOR_FAILED');
    } finally {
      closeSync(fd);
    }
  }
}
/** Offline: no network, no Cloudflare binding. Hashes exactly what the business object hashes and verifies. */
export async function expectedMigrationsReport() {
  const { registerSqlTextLoader } = await import('./web-sql-text.ts');
  registerSqlTextLoader();
  const { expectedWebMigrations } = await import('../workers/web-cloudflare/migrations.ts');
  return expectedWebMigrations();
}
async function main() {
  if (process.argv[2] === 'expected-migrations') {
    ensure(process.argv.length === 3, 'WEB_OPERATOR_ARGUMENT_INVALID');
    const report = await expectedMigrationsReport();
    const list = (rows: { version: number; sha256: string }[]) =>
      '[\n' + rows.map((row) => '    ' + JSON.stringify(row)).join(',\n') + '\n  ]';
    console.log(`{\n  "inline": ${list(report.inline)},\n  "r2": ${list(report.r2)}\n}`);
    return;
  }
  const prepared = prepareWebOperation(webOperatorArguments(process.argv.slice(2)));
  const modulePath = process.env.FAKE_WEB_WRANGLER_MODULE;
  ensure(modulePath && isAbsolute(modulePath), 'WEB_OPERATOR_WRANGLER_MODULE_REQUIRED');
  const module = (await import(resolve(modulePath))) as { getPlatformProxy?: GetProxy };
  ensure(typeof module.getPlatformProxy === 'function', 'WEB_OPERATOR_WRANGLER_API_REQUIRED');
  const root = mkdtempSync(join(tmpdir(), 'fake-web-operator-'));
  try {
    const configPath = join(root, 'wrangler.json');
    writeFileSync(
      join(root, 'operator.mjs'),
      'export default { fetch() { return new Response(null,{status:404}); } };',
      { flag: 'wx', mode: 0o600 },
    );
    writeFileSync(configPath, JSON.stringify(webOperatorConfig(prepared.args.action, undefined, prepared.args)), {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify(await runWebOperator(prepared, module.getPlatformProxy, configPath)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (import.meta.main)
  void main().catch(() => {
    process.stderr.write('WEB_OPERATOR_FAILED: inspect the private receipt; do not auto-retry unknown operations.\n');
    process.exitCode = 1;
  });
