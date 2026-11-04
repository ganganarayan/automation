/**
 * Mail provider (interface + HTTP API and SMTP implementations).
 *
 * Purpose:      Abstract outbound email (approvals, alerts) behind an interface.
 *               Railway blocks outbound SMTP, so the default is the connected
 *               Google account's Gmail API (free); an email provider's HTTPS
 *               API (Resend, Brevo, SendGrid, Postmark, SMTP2GO) also works,
 *               and SMTP stays for hosts that allow it.
 * Responsibility: send({ to, subject, text, html, attachments }); skip({
 *               subject, reason }) for a caller that has no one to send to.
 *               Every attempt is logged with its outcome (recipient domain
 *               only) and handed to onResult, so a failure never stays silent.
 * Dependencies: nodemailer, fetch, utils/{mailApis,emailHealth}.
 */
import nodemailer from 'nodemailer';
import { buildMailRequest, readMailResponse, messageIdOf, providerName, parseFrom } from '../utils/mailApis.js';
import { mailMissing, recipientDomain, sendRecord } from '../utils/emailHealth.js';

/**
 * @typedef {object} MailProvider
 * @property {(msg: {to: string, subject: string, text?: string, html?: string}) => Promise<{ok: boolean, id?: string, error?: string}>} send
 * @property {(info: {subject: string, reason: string}) => Promise<{ok: false, error: string}>} skip
 */

const TIMEOUT_MS = 20000;

/** The function that actually delivers one message: returns the message id or throws. */
function deliverer(mail, request) {
  if (mail.provider === 'smtp') {
    const s = mail.smtp;
    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.port === 465,
      auth: { user: s.user, pass: s.pass },
    });
    return async (msg) => (await transport.sendMail({ from: mail.from || s.from || s.user, ...msg })).messageId;
  }
  return async (msg) => {
    // Gmail sends as the connected account, under the name in From if there is one.
    const gmail = mail.provider === 'gmail';
    const name = gmail ? parseFrom(mail.from).name : '';
    const from = gmail ? (name ? `${name} <${mail.gmailEmail}>` : mail.gmailEmail) : mail.from;
    const apiKey = gmail ? await mail.gmailToken() : mail.apiKey;
    const { url, init } = buildMailRequest(mail.provider, { ...msg, apiKey, from });
    const res = await request(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text().catch(() => '');
    const error = readMailResponse(mail.provider, res.status, body);
    if (error) throw new Error(error);
    return messageIdOf(body);
  };
}

/**
 * Build the tenant's MailProvider. When the chosen provider is incomplete:
 * no sender details at all → send is a no-op that warns which setting is
 * missing (alert paths never crash); partly set (e.g. key without From, or
 * SMTP host+user without password) → logged and thrown with the plain reason.
 * A provider error is logged and thrown as well.
 * @param {{ provider: string, apiKey?: string, from?: string, smtp: object, gmailReady?: boolean, gmailEmail?: string, gmailToken?: () => Promise<string> }} mail
 * @param {import('pino').Logger} log
 * @param {(record: object) => Promise<void>|void} [onResult] - stores the outcome
 * @param {typeof fetch} [request]
 * @returns {MailProvider}
 */
export function createMailProvider(mail, log, onResult = null, request = globalThis.fetch) {
  const via = providerName(mail.provider);
  const record = async (r) => {
    if (!onResult) return;
    try { await onResult(sendRecord(r)); } catch (err) { log.warn({ err: err.message }, 'email: could not store the send result'); }
  };
  const skip = async ({ subject = '', to = '', reason }) => {
    log.warn({ via, subject, to_domain: recipientDomain(to), reason }, `email skipped: ${reason}`);
    await record({ ok: false, skipped: true, subject, to, error: reason });
    return { ok: false, error: reason };
  };
  const fail = async ({ subject, to, reason }) => {
    log.error({ via, to_domain: recipientDomain(to), subject, err: reason }, `email failed: ${reason}`);
    await record({ ok: false, subject, to, error: reason });
    throw new Error(reason);
  };

  const missing = mailMissing(mail);
  const s = mail.smtp || {};
  const partly = mail.provider === 'smtp' ? !!(s.host && s.user) : mail.provider !== 'gmail' && !!(mail.apiKey || mail.from);
  const deliver = missing.length ? null : deliverer(mail, request);

  return {
    async send({ to, subject, text, html, attachments }) {
      if (!deliver) {
        const reason = `${via} not configured: set ${missing.join(', ')} on Settings`;
        return partly ? fail({ subject, to, reason }) : skip({ subject, to, reason });
      }
      if (!String(to || '').trim()) return skip({ subject, reason: 'no recipient address (set Settings, Emails, Notification)' });
      let id;
      try {
        id = await deliver({ to, subject, text, html, attachments });
      } catch (err) {
        return fail({ subject, to, reason: err.message });
      }
      log.info({ via, to_domain: recipientDomain(to), subject, id }, 'email sent');
      await record({ ok: true, subject, to });
      return { ok: true, id };
    },
    skip,
  };
}

export default { createMailProvider };
