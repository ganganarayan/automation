import { describe, it, expect } from 'vitest';
import { buildSaveOps } from '../src/services/configOps.js';
import { CONFIG_MANIFEST, settingKeys, moduleKey, fieldByKey } from '../src/services/configManifest.js';
import { WIZARD_STEPS } from '../src/services/videoWizardManifest.js';

describe('configManifest', () => {
  it('exposes the configured apps', () => {
    expect(Object.keys(CONFIG_MANIFEST)).toEqual(['api-keys', 'content-engine', 'tracking-bridge']);
  });
  it('keeps every provider credential on the central API Keys page', () => {
    const central = settingKeys('api-keys');
    for (const k of ['openai_api_key', 'gemini_api_key', 'kling_access_key', 'kling_secret_key',
      'runway_api_key', 'hailuo_api_key', 'elevenlabs_api_key', 'transcript_api_key',
      'postforme_api_key', 'meta_app_secret']) {
      expect(central).toContain(k);
    }
    // ...and out of the per-feature page, so each key lives in exactly one place.
    expect(settingKeys('content-engine')).not.toContain('openai_api_key');
    expect(settingKeys('content-engine')).not.toContain('postforme_api_key');
  });
  it('keeps provider keys OUT of the funnel wizard (funnels pick providers, not keys)', () => {
    const keys = WIZARD_STEPS.flatMap((s) => s.fields.map((f) => f.key));
    for (const forbidden of ['postforme_api_key', 'kling_access_key', 'kling_secret_key',
      'runway_api_key', 'hailuo_api_key', 'hailuo_group_id', 'tts_api_key',
      'transcript_api_key', 'openai_api_key', 'gemini_api_key']) {
      expect(keys).not.toContain(forbidden);
    }
    // The funnel still chooses the provider/model and its own accounts.
    for (const choice of ['animation_provider', 'tts_provider', 'transcript_source',
      'image_provider', 'postforme_accounts', 'voice_id']) {
      expect(keys).toContain(choice);
    }
  });
  it('lists setting keys for an app', () => {
    expect(settingKeys('tracking-bridge')).toContain('meta_pixel_id');
  });
  it('namespaces module keys per app', () => {
    expect(moduleKey('tracking-bridge', 'capi')).toBe('module.tracking-bridge.capi');
  });
  it('marks secret fields', () => {
    expect(fieldByKey('tracking-bridge', 'meta_capi_token').type).toBe('secret');
  });
});

describe('buildSaveOps', () => {
  it('sets a normal field with a value', () => {
    const ops = buildSaveOps('tracking-bridge', { settings: { event_source_url: 'https://x' }, modules: {} });
    expect(ops.sets).toContainEqual({ key: 'event_source_url', value: 'https://x' });
    expect(ops.errors).toEqual([]);
  });

  it('deletes a normal field when blank (revert to env default)', () => {
    const ops = buildSaveOps('tracking-bridge', { settings: { event_source_url: '' }, modules: {} });
    expect(ops.dels).toContain('event_source_url');
  });

  it('leaves a secret unchanged when blank, sets when provided', () => {
    const blank = buildSaveOps('tracking-bridge', { settings: { meta_capi_token: '' }, modules: {} });
    expect(blank.sets.find((s) => s.key === 'meta_capi_token')).toBeUndefined();
    expect(blank.dels).not.toContain('meta_capi_token');

    const set = buildSaveOps('tracking-bridge', { settings: { meta_capi_token: 'tok123' }, modules: {} });
    expect(set.sets).toContainEqual({ key: 'meta_capi_token', value: 'tok123' });
  });

  it('sets module true/false and deletes on default', () => {
    const ops = buildSaveOps('content-engine', {
      settings: {},
      modules: { vidapulseRefill: 'false', delivery: 'default' },
    });
    expect(ops.sets).toContainEqual({ key: 'module.content-engine.vidapulseRefill', value: 'false' });
    expect(ops.dels).toContain('module.content-engine.delivery');
  });

  it('ignores unknown apps with an error', () => {
    const ops = buildSaveOps('nope', { settings: {}, modules: {} });
    expect(ops.errors[0]).toMatch(/unknown app/);
  });
});
