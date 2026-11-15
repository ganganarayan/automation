/**
 * LLM + AI image provider (interfaces + OpenAI/Gemini implementations).
 *
 * Purpose:      Abstract text generation, JSON generation, and image generation
 *               so business logic depends on interfaces, not vendor SDKs.
 * Responsibility:
 *               - generateText({ system, user }): string
 *               - generateJson({ system, user, maxTokens }): parsed object
 *               - generateJsonDetailed(...): { data, model, usage } (optionally with images)
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
import { geminiQuotaOf, geminiQuotaReason, quotaRetryWait } from '../utils/geminiQuota.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} cfg - { openai: {apiKey, imageModel, textModel}, gemini: {apiKey, imageModel} }
 */
export function createLlmProvider(cfg, log) {
  const openai = cfg.openai.apiKey ? new OpenAI({ apiKey: cfg.openai.apiKey }) : null;
  const gemini = cfg.gemini.apiKey ? new GoogleGenerativeAI(cfg.gemini.apiKey) : null;

  // The global system prompt (API Keys → System prompts) leads every call.
  const withGlobal = (system) => [String(cfg.globalSystem || '').trim(), String(system || '').trim()].filter(Boolean).join('\n\n');

  const requireOpenai = () => {
    if (!openai) throw new ExternalAPIError('OpenAI not configured (OPENAI_API_KEY missing)');
    return openai;
  };

  return {
    async generateText({ system, user, model }) {
      const { text } = await this.generateTextDetailed({ system, user, model });
      return text;
    },

    /** Like generateText but also returns the real token usage (for cost). */
    async generateTextDetailed({ system, user, model }) {
      const client = requireOpenai();
      const usedModel = model || cfg.openai.textModel;
      const res = await client.chat.completions.create({
        model: usedModel,
        messages: [
          ...(withGlobal(system) ? [{ role: 'system', content: withGlobal(system) }] : []),
          { role: 'user', content: user },
        ],
      });
      return {
        text: res.choices?.[0]?.message?.content?.trim() || '',
        model: usedModel,
        usage: {
          inputTokens: res.usage?.prompt_tokens || 0,
          outputTokens: res.usage?.completion_tokens || 0,
        },
      };
    },

    async generateJson({ system, user, model, maxTokens = 4000 }) {
      const { data } = await this.generateJsonDetailed({ system, user, model, maxTokens });
      return data;
    },

    /**
     * Like generateJson but also returns the model and real token usage (for cost).
     * `images` (JPEG Buffers) go with the user message, at low detail.
     */
    async generateJsonDetailed({ system, user, model, maxTokens = 4000, images = [] }) {
      const client = requireOpenai();
      const usedModel = model || cfg.openai.textModel;
      const res = await client.chat.completions.create({
        model: usedModel,
        response_format: { type: 'json_object' },
        // max_completion_tokens: newer models reject max_tokens; reasoning tokens count here too.
        max_completion_tokens: maxTokens,
        messages: [
          ...(withGlobal(system) ? [{ role: 'system', content: withGlobal(system) }] : []),
          {
            role: 'user',
            content: images.length
              ? [{ type: 'text', text: user }, ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`, detail: 'low' } }))]
              : user,
          },
        ],
      });
      const raw = res.choices?.[0]?.message?.content || '{}';
      let data;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        throw new ExternalAPIError('LLM returned invalid JSON', { cause: err });
      }
      return {
        data,
        model: usedModel,
        usage: {
          inputTokens: res.usage?.prompt_tokens || 0,
          outputTokens: res.usage?.completion_tokens || 0,
        },
      };
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

    /**
     * A JSON answer about a few images (JPEG Buffers) from Gemini vision; OpenAI
     * when Gemini has no key or its call fails. Returns { data, model, usage, provider }.
     */
    async generateJsonVision({ system, user, images = [], model, maxTokens = 4000 }) {
      if (gemini) {
        const usedModel = model || cfg.gemini.visionModel || 'gemini-2.5-flash';
        try {
          const m = gemini.getGenerativeModel({
            model: usedModel,
            ...(String(system || '').trim() ? { systemInstruction: String(system).trim() } : {}),
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens },
          });
          const res = await m.generateContent([{ text: user }, ...images.map((b) => ({ inlineData: { mimeType: 'image/jpeg', data: Buffer.from(b).toString('base64') } }))]);
          const text = res.response?.text?.() || '';
          let data;
          try { data = JSON.parse(text); } catch { throw new ExternalAPIError(`Gemini returned no JSON: ${text.slice(0, 120)}`); }
          const u = res.response?.usageMetadata || {};
          return { data, model: usedModel, provider: 'gemini', usage: { inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0 } };
        } catch (err) {
          if (!openai) throw err;
          log?.warn?.({ err: err.message }, 'Gemini vision failed, asking OpenAI');
        }
      }
      return { ...(await this.generateJsonDetailed({ system, user, images, maxTokens })), provider: 'openai' };
    },

    /**
     * A 429 is read in plain words: a per-minute limit waits Google's retry
     * delay and tries once more; limit 0 or a spent daily quota throws at once
     * with the reason, and err.geminiQuota set so a caller can switch provider.
     */
    async generateImageGemini({ prompt, model }) {
      if (!gemini) throw new ExternalAPIError('Gemini not configured (GEMINI_API_KEY missing)');
      const m = gemini.getGenerativeModel({ model: model || cfg.gemini.imageModel });
      let res;
      for (let attempt = 0; ; attempt += 1) {
        try {
          res = await m.generateContent(prompt);
          break;
        } catch (err) {
          const q = geminiQuotaOf(err);
          if (!q) throw err;
          const wait = attempt === 0 ? quotaRetryWait(q) : null;
          if (wait != null) {
            log?.warn?.({ wait, model: q.model }, 'Gemini per-minute limit, waiting once');
            await sleep(wait * 1000);
            continue;
          }
          const e = new ExternalAPIError(geminiQuotaReason(q), { status: 429, cause: err });
          e.geminiQuota = q;
          throw e;
        }
      }
      const parts = res.response?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) return Buffer.from(p.inlineData.data, 'base64');
      }
      throw new ExternalAPIError('Gemini image response had no inline image data');
    },
  };
}

export default { createLlmProvider };
