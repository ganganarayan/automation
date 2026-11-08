/**
 * Disapprove rules (pure).
 *
 * Purpose:      Which runs can be disapproved, and which Drive files a run made
 *               (so only those are deleted). Your own files are never touched:
 *               a ready video's original, a festival's shared picture.
 * Dependencies: none.
 */

/** Already handed on, or locked: these can't be disapproved (unschedule or delete them instead). */
export const NOT_DISAPPROVABLE = ['approved', 'scheduled', 'posted', 'partial', 'disapproved'];

export function canDisapprove(row = {}) {
  if (!row || !row.id || row.locked) return false;
  if (String(row.post_status || '').startsWith('post')) return false;
  return !NOT_DISAPPROVABLE.includes(row.status);
}

// A Drive file id inside a link: ...?id=XXXX, ...&id=XXXX or .../d/XXXX/...
const ID_IN_URL = /(?:[?&]id=|\/d\/)([A-Za-z0-9_-]{20,})/;
const ID = /^[A-Za-z0-9_-]{20,}$/;

/**
 * The Drive file ids an instance's steps hold that the app made: picture,
 * voice, video files and their links. A ready video (its source is your
 * folder) gives none, and a festival's shared picture is left out.
 */
export function appDriveFiles(row = {}, steps = []) {
  if (['drive_folder', 'drive_pick'].includes(row.source_type)) return [];
  const keep = new Set();
  const out = new Set();
  const visit = (v, key = '') => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => visit(x, key)); return; }
    if (typeof v === 'object') {
      if (/^(videoids|imageids)$/i.test(key)) {
        for (const x of Object.values(v)) if (ID.test(String(x))) out.add(String(x));
        return;
      }
      for (const [k, x] of Object.entries(v)) {
        if (k === 'festival') {
          // Shared by every funnel of the batch: never deleted with one of them.
          if (x && x.driveId) keep.add(String(x.driveId));
          const m = x && String(x.imageUrl || '').match(ID_IN_URL);
          if (m) keep.add(m[1]);
          continue;
        }
        visit(x, k);
      }
      return;
    }
    const s = String(v);
    if (/driveid$/i.test(key) && ID.test(s)) out.add(s);
    else if (/^https:\/\/(drive|docs)\.google|drive\.usercontent\.google/.test(s)) {
      const m = s.match(ID_IN_URL);
      if (m) out.add(m[1]);
    }
  };
  for (const st of Array.isArray(steps) ? steps : []) visit(st && st.artifacts);
  return [...out].filter((id) => !keep.has(id));
}

export default { NOT_DISAPPROVABLE, canDisapprove, appDriveFiles };
