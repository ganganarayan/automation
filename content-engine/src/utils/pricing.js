/**
 * AI cost engine (real spend from measured usage).
 *
 * Purpose:      Turn the ACTUAL quantities an API call reports — tokens, image
 *               count, clip seconds, characters, audio minutes — into a dollar
 *               cost, using a unit-price table the operator controls. Every
 *               figure is auditable: each entry carries provider, model, unit,
 *               quantity, unit price, and the computed cost. Not an estimate of
 *               usage — the usage is real; only the per-unit price is a setting.
 * Responsibility: Pure functions + the default price table. No I/O.
 * Dependencies: none.
 *
 * Prices are USD, reference values as of 2026-10-20, meant to be overridden per
 * tenant with your real contracted rates (pass `prices` to override a default).
 */

export const DEFAULT_PRICES = {
  // Text models: USD per 1,000,000 tokens (input / output).
  text: {
    'gpt-5-mini': { inPer1M: 0.25, outPer1M: 2.0 },
    default: { inPer1M: 0.25, outPer1M: 2.0 },
  },
  // Image generation: USD per image, by pixel size.
  image: {
    '1024x1024': 0.04,
    '1024x1536': 0.07,
    '1536x1024': 0.07,
    default: 0.07,
  },
  // Image -> video: USD per generated second, by provider.
  animation: {
    kling: 0.035,
    runway: 0.05,
    hailuo: 0.045,
    default: 0.05,
  },
  // Text-to-speech: USD per 1,000 characters, by provider.
  tts: {
    elevenlabs: 0.18,
    heygen: 0.3,
    default: 0.18,
  },
  // Transcription: USD per audio minute, by provider.
  transcript: {
    whisper: 0.006,
    turboscribe: 0.0,
    default: 0.006,
  },
};

const r4 = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4;
const pick = (table, key) => (table && (key in table) ? table[key] : table.default);

function entry({ provider, model, unit, quantity, unitPriceUsd }) {
  return {
    provider: provider || model || 'unknown',
    model: model || null,
    unit,
    quantity: Number(quantity) || 0,
    unitPriceUsd: r4(unitPriceUsd),
    costUsd: r4((Number(quantity) || 0) * (Number(unitPriceUsd) || 0)),
  };
}

/** Script / LLM text cost from real token usage. */
export function costText({ inputTokens = 0, outputTokens = 0, model = 'default' }, prices = DEFAULT_PRICES) {
  const p = pick(prices.text, model);
  const costUsd = r4((inputTokens / 1e6) * p.inPer1M + (outputTokens / 1e6) * p.outPer1M);
  return {
    provider: 'openai',
    model,
    unit: 'tokens',
    quantity: (Number(inputTokens) || 0) + (Number(outputTokens) || 0),
    unitPriceUsd: null,
    costUsd,
    inputTokens: Number(inputTokens) || 0,
    outputTokens: Number(outputTokens) || 0,
  };
}

/** Image generation cost from the real number of images at a size. */
export function costImages({ count = 0, size = 'default', model = 'gpt-image-1' }, prices = DEFAULT_PRICES) {
  const unitPriceUsd = pick(prices.image, size);
  return entry({ provider: 'openai', model, unit: 'images', quantity: count, unitPriceUsd });
}

/** Animation cost from the real generated seconds for a provider. */
export function costAnimation({ provider = 'default', seconds = 0 }, prices = DEFAULT_PRICES) {
  const unitPriceUsd = pick(prices.animation, provider);
  return entry({ provider, model: null, unit: 'seconds', quantity: seconds, unitPriceUsd });
}

/** Voiceover cost from the real character count for a provider. */
export function costTts({ provider = 'default', chars = 0 }, prices = DEFAULT_PRICES) {
  const per1k = pick(prices.tts, provider);
  return entry({ provider, model: null, unit: 'chars', quantity: chars, unitPriceUsd: per1k / 1000 });
}

/** Transcription cost from the real audio minutes for a provider. */
export function costTranscript({ provider = 'default', minutes = 0 }, prices = DEFAULT_PRICES) {
  const unitPriceUsd = pick(prices.transcript, provider);
  return entry({ provider, model: null, unit: 'minutes', quantity: minutes, unitPriceUsd });
}

/** Sum an array of cost entries (each must carry costUsd). */
export function sumCosts(entries) {
  return r4((Array.isArray(entries) ? entries : []).reduce((t, e) => t + (Number(e?.costUsd) || 0), 0));
}

export default {
  DEFAULT_PRICES,
  costText,
  costImages,
  costAnimation,
  costTts,
  costTranscript,
  sumCosts,
};
