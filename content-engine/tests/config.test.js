import { describe, it, expect } from 'vitest';
import { buildSaveOps } from '../src/services/configOps.js';
import { CONFIG_MANIFEST, settingKeys, moduleKey, fieldByKey } from '../src/services/configManifest.js';

describe('configManifest', () => {
  it('exposes the configured apps', () => {
    expect(Object.keys(CONFIG_MANIFEST)).toEqual(['content-engine', 'tracking-bridge']);
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
      modules: { imageFactory: 'false', delivery: 'true', videoPipeline: 'default' },
    });
    expect(ops.sets).toContainEqual({ key: 'module.content-engine.imageFactory', value: 'false' });
    expect(ops.sets).toContainEqual({ key: 'module.content-engine.delivery', value: 'true' });
    expect(ops.dels).toContain('module.content-engine.videoPipeline');
  });

  it('ignores unknown apps with an error', () => {
    const ops = buildSaveOps('nope', { settings: {}, modules: {} });
    expect(ops.errors[0]).toMatch(/unknown app/);
  });
});
