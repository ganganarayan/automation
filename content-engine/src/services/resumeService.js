/**
 * Runs a restart cut off, carried on by themselves.
 *
 * Purpose:      A deploy or a wake from sleep starts a new server; whatever the
 *               old one was in the middle of (drawing pictures, a script, a
 *               stage) is left 'running' with nobody working on it, and used to
 *               wait 45 minutes for a Retry by hand. A few minutes after start,
 *               every such run is carried on from where it stopped, exactly as
 *               ↻ Retry would, and the pass is written on its Log and Run log.
 *               Runs waiting on GitHub Actions are left alone: they are not lost.
 * Responsibility:
 *               - resumeCutOff({ bootAt }): find and carry on the cut-off runs; returns { resumed, skipped }
 *               - scheduleResume(bootAt): run it once, RESUME_DELAY_MS after start
 * Dependencies: instanceRepository, runLogRepository, stepLogService, instanceService,
 *               aiLaneService, utils/{retrySpec,stepTimeSpec}.
 */
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as runLog from '../repositories/runLogRepository.js';
import * as stepLog from './stepLogService.js';
import * as instanceService from './instanceService.js';
import { resumeAction } from '../utils/retrySpec.js';
import { retryPasses } from '../utils/stepTimeSpec.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'resume' });

// Long enough for the old server to finish and stop (Railway overlaps the two briefly).
export const RESUME_DELAY_MS = 3 * 60 * 1000;

export async function resumeCutOff({ bootAt }) {
  const rows = await instanceRepo.runningBefore(bootAt);
  const resumed = [];
  const skipped = [];
  for (const row of rows) {
    const action = resumeAction(row, instanceService.parseSteps(row), bootAt);
    if (!action) { skipped.push(row.id); continue; }
    const pass = retryPasses(row.step_log) + 1;
    const note = `Pass ${pass}: a restart of the app stopped this run, so it carried on by itself from where it stopped (${action}).`;
    try {
      await stepLog.mark(row.id, 'retry', note);
      await runLog.write(row.id, 'retry', { detail: note, by: 'app restart' });
      const aiLane = await import('./aiLaneService.js');
      await aiLane.retry({ instanceId: row.id, action });
      resumed.push(row.id);
      log.info({ instance: row.id, action, pass }, 'run cut off by a restart carried on');
    } catch (err) {
      skipped.push(row.id);
      await stepLog.mark(row.id, 'retry-refused', `Could not carry on by itself after the restart: ${String(err.message).slice(0, 300)}. Use Retry in the Library.`).catch(() => null);
      log.warn({ instance: row.id, action, err: err.message }, 'run cut off by a restart not carried on');
    }
  }
  if (rows.length) log.info({ resumed: resumed.length, skipped: skipped.length }, 'restart check done');
  return { resumed, skipped };
}

export function scheduleResume(bootAt = new Date()) {
  setTimeout(() => {
    resumeCutOff({ bootAt }).catch((err) => log.warn({ err: err.message }, 'restart check failed'));
  }, RESUME_DELAY_MS).unref();
}

export default { RESUME_DELAY_MS, resumeCutOff, scheduleResume };
