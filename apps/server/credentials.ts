import { lstatSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { DomainError, ensure } from '../../packages/domain/errors.ts';

/** Explicit CLI-only load. Tests and configuration diagnostics never call this implicitly. */
export function deepSeekEnvironment(path: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return selectedEnvironment(path, ['TEXT_PROVIDER', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_REVIEW_MODEL', 'DEEPSEEK_API_KEY'], inherited);
}

export function voiceEnvironment(path: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return selectedEnvironment(path, ['FISH_API_KEY', 'FISH_MODEL'], inherited);
}

export function sourceEnvironment(path: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return selectedEnvironment(path, ['WEIBO_ACCESS_TOKEN'], inherited);
}

function selectedEnvironment(path: string, allowed: string[], inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let values: NodeJS.ProcessEnv = {};
  try {
    const stat = lstatSync(path);
    ensure(stat.isFile() && stat.size <= 16_384 && (stat.mode & 0o077) === 0, 'INSECURE_ENV_FILE');
    values = parseEnv(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DomainError('ENV_FILE_UNREADABLE');
  }
  const selected: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (inherited[key] !== undefined) selected[key] = inherited[key];
    else if (values[key] !== undefined) selected[key] = values[key];
  }
  return selected;
}
