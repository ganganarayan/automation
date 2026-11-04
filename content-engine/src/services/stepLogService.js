/**
 * Step log writer.
 *
 * Purpose:      Note when an instance's steps start and end, and when it starts and
 *               stops waiting on an approval (utils/stepTimeSpec reads this back).
 * Responsibility: Append events to instances.step_log. It only keeps time: a failed
 *               write is logged and never stops the run it is timing.
 * Dependencies: instanceRepository, utils/stepTimeSpec, logger.
 */
import * as repo from '../repositories/instanceRepository.js';
import { stepEvent } from '../utils/stepTimeSpec.js';
import { childLogger } from '../core/logger.js';

const write = async (instanceId, events) => {
  try {
    await repo.appendStepLog(instanceId, events);
  } catch (err) {
    childLogger({ module: 'stepLog' }).warn({ err: err.message, instance: instanceId }, 'step log not written');
  }
};

export const start = (instanceId, key, extra) => write(instanceId, [stepEvent(key, 'start', extra)]);
export const end = (instanceId, key, extra) => write(instanceId, [stepEvent(key, 'end', extra)]);
export const fail = (instanceId, key, extra) => write(instanceId, [stepEvent(key, 'fail', extra)]);

/** A step that ran before the instance existed, written once it does. */
export const span = (instanceId, key, startedAt, endedAt = null) => write(instanceId, [
  stepEvent(key, 'start', { at: startedAt }),
  stepEvent(key, 'end', { at: endedAt }),
]);

export default { start, end, fail, span };
