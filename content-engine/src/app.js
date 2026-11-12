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
import { bindTenant, guardRecords, guardParamId } from './middleware/tenantGuard.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import * as tenantSettings from './core/tenantSettings.js';
import * as publicPages from './utils/publicPages.js';
import * as comparePages from './utils/comparePages.js';
import { currencyOf, countryOf } from './utils/geo.js';
import * as landingDeploy from './services/landingDeployService.js';
import * as planCancel from './modules/planCancel.js';
import * as billingModule from './modules/billing.js';

import * as approvalService from './services/approvalService.js';

import * as funnelPosters from './modules/funnelPosters.js';
import * as vidapulseRefill from './modules/vidapulseRefill.js';
import * as delivery from './modules/delivery.js';
import * as videoPipeline from './modules/videoPipeline.js';
import * as imageGate from './modules/imageGate.js';
import * as instances from './modules/instances.js';
import * as capture from './modules/capture.js';
import * as firstComments from './modules/firstComments.js';
import * as leadVisits from './modules/leadVisits.js';
import * as linkedinRelay from './modules/linkedinRelay.js';
import * as videoScheduler from './modules/videoScheduler.js';
import * as dailyRouter from './modules/router.js';
import * as instanceReview from './modules/instanceReview.js';
import * as imageFactory from './modules/imageFactory.js';
import * as dashboard from './modules/dashboard.js';
import * as configUi from './modules/configUi.js';
import * as authModule from './modules/auth.js';
import * as cleanHooks from './modules/cleanHooks.js';
import * as admin from './modules/admin.js';
import * as workPages from './modules/workPages.js';
import * as agencyPages from './modules/agencyPages.js';
import * as connectPage from './modules/connectPage.js';
import * as onboardingTour from './modules/onboardingTour.js';
import * as festivalPage from './modules/festival.js';

export function createApp() {
  const app = express();
  // Railway sits one proxy hop in front; req.ip then reads the real client
  // (used to rate-limit the reset form).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(tenantResolver);
  app.use(requestLogger);
  // Keep the raw body alongside the parsed JSON so webhook signatures
  // (e.g. Meta's X-Hub-Signature-256) can be verified over the exact bytes.
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));
  app.use(express.urlencoded({ extended: true }));
  // The signed-in user's tenant wins over any header, path or ?tenant= (tenantGuard).
  app.use(bindTenant);

  // Public pages (no sign-in): the bare domain is a home page whose Sign in
  // button opens the app; /privacy and /terms are the links Google's OAuth
  // consent screen needs. The contact is the default tenant's notification email.
  const contactEmail = async () => {
    const e = (await tenantSettings.forTenant('default').catch(() => null))?.emails || {};
    return e.public || e.notify || '';
  };
  // Once the landing pages are live on Cloudflare (Tenants panel), this app
  // sends its own copies there; Sign in, /buy and the app stay here.
  const toLanding = async (req, res, next) => {
    const domain = await landingDeploy.liveDomain().catch(() => '');
    if (!domain || req.hostname === domain) return next();
    return res.redirect(302, `https://${domain}${req.originalUrl}`);
  };
  app.get(['/', '/compare', '/compare/:page', '/privacy', '/terms', '/refund', '/shipping'], toLanding);
  app.get('/', async (req, res) => res.type('html').send(publicPages.homePage({ email: await contactEmail(), cur: currencyOf(req) })));
  app.get('/compare', async (req, res) => res.type('html').send(comparePages.compareIndexPage({ email: await contactEmail(), cur: currencyOf(req) })));
  app.get('/compare/:page', async (req, res, next) => {
    const c = comparePages.competitorForPage(req.params.page);
    if (!c) return next();
    return res.type('html').send(comparePages.comparisonPage(c, { email: await contactEmail(), cur: currencyOf(req) }));
  });
  app.get('/privacy', async (_req, res) => res.type('html').send(publicPages.privacyPage({ email: await contactEmail() })));
  app.get('/terms', async (_req, res) => res.type('html').send(publicPages.termsPage({ email: await contactEmail() })));
  app.get('/refund', async (req, res) => res.type('html').send(publicPages.refundPage({ email: await contactEmail(), cur: currencyOf(req) })));
  app.get('/shipping', async (_req, res) => res.type('html').send(publicPages.shippingPage({ email: await contactEmail() })));
  // Buy a plan: Razorpay in rupees with GST (India) or US dollars (elsewhere).
  billingModule.mount(app, { log: logger, contactEmail });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: settings.service }));
  app.get('/live', (_req, res) => res.json({ status: 'alive' }));
  // Running build identity: lets a deploy be verified against the pushed commit.
  // Railway injects RAILWAY_GIT_COMMIT_SHA; fall back to a generic dev marker.
  const version = (_req, res) => res.json({
    service: settings.service,
    sha: process.env.RAILWAY_GIT_COMMIT_SHA || 'dev',
    branch: process.env.RAILWAY_GIT_BRANCH || null,
  });
  app.get('/api/version', version);
  // Which currency this visitor is shown (country only, never the IP).
  app.get('/api/geo', (req, res) => res.set('Cache-Control', 'no-store').json({ country: countryOf(req) || null, currency: currencyOf(req) }));
  app.get('/version', version);
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
  // No tenant reads or changes another tenant's funnel, instance, rule or lead.
  router.use(guardRecords);
  router.param('id', guardParamId);

  // Approval review routes are core (several modules depend on them).
  approvalService.register(router);

  const registry = createRegistry();
  const ctx = { router, log: logger, registry };

  registry
    .add({ name: 'funnel-posters', enabled: true, register: funnelPosters.register })
    .add({ name: 'vidapulse-refill', enabled: settings.modules.vidapulseRefill, register: vidapulseRefill.register })
    .add({ name: 'delivery', enabled: settings.modules.delivery, register: delivery.register })
    .add({ name: 'video-pipeline', enabled: settings.modules.videoPipeline, register: videoPipeline.register })
    .add({ name: 'image-gate', enabled: true, register: imageGate.register })
    .add({ name: 'instances', enabled: true, register: instances.register })
    .add({ name: 'capture', enabled: true, register: capture.register })
    .add({ name: 'first-comments', enabled: true, register: firstComments.register })
    .add({ name: 'lead-visits', enabled: true, register: leadVisits.register })
    .add({ name: 'linkedin-relay', enabled: true, register: linkedinRelay.register })
    .add({ name: 'video-scheduler', enabled: true, register: videoScheduler.register })
    .add({ name: 'router', enabled: true, register: dailyRouter.register })
    .add({ name: 'instance-review', enabled: true, register: instanceReview.register })
    .add({ name: 'image-factory', enabled: settings.modules.imageFactory, register: imageFactory.register })
    .add({ name: 'dashboard', enabled: settings.modules.dashboard, register: dashboard.register })
    .add({ name: 'auth', enabled: settings.modules.admin, register: authModule.register })
    .add({ name: 'clean-hooks', enabled: settings.modules.admin, register: cleanHooks.register })
    .add({ name: 'config-ui', enabled: settings.modules.admin, register: configUi.register })
    .add({ name: 'work-pages', enabled: settings.modules.admin, register: workPages.register })
    .add({ name: 'agency-pages', enabled: settings.modules.admin, register: agencyPages.register })
    .add({ name: 'plan-cancel', enabled: settings.modules.admin, register: planCancel.register })
    .add({ name: 'connect-page', enabled: settings.modules.admin, register: connectPage.register })
    .add({ name: 'onboarding-tour', enabled: settings.modules.admin, register: onboardingTour.register })
    .add({ name: 'festival', enabled: settings.modules.admin, register: festivalPage.register })
    .add({ name: 'admin', enabled: settings.modules.admin, register: admin.register });

  registry.registerAll(ctx);

  app.use('/api/v1', router);
  app.use(notFound);
  app.use(errorHandler);

  return { app, shutdown: async () => {} };
}

export default createApp;
