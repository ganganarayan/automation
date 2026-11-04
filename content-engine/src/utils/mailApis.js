/**
 * Email over HTTP: pure request builders.
 *
 * Purpose:      Railway blocks outbound SMTP, so approval and status emails go
 *               through an HTTPS API instead: the owner's own Gmail (free, the
 *               default) or an email provider.
 * Responsibility: MAIL_PROVIDERS (the Settings choices), parseFrom ("Name
 *               <a@b>" or "a@b"), buildMailRequest (url + fetch init per
 *               provider), readMailResponse (error text or null; some
 *               providers report failures inside a 200).
 * Dependencies: none.
 */

export const MAIL_PROVIDERS = [
  { value: 'gmail', label: 'Gmail (your connected Google account, free)', keyLabel: '' },
  { value: 'resend', label: 'Resend (HTTP API)', keyLabel: 'Resend API key' },
  { value: 'brevo', label: 'Brevo (HTTP API)', keyLabel: 'Brevo API key' },
  { value: 'sendgrid', label: 'SendGrid (HTTP API)', keyLabel: 'SendGrid API key' },
  { value: 'postmark', label: 'Postmark (HTTP API)', keyLabel: 'Postmark server token' },
  { value: 'smtp2go', label: 'SMTP2GO (HTTP API)', keyLabel: 'SMTP2GO API key' },
  { value: 'smtp', label: 'SMTP (blocked on Railway, only for other hosts)', keyLabel: '' },
];
export const HTTP_PROVIDERS = MAIL_PROVIDERS.filter((p) => p.value !== 'smtp').map((p) => p.value);
export const DEFAULT_MAIL_PROVIDER = 'gmail';

/** The provider's display name ("Resend"), or the raw value. */
export function providerName(value) {
  const p = MAIL_PROVIDERS.find((x) => x.value === value);
  return p ? p.label.replace(/ \(.*$/, '') : String(value || '');
}

/** "Gita <a@b.com>" -> { email: 'a@b.com', name: 'Gita' }; "a@b.com" -> { email, name: '' }. */
export function parseFrom(from) {
  const s = String(from || '').trim();
  const m = s.match(/^(.*)<([^>]+)>\s*$/);
  if (m) return { email: m[2].trim(), name: m[1].trim().replace(/^"|"$/g, '') };
  return { email: s, name: '' };
}

const b64 = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''))).toString('base64');
const toList = (to) => String(to || '').split(',').map((x) => x.trim()).filter(Boolean);
const htmlOf = (msg) => msg.html || `<pre style="font-family:inherit;white-space:pre-wrap">${String(msg.text || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;

const headerText = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
// Non-ASCII headers (a subject with 🟢, say) travel as an encoded word.
const encodeHeader = (s) => {
  const t = headerText(s);
  return /^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t).toString('base64')}?=`;
};
const wrap76 = (b) => (b.match(/.{1,76}/g) || []).join('\r\n');
const b64Part = (type, content, extra = []) => [`Content-Type: ${type}`, 'Content-Transfer-Encoding: base64', ...extra, '', wrap76(b64(content))].join('\r\n');
const multipart = (kind, boundary, parts) => [
  `Content-Type: multipart/${kind}; boundary="${boundary}"`, '',
  ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`,
].join('\r\n');

/**
 * One email as the RFC 2822 text the Gmail API takes (still to be base64url'd).
 * Bodies and attachments are base64, which cannot contain a boundary's dashes.
 */
export function rfc2822Message(msg) {
  const { email, name } = parseFrom(msg.from);
  const html = b64Part('text/html; charset="UTF-8"', htmlOf(msg));
  const text = msg.text ? b64Part('text/plain; charset="UTF-8"', msg.text) : '';
  let body = text ? multipart('alternative', 'ce-alt-boundary', [text, html]) : html;
  const files = msg.attachments || [];
  if (files.length) {
    const parts = files.map((f) => {
      const file = headerText(f.filename).replace(/"/g, '');
      return b64Part(`application/octet-stream; name="${file}"`, f.content, [`Content-Disposition: attachment; filename="${file}"`]);
    });
    body = multipart('mixed', 'ce-mixed-boundary', [body, ...parts]);
  }
  return [
    `From: ${name ? `${encodeHeader(name)} <${headerText(email)}>` : headerText(email)}`,
    `To: ${toList(msg.to).map(headerText).join(', ')}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    body,
  ].join('\r\n');
}

/**
 * The HTTPS request for one email.
 * @param {string} provider - one of HTTP_PROVIDERS
 * @param {{ apiKey: string, from: string, to: string, subject: string, text?: string, html?: string, attachments?: {filename: string, content: Buffer|string}[] }} msg
 * @returns {{ url: string, init: RequestInit }}
 */
export function buildMailRequest(provider, msg) {
  const { email, name } = parseFrom(msg.from);
  const fromHeader = name ? `${name} <${email}>` : email;
  const to = toList(msg.to);
  const files = msg.attachments || [];
  const json = (url, headers, body) => ({
    url,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) },
  });
  switch (provider) {
    case 'gmail': // apiKey here is the connected account's access token.
      return json('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { Authorization: `Bearer ${msg.apiKey}` }, {
        raw: Buffer.from(rfc2822Message(msg)).toString('base64url'),
      });
    case 'resend':
      return json('https://api.resend.com/emails', { Authorization: `Bearer ${msg.apiKey}` }, {
        from: fromHeader, to, subject: msg.subject, html: htmlOf(msg),
        ...(msg.text ? { text: msg.text } : {}),
        ...(files.length ? { attachments: files.map((f) => ({ filename: f.filename, content: b64(f.content) })) } : {}),
      });
    case 'brevo':
      return json('https://api.brevo.com/v3/smtp/email', { 'api-key': msg.apiKey }, {
        sender: { email, ...(name ? { name } : {}) },
        to: to.map((x) => ({ email: x })),
        subject: msg.subject, htmlContent: htmlOf(msg),
        ...(msg.text ? { textContent: msg.text } : {}),
        ...(files.length ? { attachment: files.map((f) => ({ name: f.filename, content: b64(f.content) })) } : {}),
      });
    case 'sendgrid':
      return json('https://api.sendgrid.com/v3/mail/send', { Authorization: `Bearer ${msg.apiKey}` }, {
        personalizations: [{ to: to.map((x) => ({ email: x })) }],
        from: { email, ...(name ? { name } : {}) },
        subject: msg.subject,
        content: [...(msg.text ? [{ type: 'text/plain', value: msg.text }] : []), { type: 'text/html', value: htmlOf(msg) }],
        ...(files.length ? { attachments: files.map((f) => ({ filename: f.filename, content: b64(f.content) })) } : {}),
      });
    case 'postmark':
      return json('https://api.postmarkapp.com/email', { 'X-Postmark-Server-Token': msg.apiKey }, {
        From: fromHeader, To: to.join(', '), Subject: msg.subject, HtmlBody: htmlOf(msg),
        ...(msg.text ? { TextBody: msg.text } : {}),
        MessageStream: 'outbound',
        ...(files.length ? { Attachments: files.map((f) => ({ Name: f.filename, Content: b64(f.content), ContentType: 'application/octet-stream' })) } : {}),
      });
    case 'smtp2go':
      return json('https://api.smtp2go.com/v3/email/send', { 'X-Smtp2go-Api-Key': msg.apiKey }, {
        sender: fromHeader, to, subject: msg.subject, html_body: htmlOf(msg),
        ...(msg.text ? { text_body: msg.text } : {}),
        ...(files.length ? { attachments: files.map((f) => ({ filename: f.filename, fileblob: b64(f.content), mimetype: 'application/octet-stream' })) } : {}),
      });
    default:
      throw new Error(`unknown email provider "${provider}"`);
  }
}

/**
 * Error text for a provider's answer, or null when it was sent. Postmark and
 * SMTP2GO can answer 200 with the failure in the body.
 */
export function readMailResponse(provider, status, bodyText = '') {
  let body = null;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  const name = providerName(provider);
  if (status < 200 || status >= 300) {
    const why = body?.error?.message || body?.message || body?.Message || body?.errors?.[0]?.message || body?.data?.error || String(bodyText || '').slice(0, 200) || 'no reason given';
    return `${name} said ${status}: ${why}`;
  }
  if (provider === 'postmark' && body?.ErrorCode) return `Postmark error ${body.ErrorCode}: ${body.Message || 'no message'}`;
  if (provider === 'smtp2go' && body?.data?.error) return `SMTP2GO: ${body.data.error}`;
  if (provider === 'smtp2go' && body?.data?.succeeded === 0) return 'SMTP2GO accepted the request but sent nothing';
  return null;
}

/** The message id the provider returned, if any. */
export function messageIdOf(bodyText = '') {
  try {
    const b = JSON.parse(bodyText);
    return b?.id || b?.messageId || b?.MessageID || b?.data?.email_id || null;
  } catch {
    return null;
  }
}

export default { MAIL_PROVIDERS, HTTP_PROVIDERS, DEFAULT_MAIL_PROVIDER, providerName, parseFrom, rfc2822Message, buildMailRequest, readMailResponse, messageIdOf };
