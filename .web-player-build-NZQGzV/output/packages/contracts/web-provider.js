/** Separate provider-web protocol. Synthetic local-1/2/3 wire objects are not assignable. */
export const WEB_PROVIDER_CONTRACT = 'web-v1-provider-2';
/** Initial approved seed only, never the operational runtime allowlist. */
export const WEB_PROVIDER_CHARACTER_IDS = ['chen-jimi', 'wei-guagua', 'jojo'];
export const isWebProviderCharacterId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const record = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('WEB_PROVIDER_PROTOCOL_INVALID');
    return value;
};
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const characterId = isWebProviderCharacterId;
const millis = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
const reasons = new Set([
    'material_missing',
    'voice_unverified',
    'audio_missing',
    'quality_pending',
    'region_unavailable',
]);
const reason = (value) => reasons.has(value);
const color = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
const publicUrl = (value, kind, mediaId) => typeof value === 'string' &&
    new RegExp(`^/api/web/provider/${kind}/[A-Za-z0-9_-]{1,128}$`).test(value) &&
    (mediaId === undefined || value.endsWith(`/${mediaId}`));
const invalid = () => {
    throw new Error('WEB_PROVIDER_PROTOCOL_INVALID');
};
const exact = (value, keys) => {
    if (Object.keys(value).sort().join(',') !== keys.sort().join(','))
        invalid();
};
function parseTheme(value) {
    if (value === null)
        return;
    const theme = record(value);
    exact(theme, [
        'themeVersion',
        'pageBackground',
        'sourceColor',
        'resolvedColor',
        'adjustment',
        'approved',
        'cardSurface',
        'messageSurface',
        'inputSurface',
        'textColor',
        'border',
        'shadow',
    ]);
    if (!millis(theme.themeVersion) ||
        !color(theme.pageBackground) ||
        !(theme.sourceColor === null || color(theme.sourceColor)) ||
        !color(theme.resolvedColor) ||
        !(theme.adjustment === null ||
            (typeof theme.adjustment === 'number' &&
                Number.isFinite(theme.adjustment) &&
                theme.adjustment >= -1 &&
                theme.adjustment <= 1)) ||
        typeof theme.approved !== 'boolean' ||
        !color(theme.cardSurface) ||
        !color(theme.messageSurface) ||
        !color(theme.inputSurface) ||
        !color(theme.textColor) ||
        !color(theme.border) ||
        theme.shadow !== 'none')
        invalid();
}
/** B/E boundary: never parse local-3 or private Fish identifiers as catalog data. */
export function parseWebProviderBootstrap(value) {
    const root = record(value);
    exact(root, [
        'contractVersion',
        'mode',
        'region',
        'fixture',
        'instanceId',
        'recoveryEpoch',
        'csrf',
        'access',
        'characters',
        'slots',
        'conversations',
        'syncCursor',
    ]);
    if (root.contractVersion !== WEB_PROVIDER_CONTRACT ||
        !((root.mode === 'provider-local' && root.region === 'local-test') ||
            (root.mode === 'provider-cloud' && root.region === 'public' && root.fixture === false)) ||
        typeof root.fixture !== 'boolean' ||
        !id(root.instanceId) ||
        !id(root.recoveryEpoch) ||
        !id(root.csrf) ||
        typeof root.syncCursor !== 'string')
        invalid();
    const access = record(root.access);
    if (access.kind !== 'guest' ||
        !id(access.principalId) ||
        !id(access.playerId) ||
        !id(access.worldId) ||
        !millis(access.revision) ||
        typeof access.canSend !== 'boolean')
        invalid();
    // Part 26a: present only for an unregistered guest under GUEST_ONE_CHARACTER_ENABLED; absent everywhere else.
    const hasLocks = Object.hasOwn(access, 'lockedCharacterIds');
    exact(access, [
        ...(hasLocks ? ['lockedCharacterIds'] : []),
        'kind',
        'principalId',
        'playerId',
        'worldId',
        'revision',
        'lockedCharacterId',
        'remainingReplies',
        'reservedReplies',
        'trialExpiresAt',
        'canSend',
    ]);
    if (!(access.lockedCharacterId === null || characterId(access.lockedCharacterId)) ||
        (hasLocks &&
            !(Array.isArray(access.lockedCharacterIds) &&
                access.lockedCharacterIds.length <= 15 &&
                new Set(access.lockedCharacterIds).size === access.lockedCharacterIds.length &&
                access.lockedCharacterIds.every(characterId))) ||
        !millis(access.remainingReplies) ||
        !millis(access.reservedReplies) ||
        !(access.trialExpiresAt === null || millis(access.trialExpiresAt)) ||
        (root.fixture && access.canSend))
        invalid();
    if (!Array.isArray(root.characters) ||
        root.characters.length > 15 ||
        !Array.isArray(root.slots) ||
        root.slots.length !== 15 ||
        !Array.isArray(root.conversations))
        invalid();
    const characters = root.characters;
    const slots = root.slots;
    const conversations = root.conversations;
    const seen = new Set();
    for (const raw of characters) {
        const c = record(raw);
        exact(c, [
            'characterId',
            'displayName',
            'publicDescription',
            'portraitUrl',
            'theme',
            'mainColor',
            'availability',
            'welcome',
            ...['palette', 'birthDate'].filter((key) => key in c),
        ]);
        if (!(c.palette === undefined ||
            c.palette === null ||
            (Array.isArray(c.palette) &&
                c.palette.length <= 12 &&
                c.palette.every((entry) => {
                    const e = record(entry);
                    exact(e, ['hex', 'role']);
                    return (typeof e.hex === 'string' && /^#[0-9A-F]{6}$/.test(e.hex) && (e.role === 'main' || e.role === 'accent'));
                }))) ||
            !(c.birthDate === undefined ||
                c.birthDate === null ||
                (typeof c.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.birthDate))))
            invalid();
        if (!characterId(c.characterId) ||
            seen.has(c.characterId) ||
            typeof c.displayName !== 'string' ||
            !c.displayName.trim() ||
            c.displayName.length > 100 ||
            typeof c.publicDescription !== 'string' ||
            c.publicDescription.length > 500 ||
            !(c.portraitUrl === null || publicUrl(c.portraitUrl, 'public-image')) ||
            (root.fixture && c.portraitUrl !== null) ||
            !c.availability ||
            !c.welcome)
            invalid();
        parseTheme(c.theme);
        if (!(c.mainColor === null || (typeof c.mainColor === 'string' && /^#[0-9A-F]{6}$/.test(c.mainColor))))
            invalid();
        seen.add(c.characterId);
        const availability = record(c.availability), welcome = record(c.welcome);
        if (availability.state === 'available') {
            exact(availability, ['state', 'personaVersion']);
            if (root.fixture || !millis(availability.personaVersion) || availability.personaVersion === 0)
                invalid();
        }
        else if (availability.state === 'unavailable') {
            exact(availability, ['state', 'reason']);
            if (!reason(availability.reason))
                invalid();
        }
        else
            invalid();
        exact(welcome, ['text', 'version', 'audio']);
        const audio = record(welcome.audio);
        if (audio.state === 'available') {
            exact(audio, ['state', 'mediaId', 'url', 'version', 'sha256', 'durationMs']);
            if (root.fixture ||
                availability.state !== 'available' ||
                !id(audio.mediaId) ||
                !publicUrl(audio.url, 'public-audio', audio.mediaId) ||
                !id(audio.version) ||
                !/^[a-f0-9]{64}$/.test(String(audio.sha256)) ||
                !millis(audio.durationMs) ||
                audio.durationMs === 0)
                invalid();
        }
        else if (audio.state === 'unavailable') {
            exact(audio, ['state', 'reason']);
            if (!reason(audio.reason))
                invalid();
        }
        else
            invalid();
        if (welcome.text === null || welcome.version === null) {
            if (welcome.text !== null || welcome.version !== null || audio.state !== 'unavailable')
                invalid();
        }
        else if (typeof welcome.text !== 'string' ||
            !welcome.text.trim() ||
            [...welcome.text].length > 500 ||
            !id(welcome.version) ||
            availability.state !== 'available' ||
            root.fixture)
            invalid();
    }
    const slotted = new Set(), previews = new Set();
    for (const raw of slots) {
        const slot = record(raw);
        if (slot.kind === 'character') {
            exact(slot, ['kind', 'characterId']);
            if (!characterId(slot.characterId) || !seen.has(slot.characterId) || slotted.has(slot.characterId))
                invalid();
            slotted.add(slot.characterId);
        }
        else if (slot.kind === 'preview') {
            exact(slot, ['kind', 'slotId', 'label']);
            if (!id(slot.slotId) || previews.has(slot.slotId) || typeof slot.label !== 'string')
                invalid();
            previews.add(slot.slotId);
        }
        else
            invalid();
    }
    if (slotted.size !== seen.size || previews.size !== 15 - seen.size)
        invalid();
    const conversationIds = new Set();
    for (const raw of conversations) {
        const conversation = record(raw);
        exact(conversation, ['conversationId', 'characterId', 'lastMessageId', 'unreadCount']);
        if (!id(conversation.conversationId) ||
            !characterId(conversation.characterId) ||
            !seen.has(conversation.characterId) ||
            conversationIds.has(conversation.conversationId) ||
            !(conversation.lastMessageId === null || id(conversation.lastMessageId)) ||
            !millis(conversation.unreadCount))
            invalid();
        conversationIds.add(conversation.conversationId);
    }
    return root;
}
/** Same wire shape as bootstrap; all media unavailable and explicitly marked as a fixture. */
export function syntheticProviderBootstrap() {
    const names = {
        'chen-jimi': '陈吉米',
        'wei-guagua': '瓜瓜',
        jojo: 'JOJO',
    };
    return {
        contractVersion: WEB_PROVIDER_CONTRACT,
        mode: 'provider-local',
        region: 'local-test',
        fixture: true,
        instanceId: 'fixture-instance',
        recoveryEpoch: 'fixture-epoch',
        csrf: 'fixture-csrf',
        access: {
            kind: 'guest',
            principalId: 'fixture-principal',
            playerId: 'fixture-player',
            worldId: 'fixture-world',
            revision: 0,
            lockedCharacterId: null,
            remainingReplies: 3,
            reservedReplies: 0,
            trialExpiresAt: null,
            canSend: false,
        },
        characters: WEB_PROVIDER_CHARACTER_IDS.map((characterId) => ({
            characterId,
            displayName: names[characterId],
            publicDescription: '合成契约占位，尚无可展示人物资料。',
            portraitUrl: null,
            theme: null,
            mainColor: null,
            availability: { state: 'unavailable', reason: 'material_missing' },
            welcome: { text: null, version: null, audio: { state: 'unavailable', reason: 'audio_missing' } },
        })),
        slots: [
            ...WEB_PROVIDER_CHARACTER_IDS.map((characterId) => ({ kind: 'character', characterId })),
            ...Array.from({ length: 12 }, (_, index) => ({
                kind: 'preview',
                slotId: `preview-${index + 1}`,
                label: '敬请期待',
            })),
        ],
        conversations: [],
        syncCursor: 'fixture-cursor',
    };
}
