/**
 * Ready-video direct post: pure helpers.
 *
 * Purpose:      The settings-free pieces of the "pick a ready video from Drive and
 *               post it directly via Post-for-Me" path — selecting which Drive
 *               files are postable, the default sequential publish slots, IST
 *               datetime parsing, the default caption, and normalising the
 *               operator's tick-order selection. Kept apart from the service so
 *               they unit-test without settings or a DB (like utils/videoSchedule).
 * Responsibility: Pure functions only.
 * Dependencies: luxon.
 */
import { DateTime } from 'luxon';

const ZONE = 'Asia/Kolkata';

/**
 * The Drive folder ID from whatever the operator pasted: a folder link
 * (…/folders/<id>?usp=…), an ?id=<id> link, or a bare ID. '' when none.
 */
export function parseDriveFolderId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : '';
}

/**
 * The files the operator picked with the Google Drive picker, carried in the
 * page URL as JSON [{ id, name }]. Drops anything that isn't a Drive id and
 * de-dupes; at most 50. [] when absent or malformed.
 */
export function parsePickedFiles(raw) {
  let list;
  try { list = JSON.parse(String(raw || '')); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const id = String((f && f.id) || '').trim();
    if (!/^[\w-]{10,}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String((f && f.name) || id).slice(0, 300) });
    if (out.length >= 50) break;
  }
  return out;
}

const VIDEO_EXT = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo' };
const unent = (s) => String(s).replace(/&(amp|lt|gt|quot|#39|#(\d+));/g, (m, n, d) => (d ? String.fromCharCode(Number(d)) : { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[n]));

/**
 * Parse Google's public embedded folder view (drive.google.com/embeddedfolderview)
 * into [{ id, name, mimeType, createdTime }]. Sub-folders are skipped; the
 * mime type comes from the list icon, else the file extension.
 */
export function parseEmbeddedFolder(html) {
  const out = [];
  const parts = String(html || '').split('class="flip-entry"').slice(1);
  for (const part of parts) {
    const href = (part.match(/href="([^"]*)"/) || [])[1] || '';
    if (/\/folders\//.test(href)) continue;
    const id = (part.match(/id="entry-([\w-]{10,})"/) || href.match(/\/file\/d\/([\w-]{10,})/) || [])[1];
    if (!id) continue;
    const name = unent(((part.match(/class="flip-entry-title">([^<]*)</) || [])[1] || id).trim());
    const ext = ((name.match(/\.(\w{2,4})$/) || [])[1] || '').toLowerCase();
    const icon = (part.match(/\/type\/([\w.+-]+\/[\w.+-]+)/) || [])[1] || '';
    out.push({ id, name, mimeType: icon || VIDEO_EXT[ext] || '', createdTime: null });
  }
  return out;
}

/** The postable files in a Drive folder: videos not already tagged POSTED. */
export function filterReadyVideos(files) {
  return (Array.isArray(files) ? files : []).filter(
    (f) => String(f.mimeType || '').startsWith('video') && !/posted/i.test(String(f.name || '')),
  );
}

/**
 * Default sequential schedule slots (ISO, IST) for `count` uploads: the funnel's
 * publish_time on consecutive days, starting from the next slot strictly ahead of
 * "now" — one per day, in selection order. The operator can override each.
 */
export function defaultSlotsIso(publishTime, count, now = DateTime.now().setZone(ZONE)) {
  const [h, m] = String(publishTime || '08:02').split(':').map((x) => parseInt(x, 10) || 0);
  const n = now.setZone(ZONE);
  let first = n.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (first <= n) first = first.plus({ days: 1 });
  const out = [];
  for (let i = 0; i < Math.max(0, Math.floor(Number(count) || 0)); i += 1) out.push(first.plus({ days: i }).toISO());
  return out;
}

/** Parse a human IST datetime "DD-MM-YYYY HH:MM" into an ISO string, or null. */
export function parseIstDateTime(str) {
  const dt = DateTime.fromFormat(String(str || '').trim(), 'dd-MM-yyyy HH:mm', { zone: ZONE });
  return dt.isValid ? dt.toISO() : null;
}

/**
 * The default caption: the funnel's configured direct-upload caption if set,
 * else its audience prefix; the CTA link is appended when not already present.
 */
export function defaultCaption({ directCaption = '', audiencePrefix = '', ctaLink = '' } = {}) {
  const body = String(directCaption || '').trim() || String(audiencePrefix || '').trim();
  const link = String(ctaLink || '').trim();
  if (link && !body.includes(link)) return [body, link].filter(Boolean).join('\n');
  return body;
}

/**
 * Normalise the operator's selection into an ordered, de-duplicated list,
 * preserving the tick order (posting order). Drops entries without a driveId.
 */
export function normalizeSelections(selections) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(selections) ? selections : []) {
    const driveId = String((s && s.driveId) || '').trim();
    if (!driveId || seen.has(driveId)) continue;
    seen.add(driveId);
    out.push({
      driveId,
      name: String((s && s.name) || '').trim(),
      caption: String((s && s.caption) || ''),
      scheduledAt: s && s.scheduledAt ? String(s.scheduledAt).trim() : '',
      now: !!(s && s.now), // post immediately (ignore the schedule)
      // AI-copy lane: the per-video, per-platform copy and what generating it cost.
      copy: s && s.copy && typeof s.copy === 'object' ? s.copy : null,
      costs: (Array.isArray(s && s.costs) ? s.costs : [])
        .filter((c) => c && Number.isFinite(Number(c.costUsd)))
        .slice(0, 4),
    });
  }
  return out;
}

export { ZONE };
export default { parseEmbeddedFolder, parseDriveFolderId, parsePickedFiles, filterReadyVideos, defaultSlotsIso, parseIstDateTime, defaultCaption, normalizeSelections, ZONE };
