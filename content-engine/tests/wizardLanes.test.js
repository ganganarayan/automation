import { describe, it, expect } from 'vitest';
import { WIZARD_STEPS, completeness, stepFields, readyRequired } from '../src/services/videoWizardManifest.js';

const ids = () => WIZARD_STEPS.map((s) => s.id);
const keysOf = (id) => stepFields(WIZARD_STEPS.find((s) => s.id === id)).map((f) => f.key);

describe('funnel setup pages, one per lane', () => {
  it('orders the pages basics, Lane 1, Lane 2, Lane 3, publish', () => {
    expect(ids()).toEqual(['basics', 'ready', 'ai', 'image', 'publish']);
  });

  it('has no source chooser: the router picks the lane', () => {
    const all = WIZARD_STEPS.flatMap((s) => stepFields(s).map((f) => f.key));
    for (const gone of ['research_mode', 'research_topics', 'research_count', 'script_source']) expect(all).not.toContain(gone);
  });

  it('lists every key once across the pages', () => {
    const all = WIZARD_STEPS.flatMap((s) => stepFields(s).map((f) => f.key));
    expect(new Set(all).size).toBe(all.length);
  });

  it('puts each lane\'s keys on its own page', () => {
    expect(keysOf('ready')).toEqual(expect.arrayContaining(['direct_drive_folder', 'direct_copy_brief', 'direct_caption', 'direct_yt_title']));
    expect(keysOf('ai')).toEqual(expect.arrayContaining(['script_tone', 'image_count', 'animation_provider', 'video_provider_order', 'voice_id', 'aspect']));
    expect(keysOf('image')).toEqual(expect.arrayContaining(['sheet_id', 'sheet_tab', 'image_size']));
    expect(keysOf('publish')).toContain('postforme_accounts');
    expect(keysOf('basics')).toEqual(expect.arrayContaining(['approval_email', 'cta_link', 'publish_time', 'generate_days']));
  });
});

describe('stepFields', () => {
  it('drops section headings (no key, never saved)', () => {
    const step = { fields: [{ type: 'heading', label: 'Script' }, { key: 'script_tone' }, null] };
    expect(stepFields(step)).toEqual([{ key: 'script_tone' }]);
    expect(stepFields(undefined)).toEqual([]);
  });
});

describe('readyRequired', () => {
  it('needs the lane folder, or the funnel media folder it falls back to', () => {
    expect(readyRequired({ direct_drive_folder: 'abc' })).toEqual([]);
    expect(readyRequired({ direct_drive_folder: '  ' })).toEqual(['drive_folder_id']);
    expect(readyRequired(undefined)).toEqual(['drive_folder_id']);
  });
});

describe('completeness with an old direct-upload funnel', () => {
  it('still ticks the pages from its stored keys', () => {
    const cfg = {
      research_mode: 'direct', research_topics: 'x', approval_email: 'a@b.c', cta_link: 'https://x',
      direct_drive_folder: 'folder', voice_id: 'v1', sheet_id: 's', postforme_accounts: '["acc"]',
    };
    expect(completeness(cfg)).toEqual([true, true, true, true, true]);
    expect(completeness({ drive_folder_id: 'media' })).toEqual([false, true, false, false, false]);
  });
});
