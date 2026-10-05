import type { WebLocalMessage } from '../../../../packages/contracts/web-local.ts';
import { LocalSession } from '../session/local-session.ts';

export type PlayResult = 'playing' | 'needs_user_gesture' | 'stale_generation';

/** Single current private published synthetic WAV; E must call play from a user action. */
export class LocalAudioController {
  private current: HTMLAudioElement | null = null;
  private url: string | null = null;
  private abort: AbortController | null = null;
  private ticket = 0;
  private selectedCharacter: string | null = null;
  private readonly session: LocalSession; private readonly fetcher: typeof fetch;
  private readonly makeAudio: () => HTMLAudioElement;
  constructor(session: LocalSession, fetcher: typeof fetch = (input, init) => fetch(input, init),
    makeAudio: () => HTMLAudioElement = () => new Audio()) {
    this.session = session; this.fetcher = fetcher; this.makeAudio = makeAudio;
    session.onInvalidate(() => { this.stop(); this.selectedCharacter = null; });
  }
  selectCharacter(characterId: string) {
    if (this.selectedCharacter !== characterId) { this.stop(); this.selectedCharacter = characterId; }
  }
  stop() {
    this.ticket++;
    this.abort?.abort(); this.abort = null;
    if (this.current && this.url) this.release(this.current, this.url);
    this.url = null;
    this.current = null;
  }
  private release(audio: HTMLAudioElement, url: string) {
    audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url);
  }
  async play(message: WebLocalMessage): Promise<PlayResult> {
    this.stop();
    if (this.selectedCharacter && this.selectedCharacter !== message.characterId)
      throw new Error('character selection changed');
    this.selectedCharacter = message.characterId;
    const scope = this.session.scope, ticket = this.ticket;
    if (scope && !this.session.contentAvailable(scope)) this.session.denyContent();
    if (!scope || !this.session.contentAvailable(scope) || message.author !== 'character' ||
        !['narrative', 'trial_footer'].includes(message.origin) ||
        message.audio?.status !== 'ready' || message.audio.synthetic !== true)
      throw new Error('published synthetic character audio required');
    const abort = new AbortController(); this.abort = abort;
    const path = `/api/web/local/conversations/${encodeURIComponent(message.conversationId)}` +
      `/messages/${encodeURIComponent(message.messageId)}/audio/${encodeURIComponent(message.audio.mediaId)}`;
    let response: Response;
    try { response = await this.fetcher(path, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal }); }
    catch (error) {
      if (ticket !== this.ticket || !this.session.contentAvailable(scope)) return 'stale_generation';
      throw error;
    }
    if (response.status === 410) { this.session.denyContent(); return 'stale_generation'; }
    if (!response.ok) throw new Error(`audio unavailable: ${response.status}`);
    const blob = await response.blob();
    if (!this.session.contentAvailable(scope) || ticket !== this.ticket) {
      if (this.session.isCurrent(scope) && !this.session.contentAvailable(scope)) this.session.denyContent();
      return 'stale_generation';
    }
    if (blob.type !== 'audio/wav' && blob.type !== 'audio/x-wav') throw new Error('unexpected audio format');
    const url = URL.createObjectURL(blob), audio = this.makeAudio();
    this.url = url; this.current = audio; audio.src = url;
    try { await audio.play(); }
    catch {
      if (ticket !== this.ticket || !this.session.contentAvailable(scope)) {
        this.release(audio, url); return 'stale_generation';
      }
      this.stop(); return 'needs_user_gesture';
    }
    if (!this.session.contentAvailable(scope) || ticket !== this.ticket) {
      if (this.session.isCurrent(scope) && !this.session.contentAvailable(scope)) this.session.denyContent();
      this.release(audio, url); return 'stale_generation';
    }
    return 'playing';
  }
}
