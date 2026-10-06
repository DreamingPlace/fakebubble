import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WebStore } from './store.ts';
import { readWebV7Request } from '../generation/web-v7-request.ts';

/** The saved full output is usable only with its original frozen request and known receipt. */
export function readKnownTextOutput(store: WebStore, operationId: string, phase: 'draft' | 'review'): unknown {
  const frozen = readWebV7Request(store, operationId);
  const row = store.get<{ output_json: string; output_digest: string; request_digest: string }>(
    'SELECT * FROM web_local_text_outputs WHERE operation_id=? AND phase=?',
    operationId,
    phase,
  );
  const attempt = store.get<{ receipt_json: string; dispatch_state: string; outcome: string }>(
    `SELECT receipt_json,dispatch_state,outcome FROM web_external_attempts
      WHERE operation_id=? AND stage='text' AND phase=? AND ordinal=-1`,
    operationId,
    phase,
  );
  ensure(
    row &&
      attempt?.dispatch_state === 'known' &&
      attempt.outcome === 'succeeded' &&
      row.request_digest === frozen.row.request_digest &&
      createHash('sha256').update(row.output_json).digest('hex') === row.output_digest,
    'WEB_TEXT_OUTPUT_INVALID',
  );
  let receipt: unknown;
  try {
    receipt = JSON.parse(attempt.receipt_json);
  } catch {
    receipt = null;
  }
  ensure(
    receipt !== null &&
      typeof receipt === 'object' &&
      (receipt as Record<string, unknown>).origin === 'synthetic_test' &&
      (receipt as Record<string, unknown>).outputDigest === row.output_digest,
    'WEB_TEXT_OUTPUT_INVALID',
  );
  return JSON.parse(row.output_json) as unknown;
}

export function readKnownAudioOutput(store: WebStore, operationId: string, ordinal: number): Buffer {
  const row = store.get<{ bytes: Uint8Array; byte_length: number; sha256: string }>(
    'SELECT bytes,byte_length,sha256 FROM web_local_audio_outputs WHERE operation_id=? AND ordinal=?',
    operationId,
    ordinal,
  );
  const attempt = store.get<{ receipt_json: string; dispatch_state: string; outcome: string }>(
    `SELECT receipt_json,dispatch_state,outcome FROM web_external_attempts WHERE operation_id=?
      AND stage='audio' AND phase='speech' AND ordinal=?`,
    operationId,
    ordinal,
  );
  ensure(
    row &&
      attempt?.dispatch_state === 'known' &&
      attempt.outcome === 'succeeded' &&
      row.bytes.length === row.byte_length &&
      createHash('sha256').update(row.bytes).digest('hex') === row.sha256,
    'WEB_AUDIO_OUTPUT_INVALID',
  );
  let receipt: unknown;
  try {
    receipt = JSON.parse(attempt.receipt_json);
  } catch {
    receipt = null;
  }
  ensure(
    receipt !== null &&
      typeof receipt === 'object' &&
      (receipt as Record<string, unknown>).origin === 'synthetic_test' &&
      (receipt as Record<string, unknown>).outputDigest === row.sha256,
    'WEB_AUDIO_OUTPUT_INVALID',
  );
  return Buffer.from(row.bytes);
}
