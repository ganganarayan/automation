/**
 * Tenant-aware settings resolver.
 *
 * Purpose:      Resolve configuration for a tenant, overlaying tenant_config
 *               overrides on top of environment settings so per-brand values can
 *               move into the database later without a code change.
 * Responsibility: Build a per-tenant view of the settings groups modules need.
 * Dependencies: settings, tenantConfigRepository.
 */
import { settings } from '../settings/index.js';
import { DEFAULT_MAIL_PROVIDER } from '../utils/mailApis.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import { scopeFor, OWNER_TENANT } from '../utils/pfmScope.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map();

async function loadOverrides(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.map;
  let map = {};
  try {
    map = await tenantConfig.getAll(tenantId);
  } catch {
    return {}; // fail safe: fall back to env defaults, retry next call
  }
  cache.set(tenantId, { at: Date.now(), map });
  return map;
}

// Every tenant id but the owner's, for the shared Post for Me key (null = unknown: fail closed).
let tenantIds = null;
async function otherTenantIds() {
  if (tenantIds && Date.now() - tenantIds.at < CACHE_TTL_MS) return tenantIds.ids;
  try {
    const ids = (await tenantRepo.list()).map((t) => String(t.id)).filter((id) => id !== OWNER_TENANT);
    tenantIds = { at: Date.now(), ids };
    return ids;
  } catch {
    return null;
  }
}

/**
 * The Post for Me key a tenant posts with and its scope. A tenant with a key of
 * its own uses it (scope null, the whole account is its own). Otherwise it uses
 * the owner's shared key (set on the default tenant by the super admin) and only
 * ever sees accounts connected with its own external_id.
 */
export async function postformeFor(tenantId, o) {
  const id = String(tenantId || OWNER_TENANT);
  const ownKey = String((o && o.postforme_api_key) || '').trim();
  const ownerO = id === OWNER_TENANT ? o : await loadOverrides(OWNER_TENANT);
  const ownerKey = String((ownerO && ownerO.postforme_api_key) || settings.postforme.apiKey || '').trim();
  const key = id === OWNER_TENANT ? ownerKey : (ownKey || ownerKey);
  const scope = key ? scopeFor({ tenantId: id, ownKey: id === OWNER_TENANT ? '' : ownKey, ownerKey, ownerTenant: OWNER_TENANT, otherTenants: id === OWNER_TENANT ? await otherTenantIds() : null }) : null;
  return { key, scope, shared: !!scope && key === ownerKey };
}

// The paid provider keys. A tenant's own key wins; without one it uses the
// owner's (the platform key, on the owner's bill), except on a plan that
// brings its own keys (Agency). The env value is the owner's last fallback.
const PROVIDER_KEYS = {
  openai_api_key: { provider: 'openai', env: () => settings.openai.apiKey },
  anthropic_api_key: { provider: 'anthropic', env: () => '' },
  gemini_api_key: { provider: 'gemini', env: () => settings.gemini.apiKey },
  kling_access_key: { provider: 'kling', env: () => '' },
  kling_secret_key: { provider: 'kling', env: () => '' },
  runway_api_key: { provider: 'runway', env: () => '' },
  hailuo_api_key: { provider: 'hailuo', env: () => '' },
  hailuo_group_id: { provider: 'hailuo', env: () => '' },
  elevenlabs_api_key: { provider: 'elevenlabs', env: () => '' },
  heygen_api_key: { provider: 'heygen', env: () => '' },
  transcript_api_key: { provider: 'transcript', env: () => '' },
  json2video_api_key: { provider: 'json2video', env: () => settings.video.json2videoApiKey },
};
export const BYO_PLANS = ['agency'];

const planCache = new Map();
async function planOf(tenantId) {
  const hit = planCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.plan;
  let plan = 'custom';
  try { plan = ((await tenantRepo.findById(tenantId)) || {}).plan || 'custom'; } catch { /* keep custom */ }
  planCache.set(tenantId, { at: Date.now(), plan });
  return plan;
}

/**
 * One provider key for a tenant: [value, owner] where owner is 'tenant' (its
 * own), 'platform' (the owner's) or 'none'. Pure, for tests.
 */
export function providerKey(key, { own = {}, owner = {}, isOwner = false, byo = false, envValue = '' }) {
  const mine = String(own[key] ?? '').trim();
  if (mine) return [mine, isOwner ? 'platform' : 'tenant'];
  if (isOwner) return [envValue || '', envValue ? 'platform' : 'none'];
  if (byo) return ['', 'none'];
  const plat = String(owner[key] ?? '').trim() || String(envValue || '').trim();
  return [plat, plat ? 'platform' : 'none'];
}

export function invalidate(tenantId) {
  planCache.clear();
  tenantIds = null;
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

const APP = 'content-engine';

/**
 * The env defaults a tenant may fall back on. The default tenant (the owner)
 * gets them all; any other tenant only platform pieces: model names, the SMTP
 * port and the Google service account (it reads only what a tenant shares with it).
 */
export function envFor(tenantId = OWNER_TENANT, base = settings) {
  if (String(tenantId || OWNER_TENANT) === OWNER_TENANT) return base;
  return {
    google: { serviceAccount: base.google.serviceAccount },
    sheets: {},
    drive: {},
    postforme: { apiKey: '', gitaAccounts: [], vidapulseAccounts: [], gitaVideoAccounts: [], accountMap: {} },
    emails: {},
    links: {},
    openai: { apiKey: '', imageModel: base.openai.imageModel, textModel: base.openai.textModel },
    gemini: { apiKey: '', imageModel: base.gemini.imageModel },
    video: { json2videoApiKey: '' },
    instagram: {},
    smtp: { port: base.smtp.port },
    modules: {},
  };
}

/**
 * Whether a module is enabled for a tenant. A `module.content-engine.<name>`
 * tenant_config override ('true'/'false') wins; otherwise the env flag
 * (settings.modules[name]) is the default, so behavior is unchanged when no
 * override exists.
 * @param {string} tenantId
 * @param {string} name - camelCase module key (e.g. 'gitaImage')
 */
export async function moduleEnabled(tenantId = 'default', name) {
  const o = await loadOverrides(tenantId);
  const v = o[`module.${APP}.${name}`];
  if (v === 'true') return true;
  if (v === 'false') return false;
  // The env flags are the owner's (its own brands' jobs); another tenant turns a module on itself.
  return !!envFor(tenantId).modules[name];
}

const parseJson = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

/**
 * Build a resolved settings view for a tenant. Env is the fallback for the
 * default tenant; tenant_config keys override when present.
 */
export async function forTenant(tenantId = 'default') {
  const o = await loadOverrides(tenantId);
  // The owner's env values are the default tenant's only: another tenant gets
  // its own settings or nothing (model names and the Google service account,
  // platform infrastructure, are shared).
  const env = envFor(tenantId);
  const pick = (key, fallback) => (o[key] !== undefined && o[key] !== null && o[key] !== '' ? o[key] : fallback);
  const pfm = await postformeFor(tenantId, o);
  const isOwner = String(tenantId || OWNER_TENANT) === OWNER_TENANT;
  const ownerO = isOwner ? o : await loadOverrides(OWNER_TENANT);
  const byo = isOwner ? false : BYO_PLANS.includes(await planOf(String(tenantId)));
  const keyOwners = {};
  const key = (k) => {
    const [v, who] = providerKey(k, { own: o, owner: ownerO, isOwner, byo, envValue: PROVIDER_KEYS[k].env() });
    const p = PROVIDER_KEYS[k].provider;
    if (!keyOwners[p] || keyOwners[p] === 'none') keyOwners[p] = who;
    return v;
  };

  return {
    tenantId,
    // Google Sheets/Drive identity: the service-account JSON set in the app
    // (write-only in the UI) wins; env GOOGLE_SERVICE_ACCOUNT_JSON is a fallback.
    google: {
      serviceAccount: parseJson(pick('google_service_account_json', null), null) || env.google.serviceAccount,
      // "Sign in with Google" + Drive picker (browser-side; no secret).
      oauthClientId: String(pick('google_oauth_client_id', '') || '').trim(),
      pickerApiKey: String(pick('google_picker_api_key', '') || '').trim(),
      projectNumber: String(pick('google_project_number', '') || '').trim(),
      // The one-time "Connect Google Drive" (server side) needs the secret too.
      oauthClientSecret: String(pick('google_oauth_client_secret', '') || '').trim(),
    },
    // ✂ Clean: where it runs, and the GitHub Actions runner's settings.
    clean: {
      runner: String(pick('clean_runner', 'railway') || 'railway').trim(),
      githubToken: String(pick('github_actions_token', '') || '').trim(),
      githubRepo: String(pick('github_repo', '') || '').trim(),
      githubRef: String(pick('github_ref', '') || '').trim(),
    },
    sheets: {
      gita: pick('gita_sheet_id', env.sheets.gita),
      vidapulse: pick('vidapulse_sheet_id', env.sheets.vidapulse),
      video: pick('video_sheet_id', env.sheets.video),
      factory: pick('factory_sheet_id', env.sheets.factory),
    },
    drive: {
      gitaFolder: pick('gita_drive_folder_id', env.drive.gitaFolder),
      stripFile: pick('strip_file_id', env.drive.stripFile),
      voiceoverFolder: pick('voiceover_folder_id', env.drive.voiceoverFolder),
      reelsFolder: pick('reels_folder_id', env.drive.reelsFolder),
      factoryGptFolder: pick('factory_gpt_folder_id', env.drive.factoryGptFolder),
      factoryGeminiFolder: pick('factory_gemini_folder_id', env.drive.factoryGeminiFolder),
    },
    postforme: {
      gitaAccounts: parseJson(pick('pfm_gita_accounts', null), env.postforme.gitaAccounts),
      vidapulseAccounts: parseJson(pick('pfm_vidapulse_accounts', null), env.postforme.vidapulseAccounts),
      gitaVideoAccounts: parseJson(pick('pfm_gita_video_accounts', null), env.postforme.gitaVideoAccounts),
      accountMap: parseJson(pick('pfm_account_map', null), env.postforme.accountMap),
    },
    emails: {
      // One address for every approval / go-live email a funnel has no own address for.
      notify: pick('notify_email', ''),
      approvalGita: pick('approval_email_gita', env.emails.approvalGita),
      approvalVidapulse: pick('approval_email_vidapulse', env.emails.approvalVidapulse),
      report: pick('report_email', env.emails.report),
    },
    links: {
      gitaAssessment: pick('gita_assessment_link', env.links.gitaAssessment),
      gitaSimpleAssessment: pick('gita_simple_assessment_link', env.links.gitaSimpleAssessment),
    },
    // Tenant-scoped credentials (BYO). Env is only a platform-provided default.
    openai: {
      apiKey: key('openai_api_key'),
      imageModel: pick('image_model', env.openai.imageModel),
      textModel: pick('text_model', env.openai.textModel),
    },
    // The Ready video copy writer. No key = the OpenAI text model, as before.
    claude: {
      apiKey: String(key('anthropic_api_key') || '').trim(),
      model: pick('claude_model', ''),
    },
    gemini: {
      apiKey: key('gemini_api_key'),
      imageModel: pick('gemini_image_model', env.gemini.imageModel),
    },
    // Post for Me: the tenant's own key, else the owner's shared one (see postformeFor).
    postformeKey: pfm.key,
    postformeScope: pfm.scope,
    postformeShared: pfm.shared,
    // Per provider: 'tenant' (its own key), 'platform' (the owner's) or 'none'.
    get keyOwners() { return keyOwners; },
    // Central provider credentials (API Keys page). Funnels pick the provider;
    // the key is always taken from here, never from funnel_config.
    animation: {
      klingAccessKey: key('kling_access_key'),
      klingSecretKey: key('kling_secret_key'),
      runwayApiKey: key('runway_api_key'),
      hailuoApiKey: key('hailuo_api_key'),
      hailuoGroupId: key('hailuo_group_id'),
    },
    tts: {
      elevenlabsApiKey: key('elevenlabs_api_key'),
      heygenApiKey: key('heygen_api_key'),
    },
    transcriptKey: key('transcript_api_key'),
    // Comparison videos. Blank = the built-in Assess360 list.
    comparison: {
      list: pick('comparison_list', ''),
      brand: pick('comparison_brand', ''),
      logo: pick('comparison_logo', ''),
    },
    // The music on a YouTube Short made from an image post.
    shortMusic: {
      track: pick('short_music', ''),
      url: pick('short_music_url', ''),
    },
    // Image posts: 'on' = a video with music and the caption read aloud (default),
    // 'music' = a video with music only, 'off' = the picture.
    imageVideo: pick('image_video', 'on'),
    // Where image-post videos are made, start to finish: 'github' (default) or 'railway';
    // the fail-safe ('on' default) makes it in the other place when that fails.
    imageVideoRunner: pick('image_video_runner', 'github'),
    imageVideoFailSafe: pick('image_video_failsafe', 'on'),
    // What the app learned from your Disapprove reasons and Remake corrections (utils/lessonSpec).
    lessons: { image: pick('lessons_image', ''), video: pick('lessons_video', '') },
    // System prompts (API Keys → System prompts). Blank = the built-in default.
    prompts: {
      global: pick('system_prompt_global', ''),
      copy: pick('system_prompt_copy', ''),
      claudeContext: pick('claude_context', ''),
      thumbnail: pick('system_prompt_thumbnail', ''),
      comparison: pick('system_prompt_comparison', ''),
      script: pick('system_prompt_script', ''),
      refill: pick('system_prompt_refill', ''),
      // Names / spellings, passed to Whisper as its prompt.
      glossary: pick('transcript_glossary', ''),
    },
    video: {
      json2videoApiKey: key('json2video_api_key'),
    },
    instagram: {
      automationUrl: pick('ig_automation_url', env.instagram.automationUrl),
      contactEmail: pick('ig_contact_email', env.instagram.contactEmail),
      commentWebhookUrl: pick('ig_comment_webhook_url', env.instagram.commentWebhookUrl),
    },
    // Email/SMTP is tenant-scoped (each tenant sends from their own mailbox);
    // env is only a fallback default.
    smtp: {
      host: pick('smtp_host', env.smtp.host),
      port: Number(pick('smtp_port', env.smtp.port)) || env.smtp.port,
      user: pick('smtp_user', env.smtp.user),
      pass: pick('smtp_pass', env.smtp.pass),
      from: pick('smtp_from', env.smtp.from),
    },
    // How email goes out. Railway blocks outbound SMTP, so the default is an
    // HTTP email API; From falls back to the SMTP From/user already entered.
    mail: {
      provider: String(pick('mail_provider', DEFAULT_MAIL_PROVIDER)).trim(),
      apiKey: String(pick('mail_api_key', '') || '').trim(),
      from: String(pick('mail_from', pick('smtp_from', env.smtp.from) || pick('smtp_user', env.smtp.user)) || '').trim(),
      // Gmail: the account connected under Settings, Google, if it allowed sending.
      gmailEmail: String(pick('google_drive_email', '') || '').trim(),
      gmailReady: !!pick('google_drive_refresh_token', '') && String(pick('google_drive_scopes', '')).includes('gmail.send'),
    },
  };
}

export default { forTenant, invalidate };
