/**
 * Part 45: what opens at /s/<token>. It asks the public share route for the card and shows it; there is no sign-in, no session and
 * no cookie (the request omits credentials). Whatever goes wrong with the link (unknown, expired, purged, a network error that
 * leaves no card) shows the same page: 链接已过期 and 也来聊聊.
 */
import { expireSharedCard, renderSharedCard, renderSharedExpired, sharedCardData } from './shared-card.ts';
import { clearVoiceProgress, setVoiceProgress } from '../prototype/voice-progress.ts';
import type { PublicShareAnswer } from './shared-card.ts';

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{32}$/;
const API = '/api/web/provider/shares';

export async function readSharedCard(token: string, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  if (!SHARE_TOKEN.test(token)) return null;
  try {
    const response = await fetcher(`${API}/${token}`, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return null;
    const value = (await response.json()) as PublicShareAnswer;
    if (
      !value ||
      typeof value.displayName !== 'string' ||
      typeof value.characterId !== 'string' ||
      typeof value.voiceUrl !== 'string' ||
      value.voiceUrl !== `${API}/${token}/audio`
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export async function startSharePage(
  root: HTMLElement,
  token: string,
  deps: { fetcher?: typeof fetch; audio?: (url: string) => HTMLAudioElement } = {},
) {
  const fetcher = deps.fetcher ?? ((input, init) => fetch(input, init));
  const answer = await readSharedCard(token, fetcher);
  if (!answer) {
    renderSharedExpired(root);
    return;
  }
  let audio: HTMLAudioElement | null = null;
  let blobUrl: string | null = null;
  let loading = false;
  const page: HTMLElement = renderSharedCard(root, sharedCardData(answer), { play: () => void toggle() });
  const button = page.querySelector<HTMLElement>('.face-voice')!;
  const stop = () => {
    audio?.pause();
    button.removeAttribute('data-playing');
    clearVoiceProgress(button);
  };
  async function toggle() {
    if (audio && !audio.paused) {
      stop();
      return;
    }
    if (loading) return;
    if (!audio) {
      loading = true;
      try {
        // The voice is read through the same token; a link that has just run out answers like any unknown one.
        const response = await fetcher(answer!.voiceUrl, { credentials: 'omit', cache: 'no-store' });
        if (!response.ok) {
          expireSharedCard(page);
          return;
        }
        blobUrl = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'audio/wav' }));
      } catch {
        expireSharedCard(page);
        return;
      } finally {
        loading = false;
      }
      audio = deps.audio ? deps.audio(blobUrl) : new Audio(blobUrl);
      audio.addEventListener('timeupdate', () => {
        const total = audio!.duration;
        if (Number.isFinite(total) && total > 0)
          setVoiceProgress(button, audio!.currentTime / total);
      });
      audio.addEventListener('ended', stop);
      audio.addEventListener('pause', () => button.removeAttribute('data-playing'));
    }
    button.setAttribute('data-playing', 'true');
    try {
      await audio.play();
    } catch {
      stop();
    }
  }
  window.addEventListener('pagehide', () => {
    audio?.pause();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  });
}
