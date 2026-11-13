import { h } from '../../cocreation/h.ts';
import type { PreviewAdminClient } from '../../../services/preview-admin-api.ts';
import type { SpeechClip, SpeechEstimate } from '../../../services/speech-admin-api.ts';
import { paidButton } from '../ui/paid-button.ts';
import { micros } from './copy.ts';

/**
 * Part 24k-1: 试听 on a succeeded 预演. One paid button (the shared paid-button: the first click names the cost, the second sends)
 * speaks the final bubbles through the admin speech path, then plays them. A 预演 that was already spoken shows a free 播放 instead:
 * the clips are kept, so listening again never pays again. The 预演 result itself is untouched.
 */
export type ListenHost = {
  api: Pick<PreviewAdminClient, 'speechEstimate' | 'listen' | 'clips' | 'clipAudio'>;
  characterId: string;
  previewId: string;
  /** The server runs the admin speech path at all. */
  available: () => boolean;
  /** The draft has a voice reference (a prepared 素材版本, the live binding, or the Fish ID a profile import recorded). */
  hasVoice: () => boolean;
  allowed: () => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  newId: () => string;
  disposed: () => boolean;
  /** Plays one clip; resolves when it ends. Injected in tests. */
  play?: (url: string, signal: AbortSignal) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};
export const NO_VOICE_REASON = '先填音色编号';
const REASONS: Record<string, string> = {
  NO_VOICE_REFERENCE: NO_VOICE_REASON,
  PRICE_MISSING: 'Fish 价格未生效，先到「系统」续期价格',
  TEXT_INVALID: '气泡含不能朗读的符号，或太长',
  NOT_SUCCEEDED: '预演还没有结果',
  NO_BUBBLES: '没有可朗读的气泡',
};
const playUrl = (url: string, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    const stop = () => {
      audio.pause();
      resolve();
    };
    signal.addEventListener('abort', stop, { once: true });
    audio.addEventListener('ended', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error('AUDIO_PLAY_FAILED')), { once: true });
    void audio.play().catch(reject);
  });

export function listenBar(host: ListenHost) {
  let clips: SpeechClip[] | null = null;
  let estimate: SpeechEstimate | null = null;
  let phase: 'idle' | 'speaking' | 'playing' = 'idle';
  let at = 0;
  let controller: AbortController | null = null;
  let disposed = false;
  const urls = new Map<string, string>();
  const status = h('span', { class: 'pw-listen-status', attrs: { 'aria-live': 'polite' } });
  const play = h('button', {
    class: 'pw-play',
    text: '播放',
    attrs: { type: 'button', 'data-pw-play': host.previewId },
    hidden: true,
  });
  const stop = h('button', { class: 'pw-cancel', text: '停止', attrs: { type: 'button' }, hidden: true });
  const reason = (): string => {
    if (!host.allowed()) return '你没有预演权限';
    if (!host.hasVoice()) return NO_VOICE_REASON;
    if (clips === null || estimate === null) return '正在读取';
    if (!estimate.ok) return REASONS[estimate.reason] ?? '暂不能试听';
    if (phase !== 'idle') return '正在朗读';
    return '';
  };
  const cost = () => (estimate?.ok ? micros(estimate.estimateMicros) : '');
  const bar = paidButton({
    name: `listen-${host.previewId}`,
    label: () => (cost() ? `试听 · 约 ${cost()}` : '试听'),
    confirmLabel: () => `确认付费 · ${cost()}`,
    reason,
    onConfirm: () => void speak(),
    ...(host.setTimer ? { setTimer: host.setTimer } : {}),
    ...(host.clearTimer ? { clearTimer: host.clearTimer } : {}),
  });
  const root = h('div', { class: 'pw-listen', attrs: { 'data-state': 'idle' } }, bar.root, play, stop, status);
  const paint = () => {
    const spoken = (clips?.length ?? 0) > 0;
    root.dataset.state = phase === 'idle' ? (spoken ? 'ready' : 'idle') : phase;
    // Spoken already: the free 播放 replaces the paid button (listening again never pays again).
    bar.root.hidden = spoken;
    play.hidden = !spoken || phase !== 'idle';
    stop.hidden = phase !== 'playing';
    status.textContent =
      phase === 'speaking'
        ? '正在朗读…'
        : phase === 'playing'
          ? `播放中 ${at + 1}/${clips?.length ?? 0}`
          : spoken
            ? `已朗读 · ${((clips ?? []).reduce((n, c) => n + c.durationMs, 0) / 1000).toFixed(1)} 秒`
            : '';
    bar.refresh();
  };
  async function urlOf(clip: SpeechClip) {
    const known = urls.get(clip.callId);
    if (known) return known;
    const audio = await host.api.clipAudio(host.characterId, clip.callId);
    const bytes = Uint8Array.from(atob(audio.base64), (c) => c.charCodeAt(0));
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (digest !== clip.sha256) throw new Error('AUDIO_HASH_MISMATCH');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    urls.set(clip.callId, url);
    return url;
  }
  async function playAll() {
    if (!clips?.length || phase === 'playing') return;
    phase = 'playing';
    controller = new AbortController();
    const signal = controller.signal;
    try {
      for (at = 0; at < clips.length && !signal.aborted && !disposed; at++) {
        paint();
        await (host.play ?? playUrl)(await urlOf(clips[at]!), signal);
      }
    } finally {
      phase = 'idle';
      controller = null;
      at = 0;
      if (!disposed) paint();
    }
  }
  async function speak() {
    if (phase !== 'idle' || !estimate?.ok) return;
    const acknowledgeMicros = estimate.estimateMicros;
    phase = 'speaking';
    paint();
    try {
      await host.run(async () => {
        const spoken = await host.api.listen(host.characterId, {
          requestId: host.newId(),
          previewId: host.previewId,
          acknowledgeMicros,
        });
        if (disposed || host.disposed()) return;
        clips = spoken;
      });
    } finally {
      phase = 'idle';
      if (!disposed) paint();
    }
    // Then plays them. Playing is not a request: it never locks the page, and a failure is only said here.
    if (clips?.length && !disposed) await playSafely();
  }
  const playSafely = () =>
    playAll().catch(() => {
      if (!disposed) status.textContent = '播放失败，可再点播放';
    });
  play.addEventListener('click', () => void playSafely());
  stop.addEventListener('click', () => controller?.abort());
  async function load() {
    if (!host.available()) {
      root.hidden = true;
      return;
    }
    // Reads only, and issued while the row's own read may still hold the page's busy lock, so it does not go through `run`.
    try {
      clips = await host.api.clips(host.characterId, host.previewId);
      if (!clips.length && host.hasVoice()) estimate = await host.api.speechEstimate(host.characterId, host.previewId);
      else estimate = { ok: false, reason: host.hasVoice() ? 'NO_BUBBLES' : 'NO_VOICE_REFERENCE' };
    } catch {
      clips = clips ?? [];
      estimate = { ok: false, reason: 'UNAVAILABLE' };
    }
    if (!disposed && !host.disposed()) paint();
  }
  paint();
  void load();
  return {
    root,
    refresh: paint,
    dispose() {
      disposed = true;
      controller?.abort();
      bar.dispose();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
