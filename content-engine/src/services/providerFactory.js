/**
 * Per-tenant provider factory.
 *
 * Purpose:      Build the external-integration clients a flow needs, using the
 *               tenant's resolved configuration: so tenant-set credentials
 *               (AI keys, Post for Me key, JSON2Video key) actually take effect.
 *               A tenant configures everything from the app UI; nothing
 *               user-scoped depends on an environment variable.
 * Responsibility: Construct providers from tenant_config (with env as a
 *               platform-provided default only). Platform-shared infrastructure
 *               that a tenant never sets, the Google service account (for Drive
 *               and Sheets access to sheets the tenant shares) and the SMTP
 *               sender: comes from platform settings.
 * Dependencies: tenantSettings, provider factories, settings, logger.
 */
import * as tenantSettings from '../core/tenantSettings.js';
import { settings } from '../settings/index.js';
import { logger } from '../core/logger.js';

import { createLlmProvider } from '../providers/llmProvider.js';
import { createClaudeProvider } from '../providers/claudeProvider.js';
import { createGoogleDriveProvider } from '../providers/storageProvider.js';
import * as driveConnect from './driveConnectService.js';
import { createGoogleSheetsProvider } from '../providers/sheetsProvider.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { createJson2VideoProvider } from '../providers/videoProvider.js';
import { createMailProvider } from '../providers/mailProvider.js';
import { createWaGatewayClient } from '../providers/whatsappClient.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';

/** Keep the last email outcome (and the last failure) for Settings, Email health. */
function mailRecorder(tenantId) {
  return async (rec) => {
    await tenantConfig.set(tenantId, 'email_last_send', JSON.stringify(rec));
    if (!rec.ok) await tenantConfig.set(tenantId, 'email_last_error', JSON.stringify(rec));
  };
}

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
    llm: createLlmProvider({ openai: r.openai, gemini: r.gemini, globalSystem: r.prompts.global }, log),
    // Only with a key in Settings; the Ready video copy falls back to llm without one.
    claude: r.claude.apiKey ? createClaudeProvider({ apiKey: r.claude.apiKey, model: r.claude.model, context: r.prompts.claudeContext, globalSystem: r.prompts.global }, log) : null,
    publish: createPostForMeProvider({ apiKey: r.postformeKey }, log),
    video: createJson2VideoProvider(r.video, log),

    // Tenant-scoped: each tenant sends approval/status email through the
    // provider chosen in the app (an HTTP email API; SMTP only off Railway).
    mail: createMailProvider({ ...r.mail, smtp: r.smtp, gmailToken: () => driveConnect.accessToken(tenantId) }, log, mailRecorder(tenantId)),

    // Google Sheets/Drive identity: the service account configured in the app
    // (tenant_config), falling back to the env default (see tenantSettings).
    storage: createGoogleDriveProvider({
      serviceAccount: r.google.serviceAccount,
      ownerUpload: async (name, mimeType, buffer) => {
        const { connected } = await driveConnect.status(tenantId);
        if (!connected) throw new Error('This Drive folder is in a personal My Drive, where the service account cannot add files. Connect Google Drive under Setup → Settings → Google, or use a folder on a shared drive');
        return driveConnect.uploadMedia(tenantId, name, mimeType, buffer);
      },
    }, log),
    sheets: createGoogleSheetsProvider({ serviceAccount: r.google.serviceAccount }, log),
    wa: createWaGatewayClient(settings.waGateway, log), // platform service topology

    resolved: r,
  };
}

export default { buildProviders };
