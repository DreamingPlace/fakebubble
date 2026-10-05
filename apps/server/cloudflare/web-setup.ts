import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { WEB_PROVIDER_CHARACTER_IDS } from '../../../packages/contracts/web-provider.ts';
import { WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WebRuntimeStore } from '../web-store-contract.ts';
import type { verifySelectedVoiceSetup } from '../web-provider-materials.ts';
import { configureWebProvider } from '../web-provider-configuration.ts';
import { WebProviderOffline } from '../web-provider-offline.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../web-vertical-publisher.ts';
import type { WebBudgetPolicy } from '../web-provider-budget-contract.ts';

export interface WebCloudFixedAsset {
  kind: 'welcome' | 'footer'; characterId: typeof WEB_PROVIDER_CHARACTER_IDS[number];
  voiceVersion: string; body: string; sha256: string; byteLength: number;
}
/** Produced locally from verifySelectedVoiceSetup and the six already-rendered clips, not raw samples. */
export interface WebCloudMaterialPackage {
  selected: ReturnType<typeof verifySelectedVoiceSetup>;
  assets: WebCloudFixedAsset[];
}
export const webMaterialHash = (value: WebCloudMaterialPackage) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Exact, immutable deployment identity. Operator retries do not renew prices or overwrite material. */
export class WebCloudSetup {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  private readonly materialHash: string;
  private readonly budgetPolicy: WebBudgetPolicy;
  constructor(store: WebRuntimeStore, clock: Clock, configHash: string, materialHash: string,
    budgetPolicy: WebBudgetPolicy = 'test-cumulative') {
    ensure([configHash,materialHash].every(hash => /^[a-f0-9]{64}$/.test(hash)), 'WEB_CLOUD_SETUP_INVALID');
    this.store = store; this.clock = clock; this.materialHash = materialHash;
    this.budgetPolicy = budgetPolicy;
    store.transaction(() => {
      store.run(`CREATE TABLE IF NOT EXISTS cf_web_setup(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        config_hash TEXT NOT NULL,material_hash TEXT NOT NULL,assets_json TEXT,initialized_at INTEGER) STRICT`);
      if (!store.get('SELECT 1 FROM cf_web_setup')) store.run('INSERT INTO cf_web_setup VALUES (1,?,?,NULL,NULL)', configHash, materialHash);
      const prior = store.get<{ config_hash: string; material_hash: string }>('SELECT * FROM cf_web_setup')!;
      ensure(prior.config_hash === configHash && prior.material_hash === materialHash, 'WEB_CLOUD_DEPLOYMENT_MISMATCH');
    });
  }
  initialize(value: WebCloudMaterialPackage) {
    ensure(value && webMaterialHash(value) === this.materialHash && Array.isArray(value.selected) &&
      value.selected.length === 3 && value.selected.map(item => item.characterId).sort().join(',') ===
        [...WEB_PROVIDER_CHARACTER_IDS].sort().join(',') && Array.isArray(value.assets) && value.assets.length === 6,
    'WEB_CLOUD_MATERIAL_MISMATCH');
    for (const selected of value.selected) {
      const template = selected.template;
      ensure(template.id === selected.characterId && template.version === selected.personaVersion &&
        template.fictional === true && typeof template.persona === 'string' && template.persona.length > 0 &&
        template.name === selected.displayName && template.schedule && selected.voice.model === 's2.1-pro',
      'WEB_CLOUD_MATERIAL_INVALID');
      for (const kind of ['welcome','footer'] as const) {
        const assets = value.assets.filter(asset => asset.characterId === selected.characterId && asset.kind === kind);
        const asset = assets[0];
        ensure(assets.length === 1 && asset && asset.voiceVersion === selected.voice.voiceVersion &&
          asset.body === (kind === 'welcome' ? WEB_PROVIDER_WELCOME[selected.characterId].text : SYNTHETIC_TRIAL_FOOTER) &&
          /^[a-f0-9]{64}$/.test(asset.sha256) && Number.isSafeInteger(asset.byteLength) &&
          asset.byteLength > 44 && asset.byteLength <= 6_000_000, 'WEB_CLOUD_MATERIAL_INVALID');
      }
    }
    const assets = JSON.stringify(value.assets);
    ensure(Buffer.byteLength(JSON.stringify(value)) <= 500_000, 'WEB_CLOUD_MATERIAL_INVALID');
    return this.store.transaction(() => {
      const prior = this.store.get<{ assets_json: string | null; initialized_at: number | null }>('SELECT * FROM cf_web_setup')!;
      if (prior.initialized_at !== null) {
        ensure(prior.assets_json === assets, 'WEB_CLOUD_MATERIAL_MISMATCH');
        return { duplicate: true, initializedAt: prior.initialized_at };
      }
      ensure(!this.store.get('SELECT 1 FROM character_templates') && !this.store.get('SELECT 1 FROM web_principals'),
        'WEB_CLOUD_EMPTY_REQUIRED');
      for (const item of value.selected) this.store.run('INSERT INTO character_templates VALUES (?,?,?)',
        item.characterId, item.personaVersion, JSON.stringify(item.template));
      const now = this.clock.now(); configureWebProvider(this.store, value.selected, now, this.budgetPolicy);
      this.store.run('UPDATE cf_web_setup SET assets_json=?,initialized_at=? WHERE singleton=1 AND initialized_at IS NULL', assets, now);
      return { duplicate: false, initializedAt: now };
    });
  }
  private assets() {
    const row = this.store.get<{ assets_json: string | null }>('SELECT assets_json FROM cf_web_setup')!;
    ensure(row.assets_json, 'WEB_CLOUD_NOT_INITIALIZED');
    return JSON.parse(row.assets_json) as WebCloudFixedAsset[];
  }
  async importFixed(kind: 'welcome' | 'footer', characterId: string, value: Uint8Array) {
    const bytes = Buffer.from(value);
    const asset = this.assets().find(item => item.kind === kind && item.characterId === characterId);
    ensure(asset && bytes.length === asset.byteLength && createHash('sha256').update(bytes).digest('hex') === asset.sha256,
      'WEB_CLOUD_ASSET_MISMATCH');
    return new WebProviderOffline(this.store, this.clock).registerFixedAudio(kind, { ...asset, wav: bytes });
  }
  status() {
    const assets = this.assets();
    const installed = assets.filter(asset => this.store.get(`SELECT 1 FROM ${asset.kind === 'welcome' ?
      'web_provider_welcome_assets' : 'web_provider_footer_assets'} WHERE character_id=? AND voice_version=? AND sha256=? AND byte_length=?`,
    asset.characterId, asset.voiceVersion, asset.sha256, asset.byteLength)).length;
    return { materialHash: this.materialHash, installed, required: assets.length };
  }
  ready() { const status = this.status(); ensure(status.installed === 6, 'WEB_CLOUD_ASSETS_REQUIRED'); return status; }
}
