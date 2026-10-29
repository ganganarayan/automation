/**
 * Model catalog (pure).
 *
 * Purpose:      Turn a provider's raw model listing into the short, relevant
 *               lists the settings dropdowns offer, so a model is always PICKED
 *               from what the key can actually call — never typed by hand (a
 *               typo there fails at generation time, long after saving).
 * Responsibility: Pure classification only; the network call lives in
 *               providers/modelsProvider.
 * Dependencies: none.
 */

/** OpenAI: split ids into image-capable and text/chat models. */
export function classifyOpenAiModels(ids = []) {
  const all = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].sort();
  const isImage = (id) => /(^|[-_])image|dall-e/i.test(id);
  const isNonText = (id) => /embedding|whisper|tts|audio|moderation|realtime|transcribe|rerank|search/i.test(id);
  return {
    image: all.filter((id) => isImage(id) && !isNonText(id)),
    text: all.filter((id) => !isImage(id) && !isNonText(id) && /^(gpt|o\d|chatgpt)/i.test(id)),
  };
}

/** Gemini: accepts the raw models[] (objects with .name) or plain name strings. */
export function classifyGeminiModels(models = []) {
  const rows = (Array.isArray(models) ? models : []).map((m) => (typeof m === 'string' ? { name: m } : (m || {})));
  const names = [...new Set(rows.map((m) => String(m.name || '')).filter(Boolean))].sort();
  return {
    image: names.filter((n) => /image/i.test(n)),
    text: names.filter((n) => /gemini/i.test(n) && !/image|embedding|aqa/i.test(n)),
  };
}

/**
 * Build the catalog blob stored in tenant_config.models_catalog. Keys match the
 * `catalog` of each model_select field so the renderer can look its list up.
 */
export function buildCatalog({ openaiIds, geminiModels } = {}, at = new Date()) {
  const out = { refreshedAt: at.toISOString() };
  if (openaiIds !== undefined) {
    const o = classifyOpenAiModels(openaiIds);
    out.openai_image = o.image;
    out.openai_text = o.text;
  }
  if (geminiModels !== undefined) {
    const g = classifyGeminiModels(geminiModels);
    out.gemini_image = g.image;
    out.gemini_text = g.text;
  }
  return out;
}

export default { classifyOpenAiModels, classifyGeminiModels, buildCatalog };
