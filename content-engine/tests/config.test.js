import { describe, it, expect } from 'vitest';
import { buildSaveOps } from '../src/services/configOps.js';
import { CONFIG_MANIFEST, settingKeys, moduleKey, fieldByKey } from '../src/services/configManifest.js';

describe('configManifest', () => {
  it('exposes all three apps', () => {
    expect(Object.keys(CONFIG_MANIFEST)).toEqual(['wa-gateway', 'content-engine', 'tracking-bridge']);
  });
  it('lists setting keys for an app', () => {
    expect(settingKeys('wa-gateway')).toContain('evolution_base_url');
  });
  it('namespaces module keys per app', () => {
    expect(moduleKey('wa-gateway', 'dispatcher')).toBe('module.wa-gateway.dispatcher');
  });
  it('marks secret fields', () => {
    expect(fieldByKey('wa-gateway', 'evolution_api_key').type).toBe('secret');
  });
});

describe('buildSaveOps', () => {
  it('sets a normal field with a value', () => {
    const ops = buildSaveOps('wa-gateway', { settings: { calendar_link: 'https://x' }, modules: {} });
    expect(ops.sets).toContainEqual({ key: 'calendar_link', value: 'https://x' });
    expect(ops.errors).toEqual([]);
  });

  it('deletes a normal field when blank (revert to env default)', () => {
    const ops = buildSaveOps('wa-gateway', { settings: { calendar_link: '' }, modules: {} });
    expect(ops.dels).toContain('calendar_link');
  });

  it('leaves a secret unchanged when blank, sets when provided', () => {
    const blank = buildSaveOps('wa-gateway', { settings: { evolution_api_key: '' }, modules: {} });
    expect(blank.sets.find((s) => s.key === 'evolution_api_key')).toBeUndefined();
    expect(blank.dels).not.toContain('evolution_api_key');

    const set = buildSaveOps('wa-gateway', { settings: { evolution_api_key: 'k123' }, modules: {} });
    expect(set.sets).toContainEqual({ key: 'evolution_api_key', value: 'k123' });
  });

  it('validates JSON fields', () => {
    const bad = buildSaveOps('wa-gateway', { settings: { audio_bands: '{not json' }, modules: {} });
    expect(bad.errors.length).toBe(1);
    const good = buildSaveOps('wa-gateway', { settings: { audio_bands: '{"stable":[]}' }, modules: {} });
    expect(good.errors).toEqual([]);
    expect(good.sets).toContainEqual({ key: 'audio_bands', value: '{"stable":[]}' });
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
