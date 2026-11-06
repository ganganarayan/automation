/**
 * What each funnel still has ready to post, for the Funnels page.
 *
 * Purpose:      See at a glance when a funnel is about to run out, counted the
 *               way the daily router picks, so the number is what it can use.
 * Responsibility:
 *               - Ready videos (Lane 1): videos in the ready folder, not posted,
 *                 not lined up for a day, not waiting for text (no speech).
 *               - Ready images (Lane 3): Ready rows in the content sheet that no
 *                 open post holds.
 *               - Lane 2 makes its videos when asked, so it has no stock.
 *               Each count fails alone: { count: null, note } says why.
 * Dependencies: readyPostService, funnelPosterService, providerFactory,
 *               funnelsRepository, instanceRepository, utils/{routerSpec,postCompose}.
 */
import * as readyPost from './readyPostService.js';
import * as poster from './funnelPosterService.js';
import { buildProviders } from './providerFactory.js';
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import { waitingVideos, freeReadyRows, stockDot } from '../utils/routerSpec.js';
import { extractRow } from '../utils/postCompose.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'funnelStock' });

const counted = (count) => ({ count, dot: stockDot(count), note: '' });
const noCount = (note) => ({ count: null, dot: stockDot(null), note });

async function videoStock(funnelRow) {
  const { funnel, providers, folder, files, posted } = await readyPost.folderFiles({ funnelId: funnelRow.id });
  if (!folder) return noCount('no folder set');
  const held = await instanceRepo.routerHeldDriveIds(funnel.id, funnel.tenant_id).catch(() => []);
  const silent = await readyPost.silentDriveIds({ funnel, resolved: providers.resolved, files }).catch(() => []);
  return counted(waitingVideos(files, [...posted, ...held, ...silent]).length);
}

async function imageStock(funnelRow) {
  const f = await funnels.resolve(funnelRow);
  if (!f.sheetId) return noCount('no sheet set');
  const { sheets } = await buildProviders(f.tenantId);
  const tab = await poster.tabFor(sheets, f);
  const rows = await sheets.readTab(f.sheetId, tab, { fresh: true });
  if (!rows.length || !extractRow(rows[0], []).hasSchema) return noCount('sheet not set up');
  const open = await instanceRepo.openSheetRefs(f.id, f.tenantId);
  return counted(freeReadyRows(rows, open).length);
}

const safely = (what, funnelRow, fn) => fn(funnelRow).catch((err) => {
  log.warn({ err: err.message, funnel: funnelRow.id }, `could not count ready ${what}`);
  return noCount('could not read');
});

/** [{ id, videos: { count, dot, note }, images: { count, dot, note } }], one per funnel of this tenant. */
export async function stockForTenant(tenantId = 'default') {
  const list = await funnels.listByTenant(tenantId);
  return Promise.all(list.map(async (f) => {
    const [videos, images] = await Promise.all([safely('videos', f, videoStock), safely('images', f, imageStock)]);
    return { id: f.id, videos, images };
  }));
}

export default { stockForTenant };
