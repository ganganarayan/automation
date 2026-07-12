/**
 * Express application assembly.
 *
 * Purpose:      Build the HTTP app: middleware order, health endpoints, the
 *               versioned API router with all enabled modules, and the error
 *               handler.
 * Responsibility:
 *               - Compose middleware in a fixed order.
 *               - Instantiate providers and the module registry.
 *               - Register enabled modules under /api/v1.
 * Dependencies: express, settings, middleware, providers, modules, core/db.
 *
 * Middleware order: requestId -> tenantResolver -> requestLogger -> body parser
 * -> routes -> notFound -> errorHandler.
 */
import express from 'express';
import { settings } from './settings/index.js';
import { logger } from './core/logger.js';
import { ping } from './core/db.js';
import { createRegistry } from './core/moduleRegistry.js';
import { requestId, tenantResolver, requestLogger } from './middleware/requestContext.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

import { createSmtpMailProvider } from './providers/mailProvider.js';
import { createGoogleSheetsProvider } from './providers/sheetsProvider.js';

import * as crmRelay from './modules/crmRelay.js';
import * as rawRelay from './modules/rawRelay.js';
import * as formBooking from './modules/formBooking.js';
import * as emotionalOutreach from './modules/emotionalOutreach.js';
import * as connectionMonitor from './modules/connectionMonitor.js';
import * as delayRelay from './modules/delayRelay.js';
import * as dispatcher from './modules/dispatcher.js';
import * as admin from './modules/admin.js';

/**
 * Build the app.
 * @returns {{ app: import('express').Express, shutdown: () => Promise<void> }}
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Correlation + tenant + logging, then body parsing.
  app.use(requestId);
  app.use(tenantResolver);
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Health endpoints (unversioned, unauthenticated).
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

  // Providers (external integrations behind interfaces).
  const providers = {
    mail: createSmtpMailProvider(settings.smtp, logger),
    sheets: createGoogleSheetsProvider(settings.google, logger),
  };

  // Shutdown hooks collected from modules that start background work.
  const shutdownHooks = [];
  const onShutdown = (fn) => shutdownHooks.push(fn);

  // Versioned API router.
  const router = express.Router();
  const registry = createRegistry();

  const ctx = { router, providers, log: logger, registry, onShutdown };

  registry
    .add({ name: 'crm-relay', enabled: settings.modules.crmRelay, register: crmRelay.register })
    .add({ name: 'raw-relay', enabled: settings.modules.rawRelay, register: rawRelay.register })
    .add({ name: 'form-booking', enabled: settings.modules.formBooking, register: formBooking.register })
    .add({ name: 'emotional-outreach', enabled: settings.modules.emotionalOutreach, register: emotionalOutreach.register })
    .add({ name: 'connection-monitor', enabled: settings.modules.connectionMonitor, register: connectionMonitor.register })
    .add({ name: 'delay-relay', enabled: settings.modules.delayRelay, register: delayRelay.register })
    .add({ name: 'dispatcher', enabled: settings.modules.dispatcher, register: dispatcher.register })
    .add({ name: 'admin', enabled: settings.modules.admin, register: admin.register });

  registry.registerAll(ctx);

  app.use('/api/v1', router);

  app.use(notFound);
  app.use(errorHandler);

  const shutdown = async () => {
    for (const fn of shutdownHooks) {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    }
  };

  return { app, shutdown };
}

export default createApp;
