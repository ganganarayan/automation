/**
 * LLM + AI image provider (interfaces + OpenAI/Gemini implementations).
 *
 * Purpose:      Abstract text generation, JSON generation, and image generation
 *               so business logic depends on interfaces, not vendor SDKs.
 * Responsibility:
 *               - generateText({ system, user }): string
 *               - generateJson({ system, user, maxTokens }): parsed object
 *               - generateImage({ prompt, size }): PNG Buffer (OpenAI)
 *               - generateImageGemini({ prompt }): PNG Buffer (Gemini)
 * Dependencies: openai, @google/generative-ai, errors, logger.
 *
 * Unconfigured providers throw a clear ExternalAPIError at call time (never at
 * boot), so the service starts even without keys.
 */
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ExternalAPIError } from '../core/errors.js';

/**
 * @param {object} cfg - { openai: {apiKey, imageModel, textModel}, gemini: {apiKey, imageModel} }
 */
export function createLlmProvider(cfg, log) {
  const openai = cfg.openai.apiKey ? new OpenAI({ apiKey: cfg.openai.apiKey }) : null;
  const gemini = cfg.gemini.apiKey ? new GoogleGenerativeAI(cfg.gemini.apiKey) : null;

  const requireOpenai = () => {
    if (!openai) throw new ExternalAPIError('OpenAI not configured (OPENAI_API_KEY missing)');
    return openai;
  };

  return {
    async generateText({ system, user, model }) {
      const client = requireOpenai();
      const res = await client.chat.completions.create({
        model: model || cfg.openai.textModel,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      });
      return res.choices?.[0]?.message?.content?.trim() || '';
    },

    async generateJson({ system, user, model, maxTokens = 4000 }) {
      const client = requireOpenai();
      const res = await client.chat.completions.create({
        model: model || cfg.openai.textModel,
        response_format: { type: 'json_object' },
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      });
      const raw = res.choices?.[0]?.message?.content || '{}';
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new ExternalAPIError('LLM returned invalid JSON', { cause: err });
      }
    },

    async generateImage({ prompt, size = '1024x1024', model }) {
      const client = requireOpenai();
      const res = await client.images.generate({
        model: model || cfg.openai.imageModel,
        prompt,
        size,
        n: 1,
      });
      const b64 = res.data?.[0]?.b64_json;
      if (b64) return Buffer.from(b64, 'base64');
      const url = res.data?.[0]?.url;
      if (url) {
        const r = await fetch(url);
        return Buffer.from(await r.arrayBuffer());
      }
      throw new ExternalAPIError('OpenAI image response had no image data');
    },

    async generateImageGemini({ prompt, model }) {
      if (!gemini) throw new ExternalAPIError('Gemini not configured (GEMINI_API_KEY missing)');
      const m = gemini.getGenerativeModel({ model: model || cfg.gemini.imageModel });
      const res = await m.generateContent(prompt);
      const parts = res.response?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) return Buffer.from(p.inlineData.data, 'base64');
      }
      throw new ExternalAPIError('Gemini image response had no inline image data');
    },
  };
}

export default { createLlmProvider };
