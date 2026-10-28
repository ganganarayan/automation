/**
 * LinkedIn notification parsing (pure).
 *
 * Purpose:      Turn a LinkedIn notification email into the three things we relay
 *               to WhatsApp — who acted, the first line of what they said, and a
 *               direct link to the post — plus the WhatsApp message text.
 * Responsibility: Pure functions only (no IMAP, no network). Best-effort and
 *               defensive: LinkedIn's templates change, so every field degrades
 *               gracefully rather than throwing.
 * Dependencies: none.
 */

const ACTION_RE = /\b(commented|replied|mentioned|reacted|liked|likes|sent you|messaged|shared|posted)\b/i;
// Order matters: a "mentioned you in a comment" subject is a mention, not a
// comment, so test the more specific kinds first and match comment by its verb.
const KIND_MAP = [
  [/mention/i, 'mention'],
  [/sent you a message|messaged|new message|\bmessage\b/i, 'message'],
  [/reacted|\blikes?\b|liked/i, 'reaction'],
  [/shared/i, 'share'],
  [/commented|replied/i, 'comment'],
];

/** True when the email actually came from LinkedIn (don't touch other mail). */
export function isLinkedinEmail({ from = '', subject = '' } = {}) {
  const f = String(from).toLowerCase();
  if (f.includes('linkedin.com') || f.includes('@linkedin.')) return true;
  // Fallback: a "via LinkedIn" sender display name.
  return /\bvia linkedin\b/i.test(String(from)) || /\blinkedin\b/i.test(String(subject)) && f.includes('linkedin');
}

/** Classify the notification from its subject. */
export function classify(subject = '') {
  for (const [re, kind] of KIND_MAP) if (re.test(subject)) return kind;
  return 'notification';
}

/** The person who acted — from the subject ("Name commented on…"), else the
 *  sender display name ("Name via LinkedIn"). */
export function extractName({ from = '', subject = '' } = {}) {
  const s = String(subject).trim();
  const m = s.match(ACTION_RE);
  if (m && m.index > 0) {
    const name = s.slice(0, m.index).trim().replace(/[:\-–—]+$/, '').trim();
    if (name && name.length <= 80) return name;
  }
  // Sender display name: "Pat Rao via LinkedIn <...>" or "Pat Rao <...>".
  const disp = String(from).split('<')[0].replace(/"/g, '').replace(/\bvia linkedin\b/i, '').trim();
  if (disp && !disp.toLowerCase().includes('linkedin')) return disp;
  return 'Someone';
}

const SKIP_LINE = /(linkedin|unsubscribe|view (in|on|the)|©|all rights|notification settings|you are receiving|manage|open the app|^\s*$|^https?:|commented on|replied to|mentioned you|reacted to|sent you|likes? your|liked your|shared your|on your post|view comment|view post|view message)/i;

/** First meaningful line of the comment/message body (plain text preferred). */
export function extractFirstLine({ text = '', html = '', subject = '' } = {}) {
  const body = String(text || stripHtml(html));
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (SKIP_LINE.test(l)) continue;
    if (l.length < 2) continue;
    return l.slice(0, 280);
  }
  // Fallback: the part of the subject after a colon ("… your post: <text>").
  const after = String(subject).split(':').slice(1).join(':').trim();
  return after || '';
}

const POST_URL_RE = /https?:\/\/[^\s"'<>]*linkedin\.com\/(?:comm\/)?(?:feed\/update|posts|feed\/update\/urn)[^\s"'<>]*/i;
const ANY_LI_URL_RE = /https?:\/\/[^\s"'<>]*(?:linkedin\.com|lnkd\.in)\/[^\s"'<>]*/i;

/** A direct link to the post/thread — a feed/update or posts permalink if we can
 *  find one, else the first LinkedIn link in the email. '' if none. */
export function extractPostUrl({ html = '', text = '' } = {}) {
  const hay = `${html}\n${text}`;
  const direct = hay.match(POST_URL_RE);
  if (direct) return decodeEntities(direct[0]);
  const any = hay.match(ANY_LI_URL_RE);
  return any ? decodeEntities(any[0]) : '';
}

/** Parse a full LinkedIn email into the relay fields. */
export function parseLinkedinNotification(email = {}) {
  const relevant = isLinkedinEmail(email);
  const kind = classify(email.subject || '');
  const name = extractName(email);
  const firstLine = extractFirstLine(email);
  const postUrl = extractPostUrl(email);
  return { relevant, kind, name, firstLine, postUrl, subject: String(email.subject || '').trim() };
}

/** The WhatsApp text we send the operator. */
export function buildWhatsappMessage(parsed = {}) {
  const kind = parsed.kind || 'notification';
  const name = parsed.name || 'Someone';
  const head = `🔔 LinkedIn ${kind} — ${name}`;
  const quote = parsed.firstLine ? `\n“${parsed.firstLine}”` : (parsed.subject ? `\n${parsed.subject}` : '');
  const link = parsed.postUrl ? `\n${parsed.postUrl}` : '\n(no post link found — open LinkedIn)';
  return `${head}${quote}${link}\n\nReply on LinkedIn yourself.`;
}

// ---- tiny helpers ----------------------------------------------------------

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
}

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#38;/g, '&');
}

export default {
  isLinkedinEmail, classify, extractName, extractFirstLine, extractPostUrl,
  parseLinkedinNotification, buildWhatsappMessage,
};
