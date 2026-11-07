/**
 * Claude provider: writes the Ready video copy and image prompt.
 *
 * Purpose:      Give the copy writer what a chat with Claude has: the model, and
 *               the owner's background (rules, past decisions, prompts that
 *               worked), pasted once in Settings and sent with every video.
 * Responsibility:
 *               - generateJsonDetailed({ system, user, schema }): { data, model, usage }
 * Dependencies: @anthropic-ai/sdk, errors.
 *
 * The owner's background is the first, cached system block: a retry within a few
 * minutes reads it at a tenth of the price. If Opus declines a request the API
 * reruns it on its default fallback model, inside the same call.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ExternalAPIError } from '../core/errors.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The system blocks: house rules and the owner's background first (cached), this call's instructions after. */
export function claudeSystem({ globalSystem = '', context = '', system = '' }) {
  const background = String(context || '').trim();
  const lead = [
    String(globalSystem || '').trim(),
    background ? `Background from the owner: their rules, past decisions and examples of work they approved. Write the way this background shows, and when it disagrees with the general instructions after it about the picture or the voice, it wins.\n\n<owner_background>\n${background}\n</owner_background>` : '',
  ].filter(Boolean).join('\n\n');
  return [
    ...(lead ? [{ type: 'text', text: lead, cache_control: { type: 'ephemeral' } }] : []),
    { type: 'text', text: String(system || '').trim() },
  ];
}

/** `client` is for tests; the app builds it from the key in Settings. */
export function createClaudeProvider({ apiKey, model, context = '', globalSystem = '' }, log, client = new Anthropic({ apiKey })) {
  const usedModel = String(model || '').trim() || DEFAULT_CLAUDE_MODEL;
  return {
    async generateJsonDetailed({ system, user, schema, maxTokens = 16000 }) {
      let res;
      try {
        res = await client.beta.messages.stream({
          model: usedModel,
          max_tokens: maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: 'high', ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
          system: claudeSystem({ globalSystem, context, system }),
          messages: [{ role: 'user', content: user }],
        }).finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new ExternalAPIError('Claude refused the API key: check it under Setup → Keys and credit', { cause: err });
        throw new ExternalAPIError(`Claude: ${err.message}`, { cause: err });
      }
      if (res.stop_reason === 'refusal') throw new ExternalAPIError(`Claude declined this video${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ''}`);
      if (res.stop_reason === 'max_tokens') throw new ExternalAPIError('Claude ran out of room before finishing the copy, try again');
      const raw = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      let data;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        throw new ExternalAPIError('Claude returned invalid JSON', { cause: err });
      }
      log?.info?.({ model: res.model, cacheRead: res.usage?.cache_read_input_tokens || 0 }, 'claude copy written');
      return {
        data,
        model: res.model || usedModel,
        usage: {
          inputTokens: res.usage?.input_tokens || 0,
          outputTokens: res.usage?.output_tokens || 0,
          cacheReadTokens: res.usage?.cache_read_input_tokens || 0,
          cacheWriteTokens: res.usage?.cache_creation_input_tokens || 0,
        },
      };
    },
  };
}

export default { createClaudeProvider, claudeSystem, DEFAULT_CLAUDE_MODEL };
