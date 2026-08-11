/**
 * Per-tenant provider factory.
 *
 * Purpose:      Build the external-integration clients a flow needs, using the
 *               tenant's resolved configuration — so tenant-set credentials
 *               (AI keys, Post for Me key, JSON2Video key) actually take effect.
 *               A tenant configures everything from the app UI; nothing
 *               user-scoped depends on an environment variable.
 * Responsibility: Construct providers from tenant_config (with env as a
 *               platform-provided default only). Platform-shared infrastructure
 *               that a tenant never sets — the Google service account (for Drive
 *               and Sheets access to sheets the tenant shares) and the SMTP
 *               sender — comes from platform settings.
 * Dependencies: tenantSettings, provider factories, settings, logger.
 */
import * as tenantSettings from '../core/tenantSettings.js';
import { settings } from '../settings/index.js';
import { logger } from '../core/logger.js';

import { createLlmProvider } from '../providers/llmProvider.js';
import { createGoogleDriveProvider } from '../providers/storageProvider.js';
import { createGoogleSheetsProvider } from '../providers/sheetsProvider.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { createJson2VideoProvider } from '../providers/videoProvider.js';
import { createSmtpMailProvider } from '../providers/mailProvider.js';
import { createWaGatewayClient } from '../providers/whatsappClient.js';

/**
 * Build the provider set for a tenant.
 * @param {string} tenantId
 * @returns {Promise<{ llm, storage, sheets, publish, video, mail, resolved }>}
 */
export async function buildProviders(tenantId = 'default') {
  const r = await tenantSettings.forTenant(tenantId);
  const log = logger.child({ tenant_id: tenantId });

  return {
    // Tenant-scoped credentials (from the app UI; env is only a default).
    llm: createLlmProvider({ openai: r.openai, gemini: r.gemini }, log),
    publish: createPostForMeProvider({ apiKey: r.postformeKey }, log),
    video: createJson2VideoProvider(r.video, log),

    // Tenant-scoped: each tenant sends approval/status email from their own
    // mailbox (SMTP configured in the app; env is only a fallback).
    mail: createSmtpMailProvider(r.smtp, log),

    // Platform-shared infrastructure (operator-managed; not per-tenant):
    //  - Google service account: the account tenants share their Sheets/Drive with.
    storage: createGoogleDriveProvider(settings.google, log),
    sheets: createGoogleSheetsProvider(settings.google, log),
    wa: createWaGatewayClient(settings.waGateway, log), // platform service topology

    resolved: r,
  };
}

export default { buildProviders };
