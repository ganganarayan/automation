/**
 * LinkedIn → WhatsApp relay.
 *
 * Purpose:      LinkedIn has no DM automation API, so we don't reply there.
 *               Instead we watch a Gmail mailbox for LinkedIn comment/message
 *               notification emails and relay each — commenter name, first line,
 *               direct post link — to the operator on WhatsApp (via Evolution),
 *               then mark the email read so it is never relayed twice.
 * Responsibility: Orchestration + side effects; parsing lives in
 *               utils/linkedinRelaySpec, mailbox I/O in providers/imapClient,
 *               WhatsApp send in the wa-gateway client.
 * Dependencies: tenantConfigRepository, providerFactory (wa), imapClient,
 *               linkedinRelaySpec, logger.
 *
 * We never reply to anyone on LinkedIn — the user replies themselves.
 */
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { buildProviders } from './providerFactory.js';
import { createImapClient } from '../providers/imapClient.js';
import { parseLinkedinNotification, buildWhatsappMessage } from '../utils/linkedinRelaySpec.js';
import { childLogger } from '../core/logger.js';

/** Resolve the relay config for a tenant (IMAP creds default to the SMTP ones). */
export async function resolveConfig(tenantId = 'default') {
  const c = await tenantConfig.getAll(tenantId).catch(() => ({}));
  return {
    host: c.linkedin_imap_host || 'imap.gmail.com',
    user: c.linkedin_imap_user || c.smtp_user || '',
    pass: c.linkedin_imap_pass || c.smtp_pass || '',
    mailbox: c.linkedin_imap_mailbox || 'INBOX',
    waInstance: c.linkedin_wa_instance || '',
    waTo: c.linkedin_wa_to || '',
  };
}

/**
 * Poll the mailbox once and relay every new LinkedIn notification to WhatsApp.
 * Non-LinkedIn mail is left untouched (not read, not sent). A WhatsApp failure
 * leaves the email unread so the next poll retries it.
 * @returns {Promise<{checked, relayed, skipped, reason?}>}
 */
export async function pollAndRelay({ tenantId = 'default' } = {}) {
  const log = childLogger({ module: 'linkedinRelay', tenant_id: tenantId });
  const cfg = await resolveConfig(tenantId);
  if (!cfg.user || !cfg.pass) return { checked: 0, relayed: 0, skipped: 0, reason: 'imap_not_configured' };
  if (!cfg.waInstance || !cfg.waTo) return { checked: 0, relayed: 0, skipped: 0, reason: 'whatsapp_not_configured' };

  const providers = await buildProviders(tenantId);
  const imap = createImapClient({ host: cfg.host, user: cfg.user, pass: cfg.pass, log });

  const messages = await imap.fetchUnseen({ mailbox: cfg.mailbox, limit: 25 });
  let relayed = 0;
  let skipped = 0;

  for (const msg of messages) {
    const parsed = parseLinkedinNotification(msg);
    if (!parsed.relevant) { skipped += 1; continue; } // leave non-LinkedIn mail alone
    try {
      await providers.wa.send({
        instance: cfg.waInstance,
        number: cfg.waTo,
        message: buildWhatsappMessage(parsed),
        tenantId,
      });
      await imap.markSeen({ mailbox: cfg.mailbox, uid: msg.uid });
      relayed += 1;
      log.info({ name: parsed.name, kind: parsed.kind }, 'linkedin notification relayed to WhatsApp');
    } catch (err) {
      // Leave it unread so the next poll retries; don't mark seen on failure.
      log.warn({ err: err.message, subject: parsed.subject }, 'linkedin relay send failed (will retry)');
    }
  }

  return { checked: messages.length, relayed, skipped };
}

export default { resolveConfig, pollAndRelay };
