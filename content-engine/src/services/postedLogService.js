/**
 * The posted log: a sheet row for a live post that never had one.
 *
 * Purpose:      Lane 3 (image) posts come from a row of the funnel's content
 *               sheet, so going live just marks that row Posted and writes its
 *               links. Lane 1 (ready video) and Lane 2 (AI video) draw from
 *               Drive and from the AI pipeline, so they have no row at all.
 *               This appends one for them, so every post the app makes leaves
 *               its live links in the same sheet, in the same column.
 * Responsibility:
 *               - onPosted: the post check's "went live" hook for every
 *                 instance that is not sheet-sourced. Appends Posted + the
 *                 title + the posted time (IST) + the Post for Me id(s) + the
 *                 live links, one per line in the cell. A row this post
 *                 already has (a partial that later posted in full) is filled
 *                 in instead, so a retry never appends a second row.
 *               - Quiet when the funnel has no sheet configured, and
 *                 best-effort throughout: the sheet is a log, so nothing here
 *                 may fail a post that is already live.
 * Dependencies: funnelsRepository, providerFactory, funnelPosterService
 *               (tabFor, appendPostedRow), utils/time, logger.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import { buildProviders } from './providerFactory.js';
import * as poster from './funnelPosterService.js';
import { postedLinks, PFM_COL, LINKS_COL, CELL_NEWLINE, SHEET_STATUS } from '../utils/routerSpec.js';
import { sheetRowOf } from '../utils/instanceSpec.js';
import { formatIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const baseLog = childLogger({ module: 'postedLog' });

/**
 * Post check hook: a video-lane instance is live → the sheet row its thumbnail
 * came from is marked Posted, else one appended sheet row. Sheet-sourced instances are the image lane's own (it marks its row), and an
 * instance with no funnel or no sheet has nowhere to log.
 */
export async function onPosted(row, { refs = [], channels = [] } = {}) {
  if (!row || row.source_type === 'sheet') return false;
  const log = baseLog.child({ instance: row.id });
  try {
    const funnel = row.funnel_id ? await funnels.get(row.funnel_id) : null;
    if (!funnel) return false;
    const f = await funnels.resolve(funnel);
    if (!f.sheetId) return false; // this funnel keeps no sheet
    const providers = await buildProviders(f.tenantId);
    const tab = await poster.tabFor(providers.sheets, f);
    const postRefs = (refs.length ? refs : (Array.isArray(row.post_refs) ? row.post_refs : [])).filter(Boolean);
    const used = sheetRowOf(row.steps);
    if (used) {
      const links = postedLinks(channels);
      return poster.markSheetRow(providers.sheets, f.sheetId, used.tab || tab, {
        matchColName: used.matchColName, matchKey: used.key, rowNumber: used.rowNumber, status: SHEET_STATUS.posted,
        extra: { [PFM_COL]: postRefs.join(', '), ...(links.length ? { [LINKS_COL]: links.join(CELL_NEWLINE) } : {}) },
      }, log);
    }
    const ok = await poster.appendPostedRow(providers.sheets, f.sheetId, tab, {
      title: row.title || '',
      postedAt: formatIst(row.posted_at || new Date()),
      postRefs,
      links: postedLinks(channels),
    }, log);
    if (ok) log.info({ funnel: f.name, tab }, 'posted log row written');
    return ok;
  } catch (err) {
    log.warn({ err: err.message }, 'posted log row failed');
    return false;
  }
}

export default { onPosted };
