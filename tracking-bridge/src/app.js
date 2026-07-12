/**
 * Express application assembly.
 *
 * Purpose:      Build the HTTP app with raw-body capture (required for Razorpay
 *               signature verification), health endpoints, providers, and the
 *               versioned API router.
 * Responsibility:
 *               - Capture the raw request body while still parsing JSON.
 *               - Instantiate providers behind interfaces.
 *               - Register enabled modules under /api/v1.
 * Dependencies: express, settings, middleware, providers, modules.
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
import { createMetaProvider } from './providers/metaProvider.js';
import { createAssess360Provider } from './providers/enrichmentProvider.js';

import * as razorpayCapi from './modules/razorpayCapi.js';
import * as adInsights from './modules/adInsights.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(tenantResolver);
  app.use(requestLogger);

  // Capture the raw body (needed for HMAC signature verification) while parsing.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
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

  const providers = {
    mail: createSmtpMailProvider(settings.smtp, logger),
    sheets: createGoogleSheetsProvider(settings.google, logger),
    meta: createMetaProvider(settings.meta, logger),
    enrichment: createAssess360Provider(settings.assess360, logger),
  };

  const router = express.Router();
  const registry = createRegistry();
  const ctx = { router, providers, log: logger, registry };

  registry
    .add({ name: 'razorpay-capi', enabled: settings.modules.capi, register: razorpayCapi.register })
    .add({ name: 'ad-insights', enabled: settings.modules.insights, register: adInsights.register });

  registry.registerAll(ctx);

  app.use('/api/v1', router);
  app.use(notFound);
  app.use(errorHandler);

  return { app, shutdown: async () => {} };
}

export default createApp;
