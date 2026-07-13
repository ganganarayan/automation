/**
 * Default funnel seeding.
 *
 * Purpose:      On boot, ensure the operator's existing brands ("Gita",
 *               "VidaPulse") exist as funnels for the default tenant, seeded
 *               from the current environment values — so the migration from the
 *               two hardcoded brands to the funnel model is transparent.
 * Responsibility: Idempotent seed; only fills a funnel's config when empty.
 * Dependencies: funnelsRepository, settings.
 *
 * New tenants create their own funnels from the UI; this only bootstraps mine.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import { settings } from '../settings/index.js';
import { logger } from '../core/logger.js';

async function seedFunnel(tenantId, name, config) {
  const funnel = await funnels.create({ tenantId, name });
  const existing = await funnels.getConfig(funnel.id);
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === '') continue;
    if (existing[key] !== undefined) continue; // don't overwrite operator edits
    await funnels.setConfig(funnel.id, key, value);
  }
  return funnel;
}

/** Seed the default-tenant Gita + VidaPulse funnels from env (once). */
export async function seedDefaults() {
  try {
    const tenantId = 'default';
    const existing = await funnels.listByTenant(tenantId);
    if (existing.length > 0) return; // already set up

    await seedFunnel(tenantId, 'Gita', {
      sheet_id: settings.sheets.gita,
      drive_folder_id: settings.drive.gitaFolder,
      postforme_api_key: settings.postforme.apiKey,
      postforme_accounts: JSON.stringify(settings.postforme.gitaAccounts || []),
      account_map: JSON.stringify(settings.postforme.accountMap || {}),
      approval_email: settings.emails.approvalGita,
      cta_link: settings.links.gitaAssessment,
      publish_time: '08:02',
    });

    await seedFunnel(tenantId, 'VidaPulse', {
      sheet_id: settings.sheets.vidapulse,
      drive_folder_id: settings.drive.gitaFolder,
      postforme_api_key: settings.postforme.apiKey,
      postforme_accounts: JSON.stringify(settings.postforme.vidapulseAccounts || []),
      account_map: JSON.stringify(settings.postforme.accountMap || {}),
      approval_email: settings.emails.approvalVidapulse,
      audience_prefix: 'Coaches, trainers, consultants, B2B or B2C product/service video marketers:',
      publish_time: '10:00',
    });

    logger.info('seeded default Gita + VidaPulse funnels');
  } catch (err) {
    logger.warn({ err: err.message }, 'funnel seed skipped (will retry next boot)');
  }
}

export default { seedDefaults };
