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
import * as tenantConfig from '../repositories/tenantConfigRepository.js';

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

export function invalidate(tenantId) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

const APP = 'content-engine';

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
  return !!settings.modules[name];
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
  const pick = (key, fallback) => (o[key] !== undefined && o[key] !== null && o[key] !== '' ? o[key] : fallback);

  return {
    tenantId,
    sheets: {
      gita: pick('gita_sheet_id', settings.sheets.gita),
      vidapulse: pick('vidapulse_sheet_id', settings.sheets.vidapulse),
      video: pick('video_sheet_id', settings.sheets.video),
      factory: pick('factory_sheet_id', settings.sheets.factory),
    },
    drive: {
      gitaFolder: pick('gita_drive_folder_id', settings.drive.gitaFolder),
      stripFile: pick('strip_file_id', settings.drive.stripFile),
      voiceoverFolder: pick('voiceover_folder_id', settings.drive.voiceoverFolder),
      reelsFolder: pick('reels_folder_id', settings.drive.reelsFolder),
      factoryGptFolder: pick('factory_gpt_folder_id', settings.drive.factoryGptFolder),
      factoryGeminiFolder: pick('factory_gemini_folder_id', settings.drive.factoryGeminiFolder),
    },
    postforme: {
      gitaAccounts: parseJson(pick('pfm_gita_accounts', null), settings.postforme.gitaAccounts),
      vidapulseAccounts: parseJson(pick('pfm_vidapulse_accounts', null), settings.postforme.vidapulseAccounts),
      gitaVideoAccounts: parseJson(pick('pfm_gita_video_accounts', null), settings.postforme.gitaVideoAccounts),
      accountMap: parseJson(pick('pfm_account_map', null), settings.postforme.accountMap),
    },
    emails: {
      approvalGita: pick('approval_email_gita', settings.emails.approvalGita),
      approvalVidapulse: pick('approval_email_vidapulse', settings.emails.approvalVidapulse),
      report: pick('report_email', settings.emails.report),
    },
    links: {
      gitaAssessment: pick('gita_assessment_link', settings.links.gitaAssessment),
      gitaSimpleAssessment: pick('gita_simple_assessment_link', settings.links.gitaSimpleAssessment),
    },
    // Tenant-scoped credentials (BYO). Env is only a platform-provided default.
    openai: {
      apiKey: pick('openai_api_key', settings.openai.apiKey),
      imageModel: pick('image_model', settings.openai.imageModel),
      textModel: pick('text_model', settings.openai.textModel),
    },
    gemini: {
      apiKey: pick('gemini_api_key', settings.gemini.apiKey),
      imageModel: pick('gemini_image_model', settings.gemini.imageModel),
    },
    postformeKey: pick('postforme_api_key', settings.postforme.apiKey),
    video: {
      json2videoApiKey: pick('json2video_api_key', settings.video.json2videoApiKey),
    },
    instagram: {
      automationUrl: pick('ig_automation_url', settings.instagram.automationUrl),
      contactEmail: pick('ig_contact_email', settings.instagram.contactEmail),
      commentWebhookUrl: pick('ig_comment_webhook_url', settings.instagram.commentWebhookUrl),
    },
  };
}

export default { forTenant, invalidate };
