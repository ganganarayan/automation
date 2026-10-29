/**
 * Comment-capture pure logic (no DB, no settings — only node:crypto).
 *
 * Purpose:      The decision core of the comment-to-DM layer, kept side-effect
 *               free so it unit-tests without a database: text normalization,
 *               keyword matching, 7-day age, abuse detection, webhook signature
 *               verification, and parsing Meta's comment payloads.
 * Responsibility: Pure functions only.
 * Dependencies: node:crypto (HMAC for signature verify).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

/**
 * Lowercase, drop emoji and punctuation, collapse whitespace. Keeps letters,
 * combining marks (\p{M} — Devanagari matras), and digits across Unicode, so
 * Hindi text survives intact (मुझे stays मुझे, not म झ).
 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does a comment match a keyword under the given mode? */
export function matchKeyword(commentText, keyword, mode = 'word') {
  const text = normalize(commentText);
  const kw = normalize(keyword);
  if (!text || !kw) return false;
  if (mode === 'contains') return text.includes(kw);
  // word mode: the keyword (one or more tokens) must appear as a whole-word run.
  return ` ${text} `.includes(` ${kw} `);
}

/** First active rule whose keyword matches the comment (caller passes rules). */
export function firstMatchingRule(commentText, rules = []) {
  for (const r of rules) {
    if (r.active === false) continue;
    if (matchKeyword(commentText, r.keyword, r.match_mode || r.matchMode || 'word')) return r;
  }
  return null;
}

/** Normalize a Meta timestamp (unix seconds, unix ms, ISO, or Date) to a Date, or null. */
export function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    // Meta uses seconds; anything below ~10^12 is seconds, above is ms.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const str = String(value);
  if (/^\d+$/.test(str)) return toDate(Number(str));
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Age of a comment in seconds, or null when the creation time is unknown. */
export function ageSeconds(createdAt, now = new Date()) {
  const d = toDate(createdAt);
  if (!d) return null;
  return (now.getTime() - d.getTime()) / 1000;
}

/**
 * True when a comment is older than 7 days, counted from when it was CREATED.
 * Unknown creation time is treated as fresh (false) so we don't drop live
 * comments that arrive without a timestamp.
 */
export function isOlderThan7Days(createdAt, now = new Date()) {
  const age = ageSeconds(createdAt, now);
  if (age == null) return false;
  return age > SEVEN_DAYS_SECONDS;
}

/**
 * Built-in abuse seed (English + Hindi Devanagari + romanized Hinglish). Kept
 * deliberately small and extendable from config (capture_abuse_words). A match
 * means: log the lead, send no DM.
 */
export const DEFAULT_ABUSE_WORDS = [
  // English
  'fuck', 'fucker', 'fucking', 'bitch', 'bastard', 'asshole', 'dick', 'cunt', 'slut', 'whore', 'retard', 'moron',
  // Romanized Hindi / Hinglish
  'madarchod', 'madarchoth', 'mc', 'behenchod', 'bhenchod', 'bc', 'bhosdi', 'bhosdike', 'bhosadike', 'chutiya',
  'chutiye', 'chutia', 'gaand', 'gandu', 'gaandu', 'lund', 'lauda', 'loda', 'randi', 'kutta', 'kutti', 'kamine',
  'kamina', 'harami', 'haramzada', 'suar', 'saala', 'saali', 'tatti', 'chod', 'chodu', 'gandfat',
  // Devanagari
  'मादरचोद', 'बहनचोद', 'भोसडी', 'भोसडीके', 'चूतिया', 'चुतिया', 'गांड', 'गांडू', 'लंड', 'लौडा', 'रंडी', 'कुत्ता',
  'कमीने', 'हरामी', 'हरामज़ादा', 'सुअर', 'साला', 'टट्टी', 'चोद',
];

/** Parse a config blob (comma / newline separated) into a word list. */
export function parseWordList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n,]/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Detect abuse. Each word is tested both as a whole token and as a substring
 * (Hindi is often written without spaces, and insults get mashed into words).
 * Returns { abusive, word }.
 */
export function detectAbuse(text, extraWords = []) {
  const norm = normalize(text);
  if (!norm) return { abusive: false, word: null };
  const spaced = ` ${norm} `;
  const words = [...DEFAULT_ABUSE_WORDS, ...extraWords];
  for (const raw of words) {
    const w = normalize(raw);
    if (!w) continue;
    if (w.includes(' ')) {
      if (norm.includes(w)) return { abusive: true, word: raw };
    } else if (spaced.includes(` ${w} `) || norm.includes(w)) {
      return { abusive: true, word: raw };
    }
  }
  return { abusive: false, word: null };
}

/** Pick one public-reply variant at random (so replies aren't identical). */
export function pickVariant(variants, rng = Math.random) {
  const arr = Array.isArray(variants) ? variants.filter((v) => String(v || '').trim()) : [];
  if (!arr.length) return '';
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Verify Meta's X-Hub-Signature-256 header against the RAW request body.
 * header looks like "sha256=<hex>". Constant-time compare; false on any gap.
 */
export function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !signatureHeader || !rawBody) return false;
  const [algo, sig] = String(signatureHeader).split('=');
  if (algo !== 'sha256' || !sig) return false;
  const expected = createHmac('sha256', appSecret)
    .update(rawBody instanceof Buffer ? rawBody : Buffer.from(String(rawBody)))
    .digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Flatten a Meta webhook body into comment events we care about. Handles the
 * Instagram ('instagram') and Facebook Page ('page') shapes. Non-comment
 * changes are ignored. Returns [{ platform, commentId, postId, commenterId,
 * commenterUsername, text, createdAt, verb }].
 */
export function parseCommentEvents(body) {
  const out = [];
  if (!body || !Array.isArray(body.entry)) return out;
  const object = body.object;

  for (const entry of body.entry) {
    const entryTime = entry?.time != null ? toDate(entry.time) : null;
    const accountId = String(entry?.id || ''); // IG user id / Page id that owns the post
    for (const change of entry?.changes || []) {
      const field = change?.field;
      const v = change?.value || {};

      if (object === 'instagram' && field === 'comments') {
        const from = v.from || {};
        out.push({
          platform: 'instagram',
          verb: 'add',
          accountId,
          commentId: String(v.id || ''),
          postId: String(v.media?.id || v.media_id || ''),
          commenterId: String(from.id || ''),
          commenterUsername: from.username || null,
          text: v.text || '',
          createdAt: toDate(v.timestamp) || entryTime,
        });
      } else if (object === 'page' && field === 'feed' && v.item === 'comment') {
        const from = v.from || {};
        out.push({
          platform: 'facebook',
          verb: v.verb || 'add',
          accountId,
          commentId: String(v.comment_id || ''),
          postId: String(v.post_id || ''),
          commenterId: String(from.id || ''),
          commenterUsername: from.name || null,
          text: v.message || '',
          createdAt: toDate(v.created_time) || entryTime,
        });
      }
    }
  }
  return out.filter((e) => e.commentId);
}

/**
 * Flatten a Meta webhook body into INBOUND message events (someone replying to
 * our DM). Echoes — messages we sent — are dropped, as are delivery/read
 * receipts. A reply is what grants profile consent and opens the 24h window.
 */
export function parseMessageEvents(body) {
  const out = [];
  if (!body || !Array.isArray(body.entry)) return out;
  const platform = body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'facebook' : '';
  if (!platform) return out;

  for (const entry of body.entry) {
    const accountId = String(entry?.id || '');
    for (const m of entry?.messaging || []) {
      const msg = m?.message;
      if (!msg) continue;            // delivery / read receipt
      if (msg.is_echo) continue;     // our own outbound message
      const senderId = String(m?.sender?.id || '');
      if (!senderId) continue;
      out.push({
        platform,
        accountId,
        senderId,
        messageId: String(msg.mid || ''),
        text: msg.text || '',
        at: toDate(m.timestamp),
      });
    }
  }
  return out;
}

export default {
  normalize,
  matchKeyword,
  firstMatchingRule,
  toDate,
  ageSeconds,
  isOlderThan7Days,
  DEFAULT_ABUSE_WORDS,
  parseWordList,
  detectAbuse,
  pickVariant,
  verifyMetaSignature,
  parseCommentEvents,
  parseMessageEvents,
};
