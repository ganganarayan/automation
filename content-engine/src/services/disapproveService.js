/**
 * Disapprove: a post you don't want, gone, with its record kept.
 *
 * Purpose:      Any run still waiting (or failed, or in progress) on any lane or
 *               funnel can be disapproved: its approval is closed (an older email
 *               link can't approve it any more), a sheet row it came from reads
 *               Disapproved, the files the app made for it are deleted from Drive
 *               to free the space, and the entry moves to the permanent record of
 *               deleted runs (Log and cost) with status Disapproved, its times
 *               and the money it cost.
 * Dependencies: instanceRepository, approvalRepository, imageLaneService,
 *               driveConnectService, utils/disapproveSpec, logger.
 */
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as approvals from '../repositories/approvalRepository.js';
import * as instanceService from './instanceService.js';
import * as driveConnect from './driveConnectService.js';
import { canDisapprove, appDriveFiles } from '../utils/disapproveSpec.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'disapprove' });

/**
 * Disapprove one run. Returns { ok, files, filesLeft }: files deleted from
 * Drive, and those that could not be (already gone ones count as deleted).
 */
export async function disapprove({ tenantId = 'default', instanceId, by = '' }) {
  const row = await instanceRepo.get(instanceId);
  if (!row || String(row.tenant_id) !== String(tenantId)) throw new Error('not found');
  if (!canDisapprove(row)) throw new Error('this one is already approved, out or locked, so it cannot be disapproved');
  // Close its approval first, so a click on an older email link can't approve it now.
  const open = await approvals.openForInstance(row.id).catch(() => null);
  if (open) {
    await approvals.consumeToken(open.id).catch(() => null);
    await approvals.setStatus(open.id, 'disapproved').catch(() => null);
  }
  if (row.source_type === 'sheet') {
    const lane = await import('./imageLaneService.js');
    await lane.markDisapproved(row).catch((err) => log.warn({ err: err.message, instance: row.id }, 'sheet row not marked Disapproved'));
  }
  // The app's own files, deleted through the connected Google account (where the app keeps them).
  const ids = appDriveFiles(row, instanceService.parseSteps(row));
  let files = 0;
  const filesLeft = [];
  if (ids.length) {
    const client = await driveConnect.drive(tenantId).then((d) => d.client).catch(() => null);
    for (const id of ids) {
      try {
        if (!client) throw new Error('Google Drive is not connected');
        await client.deleteFile(id);
        files += 1;
      } catch (err) {
        filesLeft.push(id);
        log.warn({ err: err.message, file: id, instance: row.id }, 'file not deleted');
      }
    }
  }
  await instanceRepo.setStatus(row.id, 'disapproved', `Disapproved${by ? ` by ${by}` : ''}`);
  if (!(await instanceRepo.remove(row.id))) throw new Error('could not move it to the record (is it locked?)');
  log.info({ instance: row.id, funnel: row.funnel_name, files, left: filesLeft.length }, 'disapproved');
  return { ok: true, files, filesLeft: filesLeft.length };
}

export default { disapprove };
