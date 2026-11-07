/**
 * Post composition (pure).
 *
 * Purpose:      Encode the n8n poster logic, recognizing sheet columns,
 *               extracting a row, composing the image prompt, composing the
 *               full/short captions, and building Post-for-Me per-platform
 *               configurations: as pure, unit-testable functions.
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

/**
 * Where each known column is in a header row (-1 = absent). One place for every
 * name a sheet may use, so reading, refilling and counting agree.
 */
export function sheetColumnIndex(rawHeader = []) {
  const header = (Array.isArray(rawHeader) ? rawHeader : []).map((h) => String(h ?? '').trim().toLowerCase());
  // A call-out marked as going IN the image is drawn on it; a plain audience column prefixes the caption.
  const callout = header.findIndex((h) => /call-?out|in the image/.test(h));
  return {
    status: locate(header, ['status']),
    match: locate(header, ['post #', 'post no', 'post number', 'day', 'id', '#', 'no', 'no.', 'sl no', 's.no']),
    // A sheet's own wording works too: "Visual Direction", "Headline (largest type)",
    // "Sub-line", "Caption (post copy)", "Audience Call-Out (IN the image)", "CTA".
    prompt: locate(header, ['image_prompt', 'prompt', 'visual direction', 'visual', 'image description', 'scene'], ['image prompt', 'visual direction', 'image description']),
    caption: locate(header, ['caption', 'post copy', 'copy'], ['caption (', 'post copy']),
    full: locate(header, ['caption_full', 'full caption'], ['linkedin long caption']),
    short: locate(header, ['caption_short'], ['short caption']),
    headline: locate(header, ['headline'], ['headline (', 'headline:']),
    subhead: locate(header, ['subhead', 'subheadline', 'sub-line', 'subline', 'sub line', 'sub-headline', 'sub headline'], ['sub-line', 'subhead', 'sub-headline']),
    hashtags: locate(header, ['hashtags']),
    locked: locate(header, ['locked text specs']),
    callout,
    audience: locate(header, ['audience'], callout === -1 ? ['audience'] : []),
    cta: locate(header, ['cta', 'call to action'], ['cta (', 'call to action']),
    // Comment-to-DM columns (optional): a keyword on this post arms the auto-DM.
    keyword: locate(header, ['keyword', 'dm_keyword'], ['dm keyword']),
    dmText: locate(header, ['dm_text', 'dm message'], ['dm text']),
    dmLink: locate(header, ['dm_link'], ['dm link']),
  };
}

/** Extract the recognized fields from a raw header + row. */
export function extractRow(rawHeader, row) {
  const c = sheetColumnIndex(rawHeader);
  const iStatus = c.status;
  const iMatch = c.match;
  const iPrompt = c.prompt;
  const iCaption = c.caption;
  const iFull = c.full;
  const iShort = c.short;
  const iHeadline = c.headline;
  const iSubhead = c.subhead;
  const iHashtags = c.hashtags;
  const iLocked = c.locked;
  const iCallout = c.callout;
  const iAudience = c.audience;
  const iCta = c.cta;
  const iKeyword = c.keyword;
  const iDmText = c.dmText;
  const iDmLink = c.dmLink;
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
    callout: get(iCallout),
    cta: get(iCta),
    dmKeyword: get(iKeyword),
    dmText: get(iDmText),
    dmLink: get(iDmLink),
  };
}

/** Compose the final image prompt (headline/subhead rendered verbatim). */
export function composePrompt(fields, note) {
  let p = fields.imagePrompt || '';
  if (fields.lockedSpecs) p += `\n\n${fields.lockedSpecs}`;
  if (fields.callout) p += `\n\nAUDIENCE CALL-OUT (small text above the headline, render exactly and verbatim): "${fields.callout}"`;
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
  // The sheet's CTA line closes the caption, unless the caption already ends with it.
  if (fields.cta && !String(fields.caption || '').includes(fields.cta)) {
    fields = { ...fields, caption: fields.caption ? `${fields.caption}\n\n${fields.cta}` : '' };
  }
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

export default { locate, sheetColumnIndex, extractRow, composePrompt, composeCaptions, buildPlatformConfigs, OTHER_PLATFORMS };
