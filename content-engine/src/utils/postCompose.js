/**
 * Post composition (pure).
 *
 * Purpose:      Encode the n8n poster logic — recognizing sheet columns,
 *               extracting a row, composing the image prompt, composing the
 *               full/short captions, and building Post-for-Me per-platform
 *               configurations — as pure, unit-testable functions.
 * Responsibility: Pure logic only (no settings/DB/I/O).
 * Dependencies: caption util (humanizeCaption).
 */
import { humanizeCaption } from './caption.js';

export const OTHER_PLATFORMS = ['facebook', 'instagram', 'x', 'threads', 'youtube', 'tiktok', 'pinterest'];

/** Find a header index by exact name or a startsWith prefix (header is lowercased). */
export function locate(header, names, prefixes = []) {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i !== -1) return i;
  }
  for (const p of prefixes) {
    const i = header.findIndex((h) => h.startsWith(p));
    if (i !== -1) return i;
  }
  return -1;
}

/** Extract the recognized fields from a raw header + row. */
export function extractRow(rawHeader, row) {
  const header = rawHeader.map((h) => String(h).trim().toLowerCase());
  const iStatus = locate(header, ['status']);
  const iMatch = locate(header, ['post #', 'post no', 'post number', 'day', 'id']);
  const iPrompt = locate(header, ['image_prompt', 'prompt'], ['image prompt']);
  const iCaption = locate(header, ['caption']);
  const iFull = locate(header, ['caption_full', 'full caption'], ['linkedin long caption']);
  const iShort = locate(header, ['caption_short'], ['short caption']);
  const iHeadline = locate(header, ['headline']);
  const iSubhead = locate(header, ['subhead', 'subheadline']);
  const iHashtags = locate(header, ['hashtags']);
  const iLocked = locate(header, ['locked text specs']);
  const iAudience = locate(header, ['audience']);
  const get = (i) => (i === -1 ? '' : String(row[i] ?? '').trim());

  return {
    hasSchema: iStatus !== -1 && iPrompt !== -1,
    isReady: get(iStatus).toLowerCase() === 'ready',
    matchColName: iMatch === -1 ? null : rawHeader[iMatch],
    matchKey: get(iMatch),
    imagePrompt: get(iPrompt),
    caption: get(iCaption),
    captionFull: get(iFull),
    captionShort: get(iShort),
    headline: get(iHeadline),
    subhead: get(iSubhead),
    hashtags: get(iHashtags),
    lockedSpecs: get(iLocked),
    audience: get(iAudience),
  };
}

/** Compose the final image prompt (headline/subhead rendered verbatim). */
export function composePrompt(fields, note) {
  let p = fields.imagePrompt || '';
  if (fields.lockedSpecs) p += `\n\n${fields.lockedSpecs}`;
  if (fields.headline) p += `\n\nHEADLINE (render exactly and verbatim): "${fields.headline}"`;
  if (fields.subhead) p += `\nSUBHEAD (render exactly and verbatim): "${fields.subhead}"`;
  if (note) p += `\n\nRevision requested: ${note}`;
  return p;
}

function withCta({ full, short }, ctaLink) {
  if (!ctaLink) return { full, short };
  const add = (c) => (c.includes(ctaLink) ? c : `${c}\n\n${ctaLink}`);
  return { full: add(full), short: add(short) };
}

/** Compose the full (LinkedIn) and short (other channels) captions. */
export function composeCaptions(fields, { ctaLink = '', audiencePrefix = '' } = {}) {
  const structured = !!(fields.captionFull || fields.captionShort);
  if (structured) {
    const full = [fields.headline, fields.captionFull || fields.caption, fields.hashtags].filter(Boolean).join('\n\n');
    const short = [fields.captionShort || fields.caption, fields.hashtags].filter(Boolean).join('\n\n');
    return withCta({ full, short }, ctaLink);
  }
  const base = humanizeCaption(fields.caption, fields.audience || audiencePrefix || '');
  return withCta({ full: base, short: base }, ctaLink);
}

/** Build Post-for-Me platform_configurations (LinkedIn full, others short), or null. */
export function buildPlatformConfigs(full, short) {
  if (!full || !short || full === short) return null;
  const cfg = { linkedin: { caption: full } };
  for (const plat of OTHER_PLATFORMS) cfg[plat] = { caption: short };
  return cfg;
}

export default { locate, extractRow, composePrompt, composeCaptions, buildPlatformConfigs, OTHER_PLATFORMS };
