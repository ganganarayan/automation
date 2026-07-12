/**
 * Module: dispatcher.
 *
 * Purpose:      Start the background throttled sender loop.
 * Responsibility: lifecycle only; the logic lives in dispatcherService.
 * Dependencies: dispatcherService.
 *
 * No routes. Registering this module starts the loop; disabling it (module
 * flag) stops the queue from draining without affecting intake.
 */
import * as dispatcher from '../services/dispatcherService.js';

export function register(ctx) {
  const stop = dispatcher.start();
  ctx.onShutdown?.(stop);
  ctx.log.info('dispatcher loop started');
}

export default { register };
