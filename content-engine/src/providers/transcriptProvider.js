/**
 * Transcript provider (interface + OpenAI Whisper backend).
 *
 * Purpose:      Turn the voiceover audio into text with word/segment timings, so
 *               captions and cuts line up and the real audio minutes drive the
 *               transcription cost.
 * Responsibility:
 *               - createTranscriptProvider({ apiKey, model }, log)
 *                 => { transcribe({ buffer, filename }): { text, minutes, cues } }
 * Dependencies: openai, core/errors.
 *
 * The key is per-funnel (transcript_api_key), falling back to the tenant's OpenAI
 * key. Unconfigured => clear ExternalAPIError at call time.
 */
import OpenAI, { toFile } from 'openai';
import { ExternalAPIError } from '../core/errors.js';

export function createTranscriptProvider(cfg = {}, log) {
  const apiKey = cfg.apiKey || '';
  const model = cfg.model || 'whisper-1';
  const provider = cfg.provider || 'whisper';
  const client = apiKey ? new OpenAI({ apiKey }) : null;

  return {
    provider,

    async transcribe({ buffer, filename = 'audio.mp3' }) {
      if (!client) throw new ExternalAPIError('Transcription not configured (API key missing)');
      if (!buffer || !buffer.length) throw new ExternalAPIError('Transcription needs audio bytes');

      const file = await toFile(buffer, filename);
      const res = await client.audio.transcriptions.create({ file, model, response_format: 'verbose_json' });

      const segments = Array.isArray(res.segments) ? res.segments : [];
      const cues = segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }));
      const seconds = Number(res.duration) || (cues.length ? cues[cues.length - 1].end : 0);
      log?.info?.({ seconds, cues: cues.length }, 'transcript produced');
      return { text: String(res.text || '').trim(), minutes: seconds / 60, durationSeconds: seconds, cues };
    },
  };
}

export default { createTranscriptProvider };
