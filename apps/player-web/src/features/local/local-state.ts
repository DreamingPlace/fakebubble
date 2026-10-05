import type { WebLocalMessage, WebLocalOperation } from '../../../../../packages/contracts/web-local.ts';
import type { LocalScope } from '../../session/local-session.ts';

export function sameScope(a: LocalScope | null, b: LocalScope): boolean {
  return a !== null && a.instanceId === b.instanceId && a.recoveryEpoch === b.recoveryEpoch &&
    a.principalId === b.principalId && a.worldId === b.worldId && a.generation === b.generation;
}

export function operationLabel(operation: WebLocalOperation): string {
  const labels: Record<WebLocalOperation['status'], string> = {
    queued: '已接纳，等待处理', text_running: '正在生成回复', text_ready: '回复文字已就绪',
    audio_pending: '等待语音处理', audio_running: '正在生成语音',
    ready_to_publish: '即将发布', published: '回复已发布',
    retryable_failed: '处理失败，需人工确认后重试', failed: '处理失败',
    cancelled: '已取消', unknown: '结果待核对，请勿重复发送',
  };
  return labels[operation.status];
}

export function playable(message: WebLocalMessage): boolean {
  return message.author === 'character' && (message.origin === 'narrative' || message.origin === 'trial_footer') &&
    message.audio?.status === 'ready' && message.audio.synthetic === true;
}
