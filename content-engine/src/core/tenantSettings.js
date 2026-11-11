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
import { isLean } from '../utils/planSpec.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map();
// Override maps that came from a failed read (the {} fallback): never written back.
const failedReads = new WeakSet();

async function loadOverrides(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.map;
  let map = {};
  try {
    map = await tenantConfig.getAll(tenantId);
  } catch {
    const empty = {};
    failedReads.add(empty);
    return empty; // fail safe: fall back to env defaults, retry next call
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
  if (id !== OWNER_TENANT) {
    const meta = await tenantMeta(id);
    // Unknown (failed read): post nowhere rather than on the wrong key.
    if (meta.failed) return { key: '', scope: null, shared: false };
    // A client on its agency's Post for Me key: only accounts with its own
    // external_id, events on the agency's webhook.
    if (meta.parentId && !ownKey) {
      const agencyKey = String(((await loadOverrides(meta.parentId)) || {}).postforme_api_key || '').trim();
      if (agencyKey && agencyKey !== ownerKey) {
        return { key: agencyKey, scope: scopeFor({ tenantId: id, ownKey: '', ownerKey: agencyKey, ownerTenant: meta.parentId }), shared: false, agencyKey: true };
      }
    }
    // An agency on its own key with clients on it: its clients' accounts are not its own.
    if (!meta.parentId && ownKey && ownKey !== ownerKey && meta.plan === 'agency') {
      const kids = await clientsOnKey(id, ownKey);
      if (kids.length) return { key: ownKey, scope: scopeFor({ tenantId: id, ownerTenant: id, otherTenants: kids }), shared: false };
    }
  }
  const key = id === OWNER_TENANT ? ownerKey : (ownKey || ownerKey);
  const scope = key ? scopeFor({ tenantId: id, ownKey: id === OWNER_TENANT ? '' : ownKey, ownerKey, ownerTenant: OWNER_TENANT, otherTenants: id === OWNER_TENANT ? await otherTenantIds() : null }) : null;
  return { key, scope, shared: !!scope && key === ownerKey };
}

/** An agency's clients that post on its own Post for Me key (no key of their own). */
async function clientsOnKey(agencyId, agencyKey) {
  let kids = [];
  try { kids = await tenantRepo.childrenOf(agencyId); } catch { return []; }
  const out = [];
  for (const k of kids) {
    const ko = await loadOverrides(String(k.id));
    const theirs = String((ko && ko.postforme_api_key) || '').trim();
    if (!theirs || theirs === agencyKey) out.push(String(k.id));
  }
  return out;
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
/**
 * Does this workspace bring its own AI keys? Only an Agency on the old flat
 * price: one bought per client (units set) has AI included, on the owner's keys.
 */
export function bringsOwnKeys(meta) {
  return !!meta && BYO_PLANS.includes(meta.plan) && !(Number(meta.units) > 0);
}

const planCache = new Map();
async function tenantMeta(tenantId) {
  const hit = planCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  let plan = 'custom';
  let exists = false;
  let parentId = null;
  let units = null;
  let failed = false;
  try {
    // One retry: the first query after the app wakes can fail.
    const row = await tenantRepo.findById(tenantId)
      .catch(() => new Promise((r) => setTimeout(r, 400)).then(() => tenantRepo.findById(tenantId)));
    exists = !!row;
    plan = (row || {}).plan || 'custom';
    parentId = row && row.parent_id ? String(row.parent_id) : null;
    units = row && row.units !== undefined && row.units !== null ? Number(row.units) : null;
  } catch {
    // A database hiccup: the last known answer, else "unknown" (callers fail closed).
    if (hit) return hit;
    failed = true;
  }
  const meta = { at: Date.now(), plan, exists, parentId, units, failed };
  if (!failed) planCache.set(tenantId, meta);
  return meta;
}

/** True once tenantMeta found a tenants row (no write for an id that has none). */
function tenantKnown(tenantId) {
  return !!(planCache.get(tenantId) || {}).exists;
}

/**
 * One provider key for a tenant: [value, owner] where owner is 'tenant' (its
 * own, or its agency's: not on the owner's bill), 'platform' (the owner's) or
 * 'none'. A client of an agency (agency = the agency's overrides) uses its own
 * key, else the agency's, and never the owner's. Pure, for tests.
 */
export function providerKey(key, { own = {}, owner = {}, isOwner = false, byo = false, envValue = '', agency = null, agencyIncluded = false }) {
  const mine = String(own[key] ?? '').trim();
  if (mine) return [mine, isOwner ? 'platform' : 'tenant'];
  if (isOwner) return [envValue || '', envValue ? 'platform' : 'none'];
  if (agency) {
    const theirs = String(agency[key] ?? '').trim();
    if (theirs) return [theirs, 'tenant'];
    // An agency bought per client has AI included: its clients fall back to the owner's key.
    if (!agencyIncluded) return ['', 'none'];
  }
  if (byo) return ['', 'none'];
  const plat = String(owner[key] ?? '').trim() || String(envValue || '').trim();
  return [plat, plat ? 'platform' : 'none'];
}

/**
 * The key history with today's owners added, or null when nothing changed.
 * Pure, for tests. Keeps the last 60 changes.
 */
export function keyHistoryNext(hist = [], owners = {}, now = new Date()) {
  const last = (hist[hist.length - 1] || {}).owners || null;
  const same = last && Object.keys({ ...last, ...owners }).every((p) => (last[p] || 'none') === (owners[p] || 'none'));
  if (same) return null;
  return [...hist, { from: now.toISOString(), owners: { ...owners } }].slice(-60);
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
  const meta = isOwner ? null : await tenantMeta(String(tenantId));
  // A client of an agency: its agency's keys, never the owner's. A failed read
  // of the tenant is treated as bring-your-own (no owner key) too.
  const agencyO = meta && meta.parentId ? await loadOverrides(meta.parentId) : null;
  const agencyMeta = meta && meta.parentId ? await tenantMeta(meta.parentId) : null;
  // An agency bought per client (units) pays for AI in its price: its clients use the owner's keys.
  // A client's own row carries no units, so only a top-level workspace is judged by its own plan.
  const agencyIncluded = !!agencyMeta && !agencyMeta.failed && !bringsOwnKeys(agencyMeta);
  const byo = isOwner ? false : (!!(meta && meta.failed) || (!!agencyO && !agencyIncluded) || (!meta.parentId && bringsOwnKeys(meta)));
  const keyOwners = {};
  const key = (k) => {
    const [v, who] = providerKey(k, { own: o, owner: ownerO, isOwner, byo, envValue: PROVIDER_KEYS[k].env(), agency: agencyO || null, agencyIncluded });
    const p = PROVIDER_KEYS[k].provider;
    if (!keyOwners[p] || keyOwners[p] === 'none') keyOwners[p] = who;
    return v;
  };
  // Shared platform pieces: a tenant without its own Google OAuth client uses the
  // owner's (the state ticket carries the tenant), and without its own GitHub
  // token the owner's Clean runner (the job ticket carries the tenant). Each is
  // taken as a set, never mixed with the tenant's own half.
  const ownSet = (keys) => keys.some((k) => String(o[k] ?? '').trim());
  const googleShared = !isOwner && !ownSet(['google_oauth_client_id', 'google_oauth_client_secret']);
  const cleanShared = !isOwner && !ownSet(['github_actions_token']);
  const from = (shared) => (k, d = '') => String((shared ? (ownerO[k] ?? '') : pick(k, d)) || d || '').trim();
  const g = from(googleShared);
  const gh = from(cleanShared);
  keyOwners.google = googleShared ? (g('google_oauth_client_id') ? 'platform' : 'none') : (isOwner ? 'platform' : 'tenant');
  keyOwners.github = cleanShared ? (gh('github_actions_token') ? 'platform' : 'none') : (isOwner ? 'platform' : 'tenant');
  // Whose key paid, over time: a new entry each time a tenant's key owners change,
  // so the cost report splits old spend by the key in use on the day.
  // Resolve every paid key first: keyOwners fills in as key() runs, and the history
  // written below must hold who pays for each provider, not only Google and GitHub.
  for (const k of Object.keys(PROVIDER_KEYS)) key(k);
  const keyHistory = parseJson(o.key_history || null, []);
  const hist = Array.isArray(keyHistory) ? keyHistory : [];
  // Only after a good read: a failed one looks empty and would erase the history.
  if (!isOwner && !failedReads.has(o) && tenantKnown(String(tenantId))) {
    const next = keyHistoryNext(hist, keyOwners, new Date());
    if (next) tenantConfig.set(String(tenantId), 'key_history', JSON.stringify(next)).then(() => cache.delete(String(tenantId))).catch(() => {});
  }

  return {
    tenantId,
    // Google Sheets/Drive identity: the service-account JSON set in the app
    // (write-only in the UI) wins; env GOOGLE_SERVICE_ACCOUNT_JSON is a fallback.
    google: {
      serviceAccount: parseJson(pick('google_service_account_json', null), null) || env.google.serviceAccount,
      // Another tenant on the platform's service account: its Drive ids are checked.
      serviceAccountShared: !isOwner && !parseJson(o.google_service_account_json || null, null),
      // "Sign in with Google" + Drive picker (browser-side; no secret).
      oauthClientId: g('google_oauth_client_id'),
      pickerApiKey: g('google_picker_api_key'),
      projectNumber: g('google_project_number'),
      // The one-time "Connect Google Drive" (server side) needs the secret too.
      oauthClientSecret: g('google_oauth_client_secret'),
      oauthShared: googleShared,
    },
    // ✂ Clean: where it runs, and the GitHub Actions runner's settings.
    clean: {
      runner: String(pick('clean_runner', 'railway') || 'railway').trim(),
      githubToken: gh('github_actions_token'),
      githubRepo: gh('github_repo'),
      githubRef: gh('github_ref'),
      shared: cleanShared,
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
    // Starter Lite: one picture per post and the low-cost voice (utils/planSpec.js).
    lean: !isOwner && !!meta && isLean(meta.plan),
    // Per provider: 'tenant' (its own key), 'platform' (the owner's) or 'none'.
    get keyOwners() { return keyOwners; },
    keyHistory: hist,
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
    // Comparison videos. Blank = the built-in Assess360 list, for the owner only
    // (it is the owner's product); another tenant writes its own.
    comparison: {
      builtIn: isOwner,
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
