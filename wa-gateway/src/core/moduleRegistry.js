/**
 * Plugin-style module registry.
 *
 * Purpose:      Let each feature register its routes and background jobs, gated
 *               by a settings flag, so a disabled module wires nothing.
 * Responsibility:
 *               - Collect module definitions ({ name, enabled, register }).
 *               - Invoke register(ctx) for enabled modules at boot.
 *               - Expose the enabled/disabled status for the admin endpoint.
 * Dependencies: logger.
 *
 * A module definition:
 *   { name: string, enabled: boolean, register(ctx): void }
 * where ctx = { app, router, log, ...services }.
 */
import { logger } from './logger.js';

export function createRegistry() {
  const modules = [];

  return {
    /** Add a module definition. */
    add(def) {
      modules.push(def);
      return this;
    },
    /** Register all enabled modules against the given context. */
    registerAll(ctx) {
      for (const mod of modules) {
        if (!mod.enabled) {
          logger.info({ module: mod.name }, 'module disabled; skipping registration');
          continue;
        }
        mod.register(ctx);
        logger.info({ module: mod.name }, 'module registered');
      }
    },
    /** Status list for the admin endpoint. */
    status() {
      return modules.map((m) => ({ name: m.name, enabled: !!m.enabled }));
    },
  };
}

export default { createRegistry };
