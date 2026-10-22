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

/** The default caption: the funnel's audience prefix + CTA link. */
export function defaultCaption({ audiencePrefix = '', ctaLink = '' } = {}) {
  return [String(audiencePrefix || '').trim(), String(ctaLink || '').trim()].filter(Boolean).join('\n');
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
    });
  }
  return out;
}

export { ZONE };
export default { filterReadyVideos, defaultSlotsIso, parseIstDateTime, defaultCaption, normalizeSelections, ZONE };
