/**
 * Model listing (provider discovery).
 *
 * Purpose:      Ask each AI provider which models the saved key can actually
 *               call, so the settings UI can offer a picked list instead of a
 *               free-text box.
 * Responsibility: The network call only; classification lives in
 *               utils/modelCatalog.
 * Dependencies: httpClient, lazy-imported so this module (and the test/app
 *               import graph) doesn't need settings/DATABASE_URL at load.
 *
 * Keys travel in headers, never in the URL/query string.
 */
const OPENAI_URL = 'https://api.openai.com/v1/models';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';

let _request = null;
async function req(url, opts) {
  if (!_request) ({ request: _request } = await import('../core/httpClient.js'));
  return _request(url, opts);
}

/** Model ids the OpenAI key can call. */
export async function listOpenAiModels(apiKey, log) {
  if (!apiKey) throw new Error('No OpenAI API key saved — add it above and Save first.');
  const res = await req(OPENAI_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    label: 'models.openai', log, retries: 1,
  });
  if (!res.ok) throw new Error(`OpenAI model list failed (${res.status})`);
  return ((res.data && res.data.data) || []).map((m) => m && m.id).filter(Boolean);
}

/** Model objects the Gemini key can call (name + supportedGenerationMethods). */
export async function listGeminiModels(apiKey, log) {
  if (!apiKey) throw new Error('No Gemini API key saved — add it above and Save first.');
  const res = await req(GEMINI_URL, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey },
    label: 'models.gemini', log, retries: 1,
  });
  if (!res.ok) throw new Error(`Gemini model list failed (${res.status})`);
  return (res.data && res.data.models) || [];
}

export default { listOpenAiModels, listGeminiModels };
