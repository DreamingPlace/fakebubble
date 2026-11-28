import { CATALOG_MAX, type WebProviderCharacterId, type WebProviderSlot } from './web-provider.ts';

/**
 * Part 48: the PUBLIC catalog read (GET /api/web/provider/catalog). It lets the home page draw its real cards before any session
 * exists, so the first frame never waits for Turnstile or a bootstrap. It carries the published characters' card fields and nothing
 * else: the same kind of fields a share page shows (name, colours, birthday, picture) plus the home order and two booleans.
 *
 * No session, no cookie, no principal / player / world / conversation id, no welcome text, no clip URL, no CSRF token, no price, no
 * availability reason. The Latin name and the card's No. are derived on the page from `displayName`, `birthDate` and the order
 * (the player page's own rules, the same ones the share page uses).
 */
export interface WebPublicCatalogCharacter {
  characterId: WebProviderCharacterId;
  displayName: string;
  portraitUrl: string | null;
  mainColor: string | null;
  palette: { hex: string; role: 'main' | 'accent' }[] | null;
  birthDate: string | null;
  /** The character can be chatted with (published and its voice approved): the card is a chat card, not a placeholder. */
  available: boolean;
  /** A welcome clip exists for the card's voice pill. The clip itself (and its length) comes with the session. */
  welcomeClip: boolean;
}
export interface WebPublicCatalog {
  /** Published characters in home order. */
  characters: WebPublicCatalogCharacter[];
  /** Exactly CATALOG_MAX slots, characters first and then the "coming soon" places: the order the bootstrap also uses. */
  slots: WebProviderSlot[];
  /** Part 50: the PUBLIC Turnstile site key, present only when the server asks for the bot check (so the page can start it at load). */
  turnstileSiteKey?: string;
}

const invalid = (): never => {
  throw new Error('WEB_PUBLIC_CATALOG_INVALID');
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : invalid();
const keys = (value: Record<string, unknown>, expected: string[]) => {
  const actual = Object.keys(value).sort().join();
  if (actual !== [...expected].sort().join()) invalid();
};
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** The page's strict reader: anything else than exactly this shape is rejected (the page then simply waits for the session). */
export function parseWebPublicCatalog(value: unknown): WebPublicCatalog {
  const root = record(value);
  keys(root, 'turnstileSiteKey' in root ? ['characters', 'slots', 'turnstileSiteKey'] : ['characters', 'slots']);
  if (
    'turnstileSiteKey' in root &&
    !(typeof root.turnstileSiteKey === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(root.turnstileSiteKey))
  )
    invalid();
  if (!Array.isArray(root.characters) || root.characters.length > CATALOG_MAX) invalid();
  if (!Array.isArray(root.slots) || root.slots.length !== CATALOG_MAX) invalid();
  const seen = new Set<string>();
  const characters = (root.characters as unknown[]).map((raw): WebPublicCatalogCharacter => {
    const c = record(raw);
    keys(c, [
      'characterId',
      'displayName',
      'portraitUrl',
      'mainColor',
      'palette',
      'birthDate',
      'available',
      'welcomeClip',
    ]);
    if (
      !id(c.characterId) ||
      seen.has(c.characterId) ||
      typeof c.displayName !== 'string' ||
      !c.displayName ||
      [...c.displayName].length > 64 ||
      !(c.portraitUrl === null || (typeof c.portraitUrl === 'string' && c.portraitUrl.length <= 256)) ||
      !(c.mainColor === null || (typeof c.mainColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c.mainColor))) ||
      !(c.birthDate === null || (typeof c.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.birthDate))) ||
      typeof c.available !== 'boolean' ||
      typeof c.welcomeClip !== 'boolean'
    )
      invalid();
    seen.add(c.characterId as string);
    let palette: WebPublicCatalogCharacter['palette'] = null;
    if (c.palette !== null) {
      if (!Array.isArray(c.palette) || c.palette.length > 16) invalid();
      palette = (c.palette as unknown[]).map((entry) => {
        const p = record(entry);
        keys(p, ['hex', 'role']);
        if (
          typeof p.hex !== 'string' ||
          !/^#[0-9A-Fa-f]{6}$/.test(p.hex) ||
          !(p.role === 'main' || p.role === 'accent')
        )
          invalid();
        return { hex: p.hex as string, role: p.role as 'main' | 'accent' };
      });
    }
    return {
      characterId: c.characterId as string,
      displayName: c.displayName as string,
      portraitUrl: c.portraitUrl as string | null,
      mainColor: c.mainColor as string | null,
      palette,
      birthDate: c.birthDate as string | null,
      available: c.available as boolean,
      welcomeClip: c.welcomeClip as boolean,
    };
  });
  const slotted = new Set<string>();
  const previews = new Set<string>();
  const slots = (root.slots as unknown[]).map((raw): WebProviderSlot => {
    const slot = record(raw);
    if (slot.kind === 'character') {
      keys(slot, ['kind', 'characterId']);
      if (!id(slot.characterId) || !seen.has(slot.characterId) || slotted.has(slot.characterId)) invalid();
      slotted.add(slot.characterId as string);
      return { kind: 'character', characterId: slot.characterId as string };
    }
    if (slot.kind !== 'preview') return invalid();
    keys(slot, ['kind', 'slotId', 'label']);
    if (!id(slot.slotId) || previews.has(slot.slotId) || typeof slot.label !== 'string' || slot.label.length > 32)
      invalid();
    previews.add(slot.slotId as string);
    return { kind: 'preview', slotId: slot.slotId as string, label: slot.label as string };
  });
  if (slotted.size !== seen.size || previews.size !== CATALOG_MAX - seen.size) invalid();
  return {
    characters,
    slots,
    ...('turnstileSiteKey' in root ? { turnstileSiteKey: root.turnstileSiteKey as string } : {}),
  };
}
