/**
 * What each funnel still has ready to post, for the Funnels page.
 *
 * Purpose:      See at a glance when a funnel is about to run out, counted the
 *               way the daily router picks, so the number is what it can use.
 * Responsibility:
 *               - Ready videos (Lane 1): videos in the ready folder, not posted,
 *                 not lined up for a day, not waiting for text (no speech).
 *               - Ready thumbnails: those videos that have your own thumbnail
 *                 and caption, one per video. No warning dot: the router makes
 *                 a thumbnail for each of the others.
 *               - Image posts (Lane 3): Ready rows in the content sheet that no
 *                 open post holds. The picture is made when a row is used.
 *               - Lane 2 makes its videos when asked, so it has no stock.
 *               Each source fails alone: { count: null, note } says why.
 * Dependencies: readyPostService, funnelPosterService, providerFactory,
 *               funnelsRepository, instanceRepository, utils/{routerSpec,postCompose}.
 */
import * as readyPost from './readyPostService.js';
import * as poster from './funnelPosterService.js';
import { buildProviders } from './providerFactory.js';
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import { waitingVideos, ownThumbnailCount, freeReadyRows, stockDot } from '../utils/routerSpec.js';
import { extractRow } from '../utils/postCompose.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'funnelStock' });

const counted = (count) => ({ count, dot: stockDot(count), note: '' });
const noCount = (note) => ({ count: null, dot: stockDot(null), note });

async function videoStock(funnelRow) {
  const { funnel, providers, folder, files, posted } = await readyPost.folderFiles({ funnelId: funnelRow.id });
  if (!folder) return { videos: noCount('no folder set'), thumbnails: noCount('no folder set') };
  const held = await instanceRepo.routerHeldDriveIds(funnel.id, funnel.tenant_id).catch(() => []);
  const silent = await readyPost.silentDriveIds({ funnel, resolved: providers.resolved, files }).catch(() => []);
  const waiting = waitingVideos(files, [...posted, ...held, ...silent]);
  return {
    videos: counted(waiting.length),
    thumbnails: { count: ownThumbnailCount(waiting, files), dot: '', note: `of ${waiting.length} videos` },
  };
}

async function imagePostStock(funnelRow) {
  const f = await funnels.resolve(funnelRow);
  if (!f.sheetId) return noCount('no sheet set');
  const { sheets } = await buildProviders(f.tenantId);
  const tab = await poster.tabFor(sheets, f);
  const rows = await sheets.readTab(f.sheetId, tab, { fresh: true });
  if (!rows.length || !extractRow(rows[0], []).hasSchema) return noCount('sheet not set up');
  const open = await instanceRepo.openSheetRefs(f.id, f.tenantId);
  return counted(freeReadyRows(rows, open).length);
}

/** [{ id, videos, thumbnails, imagePosts }], each { count, dot, note }, one per funnel of this tenant. */
export async function stockForTenant(tenantId = 'default') {
  const list = await funnels.listByTenant(tenantId);
  return Promise.all(list.map(async (f) => {
    const [folder, imagePosts] = await Promise.all([
      videoStock(f).catch((err) => {
        log.warn({ err: err.message, funnel: f.id }, 'could not count ready videos');
        return { videos: noCount('could not read'), thumbnails: noCount('could not read') };
      }),
      imagePostStock(f).catch((err) => {
        log.warn({ err: err.message, funnel: f.id }, 'could not count image posts');
        return noCount('could not read');
      }),
    ]);
    return { id: f.id, ...folder, imagePosts };
  }));
}

/** [{ id, name, imagePosts }]: just the sheets, for the daily email's running-out warning. */
export async function sheetStockForTenant(tenantId = 'default') {
  const list = await funnels.listByTenant(tenantId);
  return Promise.all(list.map(async (f) => ({
    id: f.id,
    name: f.name || '',
    imagePosts: await imagePostStock(f).catch(() => noCount('could not read')),
  })));
}

export default { stockForTenant, sheetStockForTenant };
