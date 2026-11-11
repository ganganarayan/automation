/**
 * Module: the onboarding tour (help bot).
 *
 * Purpose:      A new workspace lands in an app it does not know. Every admin
 *               page loads one small script that shows a Help box at the top
 *               right with a bouncing bot, says which step they are on, takes
 *               them to the right page and highlights the exact field to fill.
 * Responsibility: HTTP only. Decisions live in utils/tourSpec.js (pure, tested);
 *               the browser side is tour/tourClient.js, served as a file.
 * Dependencies: funnelsRepository, tenantConfigRepository, providerFactory
 *               (the service-account email a sheet is shared with), accessService.
 *
 * Routes: GET  /api/v1/admin/tour.js       the browser script
 *         GET  /api/v1/admin/tour/state    { stage, funnel, open, saEmail, ... }
 *         POST /api/v1/admin/tour/state    { state: 'dismissed'|'done'|'' }
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as funnels from '../repositories/funnelsRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { keyOk } from '../services/accessService.js';
import { buildProviders } from '../services/providerFactory.js';
import { pickStage, autoOpen, wizardIndex, SHEET_HEADERS, TOUR_KEY } from '../utils/tourSpec.js';

const CLIENT_JS = readFileSync(fileURLToPath(new URL('./tour/tourClient.js', import.meta.url)), 'utf8');

// The service-account email barely changes: look it up once per workspace per 10 minutes.
const saCache = new Map();
async function saEmailFor(tenantId) {
  const hit = saCache.get(tenantId);
  if (hit && hit.at > Date.now() - 10 * 60 * 1000) return hit.email;
  let email = '';
  try {
    const p = await buildProviders(tenantId);
    const g = (p.resolved && p.resolved.google) || {};
    email = (g.serviceAccount && g.serviceAccount.client_email) || '';
  } catch {
    email = '';
  }
  saCache.set(tenantId, { email, at: Date.now() });
  return email;
}

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/admin/tour.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache').send(CLIENT_JS);
  });

  router.get('/admin/tour/state', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'sign in' });
      res.set('Cache-Control', 'no-store');
      const tenantId = String(req.tenantId || 'default');
      const rows = await funnels.listByTenant(tenantId).catch(() => []);
      const list = [];
      for (const f of rows) list.push({ id: f.id, name: f.name, cfg: await funnels.getConfig(f.id).catch(() => ({})) });
      const { stage, funnel } = pickStage(list, req.query.funnel);
      const saved = (await tenantConfig.get(tenantId, TOUR_KEY).catch(() => '')) || '';
      res.json({
        ok: true,
        stage,
        funnel,
        open: autoOpen(stage, saved),
        saved,
        wizard: { basics: wizardIndex('basics'), publish: wizardIndex('publish'), image: wizardIndex('image') },
        sheetHeaders: SHEET_HEADERS,
        saEmail: stage === 'image' ? await saEmailFor(tenantId) : '',
      });
    } catch (err) {
      log.warn({ err: err.message }, 'tour state failed');
      res.status(500).json({ ok: false, error: 'tour state failed' });
    }
  });

  router.post('/admin/tour/state', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'sign in' });
      const state = String((req.body && req.body.state) || '');
      const tenantId = String(req.tenantId || 'default');
      if (state === 'dismissed' || state === 'done') await tenantConfig.set(tenantId, TOUR_KEY, state);
      else await tenantConfig.del(tenantId, TOUR_KEY);
      res.json({ ok: true });
    } catch (err) {
      log.warn({ err: err.message }, 'tour state save failed');
      res.status(500).json({ ok: false, error: 'save failed' });
    }
  });
}

export default { register };
