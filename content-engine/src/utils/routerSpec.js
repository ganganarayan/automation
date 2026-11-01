/**
 * Daily post router: pure helpers.
 *
 * Purpose:      The settings-free pieces of the router (docs/daily-router-plan.md)
 *               — the target post date, which lane an existing instance belongs
 *               to, the image sheet's Ready / Approved / Posted bookkeeping, and
 *               the prompt that writes new sheet rows from the funnel's landing
 *               page + post history — so they unit-test without a database.
 * Responsibility: Pure functions only (luxon + postCompose, no settings/DB/I/O).
 * Dependencies: luxon, utils/postCompose.
 *
 * Lanes: 'ready_video' (Lane 1) → 'ai_video' (Lane 2) → 'image' (Lane 3, the
 * fail-safe); 'none' when nothing could be lined up for that day.
 */
import { DateTime } from 'luxon';
import { extractRow, locate } from './postCompose.js';

const ZONE = 'Asia/Kolkata';

export const LANES = ['ready_video', 'ai_video', 'image', 'none'];

/** Instance status while a Lane 3 image waits for the operator's approval. */
export const IMAGE_REVIEW = 'image_review';

/** Below this many Ready rows the sheet is topped up with REFILL_COUNT new ones. */
export const REFILL_BELOW = 2;
export const REFILL_COUNT = 7;

/** Columns the router keeps on the sheet (created when missing). */
export const PFM_COL = 'pfm_post_id';
export const SOURCE_COL = 'source';
export const AUTO_SOURCE = 'Auto';

/** Sheet statuses, in order. */
export const SHEET_STATUS = { ready: 'Ready', approved: 'Approved', posted: 'Posted' };

/**
 * The post the router plans at "now": TOMORROW (IST) at the funnel's
 * publish_time. Returns { scheduledFor (DateTime, IST), postDate ('yyyy-MM-dd') }.
 */
export function routerTarget(publishTime, now = DateTime.now().setZone(ZONE)) {
  const n = now.setZone(ZONE);
  const [h, m] = String(publishTime || '08:02').split(':').map((x) => parseInt(x, 10));
  const scheduledFor = n.plus({ days: 1 }).set({
    hour: Number.isFinite(h) ? h : 8, minute: Number.isFinite(m) ? m : 2, second: 0, millisecond: 0,
  });
  return { scheduledFor, postDate: scheduledFor.toFormat('yyyy-MM-dd') };
}

/** True when the run day's IST weekday is in generate_days (blank = every day). */
export function runsOn(generateDays, now = DateTime.now().setZone(ZONE)) {
  const days = String(generateDays || '').split(',').map((d) => d.trim()).filter(Boolean);
  return !days.length || days.includes(String(now.setZone(ZONE).weekday));
}

/** The router lane an existing instance stands for. */
export function laneForInstance(row = {}) {
  const t = row.source_type || '';
  if (t === 'sheet') return 'image';
  if (t === 'drive_folder' || t === 'drive_pick' || row.status === 'draft' || row.status === 'transcript_review') return 'ready_video';
  return 'ai_video';
}

/** Why the router left an existing instance alone. */
export function existingReason(row = {}) {
  return ['scheduled', 'posted', 'partial'].includes(row.status) ? 'already scheduled' : `already in progress (${row.status || 'unknown'})`;
}

/**
 * D2: a post approved after its time goes out at once. Returns the ISO time to
 * hand Post for Me, or null for "post now".
 */
export function postAtFor(scheduledFor, now = new Date()) {
  if (!scheduledFor) return null;
  const at = new Date(scheduledFor);
  if (Number.isNaN(at.getTime())) return null;
  return at.getTime() > new Date(now).getTime() ? at.toISOString() : null;
}

/** A1 column letter for a 0-based index (0 → A, 26 → AA). */
export function colLetter(index0) {
  let n = index0;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Header cells to add so every name in `needed` exists (case-insensitive).
 * Returns { header (the full new header), added: [{ index, name }] }.
 */
export function planHeader(rawHeader = [], needed = []) {
  const header = [...rawHeader];
  const added = [];
  for (const name of needed) {
    if (header.some((h) => norm(h) === norm(name))) continue;
    added.push({ index: header.length, name });
    header.push(name);
  }
  return { header, added };
}

/** The 0-based index of a header cell by name (case-insensitive), or -1. */
export function colIndex(rawHeader = [], name) {
  return rawHeader.findIndex((h) => norm(h) === norm(name));
}

/** The match key the router stores on an instance for a sheet row. */
export function rowKey(fields, rowNumber) {
  return fields.matchKey ? String(fields.matchKey) : `row:${rowNumber}`;
}

/** Ready rows of a sheet (rows[0] is the header): [{ fields, rowNumber, key }]. */
export function readyRows(rows = []) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const fields = extractRow(rows[0], rows[i] || []);
    if (fields.hasSchema && fields.isReady && fields.imagePrompt) out.push({ fields, rowNumber: i + 1, key: rowKey(fields, i + 1) });
  }
  return out;
}

/** The next Ready row not attached to an open instance (by key), or null. */
export function pickReadyRow(rows = [], openKeys = []) {
  const taken = new Set((openKeys || []).map(String));
  return readyRows(rows).find((r) => !taken.has(r.key)) || null;
}

/**
 * Next match keys for new rows: continue the numbering when the key column is
 * numeric (Post # / day), else a dated "auto-…" key. [] when the sheet has no
 * key column (rows are then found by row number).
 */
export function nextMatchKeys(rows = [], count = REFILL_COUNT, now = DateTime.now().setZone(ZONE)) {
  const fields = extractRow((rows && rows[0]) || [], []);
  if (!fields.matchColName) return [];
  const idx = colIndex(rows[0], fields.matchColName);
  const values = rows.slice(1).map((r) => String((r || [])[idx] ?? '').trim()).filter(Boolean);
  const numeric = values.length && values.every((v) => /^\d+$/.test(v));
  if (numeric || !values.length) {
    const max = values.reduce((a, v) => Math.max(a, parseInt(v, 10) || 0), 0);
    return Array.from({ length: count }, (_, i) => String(max + i + 1));
  }
  const stamp = now.setZone(ZONE).toFormat('yyyyMMdd-HHmm');
  return Array.from({ length: count }, (_, i) => `auto-${stamp}-${i + 1}`);
}

/** Landing page HTML → plain text for the LLM, capped. */
export function htmlToText(html, cap = 6000) {
  const text = String(html || '')
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return text.length > cap ? `${text.slice(0, cap).trimEnd()} …` : text;
}

/** One short line per past post/row, de-duplicated, newest first, capped. */
export function historyLines(items = [], cap = 40) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const line = String(it || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
    if (out.length >= cap) break;
  }
  return out;
}

/** One instance as a history line: its title + the caption it posted (or drafted). */
export function instanceHistoryLine(row = {}) {
  let steps = row.steps;
  if (typeof steps === 'string') {
    try { steps = JSON.parse(steps); } catch { steps = []; }
  }
  const art = (k) => ((Array.isArray(steps) ? steps : []).find((s) => s && s.key === k) || {}).artifacts || {};
  const copy = art('script').copy || {};
  const caption = (art('publish').request || {}).caption || art('publish').caption || copy.description || art('script').text || '';
  const title = String(row.title || '').replace(/\s·\s\d{2}-\d{2}-\d{4}$/, '');
  return [copy.title || title, String(caption).slice(0, 160)].filter(Boolean).join(' · ');
}

/** The sheet's existing rows as history lines (headline · caption · prompt). */
export function sheetHistory(rows = []) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  return rows.slice(1).reverse().map((r) => {
    const f = extractRow(rows[0], r || []);
    return [f.headline, f.captionShort || f.caption || f.captionFull, f.imagePrompt].filter(Boolean).join(' · ');
  });
}

/** Which content columns this sheet has (so the LLM only writes what fits). */
export function sheetColumns(rawHeader = []) {
  const h = rawHeader.map(norm);
  return {
    prompt: locate(h, ['image_prompt', 'prompt'], ['image prompt']) !== -1,
    caption: locate(h, ['caption']) !== -1,
    captionFull: locate(h, ['caption_full', 'full caption'], ['linkedin long caption']) !== -1,
    captionShort: locate(h, ['caption_short'], ['short caption']) !== -1,
    headline: locate(h, ['headline']) !== -1,
    subhead: locate(h, ['subhead', 'subheadline']) !== -1,
    hashtags: locate(h, ['hashtags']) !== -1,
  };
}

/**
 * The refill prompt: write `count` new image posts for this funnel from its
 * landing page and post history, none repeating a past topic or angle.
 * Returns { system, user } for llm.generateJson.
 */
export function refillPrompt({ funnelName = '', landingUrl = '', landingText = '', history = [], examples = [], columns = {}, count = REFILL_COUNT }) {
  const fields = ['"imagePrompt": a detailed prompt for an image model (scene, subject, mood, light, colours, composition)'];
  if (columns.headline) fields.push('"headline": 3-8 words the image shows verbatim');
  if (columns.subhead) fields.push('"subhead": one short supporting line shown under the headline');
  if (columns.caption || columns.captionFull || !columns.captionShort) fields.push('"caption": the full post caption (3-6 short paragraphs, a hook first, a clear call to action last)');
  if (columns.captionShort) fields.push('"captionShort": a short caption (1-3 sentences) for the other channels');
  if (columns.hashtags) fields.push('"hashtags": 3-6 relevant hashtags in one line');
  const system = [
    `You plan daily social media image posts for the brand/funnel "${funnelName}".`,
    'Each post must be NEW: a different topic, angle and format from every past post listed — no repeats, no near-duplicates, and the set itself must vary (e.g. a tip, a story, a myth vs fact, a question, a quote, a checklist, a before/after).',
    'Stay true to what the landing page offers and who it is for. Do not invent prices, guarantees or facts that are not on it.',
    'Do not put links in captions (the link is added separately).',
    `Return ONLY a JSON object: {"posts": [ ${count} objects ]}, each object with:`,
    ...fields.map((f) => `- ${f}`),
  ].join('\n');
  const user = [
    landingUrl ? `Landing page: ${landingUrl}` : 'Landing page: (none set)',
    landingText ? `Landing page text:\n${landingText}` : '',
    examples.length ? `Image prompts already used on this sheet (match their style, not their topics):\n${examples.map((e) => `- ${e}`).join('\n')}` : '',
    history.length ? `Past posts (do NOT repeat these topics or angles):\n${history.map((e) => `- ${e}`).join('\n')}` : 'Past posts: none yet.',
    `Write ${count} new posts.`,
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** The LLM's reply → up to `count` clean posts (each with an imagePrompt). */
export function normalizeRefill(data, count = REFILL_COUNT) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.posts) ? data.posts : []);
  const s = (v) => String(v ?? '').trim();
  return list
    .map((p) => ({
      imagePrompt: s(p && (p.imagePrompt || p.image_prompt || p.prompt)),
      headline: s(p && p.headline),
      subhead: s(p && p.subhead),
      caption: s(p && (p.caption || p.captionFull)),
      captionShort: s(p && p.captionShort),
      hashtags: Array.isArray(p && p.hashtags) ? p.hashtags.map(s).join(' ') : s(p && p.hashtags),
    }))
    .filter((p) => p.imagePrompt)
    .slice(0, count);
}

/**
 * New posts → sheet rows aligned to `rawHeader` (which already has the status
 * and source columns): status Ready, source Auto, the match key when the sheet
 * has one. Columns the sheet doesn't have are dropped.
 */
export function rowsForSheet(rawHeader = [], posts = [], keys = []) {
  const h = rawHeader.map(norm);
  const at = {
    status: locate(h, ['status']),
    match: locate(h, ['post #', 'post no', 'post number', 'day', 'id']),
    prompt: locate(h, ['image_prompt', 'prompt'], ['image prompt']),
    caption: locate(h, ['caption']),
    full: locate(h, ['caption_full', 'full caption'], ['linkedin long caption']),
    short: locate(h, ['caption_short'], ['short caption']),
    headline: locate(h, ['headline']),
    subhead: locate(h, ['subhead', 'subheadline']),
    hashtags: locate(h, ['hashtags']),
    source: colIndex(rawHeader, SOURCE_COL),
  };
  return posts.map((p, i) => {
    const row = rawHeader.map(() => '');
    const put = (idx, v) => { if (idx !== -1 && v) row[idx] = v; };
    put(at.status, SHEET_STATUS.ready);
    put(at.match, keys[i] || '');
    put(at.prompt, p.imagePrompt);
    put(at.caption, p.caption);
    put(at.full, p.caption);
    put(at.short, p.captionShort || (at.caption === -1 && at.full === -1 ? p.caption : ''));
    put(at.headline, p.headline);
    put(at.subhead, p.subhead);
    put(at.hashtags, p.hashtags);
    put(at.source, AUTO_SOURCE);
    return row;
  });
}

export default {
  LANES, IMAGE_REVIEW, REFILL_BELOW, REFILL_COUNT, PFM_COL, SOURCE_COL, AUTO_SOURCE, SHEET_STATUS,
  routerTarget, runsOn, laneForInstance, existingReason, postAtFor, colLetter, planHeader, colIndex, rowKey,
  readyRows, pickReadyRow, nextMatchKeys, htmlToText, historyLines, instanceHistoryLine, sheetHistory, sheetColumns, refillPrompt,
  normalizeRefill, rowsForSheet,
};
