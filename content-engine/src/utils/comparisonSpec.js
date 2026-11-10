/**
 * Comparison videos (pure: no I/O).
 *
 * Purpose:      A video that compares our product with a competitor gets its copy
 *               and thumbnail from checked facts, not from its file name or an
 *               AI picture of a person.
 * Responsibility:
 *               - stripCc(name): removes the operator's CC marker (subtitles burnt in)
 *               - parseComparisons(text): the Settings list into blocks and rows
 *               - findCompetitor / comparisonFor: which comparison a video is
 *               - thumbRows / comparisonHeadline / comparisonSvg: the drawn thumbnail
 *               - comparisonCopyFacts: the facts handed to the copy writer
 *               - isNoSpeech(steps): whisper found nothing and nobody has added text
 * Dependencies: utils/thumbSpec, utils/comparisonFacts.
 *
 * List format, one block per competitor, one row per line (label | ours | theirs):
 *   LeadQuizzes (checked 27-10-2026)
 *   Server-side Conversions API | yes | no
 */
import { fitText, THUMB_ACCENT } from './thumbSpec.js';
import { DEFAULT_COMPARISONS, DEFAULT_COMPARISON_BRAND } from './comparisonFacts.js';

export const COMPARISON_OFF = 'off';

export const DEFAULT_COMPARISON_PROMPT = [
  'This video compares two products, named below.',
  'The title must name both products and say what differs, in words a buyer understands.',
  'Every claim about either product comes only from the facts listed below, and nothing is claimed about a feature that is not listed.',
  'Never mention the file name, and never mention subtitles or captions.',
  'With no transcript, write in English.',
].join('\n');

// Competitor names that are also everyday words: alone they prove nothing.
const COMMON_WORDS = new Set(['interact', 'riddle', 'outgrow']);
const COMPARE_WORDS = /(^| )(vs|versus|alternative|alternatives|compared|comparison)( |$)/;

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const spaced = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compact = (s) => spaced(s).replace(/ /g, '');

/** "Assess360 vs LeadQuizzes CC.mp4" -> "Assess360 vs LeadQuizzes.mp4". Other words with cc in them stay. */
export function stripCc(name) {
  return String(name || '')
    .replace(/[\s_-]*(?<![a-z0-9])cc(?![a-z0-9])[\s_-]*/gi, ' ')
    .replace(/[([]\s*[)\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

/** The Settings list as [{ competitor, checked, rows: [{ label, us, them }] }]; us/them are booleans. */
export function parseComparisons(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes('|')) {
      const [label, us, them] = line.split('|').map((x) => x.trim());
      if (cur && label && us && them) cur.rows.push({ label, us: /^y/i.test(us), them: /^y/i.test(them) });
      continue;
    }
    const m = line.match(/^(.*?)\s*\(\s*checked\s+([^)]*)\)\s*$/i);
    cur = { competitor: m ? m[1] : line, checked: m ? m[2].trim() : '', rows: [] };
    out.push(cur);
  }
  return out.filter((c) => c.competitor && c.rows.length);
}

function mentions(text, competitor) {
  const letters = compact(competitor).split('').join(' ?');
  return letters ? new RegExp(`(^| )${letters}( |$)`).test(spaced(text)) : false;
}

/**
 * The one competitor this text is about, or null. An everyday word (interact)
 * and any mention in speech (a passing remark) need the proof of the brand name
 * or a word like "vs" next to it; a distinctive name in a file name stands alone.
 */
export function findCompetitor(text, list, { brand = '', speech = false } = {}) {
  const t = spaced(text);
  const proof = COMPARE_WORDS.test(t) || (compact(brand) && t.replace(/ /g, '').includes(compact(brand)));
  const hits = (list || []).filter((c) => mentions(t, c.competitor) && (proof || (!speech && !COMMON_WORDS.has(compact(c.competitor)))));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The comparison this video is, or null for a normal video. `choice` is what the
 * operator picked on its page: off, a competitor, or blank to detect it from the
 * file name, then from the transcript.
 */
export function comparisonFor({ settings = {}, name = '', transcript = '', choice = '' } = {}) {
  if (choice === COMPARISON_OFF) return null;
  // The built-in Assess360 list is the owner's only (builtIn false for other tenants).
  const list = parseComparisons(settings.list || (settings.builtIn === false ? '' : DEFAULT_COMPARISONS));
  const brand = settings.brand || (settings.builtIn === false ? '' : DEFAULT_COMPARISON_BRAND);
  const hit = choice
    ? list.find((c) => compact(c.competitor) === compact(choice))
    : findCompetitor(stripCc(name), list, { brand }) || findCompetitor(transcript, list, { brand, speech: true });
  return hit ? { ...hit, brand, logo: settings.logo || '' } : null;
}

/** The rows for the thumbnail: the differences first, shared features only to fill up. */
export function thumbRows(rows, max = 3) {
  const list = Array.isArray(rows) ? rows : [];
  return [...list.filter((r) => r.us && !r.them), ...list.filter((r) => r.us && r.them)].slice(0, max);
}

/** A typed headline goes on the image, unless it only repeats the "X vs Y" the panels already say. */
export function comparisonHeadline(typed) {
  const t = String(typed || '').replace(/\s+/g, ' ').trim();
  return /(^|\W)(vs|versus)(\W|$)/i.test(t) ? '' : t;
}

/** The facts section of the copy writer's user prompt. */
export function comparisonCopyFacts(c) {
  const yn = (v) => (v ? 'yes' : 'no');
  const rows = c.rows.map((r) => `- ${r.label}: ${c.brand} ${yn(r.us)}, ${c.competitor} ${yn(r.them)}`).join('\n');
  return `This video compares ${c.brand} with ${c.competitor}.\nFacts${c.checked ? ` (checked ${c.checked})` : ''}:\n${rows}`;
}

/** Transcript step shows whisper heard nothing, and nobody has added text or approved it since. */
export function isNoSpeech(steps) {
  const s = (Array.isArray(steps) ? steps : []).find((x) => x.key === 'transcript') || {};
  const a = s.artifacts || {};
  return s.status === 'done' && a.source === 'whisper' && !String(a.text || '').trim() && !a.approvedAt;
}

function textBlock(lines, size, cx, cy, attrs) {
  const lh = Math.round(size * 1.15);
  const y0 = Math.round(cy - (lines.length * lh) / 2 + size * 0.82);
  const spans = lines.map((l, i) => `<tspan x="${cx}" y="${y0 + i * lh}">${xmlEsc(l)}</tspan>`).join('');
  return `<text text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif" ${attrs} font-size="${size}">${spans}</text>`;
}

/** A tick or a cross in a coloured disc: drawn shapes, so no font can turn them into a box. */
function mark(cx, cy, r, yes) {
  const n = (v) => Math.round(v * 10) / 10;
  const stroke = `fill="none" stroke="#FFFFFF" stroke-width="${n(r * 0.2)}" stroke-linecap="round" stroke-linejoin="round"`;
  const shape = yes
    ? `<path d="M${n(cx - r * 0.48)} ${n(cy + r * 0.02)} L${n(cx - r * 0.14)} ${n(cy + r * 0.38)} L${n(cx + r * 0.5)} ${n(cy - r * 0.38)}" ${stroke}/>`
    : `<path d="M${n(cx - r * 0.38)} ${n(cy - r * 0.38)} L${n(cx + r * 0.38)} ${n(cy + r * 0.38)} M${n(cx + r * 0.38)} ${n(cy - r * 0.38)} L${n(cx - r * 0.38)} ${n(cy + r * 0.38)}" ${stroke}/>`;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${yes ? '#16A34A' : '#DC2626'}"/>${shape}`;
}

/**
 * The whole comparison thumbnail as SVG: our side on the left, the competitor's
 * plain name on the right, up to three rows with a tick or cross for each side.
 * `logo` is an optional data: URI that replaces our name. No artwork, no people.
 */
export function comparisonSvg({ w, h, brand, competitor, rows = [], checked = '', headline = '', logo = '' }) {
  const tall = h > w;
  const headH = headline ? Math.round(h * (tall ? 0.11 : 0.15)) : 0;
  const nameH = Math.round(h * (tall ? 0.2 : 0.27));
  const footH = checked ? Math.round(h * 0.06) : Math.round(h * 0.02);
  const list = thumbRows(rows);
  const rowsTop = headH + nameH;
  const rh = (h - rowsTop - footH) / Math.max(1, list.length);
  const quarter = Math.round(w / 4);
  const vsR = Math.round(Math.min(w, h) * 0.07);
  const nameBox = { boxW: w / 2 - vsR - w * 0.06, boxH: nameH * 0.7, maxSize: Math.round(h * (tall ? 0.05 : 0.09)), glyph: 0.72 };
  const name = (text, cx) => {
    const fit = fitText(text, nameBox);
    return textBlock(fit.lines, fit.size, cx, headH + nameH / 2, 'font-weight="800" fill="#FFFFFF"');
  };
  const logoW = Math.round(nameBox.boxW);
  const logoH = Math.round(nameBox.boxH);
  const ours = logo
    ? `<image x="${quarter - vsR / 2 - logoW / 2}" y="${Math.round(headH + (nameH - logoH) / 2)}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet" xlink:href="${logo}"/>`
    : name(brand, quarter - Math.round(vsR / 2));
  let body = '';
  list.forEach((r, i) => {
    const cy = Math.round(rowsTop + rh * (i + 0.5));
    const bandW = Math.round(w * 0.6);
    const bandH = Math.round(rh * 0.76);
    const fit = fitText(r.label, { boxW: bandW * 0.92, boxH: bandH * 0.86, maxSize: Math.round(h * (tall ? 0.034 : 0.062)), glyph: 0.58 });
    const dot = Math.round(Math.min(rh * 0.3, w * 0.07));
    body += `<rect x="${Math.round((w - bandW) / 2)}" y="${Math.round(cy - bandH / 2)}" width="${bandW}" height="${bandH}" rx="${Math.round(bandH * 0.14)}" fill="#000000" fill-opacity=".5"/>`;
    body += textBlock(fit.lines, fit.size, Math.round(w / 2), cy, 'font-weight="700" fill="#FFFFFF"');
    body += mark(Math.round(w * 0.1), cy, dot, r.us) + mark(Math.round(w * 0.9), cy, dot, r.them);
  });
  let head = '';
  if (headline) {
    const fit = fitText(headline, { boxW: w * 0.92, boxH: headH * 0.86, maxSize: Math.round(headH * 0.6) });
    head = `<rect width="${w}" height="${headH}" fill="#000000"/>${textBlock(fit.lines, fit.size, Math.round(w / 2), headH / 2, `font-weight="800" fill="${THUMB_ACCENT}"`)}`;
  }
  const foot = checked
    ? textBlock([`Facts checked ${checked}`], Math.round(footH * 0.42), Math.round(w / 2), h - footH / 2, 'font-weight="400" fill="#FFFFFF" fill-opacity=".75"')
    : '';
  const vs = `<circle cx="${Math.round(w / 2)}" cy="${Math.round(headH + nameH / 2)}" r="${vsR}" fill="${THUMB_ACCENT}"/>${textBlock(['VS'], Math.round(vsR * 0.85), Math.round(w / 2), headH + nameH / 2, 'font-weight="800" fill="#111111"')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}"><rect width="${Math.ceil(w / 2)}" height="${h}" fill="#0F3D33"/><rect x="${Math.floor(w / 2)}" width="${Math.ceil(w / 2)}" height="${h}" fill="#23262F"/>${head}${ours}${name(competitor, w - quarter + Math.round(vsR / 2))}${vs}${body}${foot}</svg>`;
}

export default { COMPARISON_OFF, DEFAULT_COMPARISON_PROMPT, stripCc, parseComparisons, findCompetitor, comparisonFor, thumbRows, comparisonHeadline, comparisonCopyFacts, isNoSpeech, comparisonSvg };
