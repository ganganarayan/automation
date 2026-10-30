/**
 * Text-to-speech provider (interface + ElevenLabs backend).
 *
 * Purpose:      Clone the funnel's voice over the generated script, returning the
 *               audio bytes and the real character count (which drives TTS cost).
 * Responsibility:
 *               - createTtsProvider({ provider, apiKey, voiceId, model }, log)
 *                 => { provider, synthesize({ text }): { buffer, mime, chars } }
 * Dependencies: core/errors (fetch is global on Node 20).
 *
 * The API key + voice are per-funnel (tts_api_key / voice_id), so the provider is
 * built from the funnel config, not the tenant provider bundle. An unconfigured
 * provider throws a clear ExternalAPIError at call time, never at construction.
 */
import { ExternalAPIError } from '../core/errors.js';

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

export function createTtsProvider(cfg = {}, log) {
  const provider = (cfg.provider || 'elevenlabs').toLowerCase();
  const apiKey = cfg.apiKey || '';
  const voiceId = cfg.voiceId || '';
  const model = cfg.model || 'eleven_multilingual_v2';

  return {
    provider,

    async synthesize({ text }) {
      const body = String(text || '').trim();
      if (!body) throw new ExternalAPIError('TTS needs non-empty script text');
      if (provider !== 'elevenlabs') throw new ExternalAPIError(`TTS provider not supported: ${provider}`);
      if (!apiKey) throw new ExternalAPIError('TTS not configured (voice clone API key missing)');
      if (!voiceId) throw new ExternalAPIError('TTS not configured (voice_id missing)');

      const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: body, model_id: model }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ExternalAPIError(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 300)}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      log?.info?.({ chars: body.length, bytes: buffer.length }, 'tts synthesized');
      return { buffer, mime: 'audio/mpeg', chars: body.length };
    },
  };
}

/**
 * The voices on an ElevenLabs account, for the wizard's Voice picker.
 * GET /v2/voices pages with next_page_token (page_size max 100); a short page
 * cap keeps a huge library from stalling the request.
 * Returns [{ voice_id, name, category }], sorted by name.
 */
export async function listElevenLabsVoices(apiKey, { fetchImpl = fetch, maxPages = 10 } = {}) {
  if (!apiKey) throw new ExternalAPIError('No ElevenLabs API key');
  const voices = [];
  let token = '';
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ page_size: '100', include_total_count: 'false' });
    if (token) qs.set('next_page_token', token);
    const res = await fetchImpl(`https://api.elevenlabs.io/v2/voices?${qs}`, {
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ExternalAPIError(`ElevenLabs voices failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const v of data.voices || []) {
      if (v && v.voice_id) voices.push({ voice_id: v.voice_id, name: v.name || v.voice_id, category: v.category || '' });
    }
    token = data.next_page_token || '';
    if (!data.has_more || !token) break;
  }
  return voices.sort((a, b) => a.name.localeCompare(b.name));
}

export default { createTtsProvider, listElevenLabsVoices };
