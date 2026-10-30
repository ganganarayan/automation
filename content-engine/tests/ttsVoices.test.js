import { describe, it, expect } from 'vitest';
import { listElevenLabsVoices } from '../src/providers/ttsProvider.js';
import { WIZARD_STEPS } from '../src/services/videoWizardManifest.js';

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('listElevenLabsVoices', () => {
  it('follows next_page_token, keeps id/name/category, sorts by name', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, key: opts.headers['xi-api-key'] });
      return calls.length === 1
        ? reply({ voices: [{ voice_id: 'b1', name: 'Zed', category: 'premade', samples: [] }], has_more: true, next_page_token: 'p2' })
        : reply({ voices: [{ voice_id: 'a1', name: 'Ann', category: 'cloned' }], has_more: false, next_page_token: null });
    };
    const out = await listElevenLabsVoices('k', { fetchImpl });
    expect(out).toEqual([{ voice_id: 'a1', name: 'Ann', category: 'cloned' }, { voice_id: 'b1', name: 'Zed', category: 'premade' }]);
    expect(calls[0].url).toContain('https://api.elevenlabs.io/v2/voices?page_size=100');
    expect(calls[1].url).toContain('next_page_token=p2');
    expect(calls.every((c) => c.key === 'k')).toBe(true);
  });

  it('throws a clear error on a failed call or a missing key', async () => {
    await expect(listElevenLabsVoices('')).rejects.toThrow(/No ElevenLabs API key/);
    await expect(listElevenLabsVoices('k', { fetchImpl: async () => reply({ detail: 'bad key' }, 401) })).rejects.toThrow(/401/);
  });
});

describe('voiceover step', () => {
  it('renders voice_id as the voice picker, still saved under voice_id', () => {
    const f = WIZARD_STEPS.find((s) => s.id === 'voiceover').fields.find((x) => x.key === 'voice_id');
    expect(f.type).toBe('voice_select');
  });
});
