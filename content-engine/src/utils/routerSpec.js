/**
 * Daily post router: pure helpers.
 *
 * Purpose:      The settings-free pieces of the router (docs/daily-router-plan.md)
 *, the target post date, which lane an existing instance belongs
 *               to, the image sheet's Ready / Approved / Posted bookkeeping, and
 *               the prompt that writes new sheet rows from the funnel's landing
 *               page + post history, so they unit-test without a database.
 * Responsibility: Pure functions only (luxon + postCompose, no settings/DB/I/O).
 * Dependencies: luxon, utils/postCompose.
 *
 * Lanes: 'ready_video' (Lane 1) → 'ai_video' (Lane 2) → 'image' (Lane 3, the
 * fail-safe); 'none' when nothing could be lined up for that day.
 */
import { DateTime } from 'luxon';
import { extractRow } from './postCompose.js';

const ZONE = 'Asia/Kolkata';

export const LANES = ['ready_video', 'ai_video', 'image', 'none'];

/** Instance status while a Lane 3 image waits for the operator's approval. */
export const IMAGE_REVIEW = 'image_review';

/** Columns the router keeps on the sheet (created when missing). */
export const PFM_COL = 'pfm_post_id';
/** The live post links, one per line in the cell, written when the post goes live. */
export const LINKS_COL = 'posted links';
/** Columns only an appended "already posted" row needs (the video lanes). */
export const TITLE_COL = 'title';
export const POSTED_AT_COL = 'posted at';
/** Rows the retired AI refill wrote carry this in the source column: never used. */
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

/** The accounts an image post can go to: YouTube takes only videos. */
export function imageAccounts(accounts, accountMap = {}) {
  return (Array.isArray(accounts) ? accounts : []).filter((id) => !/youtube/i.test(String((accountMap[id] || {}).platform || '')));
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

/** Links sit one per line inside a single cell. */
export const CELL_NEWLINE = String.fromCharCode(10);

/** The live links of the channels that posted, in order, de-duped. */
export function postedLinks(channels = []) {
  const list = (Array.isArray(channels) ? channels : [])
    .filter((c) => c && c.state === 'ok' && c.url)
    .map((c) => String(c.url).trim());
  return [...new Set(list)];
}

/**
 * Plan the "already posted" row for a post with no row of its own (the video
 * lanes): which headers to create, the cells to write, and whether this post
 * already has a row.
 *
 * Returns { added, header, values, rowNumber }. rowNumber > 0 means the post
 * is already on the sheet (a partial that later posted in full): fill that row
 * in with `cells` instead of appending `values`, so no row is written twice.
 */
export function postedRowPlan(rows = [], { title = '', postedAt = '', postRefs = [], links = [] } = {}) {
  const header0 = (Array.isArray(rows) && rows[0]) || [];
  const refs = (Array.isArray(postRefs) ? postRefs : []).filter(Boolean);
  const list = (Array.isArray(links) ? links : []).filter(Boolean);
  const cells = {
    status: SHEET_STATUS.posted,
    [POSTED_AT_COL]: postedAt,
    ...(list.length ? { [LINKS_COL]: list.join(CELL_NEWLINE) } : {}),
  };
  if (!header0.length) return { added: [], header: [], values: [], rowNumber: 0, cells };
  // Already here? Match on the Post for Me id, the one stable handle a row has.
  const pfmIdx = colIndex(header0, PFM_COL);
  const found = pfmIdx === -1 || !refs.length
    ? -1
    : rows.findIndex((r, i) => i > 0 && refs.some((ref) => String((r || [])[pfmIdx] ?? '').includes(ref)));
  if (found > 0) return { added: [], header: header0, values: [], rowNumber: found + 1, cells };

  const plan = planHeader(header0, ['status', TITLE_COL, POSTED_AT_COL, PFM_COL, ...(list.length ? [LINKS_COL] : [])]);
  const values = new Array(plan.header.length).fill('');
  const put = (name, value) => {
    const ci = colIndex(plan.header, name);
    if (ci !== -1) values[ci] = String(value ?? '');
  };
  // Continue the key column's numbering, so no image row can ever match this one.
  const key = extractRow(header0, []).matchColName;
  if (key) put(key, nextMatchKeys(rows, 1)[0] || '');
  put('status', SHEET_STATUS.posted);
  put(TITLE_COL, title);
  put(POSTED_AT_COL, postedAt);
  put(PFM_COL, refs.join(', '));
  if (list.length) put(LINKS_COL, list.join(CELL_NEWLINE));
  return { added: plan.added, header: plan.header, values, rowNumber: 0, cells };
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
    if (fields.hasSchema && fields.isReady && fields.imagePrompt && norm(fields.source) !== norm(AUTO_SOURCE)) out.push({ fields, rowNumber: i + 1, key: rowKey(fields, i + 1) });
  }
  return out;
}

/**
 * What the sheet holds, for the message when it runs out: rows you filled that
 * are Posted, and rows with no status yet.
 */
export function sheetStock(rows = []) {
  const stock = { posted: 0, blank: 0 };
  if (!Array.isArray(rows)) return stock;
  for (const r of rows.slice(1)) {
    const f = extractRow(rows[0], r || []);
    if (!f.imagePrompt || norm(f.source) === norm(AUTO_SOURCE)) continue;
    if (norm((r || [])[colIndex(rows[0], 'status')]) === norm(SHEET_STATUS.posted)) stock.posted += 1;
    else if (!norm((r || [])[colIndex(rows[0], 'status')])) stock.blank += 1;
  }
  return stock;
}

/** The sheet ran out: what to do about it. */
export function sheetEmptyText({ posted = 0, blank = 0 } = {}) {
  return `The content sheet has no Ready row: ${posted} posted, ${blank} with no status. Change Posted to Ready, or add new rows, and it carries on.`;
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
export function nextMatchKeys(rows = [], count = 1, now = DateTime.now().setZone(ZONE)) {
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
/**
 * The funnel's landing page setting → its URLs: one per line (commas and
 * spaces also split), http(s) only, de-duped, at most 10.
 */
export function landingUrls(raw) {
  const seen = new Set();
  const out = [];
  for (const t of String(raw || '').split(/[\s,]+/)) {
    const u = t.trim();
    if (!/^https?:\/\/\S+$/i.test(u) || seen.has(u.toLowerCase())) continue;
    seen.add(u.toLowerCase());
    out.push(u);
    if (out.length >= 10) break;
  }
  return out;
}

/** The prompt line naming the landing page(s). */
export function landingLine(raw) {
  const urls = landingUrls(raw);
  if (!urls.length) return 'Landing page: (none set)';
  return urls.length === 1 ? `Landing page: ${urls[0]}` : `Landing pages:\n${urls.map((u) => `- ${u}`).join('\n')}`;
}

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

// ---- Lane 1: ready video ---------------------------------------------------

/** Instance status while a router Lane 1 video's generated copy waits for approval. */
export const VIDEO_REVIEW = 'video_review';

const baseName = (name) => String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim().toLowerCase();
const isVideoFile = (f) => String((f && f.mimeType) || '').startsWith('video') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(String((f && f.name) || ''));

/**
 * D3: the OLDEST video in the folder that is not posted (by name or by the
 * app's record) and not held by an open job. Returns the file or null.
 */
export function pickOldestVideo(files = [], skipIds = []) {
  const skip = new Set((skipIds || []).map(String));
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && f.id && isVideoFile(f) && !/posted/i.test(String(f.name || '')) && !skip.has(String(f.id)))
    .sort((a, b) => new Date(a.createdTime || 0) - new Date(b.createdTime || 0) || String(a.name).localeCompare(String(b.name)))[0] || null;
}

/**
 * Same-name thumbnail + caption next to a video (my-video.mp4 → my-video.jpg
 * and my-video.txt). Returns { thumb, caption } (files or null each).
 */
export function sidecarsFor(files = [], video = {}) {
  const want = baseName(video.name);
  const same = (Array.isArray(files) ? files : []).filter((f) => f && f.id !== video.id && baseName(f.name) === want);
  return {
    thumb: same.find((f) => /\.(jpe?g|png)$/i.test(String(f.name || ''))) || null,
    caption: same.find((f) => /\.txt$/i.test(String(f.name || ''))) || null,
  };
}

/** A sidecar caption file → copy for every platform (first line is the title). */
export function copyFromCaption(text = '') {
  const body = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  const first = (body.split('\n').find((l) => l.trim()) || '').trim();
  return { title: first.slice(0, 100), description: body, igCaption: body, short: body, thumbText: '', thumbPrompt: '' };
}

/** The same thumbnail URL for every platform that takes one. */
export function thumbsForAll(url, platforms = []) {
  return url ? Object.fromEntries(platforms.map((k) => [k, url])) : {};
}

/** "dd-MM-yyyy HH:mm" IST for a post time, or '' when it has passed (D2: post now). */
export function istSlot(scheduledFor, now = new Date()) {
  if (!scheduledFor) return '';
  const at = new Date(scheduledFor);
  if (Number.isNaN(at.getTime()) || at.getTime() <= new Date(now).getTime()) return '';
  return DateTime.fromJSDate(at).setZone(ZONE).toFormat('dd-MM-yyyy HH:mm');
}

// ---- Lane 2: researched AI video ------------------------------------------

export const VIDEO_PROVIDERS = ['kling', 'runway', 'hailuo'];

/** A funnel's video-provider order ("runway, kling") → all three, preferred first. */
export function providerOrder(order = '', fallback = 'kling') {
  const picked = String(order || '').toLowerCase().split(/[\s,>]+/).filter((p) => VIDEO_PROVIDERS.includes(p));
  const first = VIDEO_PROVIDERS.includes(String(fallback)) ? [String(fallback)] : [];
  return [...new Set([...picked, ...first, ...VIDEO_PROVIDERS])];
}

/** True when a provider error means "out of credit / quota / balance". */
export function isCreditError(message = '') {
  if (/storage quota|My Drive/i.test(String(message || ''))) return false;
  return /insufficient|not enough (credit|balance|quota)|balance|quota|credits?\b|payment required|billing|\b402\b|account.{0,20}(arrears|overdue)|resource pack/i.test(String(message || ''));
}

/**
 * One provider's credit state from what we know:
 *   configured (key set), balance (number, or null when the provider has no
 *   balance API / it could not be read), exhaustedOn (IST date it last said
 *   "out of credit"), today (IST date).
 * → { ok, state: 'ok' | 'unknown' | 'empty' | 'exhausted' | 'missing', note }
 */
export function creditState({ configured = false, balance = null, exhaustedOn = '', today = '' } = {}) {
  if (!configured) return { ok: false, state: 'missing', note: 'no key' };
  const known = balance !== null && balance !== undefined && balance !== '' && !Number.isNaN(Number(balance));
  // A live positive reading beats an earlier "out of credit" mark (a top-up shows at once).
  if (known && Number(balance) > 0) return { ok: true, state: 'ok', balance: Number(balance), note: `balance ${balance}` };
  if (exhaustedOn && exhaustedOn === today) return { ok: false, state: 'exhausted', note: 'out of credit today' };
  if (!known) return { ok: true, state: 'unknown', note: 'no balance reading; assumed OK until it refuses' };
  return { ok: false, state: 'empty', balance: 0, note: 'balance 0' };
}

const VIDEO_LABEL = { kling: 'Kling', runway: 'Runway', hailuo: 'Hailuo' };
const fmtNum = (n) => Number(n).toLocaleString('en-IN');

/**
 * What the Keys and credit page shows: plain, calm rows (it is there to inform,
 * not to alarm). tone: 'ok' 🟢 · 'todo' 🟡 (something to do) · 'off' ⚪ (not set
 * up and not needed). → { ready, headline, todo: [text], rows: [{ name, tone, text }] }
 */
export function creditView({ provider = null, order = [], video = {}, deps = {}, funnel = '' } = {}) {
  const rows = [];
  const todo = [];
  const anyVideo = order.some((p) => video[p] && video[p].ok);
  const unit = { voice: 'characters' };
  const left = (x, u = 'credits') => (x.balance > 0 ? `${fmtNum(x.balance)} ${u} left` : '');
  for (const p of order) {
    const x = video[p];
    if (!x) continue;
    const name = VIDEO_LABEL[p] || p;
    if (x.state === 'missing') {
      rows.push({ name, tone: anyVideo ? 'off' : 'todo', text: anyVideo ? 'not set up (optional)' : 'add its key to use it' });
    } else if (x.state === 'exhausted' || x.state === 'empty') {
      const text = x.state === 'empty' ? 'balance 0: top up, then press Check again' : 'said "out of credit" today: top up, then press I topped up';
      rows.push({ name, tone: anyVideo ? 'off' : 'todo', text, clear: x.state === 'exhausted' ? p : undefined });
    } else {
      const role = p === provider ? 'in use' : 'standby';
      const bal = x.state === 'ok' ? left(x) : 'balance not shown by this provider; used until it says out of credit';
      rows.push({ name, tone: 'ok', text: `${role} · ${bal}` });
    }
  }
  if (!anyVideo) todo.push('a video provider with credit (Kling, Runway or Hailuo)');

  const v = deps.voice;
  if (v) {
    const bal = left(v, unit.voice) || (v.state === 'unknown' ? 'key set' : '');
    if (v.state === 'missing') {
      rows.push({ name: 'ElevenLabs voice', tone: 'todo', text: 'add the ElevenLabs API key' });
      todo.push('the ElevenLabs API key');
    } else if (v.state === 'needs_voice') {
      rows.push({ name: 'ElevenLabs voice', tone: 'todo', text: `${bal ? `${bal} · ` : ''}pick a narrator voice${funnel ? ` on ${funnel}` : ''} (Setup → Funnels → Set up → Voiceover step → Voice)` });
      todo.push(`a narrator voice${funnel ? ` on ${funnel}` : ''}`);
    } else if (!v.ok) {
      rows.push({ name: 'ElevenLabs voice', tone: 'todo', text: v.state === 'empty' ? 'no characters left: top up, then press Check again' : 'said "out of credit" today: top up, then press I topped up', clear: v.state === 'exhausted' ? 'voice' : undefined });
      todo.push('ElevenLabs credit');
    } else {
      rows.push({ name: 'ElevenLabs voice', tone: 'ok', text: bal || 'ready' });
    }
  }
  for (const [k, name] of [['image', 'Image API'], ['llm', 'LLM']]) {
    const x = deps[k];
    if (!x) continue;
    if (x.state === 'missing') { rows.push({ name, tone: 'todo', text: 'add an OpenAI or Gemini key' }); todo.push(`an ${name === 'LLM' ? 'LLM' : 'image'} key (OpenAI or Gemini)`); }
    else if (!x.ok) { rows.push({ name, tone: 'todo', text: 'said "out of credit" today: top up, then press I topped up', clear: k }); todo.push(`${name} credit`); }
    else rows.push({ name, tone: 'ok', text: 'ready · balance not shown by OpenAI/Gemini' });
  }
  const a = deps.assembly;
  if (a) {
    rows.push({ name: 'Video assembly (GitHub)', tone: a.ok ? 'ok' : 'todo', text: a.ok ? 'ready · Drive connected, GitHub token set' : a.note });
    if (!a.ok) todo.push(a.note);
  }
  const ready = !todo.length;
  const headline = ready
    ? `Lane 2 is ready. The next AI video uses ${VIDEO_LABEL[provider] || provider}.`
    : `Lane 2 needs ${todo.length === 1 ? 'one thing' : `${todo.length} things`} before it can make AI videos: ${todo.join('; ')}. Image posts fill in until then.`;
  return { ready, headline, todo, rows };
}

/** The first provider in `order` whose state is ok, or null. */
export function chooseProvider(order = [], states = {}) {
  return order.find((p) => states[p] && states[p].ok) || null;
}

/**
 * Lane 2 can run when a video provider is free AND voice, images, the LLM and
 * the GitHub assembly are. Returns { ok, provider, missing: [labels] }.
 */
export function laneTwoVerdict({ order = [], video = {}, deps = {} } = {}) {
  const provider = chooseProvider(order, video);
  const missing = [];
  if (!provider) missing.push('video (Kling / Runway / Hailuo)');
  for (const [k, label] of [['voice', 'ElevenLabs voice'], ['image', 'image API'], ['llm', 'LLM'], ['assembly', 'GitHub assembly (Drive connected + GitHub token)']]) {
    if (deps[k] && !deps[k].ok) missing.push(label);
  }
  return { ok: !missing.length, provider, missing };
}

/**
 * The once-per-dry-spell email: send when lane 2 just went dry; reset when it
 * runs again. prev = { dry, since } → { send, next }.
 */
export function dryTransition(prev = {}, ok, nowIso = new Date().toISOString()) {
  if (ok) return { send: false, next: { dry: false, since: null } };
  if (prev && prev.dry) return { send: false, next: prev };
  return { send: true, next: { dry: true, since: nowIso } };
}

/**
 * The research prompt: ONE new narrated short-video topic for this funnel,
 * from its landing page + post history. Returns { system, user }.
 */
export function researchPrompt({ funnelName = '', landingUrl = '', landingText = '', history = [] } = {}) {
  const system = [
    `You plan one short narrated social video (about 30-45 seconds) for the brand/funnel "${funnelName}".`,
    'It must be NEW: a topic, angle and format that differ from every past post listed (no repeats or near-duplicates). Vary the format (a story, a myth vs fact, a tip, a question, a list, a before/after).',
    'Stay true to what the landing page offers and who it is for. Never invent prices, guarantees or facts that are not on it.',
    'A third-person narrator speaks over animated images; nobody talks on screen.',
    'Return ONLY a JSON object: {"topic": "...", "angle": "...", "format": "...", "title": "a short title", "caption": "the post caption (hook first, call to action last, no links)"}',
  ].join('\n');
  const user = [
    landingLine(landingUrl),
    landingText ? `Landing page text:\n${landingText}` : '',
    history.length ? `Past posts (do NOT repeat these topics or angles):\n${history.map((e) => `- ${e}`).join('\n')}` : 'Past posts: none yet.',
    'Pick the next video.',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** The LLM's research reply → { topic, angle, format, title, caption } (topic required). */
export function normalizeResearch(data) {
  const o = data && typeof data === 'object' ? data : {};
  const s = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const out = {
    topic: s(o.topic, 300), angle: s(o.angle, 300), format: s(o.format, 120), title: s(o.title, 120),
    caption: String(o.caption ?? '').trim().slice(0, 2000),
  };
  if (!out.topic) throw new Error('the research step returned no topic');
  return out;
}

/** The script brief the stage runner writes from (topic + angle + format). */
export function briefTopic(brief = {}) {
  return [brief.topic, brief.angle && `Angle: ${brief.angle}`, brief.format && `Format: ${brief.format}`].filter(Boolean).join('. ');
}

// ---- Re-run + nudge -------------------------------------------------------

/** Statuses after the operator approved (a re-run leaves these alone). */
const APPROVED = ['approved', 'scheduled', 'posted', 'partial'];

/**
 * What a re-run does to the instance a day was recorded with:
 *   'keep' (approved / posted / dead: it stays as it is), 'release' (a ready
 *   video's draft: unlinked from the day, the video stays in the folder),
 *   'supersede' (an unapproved image / AI video: replaced, its sheet row freed).
 */
export function rerunAction(row = null) {
  if (!row) return 'none';
  if (APPROVED.includes(row.status) || ['failed', 'superseded'].includes(row.status)) return 'keep';
  if (row.source_type === 'drive_folder' || row.source_type === 'drive_pick') return 'release';
  return 'supersede';
}

/**
 * Scheduling a post by hand for a day the router already filled: does the
 * router's pick clash with it? null when not (no pick, the same instance or
 * video, or the pick failed / was replaced); else { canReplace }, false when
 * the pick is already approved or scheduled with Post for Me.
 */
export function routerClash(day, held, { instanceId = null, driveId = '' } = {}) {
  if (!day || !day.instance_id || day.lane === 'none') return null;
  if (instanceId && String(day.instance_id) === String(instanceId)) return null;
  if (!held || ['failed', 'superseded'].includes(held.status)) return null;
  if (driveId && held.source_ref && String(held.source_ref) === String(driveId)) return null;
  return { canReplace: rerunAction(held) !== 'keep' };
}

/** The 10:00 nudge goes out when some funnel has neither video lane for tomorrow. */
export function nudgeNeeded(funnelsState = []) {
  return (funnelsState || []).some((f) => !f.readyVideo && !f.aiVideo);
}

export const NUDGE_TEXT = 'Video lanes are empty. Upload ready videos or top up the video APIs so I can create videos and auto-post.';

export default {
  LANES, IMAGE_REVIEW, PFM_COL, LINKS_COL, TITLE_COL, POSTED_AT_COL, AUTO_SOURCE, SHEET_STATUS,
  CELL_NEWLINE, postedLinks, postedRowPlan,
  routerTarget, runsOn, laneForInstance, existingReason, routerClash, postAtFor, colLetter, planHeader, colIndex, rowKey,
  readyRows, pickReadyRow, nextMatchKeys, htmlToText, landingUrls, landingLine, historyLines, instanceHistoryLine, sheetStock, sheetEmptyText,
  imageAccounts, VIDEO_REVIEW, pickOldestVideo, sidecarsFor, copyFromCaption, thumbsForAll, istSlot, VIDEO_PROVIDERS, providerOrder,
  isCreditError, creditState, creditView, chooseProvider, laneTwoVerdict, dryTransition, researchPrompt, normalizeResearch, briefTopic,
  rerunAction, nudgeNeeded, NUDGE_TEXT,
};
