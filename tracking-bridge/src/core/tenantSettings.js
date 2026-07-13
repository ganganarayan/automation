/**
 * Tenant-aware settings resolver.
 *
 * Purpose:      Resolve configuration for a tenant, overlaying tenant_config
 *               overrides on top of the environment settings, so the shared
 *               config UI can drive tracking-bridge per tenant. Env acts as the
 *               fallback for the default tenant.
 * Responsibility: Build a per-tenant view of the settings groups the modules
 *               need, plus per-tenant module enablement.
 * Dependencies: settings, tenantConfigRepository.
 */
import { settings } from '../settings/index.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';

const APP = 'tracking-bridge';
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

/**
 * Whether a module is enabled for a tenant. A `module.tracking-bridge.<name>`
 * override wins; otherwise the env flag is the default.
 */
export async function moduleEnabled(tenantId = 'default', name) {
  const o = await loadOverrides(tenantId);
  const v = o[`module.${APP}.${name}`];
  if (v === 'true') return true;
  if (v === 'false') return false;
  return !!settings.modules[name];
}

/** A resolved settings view for a tenant (tenant_config over env). */
export async function forTenant(tenantId = 'default') {
  const o = await loadOverrides(tenantId);
  const pick = (key, fallback) => (o[key] !== undefined && o[key] !== null && o[key] !== '' ? o[key] : fallback);

  return {
    tenantId,
    razorpay: {
      webhookSecret: pick('razorpay_webhook_secret', settings.razorpay.webhookSecret),
    },
    meta: {
      pixelId: pick('meta_pixel_id', settings.meta.pixelId),
      capiToken: pick('meta_capi_token', settings.meta.capiToken),
      apiVersion: pick('meta_api_version', settings.meta.apiVersion),
      testEventCode: settings.meta.testEventCode, // env-only (transient test switch)
      eventSourceUrl: pick('event_source_url', settings.meta.eventSourceUrl),
      contentName: pick('content_name', settings.meta.contentName),
      adAccountId: pick('meta_ad_account_id', settings.meta.adAccountId),
      adsToken: pick('meta_ads_token', settings.meta.adsToken),
    },
    insights: {
      sheetId: pick('insights_sheet_id', settings.insights.sheetId),
      lookbackDays: settings.insights.lookbackDays,
    },
    assess360: {
      url: (pick('assess360_url', settings.assess360.url) || '').replace(/\/+$/, ''),
      token: pick('assess360_token', settings.assess360.token),
    },
  };
}

export default { forTenant, moduleEnabled, invalidate };
