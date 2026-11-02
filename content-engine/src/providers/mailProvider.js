/**
 * Mail provider (interface + SMTP implementation).
 *
 * Purpose:      Abstract outbound email (alerts) behind an interface.
 * Responsibility: send({ to, subject, text, html }); skip({ subject, reason })
 *               for a caller that has no one to send to. Every attempt is
 *               logged with its outcome (recipient domain only) and handed to
 *               onResult, so a failure never stays silent.
 * Dependencies: nodemailer, logger, utils/emailHealth.
 */
import nodemailer from 'nodemailer';
import { smtpMissing, recipientDomain, sendRecord } from '../utils/emailHealth.js';

/**
 * @typedef {object} MailProvider
 * @property {(msg: {to: string, subject: string, text?: string, html?: string}) => Promise<{ok: boolean, id?: string, error?: string}>} send
 * @property {(info: {subject: string, reason: string}) => Promise<{ok: false, error: string}>} skip
 */

/**
 * Build an SMTP-backed MailProvider. If SMTP host or user is empty, send is a
 * no-op that warns which setting is missing instead of throwing, so alert paths
 * never crash the app. A missing password, or a real SMTP error, is logged and
 * thrown (as the login failure always was).
 * @param {object} cfg - { host, port, user, pass, from }
 * @param {import('pino').Logger} log
 * @param {(record: object) => Promise<void>|void} [onResult] - stores the outcome
 * @returns {MailProvider}
 */
export function createSmtpMailProvider(cfg, log, onResult = null) {
  const record = async (r) => {
    if (!onResult) return;
    try { await onResult(sendRecord(r)); } catch (err) { log.warn({ err: err.message }, 'email: could not store the send result'); }
  };
  const skip = async ({ subject = '', to = '', reason }) => {
    log.warn({ subject, to_domain: recipientDomain(to), reason }, `email skipped: ${reason}`);
    await record({ ok: false, skipped: true, subject, to, error: reason });
    return { ok: false, error: reason };
  };

  const missing = smtpMissing(cfg);
  const transport = missing.length ? null : nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  return {
    async send({ to, subject, text, html, attachments }) {
      if (!transport) {
        const reason = `SMTP not configured: set ${missing.join(', ')} on Settings`;
        // Host and user set but no password: the server would reject the login,
        // so fail the same way (callers expect a throw) with the plain reason.
        if (cfg.host && cfg.user) {
          log.error({ to_domain: recipientDomain(to), subject, err: reason }, `email failed: ${reason}`);
          await record({ ok: false, subject, to, error: reason });
          throw new Error(reason);
        }
        return skip({ subject, to, reason });
      }
      if (!String(to || '').trim()) return skip({ subject, reason: 'no recipient address (set Settings, Emails, Notification)' });
      try {
        const info = await transport.sendMail({
          from: cfg.from || cfg.user,
          to,
          subject,
          text,
          html,
          attachments,
        });
        log.info({ to_domain: recipientDomain(to), subject, id: info.messageId }, 'email sent');
        await record({ ok: true, subject, to });
        return { ok: true, id: info.messageId };
      } catch (err) {
        log.error({ to_domain: recipientDomain(to), subject, err: err.message }, `email failed: ${err.message}`);
        await record({ ok: false, subject, to, error: err.message });
        throw err;
      }
    },
    skip,
  };
}

export default { createSmtpMailProvider };
