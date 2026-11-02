/**
 * Email health: pure helpers.
 *
 * Purpose:      Say plainly why an email can't go out, and keep the last send
 *               outcome in a form the Settings page can show.
 * Responsibility: smtpMissing / mailMissing (which settings are empty for the
 *               chosen provider: an HTTP API, or SMTP), recipientDomain
 *               (log the domain, never the full address), sendRecord (the
 *               stored last-send JSON), parseRecord, healthLines (the readout).
 * Dependencies: utils/mailApis (pure). The caller passes formatIst.
 */
import { MAIL_PROVIDERS, providerName } from './mailApis.js';

// The Settings labels, so a warning names the exact field to fill in.
const SMTP_FIELDS = [
  ['host', 'SMTP host'],
  ['user', 'SMTP user'],
  ['pass', 'SMTP password (app password)'],
];

/** Labels of the SMTP settings that are empty (empty list = complete). */
export function smtpMissing(smtp) {
  const s = smtp || {};
  return SMTP_FIELDS.filter(([k]) => !String(s[k] ?? '').trim()).map(([, label]) => label);
}

/**
 * Labels of the settings the chosen provider still needs (empty = complete).
 * @param {{ provider: string, apiKey?: string, from?: string, smtp?: object }} mail
 */
export function mailMissing(mail) {
  const m = mail || {};
  if (m.provider === 'smtp') return smtpMissing(m.smtp);
  const p = MAIL_PROVIDERS.find((x) => x.value === m.provider);
  if (!p) return [`Email provider (unknown "${m.provider || ''}")`];
  const out = [];
  if (!String(m.apiKey || '').trim()) out.push(p.keyLabel);
  if (!String(m.from || '').trim()) out.push('From address');
  return out;
}

/** The domain part(s) of a recipient list: "a@x.com, b@y.in" -> "x.com, y.in". */
export function recipientDomain(to) {
  const list = (Array.isArray(to) ? to : String(to || '').split(','))
    .map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return '';
  return [...new Set(list.map((x) => (x.includes('@') ? x.split('@').pop().replace(/>$/, '') : '?')))].join(', ');
}

/** The JSON stored as tenant_config email_last_send. */
export function sendRecord({ ok, skipped = false, subject = '', to = '', error = null, at = new Date() }) {
  return {
    at: (at instanceof Date ? at : new Date(at)).toISOString(),
    ok: !!ok,
    skipped: !!skipped,
    subject: String(subject || '').slice(0, 160),
    domain: recipientDomain(to),
    error: error ? String(error).slice(0, 300) : null,
  };
}

/** Parse a stored record (string or object); null when absent or unreadable. */
export function parseRecord(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const v = JSON.parse(value);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The readout lines for Settings: [{ dot, text }].
 * @param {{ mail: object, last: object|null, lastError: object|null, fmt: (iso: string) => string }} input
 * fmt is formatIst (utils/time): DD-MM-YYYY HH:MM IST.
 */
export function healthLines({ mail, last, lastError, fmt }) {
  const missing = mailMissing(mail);
  const name = providerName(mail?.provider);
  const lines = [];
  lines.push(missing.length
    ? { dot: '🔴', text: `${name} incomplete: set ${missing.join(', ')}, Save, then Send test` }
    : { dot: '🟢', text: `${name} is set up${mail?.provider === 'smtp' ? '' : ' (sends over HTTPS)'}` });
  if (mail?.provider === 'smtp') {
    lines.push({ dot: '🟡', text: 'Railway blocks outbound SMTP: pick an HTTP provider (Resend, Brevo, SendGrid, Postmark or SMTP2GO)' });
  }
  if (!last) {
    lines.push({ dot: '🟡', text: 'No email has been attempted since this readout was added' });
  } else {
    const when = `${fmt(last.at)} IST`;
    const what = last.subject ? ` "${last.subject}"` : '';
    const where = last.domain ? ` to @${last.domain}` : '';
    if (last.ok) lines.push({ dot: '🟢', text: `Last send ${when}: sent${what}${where}` });
    else lines.push({ dot: '🔴', text: `Last send ${when}: ${last.skipped ? 'skipped' : 'failed'}${what}${where}: ${last.error || 'unknown error'}` });
  }
  if (lastError && !(last && !last.ok && last.at === lastError.at)) {
    lines.push({ dot: '🟡', text: `Last error ${fmt(lastError.at)} IST: ${lastError.error || 'unknown error'}` });
  }
  return lines;
}

export default { smtpMissing, mailMissing, recipientDomain, sendRecord, parseRecord, healthLines };
