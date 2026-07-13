/**
 * Module gate middleware.
 *
 * Purpose:      Short-circuit a route when its module is disabled for the
 *               request's tenant (per-tenant module toggle).
 * Responsibility: Look up moduleEnabled(tenant, name); if disabled, respond 200
 *               with an accepted:false ack (webhooks expect a 2xx) and stop.
 * Dependencies: tenantSettings.
 *
 * The env flag remains the default, so an ungated tenant behaves exactly as
 * before. This only lets a per-tenant `false` override disable an inbound flow.
 */
import * as tenantSettings from '../core/tenantSettings.js';

/** @param {string} name - camelCase module key */
export function gate(name) {
  return async (req, res, next) => {
    try {
      if (await tenantSettings.moduleEnabled(req.tenantId, name)) return next();
      return res.status(200).json({ accepted: false, reason: 'module disabled for tenant' });
    } catch (err) {
      next(err);
    }
  };
}

export default { gate };
