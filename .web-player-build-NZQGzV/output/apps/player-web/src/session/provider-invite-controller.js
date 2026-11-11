import { ProviderApi, ProviderApiError } from "../services/provider-api.js";
const scope = (view) => ({
    instanceId: view.instanceId,
    recoveryEpoch: view.recoveryEpoch,
    principalId: view.access.principalId,
    playerId: view.access.playerId,
    worldId: view.access.worldId,
});
const matches = (a, b) => a.instanceId === b.instanceId &&
    a.recoveryEpoch === b.recoveryEpoch &&
    a.principalId === b.principalId &&
    a.playerId === b.playerId &&
    a.worldId === b.worldId;
/**
 * One in-memory intent survives dialog dismissal. A redemption is idempotent on its requestId (an entitlement is added once;
 * the same request answers `duplicate`), so an uncertain one is settled by asking again with the SAME request, never a new one.
 */
export class ProviderInviteController {
    phase = 'entry';
    errorCode = null;
    intent = null;
    api;
    current;
    install;
    changed;
    requestId;
    constructor(api, current, install, changed, requestId = () => crypto.randomUUID()) {
        this.api = api;
        this.current = current;
        this.install = install;
        this.changed = changed;
        this.requestId = requestId;
    }
    get state() {
        return { phase: this.phase, errorCode: this.errorCode };
    }
    get locked() {
        return this.phase !== 'entry' && this.phase !== 'accepted';
    }
    set(phase, code = null) {
        this.phase = phase;
        this.errorCode = code;
        this.changed();
    }
    check(view) {
        if (!this.intent ||
            !matches(this.intent.source, scope(this.current())) ||
            !matches(this.intent.source, scope(view)))
            throw new ProviderApiError(0, 'IDENTITY_CHANGED');
    }
    /** An entitlement changes nothing about who the player is - same principal, same session. Take the new access. */
    async accept() {
        const view = await this.api.bootstrap();
        this.check(view);
        this.install(view);
        this.intent = null;
        this.set('accepted');
        return true;
    }
    failed(error) {
        const code = error instanceof ProviderApiError ? error.code : 'NETWORK';
        // A lost answer does not prove that the request failed.
        this.set(['IDENTITY_CHANGED', 'CATALOG_CHANGED'].includes(code) ? 'blocked' : 'uncertain', code);
        return false;
    }
    async redeem(code) {
        if (this.phase !== 'entry')
            return false;
        const view = this.current();
        if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
            this.set('entry', 'INVALID_CODE');
            return false;
        }
        this.intent = { code, requestId: this.requestId(), source: scope(view) };
        this.set('submitting');
        return this.send();
    }
    async send() {
        const intent = this.intent;
        try {
            await this.api.redeemInvite({ code: intent.code, requestId: intent.requestId });
        }
        catch (error) {
            // Only an explicit transactional rejection permits editing a new intent. A guest's code is refused before it is looked
            // at (PLAYER_LOGIN_REQUIRED): nothing was consumed, so the player may sign up and enter it again.
            if (error instanceof ProviderApiError &&
                error.status === 409 &&
                ['WEB_INVITE_UNAVAILABLE', 'WEB_INVITE_UNUSABLE', 'PLAYER_LOGIN_REQUIRED'].includes(error.code)) {
                this.intent = null;
                this.set('entry', error.code);
                return false;
            }
            return this.failed(error);
        }
        try {
            return await this.accept();
        }
        catch (error) {
            return this.failed(error);
        }
    }
    /** Settles an uncertain redemption: the same request again, which the server answers without a second redemption. */
    async recover() {
        if (this.phase !== 'uncertain' || !this.intent)
            return false;
        this.set('recovering');
        try {
            this.check(this.current());
        }
        catch (error) {
            return this.failed(error);
        }
        return this.send();
    }
}
