/** Separate local-3 candidate; local-1/local-2 parsers and UI remain unchanged. */
import { parseOperation, WebLocalProtocolError } from './web-local-client.ts';
import type { WebLocalBootstrap } from './web-local.ts';

export interface WebInviteAccess {
  kind: 'invite';
  principalId: string;
  playerId: string;
  worldId: string;
  revision: number;
  grantId: string;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: number | null;
  canSend: boolean;
  canChooseText: boolean;
  trialCharacterId: string | null;
  trialRemaining: null;
  trialReserved: null;
  retentionState: 'protected';
  trialExpiresAt: null;
}
export type WebInviteBootstrap = Omit<WebLocalBootstrap, 'contractVersion' | 'access'> & {
  contractVersion: 'web-v1-local-3';
  access: WebInviteAccess;
};
export type WebInviteView = {
  kind: 'synthetic-local';
  bootstrap: WebInviteBootstrap;
  capabilities: { sendVoice: true; read: false; listened: false; invite: true; audition: false };
};
export interface WebInviteStatus {
  grantId: string;
  principalId: string;
  expiresAt: number | null;
}
export interface WebInviteReceipt extends WebInviteStatus {
  csrf: string;
}
export interface WebInviteRecoveryResult extends WebInviteReceipt {
  recoverySecret: string;
  duplicate: boolean;
}
export interface WebInviteCredential {
  grantId: string;
  secret: string;
  expiresAt: number | null;
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WEB_INVITE_PROTOCOL_INVALID');
  return value as Record<string, unknown>;
};
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const millis = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const expiry = (value: unknown) => value === null || millis(value);
const invalid = (): never => {
  throw new Error('WEB_INVITE_PROTOCOL_INVALID');
};
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).sort().join(',') === names.sort().join(',');

export function parseWebInviteAccess(value: unknown): WebInviteAccess {
  const row = object(value);
  if (
    !keys(row, [
      'kind',
      'principalId',
      'playerId',
      'worldId',
      'revision',
      'grantId',
      'status',
      'expiresAt',
      'canSend',
      'canChooseText',
      'trialCharacterId',
      'trialRemaining',
      'trialReserved',
      'retentionState',
      'trialExpiresAt',
    ]) ||
    row.kind !== 'invite' ||
    !id(row.principalId) ||
    !id(row.playerId) ||
    !id(row.worldId) ||
    !millis(row.revision) ||
    !id(row.grantId) ||
    !['active', 'expired', 'revoked'].includes(String(row.status)) ||
    !expiry(row.expiresAt) ||
    typeof row.canSend !== 'boolean' ||
    typeof row.canChooseText !== 'boolean' ||
    !(row.trialCharacterId === null || id(row.trialCharacterId)) ||
    row.trialRemaining !== null ||
    row.trialReserved !== null ||
    row.retentionState !== 'protected' ||
    row.trialExpiresAt !== null ||
    (row.status !== 'active' && row.canSend)
  )
    invalid();
  return row as unknown as WebInviteAccess;
}

export function parseWebInviteBootstrap(value: unknown): WebInviteView {
  const row = object(value);
  if (
    row.contractVersion !== 'web-v1-local-3' ||
    row.mode !== 'synthetic-local' ||
    row.region !== 'local-test' ||
    !id(row.instanceId) ||
    !id(row.recoveryEpoch) ||
    !id(row.csrf) ||
    !id(row.syncCursor) ||
    !Array.isArray(row.characters) ||
    !Array.isArray(row.conversations) ||
    !Array.isArray(row.activeOperations) ||
    !Array.isArray(row.unsupported) ||
    !row.unsupported.every(id)
  )
    invalid();
  parseWebInviteAccess(row.access);
  for (const raw of row.characters as unknown[]) {
    const character = object(raw),
      audition = object(character.audition);
    if (
      !id(character.characterId) ||
      !id(character.name) ||
      character.synthetic !== true ||
      audition.state !== 'unavailable' ||
      audition.reason !== 'not_approved'
    )
      invalid();
  }
  for (const raw of row.conversations as unknown[]) {
    const conversation = object(raw);
    if (!id(conversation.conversationId) || !id(conversation.characterId)) invalid();
  }
  try {
    (row.activeOperations as unknown[]).forEach(parseOperation);
  } catch (error) {
    if (error instanceof WebLocalProtocolError) invalid();
    throw error;
  }
  return {
    kind: 'synthetic-local',
    bootstrap: row as unknown as WebInviteBootstrap,
    capabilities: { sendVoice: true, read: false, listened: false, invite: true, audition: false },
  };
}

export function parseWebInviteStatus(value: unknown): WebInviteStatus {
  const row = object(value);
  if (
    !keys(row, ['grantId', 'principalId', 'expiresAt']) ||
    !id(row.grantId) ||
    !id(row.principalId) ||
    !expiry(row.expiresAt)
  )
    invalid();
  return row as unknown as WebInviteStatus;
}

export function parseWebInviteReceipt(value: unknown): WebInviteReceipt {
  const row = object(value);
  if (
    !keys(row, ['grantId', 'principalId', 'expiresAt', 'csrf']) ||
    !id(row.grantId) ||
    !id(row.principalId) ||
    !expiry(row.expiresAt) ||
    !id(row.csrf)
  )
    invalid();
  return row as unknown as WebInviteReceipt;
}

export function parseWebInviteRecovery(value: unknown): WebInviteRecoveryResult {
  const row = object(value);
  if (
    !keys(row, ['grantId', 'principalId', 'expiresAt', 'csrf', 'recoverySecret', 'duplicate']) ||
    !id(row.grantId) ||
    !id(row.principalId) ||
    !expiry(row.expiresAt) ||
    !id(row.csrf) ||
    typeof row.recoverySecret !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(row.recoverySecret) ||
    typeof row.duplicate !== 'boolean'
  )
    invalid();
  return row as unknown as WebInviteRecoveryResult;
}

export function parseWebInviteCredential(value: unknown): WebInviteCredential {
  const row = object(value);
  if (
    !keys(row, ['grantId', 'secret', 'expiresAt']) ||
    !id(row.grantId) ||
    !expiry(row.expiresAt) ||
    typeof row.secret !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(row.secret)
  )
    invalid();
  return row as unknown as WebInviteCredential;
}
