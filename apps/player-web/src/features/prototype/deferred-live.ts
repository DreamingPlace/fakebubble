import type { WebProviderCharacter } from '../../../../../packages/contracts/web-provider.ts';
import type { WebPublicCatalog } from '../../../../../packages/contracts/web-public-catalog.ts';
import { providerPeople, type Person } from './provider-catalog-view.ts';
import type { LiveBinding, Shell } from './provider-binding.ts';
import type { ShellLive } from './preview.ts';
import type { VerifySheet } from './verify-sheet.ts';

/**
 * Part 48: the cards of the public catalog as the page's people. The Latin name, the No., the palette and the skin come from the very same
 * rules the session's own catalog goes through (`providerPeople`); what the public catalog does not have (the welcome line, the clip's
 * length) is filled in when the session arrives. A chat card stands for a character that is available; the placeholder line it carries
 * is never shown (the chat it belongs to opens only with a session).
 */
export function publicPeople(catalog: WebPublicCatalog): Person[] {
  const characters = catalog.characters.map(
    (c): WebProviderCharacter => ({
      characterId: c.characterId,
      displayName: c.displayName,
      publicDescription: '',
      portraitUrl: c.portraitUrl,
      theme: null,
      mainColor: c.mainColor,
      palette: c.palette,
      birthDate: c.birthDate,
      availability: c.available
        ? { state: 'available', personaVersion: 0 }
        : { state: 'unavailable', reason: 'voice_unverified' },
      welcome: c.available
        ? {
            text: '…',
            version: 'public',
            audio: c.welcomeClip
              ? { state: 'available', mediaId: 'public', url: '', version: 'public', sha256: '', durationMs: 0 }
              : { state: 'unavailable', reason: 'audio_missing' },
          }
        : { text: null, version: null, audio: { state: 'unavailable', reason: 'voice_unverified' } },
    }),
  );
  return providerPeople({ characters, slots: catalog.slots });
}

/** The session side of a first-paint shell: every action that needs a session waits for the gate (and shows the sheet meanwhile). */
export class DeferredLive implements ShellLive {
  private shell: Shell | null = null;
  private real: LiveBinding | null = null;
  private readonly sheet: Pick<VerifySheet, 'request'>;
  constructor(sheet: Pick<VerifySheet, 'request'>) {
    this.sheet = sheet;
  }
  get ready() {
    return this.real !== null;
  }
  /** The session arrived: from now on the real binding does everything, and it attaches to the shell that is already on the page. */
  bind(real: LiveBinding) {
    this.real = real;
    if (this.shell) real.attach(this.shell);
  }
  request() {
    return this.real ? Promise.resolve(this.real) : this.sheet.request();
  }
  get freeTierEnabled() {
    return this.real?.freeTierEnabled ?? false;
  }
  get signedUpPlayer() {
    return this.real?.signedUpPlayer ?? false;
  }
  get legalEnabled() {
    return this.real?.legalEnabled ?? false;
  }
  attach(shell: Shell) {
    this.shell = shell;
    this.real?.attach(shell);
  }
  stopVoice() {
    this.real?.stopVoice();
  }
  open(characterId: string, card: HTMLElement) {
    return this.real?.open(characterId, card);
  }
  updateComposer(characterId: string) {
    this.real?.updateComposer(characterId);
  }
  playWelcome(characterId: string, button?: HTMLElement) {
    if (this.real) this.real.playWelcome(characterId, button);
    else
      void this.sheet.request().then(
        (real) => real.playWelcome(characterId, button),
        () => {},
      );
  }
  async send(characterId: string, text: string, card: HTMLElement, onAccepted?: () => void) {
    if (this.real) return this.real.send(characterId, text, card, onAccepted);
    try {
      return await (await this.sheet.request()).send(characterId, text, card, onAccepted);
    } catch {
      /* the player closed the sheet: nothing was sent and the draft stays */
    }
  }
}
