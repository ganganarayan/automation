/**
 * Express application assembly.
 *
 * Purpose:      Build the HTTP app: middleware order, health endpoints, provider
 *               bundle, the review routes, and the versioned API router with all
 *               enabled modules.
 * Responsibility:
 *               - Compose middleware in a fixed order.
 *               - Instantiate providers behind interfaces.
 *               - Mount the approval review routes (core to several modules).
 *               - Register enabled modules under /api/v1.
 * Dependencies: express, settings, middleware, providers, services, modules.
 */
import express from 'express';
import { settings } from './settings/index.js';
import { logger } from './core/logger.js';
import { ping } from './core/db.js';
import { createRegistry } from './core/moduleRegistry.js';
import { requestId, tenantResolver, requestLogger } from './middleware/requestContext.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

import * as approvalService from './services/approvalService.js';

import * as funnelPosters from './modules/funnelPosters.js';
import * as vidapulseRefill from './modules/vidapulseRefill.js';
import * as delivery from './modules/delivery.js';
import * as videoPipeline from './modules/videoPipeline.js';
import * as imageFactory from './modules/imageFactory.js';
import * as dashboard from './modules/dashboard.js';
import * as configUi from './modules/configUi.js';
import * as admin from './modules/admin.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(tenantResolver);
  app.use(requestLogger);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: settings.service }));
  app.get('/live', (_req, res) => res.json({ status: 'alive' }));
  app.get('/ready', async (_req, res) => {
    try {
      await ping();
      res.json({ status: 'ready' });
    } catch (err) {
      res.status(503).json({ status: 'not_ready', error: err.message });
    }
  });

  // Providers are built per-tenant on demand (see services/providerFactory.js)
  // so tenant-configured credentials take effect. Nothing is bound at boot.
  const router = express.Router();

  // Approval review routes are core (several modules depend on them).
  approvalService.register(router);

  const registry = createRegistry();
  const ctx = { router, log: logger, registry };

  registry
    .add({ name: 'funnel-posters', enabled: true, register: funnelPosters.register })
    .add({ name: 'vidapulse-refill', enabled: settings.modules.vidapulseRefill, register: vidapulseRefill.register })
    .add({ name: 'delivery', enabled: settings.modules.delivery, register: delivery.register })
    .add({ name: 'video-pipeline', enabled: settings.modules.videoPipeline, register: videoPipeline.register })
    .add({ name: 'image-factory', enabled: settings.modules.imageFactory, register: imageFactory.register })
    .add({ name: 'dashboard', enabled: settings.modules.dashboard, register: dashboard.register })
    .add({ name: 'config-ui', enabled: settings.modules.admin, register: configUi.register })
    .add({ name: 'admin', enabled: settings.modules.admin, register: admin.register });

  registry.registerAll(ctx);

  app.use('/api/v1', router);
  app.use(notFound);
  app.use(errorHandler);

  return { app, shutdown: async () => {} };
}

export default createApp;
