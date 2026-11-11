/**
 * Module: tenant-scoped configuration UI (with Users management).
 *
 * Purpose:      Browser control panel to configure each app per tenant and to
 *               manage users, roles, and plans. Settings write to the shared
 *               tenant_config table (every service's resolver reads it).
 * Responsibility: HTTP wiring + HTML rendering; logic in configService/usersRepository.
 * Dependencies: configService, configManifest, tenantRepository, usersRepository,
 *               tenantConfigRepository, accessService.
 *
 * Users model (self-signup; auth/login added later):
 *   - Accounts are created on sign-up. The super admin (ganganarayan.rns@gmail.com)
 *     is seeded and protected.
 *   - The super admin changes each user's role (user/admin/super_admin) and plan
 *     end date (a date, or "forever") with inline auto-save, no save button.
 *   - Each user has billing history and last login. Users manage their own
 *     password in their own login (not here).
 *   - Pages need an email + password sign-in (modules/auth.js, accessService).
 *
 * Routes (guarded by sign-in):
 *   GET  /api/v1/admin/settings              the control panel
 *   POST /api/v1/admin/settings/save         apply one app's config form
 *   POST /api/v1/admin/tenants               create a tenant
 *   POST /api/v1/admin/users/role            change a user's role (JSON, auto-save)
 *   POST /api/v1/admin/users/plan            change a user's plan end (JSON, auto-save)
 *   POST /api/v1/admin/tenants/expiry        change a tenant's expiry (super admin, JSON, auto-save)
 *   GET  /api/v1/admin/users/billing         a user's billing history (JSON)
 *   GET  /api/v1/admin/wake-schedule         last GitHub wake-up sync + current times (JSON)
 *   POST /api/v1/admin/wake-schedule/sync    write WAKE_SCHEDULE to GitHub now (JSON)
 *   GET  /api/v1/admin/funnels/stock         ready videos, thumbnails and image posts per funnel (JSON)
 */
import { CONFIG_MANIFEST, APPS, fieldByKey } from '../services/configManifest.js';
import { navHtml, NAV_CSS } from '../utils/adminNav.js';
import { MUSIC_PAGE_SITES } from '../utils/shortSpec.js';
import { folderMusic } from '../services/musicFolderService.js';
import { publicDlUrl } from '../providers/publicDriveProvider.js';
import { FLOW_MANIFEST, hasFlow } from '../services/flowManifest.js';
import { WIZARD_STEPS, completeness, stepFields } from '../services/videoWizardManifest.js';
import * as imageGateService from '../services/imageGateService.js';
import * as configService from '../services/configService.js';
import * as users from '../repositories/usersRepository.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import { formatIst } from '../utils/time.js';
import { mailMissing, parseRecord, healthLines } from '../utils/emailHealth.js';
import { providerName, parseFrom } from '../utils/mailApis.js';
import * as funnels from '../repositories/funnelsRepository.js';
import * as planService from '../services/planService.js';
import { PLANS, PLAN_IDS, validTenantId } from '../utils/planSpec.js';
import { hashPassword } from '../utils/passwordSpec.js';
import { randomBytes } from 'node:crypto';
import * as tenantSettings from '../core/tenantSettings.js';
import * as tenantConfigRepo from '../repositories/tenantConfigRepository.js';
import { listOpenAiModels, listGeminiModels } from '../providers/modelsProvider.js';
import { buildCatalog } from '../utils/modelCatalog.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { buildProviders } from '../services/providerFactory.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { listElevenLabsVoices } from '../providers/ttsProvider.js';
import { settings } from '../settings/index.js';
import { listReadyVideos } from '../services/readyPostService.js';
import { parseDriveFolderId } from '../utils/readyPostSpec.js';
import { keyOk, superOk, gateState, currentSession, invalidateWorkspaces } from '../services/accessService.js';
import { AGENCY_PLAN, planChangeProblem, kindOf, accessChoices, accessRole, ROLE_LABEL } from '../utils/workspaceSpec.js';
import { sendInvite } from '../services/inviteService.js';

// How Users names each access in the Add a user picker.
const ACCESS_TEXT = { admin: 'Admin: every client', staff: 'Staff: ticked clients only', owner: 'Client owner: runs this workspace', viewer: 'Client viewer: looks only' };
import * as wakeSchedule from '../services/wakeScheduleService.js';
import * as cloudflareWake from '../services/cloudflareWakeService.js';
import { DAILY_KEY, dailyTimeOf } from '../utils/cloudflareWake.js';
import { usageBox } from '../utils/pfmUsageView.js';
import { costBox } from '../utils/costUsageView.js';
import * as usageRepo from '../repositories/usageRepository.js';
import * as instanceUsage from '../repositories/instanceRepository.js';
import { stockForTenant } from '../services/funnelStockService.js';
import { REFILL_BELOW } from '../utils/routerSpec.js';
import * as qaService from '../services/qaService.js';
import { isQaTenant } from '../utils/qaSpec.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/admin/settings', async (req, res, next) => {
    try {
      const state = await gateState(req);
      if (state !== 'ok') {
        const back = encodeURIComponent(req.originalUrl || '/api/v1/admin/settings');
        return res.redirect(state === 'change' ? `/api/v1/admin/password?next=${back}` : `/api/v1/admin/login?next=${back}`);
      }
      const tenantId = (req.query.tenant || req.tenantId || 'default').toString();
      const session0 = await currentSession(req);
      const [configMap, userList, funnelList, session] = await Promise.all([
        configService.load(tenantId).catch(() => ({})),
        users.list({ tenantId: (session0 && session0.role === 'super_admin') ? null : tenantId }).catch(() => []),
        funnels.listByTenant(tenantId).catch(() => []),
        currentSession(req),
      ]);
      const funnelConfigs = {};
      for (const f of funnelList) funnelConfigs[f.id] = await funnels.getConfig(f.id).catch(() => ({}));
      const superAdmin = !!(session && session.role === 'super_admin');
      const tenantList = superAdmin ? await tenantRepo.listWithSubscription().catch(() => []) : [];
      const postUsage = superAdmin ? await instanceUsage.postUsage({ months: 3 }).catch(() => null) : null;
      // Who posts on a Post for Me key of its own (so is not on the owner's bill).
      const ownKeyIds = [];
      const keyOwners = {};
      const keyHistories = {};
      if (superAdmin) {
        for (const t of tenantList) {
          const r = await tenantSettings.forTenant(t.id).catch(() => null);
          if (r && r.postformeKey && !r.postformeShared) ownKeyIds.push(String(t.id));
          if (r) keyOwners[String(t.id)] = { ...r.keyOwners };
          if (r) keyHistories[String(t.id)] = r.keyHistory || [];
        }
      }
      const aiCosts = superAdmin ? await usageRepo.monthCosts({ months: 3 }).catch(() => null) : null;
      res.type('html').send(
        page({ tenantId, configMap, userList, funnelList, funnelConfigs, me: session ? session.email : '', session, key: '', kind: kindOf(await tenantRepo.findById(tenantId).catch(() => null)), myRole: superAdmin ? 'admin' : (req.workspaceRole || 'admin'), saved: req.query.saved, superAdmin, tenantList, postUsage, ownKeyIds, aiCosts, keyOwners, keyHistories }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/settings/save', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) {
        // The sign-in lookup could not reach the database: not a sign-out.
        if (req._sessionError) return res.status(503).json({ error: 'database unavailable, nothing saved; try again' });
        // The page's own save (fetch) keeps the typed entries and shows a note.
        if (req.get('X-Save-Fetch')) return res.status(401).json({ error: 'unauthorized' });
        // A plain browser form (signed out in another tab, or the sign-in ended): send
        // them to sign in and back to Settings instead of a bare JSON error.
        if (!req.is('application/json')) {
          const back = encodeURIComponent(`/api/v1/admin/settings?error=${encodeURIComponent('You were signed out, so nothing was saved. Sign in and save again.')}`);
          return res.redirect(303, `/api/v1/admin/login?next=${back}`);
        }
        return res.status(401).json({ error: 'unauthorized' });
      }
      const body = req.body || {};
      const tenantId = (body.tenant || req.tenantId || 'default').toString();
      const submitted = { settings: body.set || {}, modules: body.mod || {} };
      const before = await configService.load(tenantId).catch(() => ({}));
      const result = await configService.save(tenantId, body.app, submitted);
      const q = new URLSearchParams({ tenant: tenantId });
      if (result.errors.length) q.set('error', result.errors.join('; '));
      else q.set('saved', body.app);
      // A changed Daily time moves the Cloudflare waker's time for this tenant too.
      if (!result.errors.length && body.app === 'content-engine') {
        const after = await configService.load(tenantId).catch(() => ({}));
        if (String(before.daily_time ?? '') !== String(after.daily_time ?? '')) {
          await cloudflareWake.syncTimes().catch((err) => log.warn({ err: err.message }, 'daily time not synced to Cloudflare (the next daily run syncs it)'));
        }
      }
      res.redirect(`/api/v1/admin/settings?${q.toString()}#${body.app}`);
    } catch (err) {
      next(err);
    }
  });

  // --- Funnels (multi-account content scope) ---
  // Absolute redirect target (relative paths resolve against the POST route,
  // which produced a /admin/funnels/settings 404).
  const backToFunnels = (body, req) =>
    `/api/v1/admin/settings?${new URLSearchParams({ tenant: body.tenant || (req && req.tenantId) || 'default' })}#funnels`;

  // Asked for by the page once the Funnels panel opens: it reads Drive and the sheets.
  router.get('/admin/funnels/stock', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      res.json({ ok: true, funnels: await stockForTenant((req.query.tenant || req.tenantId || 'default').toString()) });
    } catch (err) {
      next(err);
    }
  });

  // The audio files of a music folder with their .txt credits, for ▶ Play.
  router.get('/admin/settings/music-folder', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const files = await folderMusic(String(req.query.link || ''));
      res.json({ ok: true, files });
    } catch (err) {
      res.json({ ok: false, error: String(err.message).slice(0, 200) });
    }
  });

  // ▶ Play for a Drive file: browsers will not play Drive's download link
  // directly, so the app passes the song through. Drive file ids only.
  router.get('/admin/settings/music-file', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).end();
      const id = String(req.query.id || '');
      if (!/^[\w-]{10,100}$/.test(id)) return res.status(400).end();
      const up = await fetch(publicDlUrl(id), { headers: { 'User-Agent': 'Mozilla/5.0 (content-engine)' } });
      const type = up.headers.get('content-type') || '';
      if (!up.ok || /text\/html|json/i.test(type)) return res.status(404).end();
      const buf = Buffer.from(await up.arrayBuffer());
      if (buf.length > 40 * 1024 * 1024) return res.status(413).end();
      res.set({ 'Content-Type': /^audio\//i.test(type) ? type : 'audio/mpeg', 'Cache-Control': 'private, max-age=600' });
      res.send(buf);
    } catch (err) {
      res.status(502).end();
    }
  });

  router.post('/admin/funnels', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      const name = (body.name || '').toString().trim();
      const ft = (body.tenant || req.tenantId || 'default').toString();
      if (name) {
        const why = await planService.limitReason(ft, 'funnels', { used: await funnels.countByTenant(ft) });
        if (why) return res.redirect(`${backToFunnels(body, req).replace('#funnels', '')}&error=${encodeURIComponent(why)}#funnels`);
        await funnels.create({ tenantId: ft, name });
      }
      res.redirect(backToFunnels(body, req));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/funnels/config', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      const id = Number(body.funnel_id);
      const funnel = await funnels.get(id);
      if (funnel) {
        const set = body.set || {};
        const tooMany = await channelsReason(funnel.tenant_id, set.postforme_accounts);
        if (tooMany) return res.redirect(`${backToFunnels(body, req).replace('#funnels', '')}&error=${encodeURIComponent(tooMany)}#funnels`);
        for (const field of funnels.FUNNEL_FIELDS) {
          if (!(field.key in set)) continue;
          let val = String(set[field.key] ?? '');
        // A pasted Drive folder link is stored as its folder ID.
        if (field.driveFolder) val = parseDriveFolderId(val) || val;
          if (field.type === 'secret') {
            if (val.trim() !== '') await funnels.setConfig(id, field.key, val);
          } else if (val.trim() === '') {
            await funnels.delConfig(id, field.key);
          } else {
            await funnels.setConfig(id, field.key, val.trim());
          }
        }
      }
      res.redirect(backToFunnels(body, req));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/funnels/active', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      await funnels.setActive(Number(body.funnel_id), body.active === 'true');
      res.redirect(backToFunnels(body, req));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/funnels/remove', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      await funnels.remove(Number(body.funnel_id));
      res.redirect(backToFunnels(body, req));
    } catch (err) {
      next(err);
    }
  });

  // Pull the connected social accounts from Post for Me so the funnel's account
  // IDs can be picked with checkboxes instead of hand-typed JSON. Uses the key
  // typed in the box if present, else the funnel's saved key. Returns JSON.
  // Ask the provider which models the saved key can actually call, cache the
  // short list, and let the settings dropdowns offer it (no hand-typed models).
  router.post('/admin/settings/models/refresh', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const provider = String(req.body?.provider || '').toLowerCase();
      const tenantId = req.tenantId;
      const t = await tenantSettings.forTenant(tenantId);
      let cat = {};
      try { cat = JSON.parse((await tenantConfigRepo.get(tenantId, 'models_catalog')) || '{}') || {}; } catch { cat = {}; }

      if (provider === 'openai') {
        const fresh = buildCatalog({ openaiIds: await listOpenAiModels(t.openai.apiKey, log) });
        cat.openai_image = fresh.openai_image; cat.openai_text = fresh.openai_text;
      } else if (provider === 'gemini') {
        const fresh = buildCatalog({ geminiModels: await listGeminiModels(t.gemini.apiKey, log) });
        cat.gemini_image = fresh.gemini_image; cat.gemini_text = fresh.gemini_text;
      } else {
        return res.status(400).json({ ok: false, error: 'unknown provider' });
      }
      cat.refreshedAt = new Date().toISOString();
      await tenantConfigRepo.set(tenantId, 'models_catalog', JSON.stringify(cat));
      tenantSettings.invalidate(tenantId);
      res.json({ ok: true, image: (cat[provider + '_image'] || []).length, text: (cat[provider + '_text'] || []).length });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/funnels/fetch-accounts', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const typed = (req.body?.api_key || '').toString().trim();
      // The Post for Me key is central (Keys and credit), else the owner's shared one.
      const t = typed
        ? await tenantSettings.postformeFor(req.tenantId, { postforme_api_key: typed })
        : await tenantSettings.forTenant(req.tenantId).then((r) => ({ key: r.postformeKey, scope: r.postformeScope }));
      if (!t.key) return res.json({ ok: false, error: 'No Post for Me API key, set it once under Keys and credit, then come back and Fetch.' });
      const provider = createPostForMeProvider({ apiKey: t.key, scope: t.scope }, log);
      const data = await provider.listAccounts();
      return res.json({ ok: true, accounts: normalizeAccounts(data), shared: !!t.scope && !t.scope.owner });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  });

  // A link that connects a social account to this workspace. On the owner's
  // shared Post for Me key it carries this tenant's external_id, so the account
  // shows up for this tenant only.
  router.post('/admin/funnels/connect-url', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const platform = String(req.body?.platform || '').trim().toLowerCase();
      if (!PFM_PLATFORMS.includes(platform)) return res.json({ ok: false, error: 'Pick a platform' });
      const t = await tenantSettings.forTenant(req.tenantId);
      if (!t.postformeKey) return res.json({ ok: false, error: 'No Post for Me key yet. The owner sets the shared one, or set your own under Keys and credit.' });
      const provider = createPostForMeProvider({ apiKey: t.postformeKey, scope: t.postformeScope }, log);
      const out = await provider.authUrl({ platform });
      return res.json({ ok: true, url: out.url });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  });

  // The ElevenLabs voices on the central key, for the wizard's Voice picker.
  // The key stays server-side; only id / name / category reach the browser.
  router.get('/admin/tts/voices', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const t = await tenantSettings.forTenant(req.tenantId);
      const apiKey = (t.tts && t.tts.elevenlabsApiKey) || '';
      if (!apiKey) return res.json({ ok: false, missingKey: true, error: 'No ElevenLabs API key. Set it once under Keys and credit, then reload this step.' });
      return res.json({ ok: true, voices: await listElevenLabsVoices(apiKey) });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  });

  // --- Video setup wizard (step-by-step; replaces the flat funnel form) ---
  router.get('/admin/funnels/:id/setup', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.redirect(`/api/v1/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      const id = Number(req.params.id);
      const funnel = await funnels.get(id);
      if (!funnel) return res.redirect('/api/v1/admin/settings#funnels');
      const cfg = await funnels.getConfig(id).catch(() => ({}));
      let stepIndex = Number(req.query.step);
      if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= WIZARD_STEPS.length) stepIndex = 0;
      res.type('html').send(wizardPage({ funnel, cfg, stepIndex, complete: completeness(cfg) }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/funnels/:id/setup/save', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      const funnel = await funnels.get(id);
      if (!funnel) return res.status(404).json({ ok: false, error: 'funnel not found' });
      const stepIndex = Number(req.body?.step);
      const step = WIZARD_STEPS[stepIndex];
      if (!step) return res.status(400).json({ ok: false, error: 'bad step' });
      const set = req.body?.set || {};
      const tooMany = await channelsReason(funnel.tenant_id, set.postforme_accounts);
      if (tooMany) return res.status(400).json({ ok: false, error: tooMany });
      // The funnel name lives on the funnels row, not funnel_config: rename first
      // so a clash or empty name is refused before anything else is saved.
      let newName = null;
      for (const field of stepFields(step)) {
        if (field.funnelName && field.key in set) newName = (await funnels.rename(id, set[field.key])).name;
      }
      for (const field of stepFields(step)) {
        if (!(field.key in set) || field.funnelName) continue;
        const val = String(set[field.key] ?? '');
        if (field.type === 'secret') {
          if (val.trim() !== '') await funnels.setConfig(id, field.key, val);
        } else if (val.trim() === '') {
          await funnels.delConfig(id, field.key);
        } else {
          await funnels.setConfig(id, field.key, val.trim());
        }
      }
      const cfg = await funnels.getConfig(id).catch(() => ({}));
      res.json({ ok: true, complete: completeness(cfg), name: newName });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Lane 1 page: the unposted videos in the ready folder (the one typed on the
  // page, else the saved one), for "Prepare selected" on the Prepare page.
  router.post('/admin/funnels/:id/ready-videos', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      const funnel = await funnels.get(id);
      if (!funnel) return res.status(404).json({ ok: false, error: 'funnel not found' });
      const folder = parseDriveFolderId(req.body?.folder || '');
      const r = await listReadyVideos({ tenantId: req.tenantId, funnelId: id, folder });
      const drafts = r.drafts || {};
      res.json({
        ok: true,
        folder: r.folder || '',
        listError: r.listError || '',
        saEmail: r.saEmail || '',
        videos: (r.videos || []).map((v) => ({
          id: v.id, name: v.name, created: v.createdTime ? formatIst(v.createdTime) : '', started: !!drafts[v.id],
        })),
      });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // Generate a small test batch of stills for a funnel and email the review.
  router.post('/admin/funnels/:id/image-gate/test', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      try {
        await imageGateService.precheck({ tenantId: req.tenantId, funnelId: id });
      } catch (e) {
        return res.json({ ok: false, error: e.message });
      }
      const topic = (req.body?.topic || '').toString();
      const count = Number(req.body?.count) || 2;
      imageGateService
        .generateForFunnel({ tenantId: req.tenantId, funnelId: id, topic, count })
        .catch((e) => log.error({ err: e.message, funnel: id }, 'image gate test failed'));
      res.json({ ok: true, message: 'Generating: you’ll get a review email shortly.' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // --- Users: inline auto-save (JSON) ---
  router.post('/admin/users/role', async (req, res, next) => {
    try {
      if (!(await superOk(req))) return res.status(403).json({ error: 'only the owner can change roles' });
      await users.setRole(req.body.email, req.body.role);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // A workspace admin (or the super admin) adds a user to the workspace, within
  // the plan's users limit. The new user gets a one-time password, shown once.
  router.post('/admin/users/add', async (req, res) => {
    try {
      const session = await currentSession(req);
      const isSuper = await superOk(req);
      if (!isSuper && !(session && session.role === 'admin' && !session.mustChange)) return res.status(403).json({ ok: false, error: 'only a workspace admin who has set their own password can add users' });
      // The super admin adds to the workspace the page shows (?tenant= is not
      // in the request's tenant); anyone else always adds to their own.
      let tenantId = String(req.tenantId || 'default');
      if (isSuper && req.body?.tenant) {
        const asked = String(req.body.tenant).trim();
        if (!(await tenantRepo.findById(asked))) throw new Error('No such workspace');
        tenantId = asked;
      }
      const email = String(req.body?.email || '').trim().toLowerCase();
      // An agency or client workspace adds people with an access (admin, staff,
      // owner, viewer); they all sign in, so their user role is admin.
      const kind = kindOf(await tenantRepo.findById(tenantId));
      const access = accessRole(kind, isSuper ? 'admin' : (req.workspaceRole || 'admin'), req.body?.access);
      if (!access) return res.status(403).json({ ok: false, error: 'You cannot give that access here.' });
      const role = kind !== 'standalone' ? 'admin' : (req.body?.role === 'admin' ? 'admin' : 'user');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That email is not valid');
      if (await users.findByEmail(email)) throw new Error('That email already has an account');
      const why = await planService.limitReason(tenantId, 'users', { used: await users.countForTenant(tenantId) });
      if (why) return res.status(402).json({ ok: false, error: why });
      const tempPassword = randomBytes(9).toString('base64url');
      await users.createForTenant({ email, tenantId, role, passwordHash: await hashPassword(tempPassword), tenantRole: access });
      invalidateWorkspaces(email);
      const invite = kind !== 'standalone' ? await sendInvite({ tenantId, email, tempPassword, access }) : { sent: false, error: '' };
      res.json({ ok: true, email, role, access: kind !== 'standalone' ? (ROLE_LABEL[access] || access) : '', tenant: tenantId, tempPassword, emailed: invite.sent, emailError: invite.error || '' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/users/plan', async (req, res, next) => {
    try {
      if (!(await superOk(req))) return res.status(403).json({ error: 'only the owner can change plans' });
      const forever = req.body.forever === true || req.body.forever === 'true';
      const endsAt = forever || !req.body.date ? null : new Date(req.body.date);
      await users.setPlanEnd(req.body.email, endsAt);
      res.json({ ok: true, endsAt });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Super admin only: change a tenant's plan (limits in utils/planSpec).
  router.post('/admin/tenants/plan', async (req, res) => {
    try {
      if (!(await superOk(req))) return res.status(403).json({ ok: false, error: 'super admin only' });
      const plan = String(req.body?.plan || '');
      if (!PLAN_IDS.includes(plan)) throw new Error('pick a plan');
      const tenant = String(req.body?.tenant || '');
      const row = await tenantRepo.findById(tenant);
      const why = planChangeProblem({ tenant: row, plan, clients: row ? await tenantRepo.countChildren(tenant) : 0 });
      if (why) throw new Error(why);
      await tenantRepo.setPlan(tenant, plan);
      planService.invalidate(tenant);
      tenantSettings.invalidate();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Super admin only: a new tenant, its owner (an admin who must choose a
  // password at first sign-in) and a one-time password shown once.
  router.post('/admin/tenants/new', async (req, res) => {
    try {
      if (!(await superOk(req))) return res.status(403).json({ ok: false, error: 'super admin only' });
      const b = req.body || {};
      const id = String(b.id || '').trim().toLowerCase();
      const email = String(b.owner_email || '').trim().toLowerCase();
      let plan = PLAN_IDS.includes(String(b.plan)) ? String(b.plan) : 'starter';
      let months = Math.max(0, Math.min(36, Number(b.months) || 0));
      if (!validTenantId(id)) throw new Error('Workspace id: 2 to 31 lower-case letters, digits or dashes');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Owner email is not valid');
      if (await users.findByEmail(email)) throw new Error('That email already has an account');
      // A client of an agency: on the agency's plan, ending with the agency (no expiry of its own).
      const parentId = String(b.parent || '').trim();
      if (parentId) {
        const why = await planService.clientReason(parentId);
        if (why) throw new Error(why);
        plan = AGENCY_PLAN;
        months = 0;
      }
      let expiresAt = null;
      if (months) { expiresAt = new Date(); expiresAt.setUTCMonth(expiresAt.getUTCMonth() + months); }
      const tenant = await tenantRepo.createNew({ id, name: String(b.name || id).trim().slice(0, 80), ownerEmail: email, phone: String(b.phone || '').trim().slice(0, 30), plan, expiresAt, parentId: parentId || null });
      const tempPassword = randomBytes(9).toString('base64url');
      await users.createForTenant({ email, tenantId: tenant.id, role: 'admin', passwordHash: await hashPassword(tempPassword) });
      tenantSettings.invalidate();
      planService.invalidate();
      invalidateWorkspaces();
      res.json({ ok: true, tenant: tenant.id, email, tempPassword, expires: expiresAt ? formatIst(expiresAt, { withTime: false }) : '' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Super admin only: a qa-* workspace with no sign-in, for the QA check.
  router.post('/admin/qa/tenant', async (req, res) => {
    try {
      if (!(await superOk(req))) return res.status(403).json({ ok: false, error: 'super admin only' });
      const t = await qaService.createQaTenant({ id: req.body?.id, plan: req.body?.plan });
      res.json({ ok: true, tenant: t.id, plan: t.plan });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Super admin only: run the QA check on a qa-* workspace (paid = a few cents of real calls).
  router.post('/admin/qa/run', async (req, res) => {
    try {
      if (!(await superOk(req))) return res.status(403).json({ ok: false, error: 'super admin only' });
      const tenant = String(req.body?.qa || '');
      const report = await qaService.run(tenant, { paid: req.body?.paid === true || req.body?.paid === 'true' });
      log.info({ tenant, verdict: report.verdict, spentUsd: report.spentUsd }, 'qa check');
      res.json({ ok: true, ...report });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Super admin only: extend (or clear) a tenant's expiry; saves on change.
  router.post('/admin/tenants/expiry', async (req, res) => {
    try {
      const session = await currentSession(req);
      if (!session || session.role !== 'super_admin') return res.status(403).json({ ok: false, error: 'super admin only' });
      const date = String(req.body?.date || '');
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('pick a valid date');
      // The end of that day in IST, so "expires 30-11-2026" covers all of the 30th.
      const expiresAt = date ? new Date(`${date}T23:59:59+05:30`) : null;
      await tenantRepo.setExpiry(String(req.body?.tenant || ''), expiresAt);
      planService.invalidate(String(req.body?.tenant || ''));
      res.json({ ok: true, expires: expiresAt ? formatIst(expiresAt, { withTime: false }) : '' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Send a test email using the tenant's saved SMTP settings.
  router.post('/admin/test-email', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const providers = await buildProviders(req.tenantId);
      const smtp = providers.resolved.smtp || {};
      const mail = { ...providers.resolved.mail, smtp };
      const to = (req.body?.to || (mail.provider === 'gmail' ? mail.gmailEmail : '') || parseFrom(mail.from).email || smtp.user || '').trim();
      const missing = mailMissing(mail);
      if (missing.length) return res.json({ ok: false, error: `${providerName(mail.provider)} not configured: set ${missing.join(', ')} and Save first` });
      if (!to) return res.json({ ok: false, error: 'no recipient (set a From/user address)' });
      const result = await providers.mail.send({
        to,
        subject: 'Test email: automation content-engine',
        text: 'This is a test from your content-engine email settings. If you received this, approval and status emails will work.',
      });
      res.json({ ok: !!result.ok, to, error: result.ok ? null : (result.error || 'send failed') });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // Settings → Email health: SMTP complete?, last send and last error.
  router.get('/admin/email-health', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const providers = await buildProviders(req.tenantId);
      const [last, lastError] = await Promise.all([
        tenantConfig.get(req.tenantId, 'email_last_send'),
        tenantConfig.get(req.tenantId, 'email_last_error'),
      ]);
      res.json({ ok: true, lines: healthLines({ mail: { ...providers.resolved.mail, smtp: providers.resolved.smtp }, last: parseRecord(last), lastError: parseRecord(lastError), fmt: formatIst }) });
    } catch (err) {
      res.json({ ok: false, lines: [{ dot: '🟡', text: err.message }] });
    }
  });

  // Settings → Daily schedule: is the waker on, and this tenant's last daily run.
  router.get('/admin/wake-timer', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const tenantId = req.tenantId || 'default';
      const st = await cloudflareWake.status();
      const me = st.tenants.find((t) => String(t.id) === String(tenantId)) || {};
      const cfg = await configService.load(tenantId).catch(() => ({}));
      res.json({ ok: st.ok, time: dailyTimeOf(cfg[DAILY_KEY]), last: me.last || '' });
    } catch (err) {
      res.json({ ok: false, text: `🟡 ${err.message}` });
    }
  });

  // Owner only: the Cloudflare waker (Tenants panel).
  const ownerOnly = async (req, res) => {
    const session = await currentSession(req).catch(() => null);
    if (session && session.role === 'super_admin') return true;
    res.status(403).json({ ok: false, error: 'super admin only' });
    return false;
  };
  router.get('/admin/cloudflare-wake', async (req, res) => {
    try {
      if (!(await ownerOnly(req, res))) return;
      res.json(await cloudflareWake.status());
    } catch (err) {
      res.status(400).json({ ok: false, text: `🔴 ${err.message}` });
    }
  });
  router.post('/admin/cloudflare-wake/credentials', async (req, res) => {
    try {
      if (!(await ownerOnly(req, res))) return;
      res.json(await cloudflareWake.saveCredentials({ account: req.body?.account, token: req.body?.token }));
    } catch (err) {
      res.status(400).json({ ok: false, text: `🔴 ${err.message}` });
    }
  });
  router.post('/admin/cloudflare-wake/deploy', async (req, res) => {
    try {
      if (!(await ownerOnly(req, res))) return;
      res.json(await cloudflareWake.deploy());
    } catch (err) {
      res.status(400).json({ ok: false, text: `🔴 ${err.message}` });
    }
  });

  // GitHub wake-up times (old: the Cloudflare waker replaced them; kept for the manual workflow).
  router.get('/admin/wake-schedule', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      res.json(await wakeSchedule.status());
    } catch (err) {
      res.json({ ok: false, text: `🟡 ${err.message}` });
    }
  });

  router.post('/admin/wake-schedule/sync', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      res.json(await wakeSchedule.sync());
    } catch (err) {
      res.json({ ok: false, text: `🟡 ${err.message}` });
    }
  });

  router.get('/admin/users/billing', async (req, res, next) => {
    try {
      if (!(await superOk(req))) return res.status(403).json({ error: 'only the owner can see billing' });
      res.json({ rows: await users.billingFor(req.query.email) });
    } catch (err) {
      next(err);
    }
  });

  log.info('config UI routes registered');
}

// ---- rendering -------------------------------------------------------------

/**
 * Keys and credit → AI video credit: a live check of what the daily router's
 * Lane 2 needs (video providers in the first active funnel's order, ElevenLabs,
 * image API, LLM, GitHub assembly). Filled by GET /api/v1/admin/credit-status.
 */
/**
 * One or two lines on top of Keys and credit: what is left on every key that
 * is set. Live for Kling, Runway and ElevenLabs; for OpenAI, Claude and
 * MiniMax, click the name and type what its dashboard shows after a top-up,
 * and the strip counts down from it with what the app spends there.
 */
function balanceStrip() {
  return `<div id="balstrip" class="hint" style="margin:0 0 .8rem;padding:.5rem .7rem;border:1px solid #2a2a3a;border-radius:8px;line-height:1.7">Reading balances…</div>
    <script>
      async function setBal(key,name){
        const v=prompt(name+': balance now, in USD, as its billing page shows it (e.g. 20)');
        if(v===null)return;
        const r=await fetch('/api/v1/admin/credit/balance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,usd:Number(String(v).replace(/[^0-9.]/g,''))})}).then((x)=>x.json()).catch(()=>({ok:false}));
        if(!r.ok)alert(r.error||'Not saved, try again');
        loadBal();
      }
      async function loadBal(){
        const box=document.getElementById('balstrip');
        const e=(t)=>String(t==null?'':t).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        try{
          const j=await (await fetch('/api/v1/admin/credit/balances',{cache:'no-store'})).json();
          if(!j.ok){box.textContent='🟡 Balances not readable just now: '+(j.error||'no reply');return;}
          if(!j.items.length){box.textContent='No keys set yet.';return;}
          const dot={ok:'🟢',low:'🟡',out:'🔴',unknown:'⚪'};
          box.innerHTML='<b>Balance</b> · '+j.items.map((i)=>{
            const nm=i.set?'<a href="#" title="'+e(i.since?'Typed '+i.since+'; click after a top-up':'Click and type its balance')+'" onclick="setBal(\\''+e(i.key)+'\\',\\''+e(i.name)+'\\');return false">'+e(i.name)+'</a>':e(i.name);
            return (dot[i.tone]||'⚪')+' '+nm+' '+e(i.text);
          }).join(' &nbsp;·&nbsp; ');
        }catch(err){box.textContent='🟡 Balances not readable just now ('+err.message+')';}
      }
      loadBal();
    </script>`;
}

function creditPanel() {
  return `<fieldset><legend>AI video credit (daily router, Lane 2)</legend>
    <p class="hint" style="margin:0 0 .4rem">What the daily router's AI videos can use right now. Runway, Kling and ElevenLabs balances are read live, so a top-up shows when you press Check again. Hailuo, OpenAI and Gemini don't show a balance: they are used until one says "out of credit", then rest for the day. After topping one of those up, press I topped up.</p>
    <div id="creditbox" class="hint">Checking…</div>
    <p style="margin:.5rem 0 0"><button type="button" class="act" onclick="loadCredit()">Check again</button></p>
    <script>
      async function clearCredit(key){
        await fetch('/api/v1/admin/credit/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})}).catch(()=>{});
        loadCredit();
      }
      async function loadCredit(){
        const box=document.getElementById('creditbox');
        box.textContent='Checking…';
        try{
          const j=await (await fetch('/api/v1/admin/credit-status',{cache:'no-store'})).json();
          if(!j.ok||!j.view){box.textContent='🟡 Could not check just now: '+(j.error||'no reply')+'. Press Check again.';return;}
          const v=j.view;
          const dot={ok:'🟢',todo:'🟡',off:'⚪'};
          const e=(t)=>String(t==null?'':t).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
          let h='<p>'+(v.ready?'🟢 ':'🟡 ')+e(v.headline)+(j.funnel?' <span class="hint">(checked for '+e(j.funnel)+')</span>':'')+'</p><table><tbody>';
          for(const r of v.rows){
            const btn=r.clear?' <button type="button" class="act" onclick="clearCredit(\\''+e(r.clear)+'\\')">I topped up</button>':'';
            h+='<tr><td>'+(dot[r.tone]||'⚪')+' '+e(r.name)+'</td><td>'+e(r.text)+btn+'</td></tr>';
          }
          box.innerHTML=h+'</tbody></table>';
        }catch(err){box.textContent='🟡 Could not check just now ('+err.message+'). Press Check again.';}
      }
      loadCredit();
    </script>
  </fieldset>`;
}

function page({ tenantId, configMap, userList, funnelList, funnelConfigs, me, session = null, key, saved, kind = 'standalone', myRole = 'admin', superAdmin = false, tenantList = [], postUsage = null, ownKeyIds = [], aiCosts = null, keyOwners = {}, keyHistories = {} }) {
  const menu = navHtml({ key, tabs: true, superAdmin, session });

  // Said once, on the two panels with plain config fields (not under every panel).
  const fallbackHint = '<p class="hint">Blank config fields fall back to a platform default where one exists. Secrets are never shown, leave blank to keep the current value. Changes apply within ~1 minute.</p>';
  // tracking-bridge is no longer a menu entry; it is reached from Settings.
  const extras = {
    'api-keys': `${fallbackHint}${creditPanel()}`,
    'content-engine': `${fallbackHint}
      <fieldset><legend>More</legend>
        <p class="hint" style="margin:0"><a href="#tracking-bridge" onclick="show('tracking-bridge');return false">Tracking bridge →</a> Razorpay → Meta CAPI purchases and daily ad insights.</p>
      </fieldset>`,
  };
  // Keys are an admin's: staff and a client's own people never see the panel.
  const appSections = APPS
    .filter((a) => myRole === 'admin' || a !== 'api-keys')
    .map((a) => (hasFlow(a) ? flowSection(a, tenantId, configMap, key, extras[a]) : appSection(a, tenantId, configMap, key, extras[a])))
    .join('');

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>automation: control panel</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .layout{display:flex;min-height:100vh}
 aside{width:220px;flex:0 0 220px;background:#12121b;border-right:1px solid #24243a;padding:1rem .6rem;position:sticky;top:0;height:100vh;overflow:auto}
 aside .brand{font-weight:700;padding:.4rem .6rem 1rem;font-size:1.05rem}
 .nav{display:block;width:100%;text-align:left;background:none;border:0;color:#c7c7d9;padding:.6rem .7rem;border-radius:8px;font-size:.92rem;cursor:pointer;margin-bottom:.15rem}
 .nav:hover{background:#1c1c2a}.nav.active{background:#2a2a44;color:#fff}
${NAV_CSS}
 aside .dash{display:block;margin-top:1rem;color:#7aa2ff;text-decoration:none;font-size:.85rem;padding:.4rem .7rem;border-top:1px solid #24243a}
 main{flex:1;padding:1.3rem;max-width:960px}
 header.top{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem}
 select,input,textarea{background:#0b0b12;color:#fff;border:1px solid #333;border-radius:8px;padding:.5rem}
 textarea{width:100%;min-height:4.5rem;font-family:ui-monospace,monospace;font-size:.82rem}
 .panel{display:none}.panel.active{display:block}
 section.card{background:#12121b;border:1px solid #24243a;border-radius:12px;padding:1.2rem;margin-bottom:1.3rem}
 h2{margin:0 0 .2rem}.blurb{color:#8a8aa2;font-size:.85rem;margin:0 0 1rem}
 fieldset{border:1px solid #24243a;border-radius:10px;margin:0 0 1rem;padding:.8rem 1rem}
 legend{color:#9a9ab0;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;padding:0 .4rem}
 label{display:block;margin:.6rem 0 .2rem;font-size:.85rem;color:#c7c7d9}
 .field input,.field select{width:100%}
 .mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:.6rem}
 .mod{display:flex;justify-content:space-between;align-items:center;gap:.5rem;background:#15151f;border:1px solid #24243a;border-radius:8px;padding:.5rem .7rem}
 .mod span{font-size:.85rem}
 .save{margin-top:.5rem;background:#0a7d32;color:#fff;border:0;border-radius:8px;padding:.6rem 1.3rem;font-size:.95rem;cursor:pointer}
 button.act{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.45rem .9rem;cursor:pointer}
 table{width:100%;border-collapse:collapse;font-size:.88rem}
 th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #24243a;vertical-align:middle}
 .flash{background:#123b1f;border:1px solid #1f6b38;color:#8ff0b0;padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.9rem}
 .err{background:#3b1212;border:1px solid #6b1f1f;color:#ff9a9a}
 .warn{background:#3a2f12;border:1px solid #7a5a1f;color:#f0d68f;padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.85rem}
 .pill{font-size:.72rem;padding:.1rem .5rem;border-radius:999px;border:1px solid #24243a;color:#c7c7d9}
 .hint{color:#6f6f88;font-size:.78rem;margin:.2rem 0 0}
 .row{display:flex;gap:.5rem;align-items:end;flex-wrap:wrap}
 .saveflag{font-size:.72rem;color:#5bd08a;margin-left:.4rem;opacity:0;transition:opacity .2s}
 .saveflag.show{opacity:1}
 .planwrap{display:flex;gap:.5rem;align-items:center}
 .billing{background:#0d0d16;border:1px solid #24243a;border-radius:8px;padding:.5rem .7rem;margin:.3rem 0}
 a{color:#7aa2ff}
 a.act{display:inline-flex;align-items:center;text-decoration:none;background:#2a2a44;color:#fff;border-radius:8px;padding:.45rem .9rem}
 .act.primary{background:#2d6cdf;color:#fff}
 .act.danger{background:#5a1d1d;color:#fff}
 .funnellist{display:flex;flex-direction:column;gap:.6rem}
 .funnelrow{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;background:#15151f;border:1px solid #24243a;border-radius:10px;padding:.8rem 1rem}
 .funnelrow-name{font-weight:600}
 .funnelrow-meta{font-size:.8rem;color:#8a8aa2;margin-top:.15rem}
 .funnelrow-main{flex:1 1 11rem}
 .funnelrow-acts{min-width:16.5rem;justify-content:flex-end}
 .stockcols{display:flex;gap:1.25rem}
 .stockcell{width:6.25rem}
 .stocklabel{font-size:.75rem;color:#8a8aa2}
 .stocknum{font-size:1.15rem;font-weight:600;margin-top:.1rem}
 .stocknote{font-size:.72rem;color:#8a8aa2}
 /* flowchart view */
 .flow{margin:.5rem 0}
 .flowphase{margin:0}
 .flowphase-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#8a8aa2;margin:.2rem 0 .5rem}
 .flowrow{display:block}
 .flowrow.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.8rem}
 .flowbox{background:#15151f;border:1px solid #2a2a44;border-radius:10px;padding:.8rem 1rem;margin:0 0 .8rem}
 .flowrow.cols .flowbox{margin:0}
 .flowbox-head{display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap}
 .flowbox-head h4{margin:0;font-size:.98rem}
 .flowdesc{color:#9a9ab0;font-size:.82rem;margin:.25rem 0 .5rem}
 .flowinfo{color:#6f6f88;font-size:.78rem;margin:.4rem 0 0;border-top:1px dashed #24243a;padding-top:.4rem}
 .flowtoggle{display:flex;align-items:center;gap:.4rem}
 .flowtoggle span{font-size:.72rem;color:#8a8aa2}
 .flowtoggle select{padding:.3rem .5rem}
 .flowarrow{text-align:center;color:#4a4a66;font-size:1rem;margin:-.2rem 0 .5rem}
 /* selectable schedule + account picker */
 input.pick,select.pick{width:auto;min-width:140px}
 input[type=time].pick{min-width:120px}
 .daychips{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.2rem}
 .daychip{display:inline-flex;align-items:center;gap:.3rem;background:#15151f;border:1px solid #2a2a44;border-radius:999px;padding:.3rem .7rem;font-size:.85rem;cursor:pointer;margin:0}
 .daychip input{margin:0}
 .acctlist{display:flex;flex-direction:column;gap:.3rem;margin:.4rem 0;max-height:260px;overflow:auto}
 .acct{display:flex;align-items:center;gap:.5rem;background:#15151f;border:1px solid #24243a;border-radius:8px;padding:.4rem .7rem;font-size:.85rem;cursor:pointer;margin:0}
 .acct b{color:#c7c7d9;text-transform:capitalize}
</style>
<div class="layout">
  <aside>
    ${menu}
  </aside>
  <main>
    ${saved ? `<div class="flash">Saved <b>${esc(saved)}</b>.</div>` : ''}
    <div id="flash-error" class="flash err" style="display:none"></div>

    ${superAdmin ? tenantsPanel({ tenantList, postUsage, ownKeyIds, aiCosts, keyOwners, keyHistories }) : ''}
    ${usersPanel({ userList, me, tenantId, kind, myRole })}
    ${funnelsPanel({ funnelList, funnelConfigs, tenantId, key })}
    ${appSections}
  </main>
</div>
<script>
  const KEY = ${JSON.stringify(key || '')};
  // Save without leaving the page: the result shows next to the Save button
  // and the panel stays open. If the sign-in is not accepted, what you typed
  // stays here; sign in in a new tab and press Save again.
  function istNow(){ const d=new Date(Date.now()+330*60000); const p=(n)=>String(n).padStart(2,'0'); return p(d.getUTCDate())+'-'+p(d.getUTCMonth()+1)+'-'+d.getUTCFullYear()+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes()); }
  document.addEventListener('submit', async (ev) => {
    const f = ev.target;
    if (!f || !(f.getAttribute('action') || '').endsWith('settings/save')) return;
    ev.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    let note = f.querySelector('.savenote');
    if (!note) { note = Object.assign(document.createElement('span'), { className: 'savenote hint' }); note.style.marginLeft = '.8rem'; if (btn) btn.insertAdjacentElement('afterend', note); else f.appendChild(note); }
    note.style.color = '';
    if (btn) btn.disabled = true;
    note.textContent = 'Saving…';
    try {
      const r = await fetch(f.action, { method: 'POST', headers: { 'X-Save-Fetch': '1' }, body: new URLSearchParams(new FormData(f)) });
      if (r.status === 401) {
        note.innerHTML = '🟡 Your sign-in was not accepted, so nothing was saved, but your entries are still here. <a href="/api/v1/admin/login?next=%2Fapi%2Fv1%2Fadmin%2Ftoday" target="_blank" rel="noopener">Sign in in a new tab</a>, come back to this tab and press Save again.';
        return;
      }
      if (r.status === 503) { note.textContent = '🟡 The app could not reach its database just now. Nothing was saved, your entries are still here: press Save again.'; return; }
      if (!r.ok) { note.textContent = '🟡 Save failed (' + r.status + '). Your entries are still here: press Save again.'; return; }
      const err = new URL(r.url, location.href).searchParams.get('error');
      if (err) { note.textContent = '🔴 Not saved: ' + err; note.style.color = '#ff9a9a'; return; }
      note.textContent = '🟢 Saved ' + istNow() + ' IST';
      note.style.color = '#5bd08a';
      // A saved secret is not shown again: clear what was typed and mark it set.
      f.querySelectorAll('input[type=password]').forEach((i) => { if (i.value) { i.value = ''; i.placeholder = '•••• (set: blank keeps current)'; } });
    } catch (err) {
      note.textContent = '🟡 Could not reach the app (' + err.message + '). Your entries are still here: press Save again.';
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  function show(id){
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+id));
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.target===id));
    if(history.replaceState) history.replaceState(null,'',location.pathname+location.search+'#'+id);
    if(id==='funnels') loadStock();
  }
  // Ready videos and images per funnel, filled in only when the Funnels panel opens.
  let stockLoaded=false;
  function paintStock(cell, s){
    if(!cell) return;
    cell.querySelector('.stocknum').textContent=(s.dot?s.dot+' ':'')+(s.count===null?'?':s.count);
    cell.querySelector('.stocknote').textContent=s.note||'';
  }
  async function loadStock(){
    if(stockLoaded) return;
    stockLoaded=true;
    const tenant=new URLSearchParams(location.search).get('tenant')||'default';
    try{
      const r=await fetch('/api/v1/admin/funnels/stock?tenant='+encodeURIComponent(tenant),{headers:{'X-Admin-Key':KEY}});
      const j=await r.json();
      if(!j.ok) throw new Error(j.error||'failed');
      for(const f of j.funnels){
        paintStock(document.querySelector('[data-stock="'+f.id+'-videos"]'),f.videos);
        paintStock(document.querySelector('[data-stock="'+f.id+'-thumbnails"]'),f.thumbnails);
        paintStock(document.querySelector('[data-stock="'+f.id+'-posts"]'),f.imagePosts);
      }
    }catch(e){
      document.querySelectorAll('[data-stock]').forEach((c)=>paintStock(c,{dot:'🟡',count:null,note:'could not read'}));
      stockLoaded=false;
    }
  }
  function flag(i){ const f=document.getElementById('flag-'+i); if(!f) return; f.classList.add('show'); setTimeout(()=>f.classList.remove('show'),1200); }
  async function post(path, body){
    const r = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':KEY},body:JSON.stringify(body)});
    return r.ok ? r.json() : Promise.reject(await r.json().catch(()=>({error:'failed'})));
  }
  async function saveRole(i, email, sel){
    try{ await post('users/role',{email,role:sel.value}); flag(i); }
    catch(e){ alert('Could not change role: '+(e.error||'')); }
  }
  async function savePlan(i, email){
    const forever=document.getElementById('fv-'+i).checked;
    const dt=document.getElementById('dt-'+i);
    dt.disabled=forever;
    try{ await post('users/plan',{email,forever,date:dt.value}); flag(i); }
    catch(e){ alert('Could not change plan: '+(e.error||'')); }
  }
  async function saveExpiry(i, tenant){
    const dt=document.getElementById('tx-'+i);
    try{ await post('tenants/expiry',{tenant,date:dt.value}); flag('t'+i); }
    catch(e){ alert('Could not change expiry: '+(e.error||'')); }
  }
  function extendExpiry(i, tenant, months){
    const dt=document.getElementById('tx-'+i);
    const today=new Date(); today.setHours(0,0,0,0);
    let base=dt.value?new Date(dt.value+'T00:00:00'):today;
    if(base<today) base=today;
    base.setMonth(base.getMonth()+months);
    const p=(n)=>String(n).padStart(2,'0');
    dt.value=base.getFullYear()+'-'+p(base.getMonth()+1)+'-'+p(base.getDate());
    saveExpiry(i, tenant);
  }
  async function toggleBilling(i, email){
    const box=document.getElementById('bill-'+i);
    if(box.style.display==='table-row'){ box.style.display='none'; return; }
    box.style.display='table-row';
    const cell=document.getElementById('billbody-'+i);
    cell.textContent='Loading…';
    try{
      const r=await fetch('users/billing?email='+encodeURIComponent(email),{headers:{'X-Admin-Key':KEY}});
      const j=await r.json();
      cell.innerHTML = (j.rows&&j.rows.length)
        ? '<div class="billing">'+j.rows.map(x=>esc2(x.occurred_at)+', '+esc2(x.description||'')+', ₹'+esc2(x.amount_inr||'0')+' ('+esc2(x.status||'')+')').join('<br>')+'</div>'
        : '<div class="billing hint">No billing history yet.</div>';
    }catch(e){ cell.textContent='Failed to load billing.'; }
  }
  function esc2(s){ return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  async function refreshModels(provider){
    const st=document.getElementById('mdl-'+provider);
    if(st){ st.textContent='Loading…'; st.style.color=''; }
    try{
      const r=await fetch('/api/v1/admin/settings/models/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:provider})});
      const j=await r.json();
      if(j.ok){ if(st){ st.textContent='✓ '+(j.image+j.text)+' models'; st.style.color='#5bd08a'; } setTimeout(function(){location.reload();},600); }
      else if(st){ st.textContent='✗ '+(j.error||'failed'); st.style.color='#ff9a9a'; }
    }catch(e){ if(st){ st.textContent='✗ '+e.message; st.style.color='#ff9a9a'; } }
  }
  function genSecret(id){
    const b=new Uint8Array(24); crypto.getRandomValues(b);
    const hex=Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
    const el=document.getElementById(id); el.value='whsec_'+hex; el.focus(); el.select();
  }
  function copyField(id){
    const el=document.getElementById(id); el.select();
    navigator.clipboard?.writeText(el.value).then(()=>{ el.style.outline='2px solid #5bd08a'; setTimeout(()=>el.style.outline='',700); });
  }
  async function testEmail(){
    const to=document.getElementById('smtp-test-to').value;
    const el=document.getElementById('smtp-test-result');
    el.textContent='Sending…'; el.style.color='';
    try{
      const r=await fetch('/api/v1/admin/test-email',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':KEY},body:JSON.stringify({to})});
      const j=await r.json();
      el.textContent = j.ok ? ('✓ sent to '+(j.to||'')+', check inbox/spam') : ('✗ '+(j.error||'failed'));
      el.style.color = j.ok ? '#5bd08a' : '#ff9a9a';
    }catch(e){ el.textContent='✗ '+e.message; el.style.color='#ff9a9a'; }
    if (typeof loadEmailHealth === 'function') loadEmailHealth();
  }
  function syncDays(gid){
    const boxes=document.querySelectorAll('[data-daygroup="'+gid+'"]');
    const vals=[]; boxes.forEach(b=>{ if(b.checked) vals.push(b.value); });
    const h=document.getElementById(gid); if(h) h.value=vals.join(',');
  }
  function syncPfm(fid){
    const boxes=document.querySelectorAll('[data-pfm="'+fid+'"]');
    const ids=[]; const map={};
    boxes.forEach(b=>{ if(b.checked){ ids.push(b.value); map[b.value]={platform:b.dataset.plat||'',account_name:b.dataset.name||''}; } });
    const a=document.getElementById('pfmaccts-'+fid); if(a) a.value=JSON.stringify(ids);
    const m=document.getElementById('pfmmap-'+fid); if(m) m.value=JSON.stringify(map);
  }
  function renderPfm(fid, accounts){
    const box=document.getElementById('pfmlist-'+fid);
    let selected=[]; try{ selected=JSON.parse(document.getElementById('pfmaccts-'+fid).value||'[]'); }catch(_){}
    if(!accounts.length){ box.innerHTML='<span class="hint">No connected accounts found for that key.</span>'; return; }
    box.innerHTML=accounts.map(function(x){
      const ck=selected.indexOf(x.id)>=0?'checked':'';
      return '<label class="acct"><input type="checkbox" value="'+esc2(x.id)+'" data-pfm="'+fid+'" data-plat="'+esc2(x.platform)+'" data-name="'+esc2(x.name)+'" onchange="syncPfm('+fid+')" '+ck+'> <b>'+esc2(x.platform)+'</b>, '+esc2(x.name)+'</label>';
    }).join('');
    syncPfm(fid);
  }
  async function fetchPfm(fid){
    const st=document.getElementById('pfmstatus-'+fid);
    const keyEl=document.getElementById('pfmkey-'+fid);
    const api_key=keyEl?keyEl.value.trim():'';
    st.textContent='Fetching…'; st.style.color='';
    try{
      const j=await post('funnels/fetch-accounts',{funnel_id:fid, api_key});
      if(!j.ok){ st.textContent='✗ '+(j.error||'failed'); st.style.color='#ff9a9a'; return; }
      renderPfm(fid, j.accounts||[]);
      st.textContent='✓ '+(j.accounts||[]).length+' accounts: tick to include, then Save';
      st.style.color='#5bd08a';
    }catch(e){ st.textContent='✗ '+((e&&e.error)||(e&&e.message)||'failed'); st.style.color='#ff9a9a'; }
  }
  const hash=(location.hash||'#users').slice(1);
  if(document.getElementById('panel-'+hash)) show(hash);
  const e=new URLSearchParams(location.search).get('error');
  if(e){const d=document.getElementById('flash-error'); d.textContent='Error: '+e; d.style.display='block';}
</script>`;
}

function tenantsPanel({ tenantList, postUsage = null, ownKeyIds = [], aiCosts = null, keyOwners = {}, keyHistories = {} }) {
  const rows = (tenantList || [])
    .map((t, i) => {
      // The date input wants YYYY-MM-DD; the expiry is the end of that IST day.
      const ex = t.expires_at ? new Date(new Date(t.expires_at).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) : '';
      const expired = t.expires_at && new Date(t.expires_at) < new Date();
      const agency = t.parent_id ? (tenantList || []).find((x) => String(x.id) === String(t.parent_id)) : null;
      const planCell = t.parent_id
        ? `<span class="hint">on ${esc(agency ? agency.name : t.parent_id)}'s Agency plan</span>`
        : `<select onchange="savePlan(${i}, '${escJs(t.id)}', this.value)">${PLAN_IDS.map((p) => '<option value="' + p + '"' + ((t.plan || 'custom') === p ? ' selected' : '') + '>' + esc(PLANS[p].label) + (PLANS[p].priceInr ? ' ₹' + PLANS[p].priceInr.toLocaleString('en-IN') + ' + GST' : '') + '</option>').join('')}</select><span id="flag-p${i}" class="saveflag">saved</span>`;
      return `<tr>
        <td>${t.parent_id ? '↳ ' : ''}${esc(t.name)}${t.status !== 'active' ? ` <span class="pill">${esc(t.status)}</span>` : ''}${t.cancelled_at ? ` <span class="pill">🟡 cancelled ${esc(formatIst(t.cancelled_at, { withTime: false }))}, do not renew</span>` : ''}${t.parent_id ? `<div class="hint">client of ${esc(agency ? agency.name : t.parent_id)}</div>` : ''}</td>
        <td>${esc(t.owner_email || '-')}</td>
        <td>${esc(t.phone || '-')}</td>
        <td>${esc(formatIst(t.subscribed_at, { withTime: false }))}</td>
        <td>${planCell}</td>
        <td><div class="planwrap">
          <input id="tx-${i}" type="date" value="${ex}" onchange="saveExpiry(${i}, '${escJs(t.id)}')" title="${expired ? 'expired' : ''}">
          <button class="act" type="button" onclick="extendExpiry(${i}, '${escJs(t.id)}', 1)">+1 month</button>
          <button class="act" type="button" onclick="extendExpiry(${i}, '${escJs(t.id)}', 12)">+1 year</button>
          <span id="flag-t${i}" class="saveflag">saved</span>
        </div>${expired ? '<div class="hint">🔴 expired</div>' : ''}</td>
      </tr>`;
    })
    .join('');

  return `<section class="panel card" id="panel-tenants">
    <h2>Tenants</h2>
    <p class="blurb">Every customer account. Change an expiry date, or press +1 month / +1 year, and it saves at once. A blank expiry means it never expires.</p>
    <fieldset><legend>Tenants</legend>
      <table><thead><tr><th>Tenant</th><th>Email</th><th>Phone</th><th>Subscribed</th><th>Plan</th><th>Expires</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="hint">No tenants yet.</td></tr>'}</tbody></table>
    </fieldset>
    ${newTenantBox(tenantList)}
    ${qaBox(tenantList)}
    ${costBox(tenantList, aiCosts, new Date(), keyOwners, keyHistories)}
    ${usageBox(tenantList, postUsage, new Date(), ownKeyIds)}
    ${wakerBox()}
  </section>`;
}

/** Owner only: make a tenant and its first admin; the one-time password is shown once. */
function newTenantBox(tenantList = []) {
  const agencies = (tenantList || []).filter((t) => !t.parent_id && t.plan === AGENCY_PLAN);
  const clientsOf = (id) => (tenantList || []).filter((t) => String(t.parent_id || '') === String(id) && t.status !== 'archived').length;
  const agencyOpts = agencies.map((a) => `<option value="${esc(a.id)}">Client of ${esc(a.name)} (${clientsOf(a.id)} of ${PLANS.agency.clients})</option>`).join('');
  return `<fieldset><legend>New tenant</legend>
    <p class="hint">Makes the workspace and its owner's sign-in. Give the owner the one-time password shown below; they choose their own at first sign-in. An expired or suspended workspace can still look around but cannot change or post anything.</p>
    <p class="hint">A client of an agency is its own workspace on the agency's plan: it uses the agency's keys (never yours), ends when the agency does, and the agency's admins can open it from their workspace switcher.</p>
    <div class="row" style="gap:.4rem;align-items:center;flex-wrap:wrap">
      <input id="nt-id" placeholder="workspace id, e.g. acme" style="min-width:10rem">
      <input id="nt-name" placeholder="Name" style="min-width:12rem">
      <input id="nt-email" placeholder="Owner email" style="min-width:14rem">
      <input id="nt-phone" placeholder="Phone (optional)" style="min-width:9rem">
      <select id="nt-parent" onchange="const c=!!this.value;document.getElementById('nt-plan').disabled=c;document.getElementById('nt-months').disabled=c"><option value="">Its own workspace</option>${agencyOpts}</select>
      <select id="nt-plan">${PLAN_IDS.map((p) => '<option value="' + p + '"' + (p === 'starter' ? ' selected' : '') + '>' + esc(PLANS[p].label) + '</option>').join('')}</select>
      <select id="nt-months"><option value="1">1 month</option><option value="12">1 year</option><option value="0">never expires</option></select>
      <button type="button" class="act" onclick="newTenant()">➕ Create</button>
    </div>
    <p id="nt-st" class="hint"></p>
    <script>
      async function newTenant(){
        const st=document.getElementById('nt-st'); const v=(id)=>document.getElementById(id).value.trim();
        st.textContent='Creating…'; st.style.color='';
        try{
          const r=await fetch('/api/v1/admin/tenants/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:v('nt-id'),name:v('nt-name'),owner_email:v('nt-email'),phone:v('nt-phone'),plan:v('nt-plan'),months:v('nt-months'),parent:v('nt-parent')})});
          const j=await r.json();
          if(!j.ok){ st.textContent='🔴 '+(j.error||'failed'); st.style.color='#ff9a9a'; return; }
          st.textContent='🟢 Made '+j.tenant+'. Sign-in: '+j.email+', one-time password: '+j.tempPassword+(j.expires?' (expires '+j.expires+')':'')+'. Copy it now: it is not shown again.'; st.style.color='#5bd08a';
        }catch(e){ st.textContent='🔴 '+e.message; st.style.color='#ff9a9a'; }
      }
      async function savePlan(i, tenant, plan){
        try{ const r=await fetch('/api/v1/admin/tenants/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenant,plan})}); const j=await r.json(); if(!j.ok) throw new Error(j.error||'failed'); const f=document.getElementById('flag-p'+i); if(f){f.classList.add('show'); setTimeout(()=>f.classList.remove('show'),1500);} }
        catch(e){ alert('Could not change the plan: '+e.message); }
      }
    </script>
  </fieldset>`;
}

/** Owner only: QA workspaces (no sign-in) and the in-app check that runs on this machine. */
function qaBox(tenantList) {
  const qa = (tenantList || []).filter((t) => isQaTenant(t.id) && t.id !== 'qa-expired');
  const opts = qa.map((t) => '<option value="' + esc(t.id) + '">' + esc(t.id) + ' (' + esc(PLANS[t.plan || 'custom'] ? PLANS[t.plan || 'custom'].label : t.plan) + ')</option>').join('');
  return `<fieldset><legend>QA check</legend>
    <p class="hint">Tests the app on this server, as a QA workspace, one group per multi-tenant phase: <b>1 doors</b> (sessions, your funnel, run, rule, lead and Drive ids, users, Post for Me accounts), <b>2 leaks</b> (your settings), <b>3 lifecycle</b> (every plan limit; an expired workspace, qa-expired, made once for this), <b>4 billing</b> (who pays per key, key history, balances, cost report), <b>5 shared</b> (Meta routing, Google ticket, Clean runner, comparison list), plus ffmpeg, fonts and the database. "With paid calls" also asks Claude and OpenAI for real (about 10 US cents) and turns the picture into a video. Nothing is posted or emailed. A QA workspace has no sign-in: open it as <b>/t/&lt;id&gt;/api/v1/admin/settings</b>. Set its expiry to a past date to switch it off.</p>
    <div class="row" style="gap:.4rem;align-items:center;flex-wrap:wrap">
      <input id="qa-id" placeholder="qa-starter" style="min-width:10rem">
      <select id="qa-plan">${PLAN_IDS.map((p) => '<option value="' + p + '"' + (p === 'starter' ? ' selected' : '') + '>' + esc(PLANS[p].label) + '</option>').join('')}</select>
      <button type="button" class="act" onclick="qaMake()">➕ Make QA workspace</button>
    </div>
    <div class="row" style="gap:.4rem;align-items:center;flex-wrap:wrap;margin-top:.4rem">
      <select id="qa-pick">${opts || '<option value="">no QA workspace yet</option>'}</select>
      <button type="button" class="act" onclick="qaRun(false)">▶ Run free checks</button>
      <button type="button" class="act" onclick="qaRun(true)">💲 Run with paid calls</button>
    </div>
    <p id="qa-st" class="hint"></p>
    <table id="qa-table" style="display:none"><thead><tr><th></th><th>Area</th><th>Check</th><th>Result</th></tr></thead><tbody id="qa-rows"></tbody></table>
    <script>
      async function qaPost(path, body){ const r=await fetch('/api/v1/admin/qa/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return r.json(); }
      async function qaMake(){
        const st=document.getElementById('qa-st'); st.textContent='Making...';
        try{ const j=await qaPost('tenant',{id:document.getElementById('qa-id').value.trim(),plan:document.getElementById('qa-plan').value});
          if(!j.ok){ st.textContent='🔴 '+(j.error||'failed'); return; }
          const sel=document.getElementById('qa-pick'); const o=document.createElement('option'); o.value=j.tenant; o.textContent=j.tenant+' ('+j.plan+')';
          if(!sel.value) sel.innerHTML=''; sel.appendChild(o); sel.value=j.tenant; st.textContent='🟢 Made '+j.tenant+'. Run a check next.';
        }catch(e){ st.textContent='🔴 '+e.message; }
      }
      async function qaRun(paid){
        const st=document.getElementById('qa-st'); const qa=document.getElementById('qa-pick').value;
        if(!qa){ st.textContent='🟡 Make a QA workspace first'; return; }
        if(paid && !confirm('Spend about 10 US cents on real Claude and OpenAI calls for '+qa+'?')) return;
        st.textContent='Checking '+qa+(paid?' with paid calls (up to a minute)':'')+'...';
        try{ const j=await qaPost('run',{qa,paid});
          if(!j.ok){ st.textContent='🔴 '+(j.error||'failed'); return; }
          const dot={ok:'🟢',warn:'🟡',fail:'🔴',skip:'⚪'};
          const e=(s)=>String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
          document.getElementById('qa-rows').innerHTML=j.checks.map(c=>'<tr><td>'+dot[c.status]+'</td><td>'+e(c.group)+'</td><td>'+e(c.name)+'</td><td>'+e(c.detail)+'</td></tr>').join('');
          document.getElementById('qa-table').style.display='';
          const n=(s)=>j.checks.filter(c=>c.status===s).length;
          st.textContent=dot[j.verdict]+' '+j.tenant+': '+n('ok')+' passed, '+n('warn')+' to look at, '+n('fail')+' failed'+(paid?', spent $'+j.spentUsd:'')+'.';
        }catch(e){ st.textContent='🔴 '+e.message; }
      }
    </script>
  </fieldset>`;
}

/** Owner only: the one Cloudflare Worker that wakes the app once a day per tenant. */
function wakerBox() {
  return `<fieldset><legend>Wake-up timer (Cloudflare)</legend>
    <p class="hint">One Worker on your Cloudflare account checks every 5 minutes, inside Cloudflare, and wakes this app only when a tenant's Daily time (Settings → Daily schedule) has come, once per tenant per day. A failed wake is tried again at the next check.
      Make the token at dash.cloudflare.com → My Profile → API Tokens → Create Token → Create Custom Token, with Account permissions <b>Workers Scripts: Edit</b> and <b>Workers KV Storage: Edit</b>, for your account only.</p>
    <div class="row" style="gap:.4rem;align-items:center;flex-wrap:wrap">
      <input id="cf-acc" placeholder="Account ID (32 letters and digits)" style="min-width:20rem">
      <input id="cf-tok" type="password" placeholder="API token (blank = keep the saved one)" style="min-width:20rem" autocomplete="off">
      <button type="button" class="act" onclick="cfSave()">💾 Save</button>
      <button type="button" class="act" onclick="cfDeploy()">☁ Deploy waker</button>
    </div>
    <p id="cf-st" class="hint">Checking…</p>
    <table><thead><tr><th>Tenant</th><th>Daily time (IST)</th><th>Last daily run</th></tr></thead><tbody id="cf-rows"></tbody></table>
    <script>
      function cfShow(j){
        document.getElementById('cf-st').textContent=(j.text||'🟡 unknown')+(j.hasToken?' · token saved':' · no token saved');
        if(j.account) document.getElementById('cf-acc').value=j.account;
        const e=(s)=>String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
        document.getElementById('cf-rows').innerHTML=(j.tenants||[]).map(t=>'<tr><td>'+e(t.name||t.id)+(t.status!=='active'?' ('+e(t.status)+', not woken)':'')+'</td><td>'+e(t.time)+'</td><td>'+e(t.last)+'</td></tr>').join('');
      }
      async function cfPost(path, body){
        const st=document.getElementById('cf-st');
        try{ const r=await fetch('/api/v1/admin/cloudflare-wake'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); cfShow(await r.json()); }
        catch(e){ st.textContent='🔴 '+e.message; }
      }
      function cfSave(){ document.getElementById('cf-st').textContent='Saving…'; cfPost('/credentials',{account:document.getElementById('cf-acc').value.trim(),token:document.getElementById('cf-tok').value.trim()}); document.getElementById('cf-tok').value=''; }
      function cfDeploy(){ document.getElementById('cf-st').textContent='Deploying to Cloudflare…'; cfPost('/deploy'); }
      (async function(){ try{ cfShow(await (await fetch('/api/v1/admin/cloudflare-wake')).json()); }catch(e){ document.getElementById('cf-st').textContent='🟡 Could not check: '+e.message; } })();
    </script>
  </fieldset>`;
}

function usersPanel({ userList, me, tenantId = 'default', kind = 'standalone', myRole = 'admin' }) {
  const choices = accessChoices(kind, myRole);
  const people = kind !== 'standalone';
  const rows = (userList || [])
    .map((u, i) => {
      const isSuper = u.email === users.SUPER_ADMIN_EMAIL;
      const roleSel = users.ROLES
        .map((r) => `<option value="${r}"${u.role === r ? ' selected' : ''}>${r}</option>`)
        .join('');
      const lastLogin = formatIst(u.last_login_at);
      return `<tr>
        <td>${esc(u.email)}${people ? `<div class="hint">${esc(ROLE_LABEL[(kind === 'client' && (u.tenant_role || 'admin') === 'admin') ? 'owner' : (u.tenant_role || 'admin')] || u.tenant_role || '')}</div>` : ''}</td>
        <td><select onchange="saveRole(${i}, '${escJs(u.email)}', this)"${isSuper || people ? ' disabled title="' + (people ? 'access is set below or on the Clients page' : 'protected') + '"' : ''}>${roleSel}</select></td>
        <td>${esc(lastLogin)}<span id="flag-${i}" class="saveflag">saved</span></td>
      </tr>`;
    })
    .join('');

  return `<section class="panel active card" id="panel-users">
    <h2>Users</h2>
    <p class="blurb">Add the people who work in this workspace below; each gets a one-time password and picks their own at first sign-in. Change a role and it saves instantly, no save button. Account expiry lives on Tenants.</p>

    <fieldset><legend>Users</legend>
      <table><thead><tr><th>Email</th><th>Role</th><th>Last login</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="hint">No users yet: they appear here after signing up.</td></tr>'}</tbody></table>
      <p class="hint">The super admin is protected: it cannot be demoted or removed.</p>
    </fieldset>

    <fieldset><legend>Add a user</legend>
      <div class="row">
        <input id="nu-email" type="email" placeholder="name@example.com" style="min-width:16rem">
        ${people
    ? `<select id="nu-access">${choices.map((c) => `<option value="${c}">${esc(ACCESS_TEXT[c] || c)}</option>`).join('')}</select><input type="hidden" id="nu-role" value="admin">`
    : '<select id="nu-role"><option value="user">user</option><option value="admin">admin</option></select>'}
        <button type="button" class="act" onclick="addUser()">Add user</button>
      </div>
      <p id="nu-st" class="hint">Your plan sets how many users this workspace may have.</p>
      <script>
        async function addUser(){
          const st=document.getElementById('nu-st'); st.textContent='Adding…';
          try{
            const r=await fetch('/api/v1/admin/users/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenant:'${escJs(tenantId)}',email:document.getElementById('nu-email').value,role:document.getElementById('nu-role').value,access:(document.getElementById('nu-access')||{}).value||''})});
            const j=await r.json();
            if(!j.ok){ st.textContent='🔴 '+(j.error||'Could not add'); return; }
            st.textContent='🟢 Added '+j.email+' ('+(j.access||j.role)+'). '+(j.emailed?'An invite email with the sign-in link went to them. ':'No invite email went out ('+(j.emailError||'mail is not set up')+'). ')+'One-time password: '+j.tempPassword+' . It is not shown again.';
          }catch(e){ st.textContent='🔴 '+e.message; }
        }
      </script>
    </fieldset>

    <fieldset><legend>Sign-in</legend>
      <p class="hint" style="margin:0">Signed in as <b>${esc(me || 'machine key')}</b>. Everyone signs in with email + password.
        Locked out? The super admin can set a new password on the <a href="/api/v1/admin/reset">reset page</a> with the reset code kept on the server.</p>
      <div class="row" style="margin-top:.6rem">
        <a class="act" href="/api/v1/admin/password?next=${encodeURIComponent('/api/v1/admin/settings#users')}">Change my password</a>
      </div>
    </fieldset>
  </section>`;
}

function funnelsPanel({ funnelList, funnelConfigs, tenantId, key }) {
  const total = WIZARD_STEPS.length;
  const cards = (funnelList || [])
    .map((f) => {
      const cfg = funnelConfigs[f.id] || {};
      const done = completeness(cfg).filter(Boolean).length;
      const ready = done === total;
      return `<div class="funnelrow">
        <div class="funnelrow-main">
          <div class="funnelrow-name">${esc(f.name)} ${f.active ? '' : '<span class="pill">paused</span>'}</div>
          <div class="funnelrow-meta">${ready ? '🟢 ready' : `🟡 ${done}/${total} pages set`}</div>
        </div>
        <div class="stockcols">
          <div class="stockcell" data-stock="${f.id}-videos"><div class="stocklabel">Ready videos</div><div class="stocknum">…</div><div class="stocknote"></div></div>
          <div class="stockcell" data-stock="${f.id}-thumbnails"><div class="stocklabel">Ready thumbnails</div><div class="stocknum">…</div><div class="stocknote"></div></div>
          <div class="stockcell" data-stock="${f.id}-posts"><div class="stocklabel">Image posts</div><div class="stocknum">…</div><div class="stocknote"></div></div>
        </div>
        <div class="row funnelrow-acts" style="gap:.4rem;margin:0">
          <a class="act primary" href="/api/v1/admin/funnels/${f.id}/setup">Set up →</a>
          <form method="post" action="/api/v1/admin/funnels/active" style="display:inline">
            <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="tenant" value="${esc(tenantId)}">
            <input type="hidden" name="funnel_id" value="${f.id}"><input type="hidden" name="active" value="${f.active ? 'false' : 'true'}">
            <button class="act" type="submit">${f.active ? 'Pause' : 'Activate'}</button>
          </form>
          <form method="post" action="/api/v1/admin/funnels/remove" style="display:inline" onsubmit="return confirm('Delete funnel ${escJs(f.name)}?')">
            <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="tenant" value="${esc(tenantId)}">
            <input type="hidden" name="funnel_id" value="${f.id}">
            <button class="act danger" type="submit">Delete</button>
          </form>
        </div>
      </div>`;
    })
    .join('');

  return `<section class="panel card" id="panel-funnels">
    <h2>Funnels</h2>
    <p class="blurb">A funnel is a brand/campaign scope with its own accounts and schedule. Each day the router picks the lane (ready video, AI video, image post) and lines up the content. Add one, then open its setup: shared basics, one page per lane, then publish.</p>
    <p class="hint"><b>Ready videos</b>: videos in the Lane 1 folder not posted or lined up yet. <b>Ready thumbnails</b>: those videos with your own same-name image and .txt, one per video whatever its sizes; the router makes a thumbnail for the others. <b>Image posts</b>: Ready rows in the Lane 3 sheet not in a post yet, used only on a day with no video to post; the picture is made when a row is used, and the router adds rows when fewer than ${REFILL_BELOW} are left. Lane 2 makes its videos when needed, so it has no count. 🔴 none left, 🟡 3 or fewer, 🟢 more than 3.</p>
    <fieldset><legend>Add a funnel</legend>
      <form method="post" action="/api/v1/admin/funnels" class="row">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="tenant" value="${esc(tenantId)}">
        <div><label style="margin:0 0 .2rem">Funnel name</label><input name="name" placeholder="e.g. Divine Leads" size="20"></div>
        <button class="act" type="submit">+ Add funnel</button>
      </form>
    </fieldset>
    <div class="funnellist">${cards || '<p class="hint">No funnels yet: add one above.</p>'}</div>
  </section>`;
}

// ---- video setup wizard (full-page, one step per screen) -------------------

// Step 3 only: generate a couple of real stills now and email them for the
// keep/regenerate review, so the whole gate is testable before the worker.
function imageGateTestBlock() {
  return `<div class="igt">
    <div class="igt-title">Test batch</div>
    <p class="hint">Generate a couple of real stills now and email them for the keep / regenerate review. Uses your OpenAI key and this funnel's Drive folder.</p>
    <div class="row">
      <input id="igt-topic" placeholder="test topic (optional)" style="flex:1;min-width:200px">
      <input id="igt-count" type="number" min="1" max="6" value="2" style="width:72px" title="how many">
      <button type="button" class="act" onclick="imageGateTest()">Generate test batch</button>
      <span id="igt-status" class="hint"></span>
    </div>
  </div>`;
}

// Lane 1 only: list the folder's unposted videos, tick some, and open them on
// the Prepare page (transcribe, AI copy + thumbnails, schedule), the same flow
// as Library's "+ New".
function readyVideosBlock(field) {
  return `<div class="field">
    <label>${esc(field.label)}</label>
    <div class="row">
      <button type="button" class="act" onclick="loadVideos()">↻ Load videos</button>
      <button type="button" class="act" id="rv-go" onclick="prepareVideos()" style="display:none">Prepare selected →</button>
      <span id="rv-status" class="hint"></span>
    </div>
    <div id="rv-list" class="acctlist"></div>
  </div>`;
}

function wizardPage({ funnel, cfg, stepIndex, complete }) {
  const total = WIZARD_STEPS.length;
  const step = WIZARD_STEPS[stepIndex];
  const base = `/api/v1/admin/funnels/${funnel.id}/setup`;
  const pct = Math.round(((stepIndex + 1) / total) * 100);

  const rail = WIZARD_STEPS
    .map((s, i) => {
      const state = i === stepIndex ? 'current' : complete[i] ? 'done' : 'todo';
      const marker = complete[i] && i !== stepIndex ? '✓' : String(i + 1);
      return `<button type="button" class="wnav ${state}" data-step="${i}" onclick="nav(${i})">
        <span class="wmark">${marker}</span><span class="wlabel">${esc(s.title)}</span></button>`;
    })
    .join('');

  const fieldsHtml = step.fields
    .map((field) => {
      if (field.type === 'heading') return `<h2 class="sect">${esc(field.label)}</h2>`;
      if (field.type === 'ready_videos') return readyVideosBlock(field);
      if (field.key === 'postforme_api_key') return funnelKeyRow(field, cfg, funnel.id);
      if (field.key === 'postforme_accounts') return pfmAccountsRow(cfg, funnel.id);
      if (field.key === 'account_map') return '';
      if (field.funnelName) return fieldRow(field, { ...cfg, [field.key]: funnel.name });
      return fieldRow(field, cfg);
    })
    .join('');

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === total - 1;

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(funnel.name)}, lane setup</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 select,input,textarea{background:#0b0b12;color:#fff;border:1px solid #333;border-radius:8px;padding:.55rem;width:100%}
 textarea{min-height:5rem;font-size:.9rem}
 .shell{max-width:980px;margin:1.3rem auto;background:#12121b;border:1px solid #24243a;border-radius:14px;overflow:hidden}
 .top{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.3rem;border-bottom:1px solid #24243a}
 .top .brand{font-size:1.05rem;font-weight:700}
 .top .sub{font-size:.8rem;color:#8a8aa2;margin-top:.1rem}
 .stepno{text-align:right}.stepno .k{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#8a8aa2}
 .stepno .v{font-size:1.1rem;font-weight:700}.stepno .v small{color:#6f6f88;font-weight:400}
 .bar{height:3px;background:#1c1c2a}.bar>i{display:block;height:3px;background:#2d6cdf;width:${pct}%}
 .body{display:grid;grid-template-columns:230px 1fr;min-height:360px}
 .rail{border-right:1px solid #24243a;padding:.8rem .6rem;display:flex;flex-direction:column;gap:.15rem}
 .wnav{display:flex;align-items:center;gap:.6rem;text-align:left;background:none;border:0;color:#9a9ab0;padding:.5rem .6rem;border-radius:8px;cursor:pointer;font-size:.86rem}
 .wnav:hover{background:#1c1c2a}
 .wnav .wmark{flex:0 0 22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:.72rem;border:1px solid #2a2a44;color:#8a8aa2}
 .wnav.current{background:#15224a;color:#fff}.wnav.current .wmark{background:#2d6cdf;border-color:#2d6cdf;color:#fff}
 .wnav.done{color:#c7c7d9}.wnav.done .wmark{background:#0a7d32;border-color:#0a7d32;color:#fff}
 .main{padding:1.4rem 1.6rem}
 .main h1{font-size:1.25rem;margin:0 0 .25rem;font-weight:600}
 .main .desc{color:#9a9ab0;font-size:.88rem;margin:0 0 1.3rem;line-height:1.55}
 .field{margin:0 0 1rem}.field label{display:block;margin:0 0 .3rem;font-size:.82rem;color:#c7c7d9}
 .hint{color:#6f6f88;font-size:.78rem;margin:.25rem 0 0}
 .sect{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:#7aa2ff;margin:1.4rem 0 .7rem;padding-top:.9rem;border-top:1px solid #24243a;font-weight:600}
 .sect:first-child{margin-top:0;padding-top:0;border-top:0}
 .igt{margin-top:1.3rem;border-top:1px solid #24243a;padding-top:1rem}
 .igt-title{font-size:.9rem;color:#c7c7d9;margin-bottom:.2rem}
 .igt input{width:auto}
 .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
 .daychips{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.2rem}
 .daychip{display:inline-flex;align-items:center;gap:.3rem;background:#15151f;border:1px solid #2a2a44;border-radius:999px;padding:.3rem .7rem;font-size:.85rem;cursor:pointer}
 .daychip input{width:auto;margin:0}
 input[type=time]{width:auto;min-width:130px}
 .acctlist{display:flex;flex-direction:column;gap:.3rem;margin:.4rem 0;max-height:260px;overflow:auto}
 .acct{display:flex;align-items:center;gap:.5rem;background:#15151f;border:1px solid #24243a;border-radius:8px;padding:.4rem .7rem;font-size:.85rem;cursor:pointer}
 .acct input{width:auto;margin:0}.acct b{color:#c7c7d9;text-transform:capitalize}
 .act{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.5rem .9rem;cursor:pointer;font-size:.86rem;text-decoration:none;display:inline-flex;align-items:center;gap:.3rem}
 .foot{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.9rem 1.3rem;border-top:1px solid #24243a;background:#12121b}
 .foot .right{display:flex;gap:.6rem}
 .btn{border:0;border-radius:9px;padding:.6rem 1.2rem;font-size:.92rem;cursor:pointer}
 .btn.back{background:#1c1c2a;color:#c7c7d9}.btn.back[disabled]{opacity:.4;cursor:not-allowed}
 .btn.save{background:#2a2a44;color:#fff}.btn.next{background:#2d6cdf;color:#fff}
 .toast{position:static;margin-top:.8rem;font-size:.82rem;min-height:1rem}
 a.back-link{color:#7aa2ff;font-size:.82rem;text-decoration:none;display:inline-block;margin:1rem auto 2rem;text-align:center;width:100%}
</style>
<div class="shell">
  <div class="top">
    <div><div class="brand">${esc(funnel.name)}</div><div class="sub">lane setup${funnel.active ? '' : ' · paused'}</div></div>
    <div class="stepno"><div class="k">Step</div><div class="v">${stepIndex + 1} <small>/ ${total}</small></div></div>
  </div>
  <div class="bar"><i></i></div>
  <div class="body">
    <nav class="rail">${rail}</nav>
    <div class="main">
      <h1>${esc(step.title)}</h1>
      <p class="desc">${esc(step.desc)}</p>
      <form id="wform" onsubmit="return false">${fieldsHtml}</form>
      ${cfg.manual_stepper === 'on' ? `<div class="igt">
        <div class="igt-title">🎛 Manual mode is on for this funnel</div>
        <p class="hint">This screen is the setup. To actually build a video stage-by-stage. Generate/edit each prompt → Execute → Preview → Approve → next → post, start a manual run. Each run opens a page with one card per stage (Script, Images, Image→video, Voiceover, Transcript, Final reel, Post), each with its input, an Execute button, and a Preview.</p>
        <div class="row">
          <button type="button" class="act" onclick="startManualRun()">▶ Start a manual run of this funnel</button>
          <a class="act" href="/api/v1/admin/instances">All instances</a>
        </div>
      </div>
      <script>
        async function startManualRun(){
          try{
            const r=await fetch('/api/v1/admin/instances/manual/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({funnelId:${funnel.id}})});
            const j=await r.json();
            if(j.ok) location.href='/api/v1/admin/instances/'+j.id; else alert(j.error||'failed');
          }catch(e){ alert(e.message); }
        }
      </script>` : ''}
      <div id="toast" class="toast"></div>
    </div>
  </div>
  <div class="foot">
    <button class="btn back" ${isFirst ? 'disabled' : ''} onclick="nav(${stepIndex - 1})">← Back</button>
    <div class="right">
      <button class="btn save" onclick="save()">Save</button>
      <button class="btn next" onclick="${isLast ? 'finish()' : `nav(${stepIndex + 1})`}">${isLast ? 'Finish' : 'Save & Next →'}</button>
    </div>
  </div>
</div>
<a class="back-link" href="/api/v1/admin/settings#funnels">← All funnels</a>
<script>
 const BASE=${JSON.stringify(base)};
 const SAVE_URL=BASE+'/save';
 const ACCOUNTS_URL='/api/v1/admin/funnels/fetch-accounts';
 const STEP=${stepIndex}, TOTAL=${total}, FID=${funnel.id};
 const FUNNEL_BASE='/api/v1/admin/funnels/'+FID;
 function esc2(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
 async function imageGateTest(){
   const st=document.getElementById('igt-status');
   const topic=(document.getElementById('igt-topic')||{}).value||'';
   const count=(document.getElementById('igt-count')||{}).value||'2';
   st.textContent='Starting…';st.style.color='';
   try{
     const r=await fetch(FUNNEL_BASE+'/image-gate/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic,count})});
     const j=await r.json();
     st.textContent=j.ok?('✓ '+(j.message||'started')):('✗ '+(j.error||'failed'));
     st.style.color=j.ok?'#5bd08a':'#ff9a9a';
   }catch(e){st.textContent='✗ '+(e.message||'failed');st.style.color='#ff9a9a';}
 }
 function toast(msg,err){const t=document.getElementById('toast');t.textContent=msg;t.style.color=err?'#ff9a9a':'#5bd08a';if(!err)setTimeout(()=>{if(t.textContent===msg)t.textContent='';},1500);}
 function collectSet(){const set={};document.querySelectorAll('#wform [name^="set["]').forEach(el=>{const m=el.name.match(/^set\\[(.+)\\]$/);if(m)set[m[1]]=el.value;});return set;}
 function updateTicks(complete){if(!complete)return;document.querySelectorAll('.wnav').forEach(n=>{const i=Number(n.dataset.step);if(i===STEP)return;const mk=n.querySelector('.wmark');n.classList.toggle('done',!!complete[i]);n.classList.toggle('todo',!complete[i]);mk.textContent=complete[i]?'✓':String(i+1);});}
 async function save(){
   try{
     const r=await fetch(SAVE_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({step:STEP,set:collectSet()})});
     const j=await r.json().catch(()=>({}));
     if(!r.ok||!j.ok){toast('Save failed'+(j.error?': '+j.error:''),true);return false;}
     updateTicks(j.complete);if(j.name){const b=document.querySelector('.brand');if(b)b.textContent=j.name;document.title=j.name+', lane setup';}toast('Saved');return true;
   }catch(e){toast('Save failed: '+e.message,true);return false;}
 }
 async function nav(i){if(i<0||i>=TOTAL||i===STEP)return;const ok=await save();if(ok!==false)location.href=BASE+'?step='+i;}
 async function finish(){const ok=await save();if(ok!==false)location.href='/api/v1/admin/settings#funnels';}
 async function loadVideos(){
   const st=document.getElementById('rv-status'),box=document.getElementById('rv-list'),go=document.getElementById('rv-go');
   const inp=document.querySelector('#wform [name="set[direct_drive_folder]"]');
   st.textContent='Loading…';st.style.color='';box.innerHTML='';go.style.display='none';
   try{
     const r=await fetch(FUNNEL_BASE+'/ready-videos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:inp?inp.value.trim():''})});
     const j=await r.json();
     if(!j.ok){st.textContent='🔴 '+(j.error||'failed');st.style.color='#ff9a9a';return;}
     if(j.listError){st.textContent='🟡 Could not read the folder: '+j.listError+(j.saEmail?' Share it with '+j.saEmail+' or make it public (anyone with the link).':' Make it public (anyone with the link).');st.style.color='#ffd479';return;}
     if(!j.folder){st.textContent='🟡 Paste the folder link above (or set the media folder on Shared basics).';st.style.color='#ffd479';return;}
     if(!j.videos.length){st.textContent='🟡 No unposted videos in that folder.';st.style.color='#ffd479';return;}
     // Serial order: the router posts from the top, one a day.
     const list=j.videos;
     box.innerHTML=list.map(function(v,i){return '<label class="acct"><input type="checkbox" data-rv="'+esc2(v.id)+'" data-name="'+esc2(v.name)+'"> '+esc2(v.name)+(v.created?' <span class="hint" style="margin:0">'+esc2(v.created)+'</span>':'')+(i===0?' <b class="hint" style="margin:0;color:#5bd08a">next for the router</b>':'')+(v.started?' <span class="hint" style="margin:0">(started)</span>':'')+'</label>';}).join('');
     st.textContent='🟢 '+j.videos.length+' video'+(j.videos.length===1?'':'s')+' not posted yet, in order of the number in the file name, then A to Z. The router posts the top one each day by itself; tick any you want to prepare and schedule now.';st.style.color='#5bd08a';
     go.style.display='';
   }catch(e){st.textContent='🔴 '+(e.message||'failed');st.style.color='#ff9a9a';}
 }
 async function prepareVideos(){
   const picked=[];document.querySelectorAll('[data-rv]').forEach(function(b){if(b.checked)picked.push({id:b.dataset.rv,name:b.dataset.name});});
   if(!picked.length){toast('Tick at least one video',true);return;}
   const ok=await save();if(ok===false)return;
   location.href='/api/v1/admin/instances/prepare?funnel='+FID+'&picked='+encodeURIComponent(JSON.stringify(picked));
 }
 function syncDays(gid){const boxes=document.querySelectorAll('[data-daygroup="'+gid+'"]');const vals=[];boxes.forEach(b=>{if(b.checked)vals.push(b.value);});const h=document.getElementById(gid);if(h)h.value=vals.join(',');}
 function syncPfm(fid){const boxes=document.querySelectorAll('[data-pfm="'+fid+'"]');const ids=[];const map={};boxes.forEach(b=>{if(b.checked){ids.push(b.value);map[b.value]={platform:b.dataset.plat||'',account_name:b.dataset.name||''};}});const a=document.getElementById('pfmaccts-'+fid);if(a)a.value=JSON.stringify(ids);const m=document.getElementById('pfmmap-'+fid);if(m)m.value=JSON.stringify(map);}
 function renderPfm(fid,accounts){const box=document.getElementById('pfmlist-'+fid);let selected=[];try{selected=JSON.parse(document.getElementById('pfmaccts-'+fid).value||'[]');}catch(_){}if(!accounts.length){box.innerHTML='<span class="hint">No connected accounts found for that key.</span>';return;}box.innerHTML=accounts.map(function(x){const ck=selected.indexOf(x.id)>=0?'checked':'';return '<label class="acct"><input type="checkbox" value="'+esc2(x.id)+'" data-pfm="'+fid+'" data-plat="'+esc2(x.platform)+'" data-name="'+esc2(x.name)+'" onchange="syncPfm('+fid+')" '+ck+'> <b>'+esc2(x.platform)+'</b>, '+esc2(x.name)+'</label>';}).join('');syncPfm(fid);}
 async function fetchPfm(fid){const st=document.getElementById('pfmstatus-'+fid);const keyEl=document.getElementById('pfmkey-'+fid);const api_key=keyEl?keyEl.value.trim():'';st.textContent='Fetching…';st.style.color='';try{const r=await fetch(ACCOUNTS_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({funnel_id:fid,api_key})});const j=await r.json();if(!j.ok){st.textContent='✗ '+(j.error||'failed');st.style.color='#ff9a9a';return;}renderPfm(fid,j.accounts||[]);st.textContent='✓ '+(j.accounts||[]).length+' accounts: tick to include, then Save';st.style.color='#5bd08a';}catch(e){st.textContent='✗ '+(e.message||'failed');st.style.color='#ff9a9a';}}
</script>`;
}

function flowSection(app, tenantId, configMap, key, extra = '') {
  const m = CONFIG_MANIFEST[app];
  const flow = FLOW_MANIFEST[app];

  const moduleSelect = (moduleKey) => {
    if (!moduleKey) return '';
    const choice = configService.moduleChoice(configMap, app, moduleKey);
    const opt = (v, lbl) => `<option value="${v}"${choice === v ? ' selected' : ''}>${lbl}</option>`;
    return `<div class="flowtoggle"><span>Status</span>
      <select name="mod[${esc(moduleKey)}]">${opt('default', 'Default')}${opt('true', 'On')}${opt('false', 'Off')}</select></div>`;
  };

  const box = (b) => {
    const fields = (b.fieldKeys || [])
      .map((fk) => {
        const field = fieldByKey(app, fk);
        return field ? fieldRow(field, configMap, tenantId) : '';
      })
      .join('');
    return `<div class="flowbox">
      <div class="flowbox-head"><h4>${esc(b.title)}</h4>${moduleSelect(b.moduleKey)}</div>
      ${b.desc ? `<p class="flowdesc">${esc(b.desc)}</p>` : ''}
      ${fields}
      ${b.info ? `<p class="flowinfo">${esc(b.info)}</p>` : ''}
    </div>`;
  };

  const phases = flow.phases
    .map((phase, i) => {
      const boxes = `<div class="flowrow${phase.columns ? ' cols' : ''}">${phase.boxes.map(box).join('')}</div>`;
      const arrow = i < flow.phases.length - 1 ? '<div class="flowarrow">▼</div>' : '';
      return `<div class="flowphase"><div class="flowphase-label">${esc(phase.label)}</div>${boxes}</div>${arrow}`;
    })
    .join('');

  return `<section class="panel card" id="panel-${esc(app)}">
    <h2>${esc(m.label)}</h2><p class="blurb">${esc(flow.intro || m.blurb)}</p>
    <form method="post" action="/api/v1/admin/settings/save">
      <input type="hidden" name="app" value="${esc(app)}">
      <input type="hidden" name="tenant" value="${esc(tenantId)}">
      <input type="hidden" name="key" value="${esc(key)}">
      <div class="flow">${phases}</div>
      <button class="save" type="submit">Save ${esc(m.label)}</button>
    </form>
    ${extra}
  </section>`;
}

function appSection(app, tenantId, configMap, key, extra = '') {
  const m = CONFIG_MANIFEST[app];
  const groups = m.groups
    .map((g) => `<fieldset><legend>${esc(g.title)}</legend>${g.fields.map((f) => fieldRow(f, configMap, tenantId)).join('')}</fieldset>`)
    .join('');

  const mods = m.modules
    .map((mod) => {
      const choice = configService.moduleChoice(configMap, app, mod.key);
      const opt = (v, lbl) => `<option value="${v}"${choice === v ? ' selected' : ''}>${lbl}</option>`;
      // "Default" is the platform setting; say what it is so the choice is clear.
      const def = settings.modules && settings.modules[mod.key] ? 'on' : 'off';
      return `<div class="mod"><span>${esc(mod.label)}${mod.help ? `<small class="hint" style="display:block;margin-top:.2rem">${esc(mod.help)}</small>` : ''}</span>
        <select name="mod[${esc(mod.key)}]">${opt('default', `Default (${def})`)}${opt('true', 'On')}${opt('false', 'Off')}</select></div>`;
    })
    .join('');

  return `<section class="panel card" id="panel-${esc(app)}">
    <h2>${esc(m.label)}</h2><p class="blurb">${esc(m.blurb)}</p>
    ${app === 'api-keys' ? balanceStrip() : ''}
    <form method="post" action="settings/save">
      <input type="hidden" name="app" value="${esc(app)}">
      <input type="hidden" name="tenant" value="${esc(tenantId)}">
      <input type="hidden" name="key" value="${esc(key)}">
      ${groups}
      ${mods ? `<fieldset><legend>Background jobs (not per funnel)</legend><div class="mods">${mods}</div></fieldset>` : ''}
      <button class="save" type="submit">Save ${esc(m.label)}</button>
    </form>
    ${extra}
  </section>`;
}

/**
 * ▶ / ■ next to the music choice. A built-in track is generated in the
 * browser from the same formula ffmpeg uses (no server work, no egress);
 * "my own music" plays the link typed below it.
 */
function musicPreviewButton() {
  return ` <button type="button" class="btn" id="mprev" style="margin-left:6px" aria-label="Play the music">▶ Play</button>
<span class="hint" id="mprev-st"></span>
<script>(function(){
  const PAGE=${String(MUSIC_PAGE_SITES).replace(/</g, '\\u003c')};
  let src=null,aud=null;
  const btn=document.getElementById('mprev'),st=document.getElementById('mprev-st');
  function stop(){try{if(src)src.stop();}catch(e){}src=null;if(aud){aud.pause();aud=null;}btn.textContent='▶ Play';}
  let pi=0;
  function fileLink(s){const m=/google\\.com/i.test(s)&&s.match(/(?:\\/d\\/|[?&]id=)([\\w-]{10,})/);
    return m?'/api/v1/admin/settings/music-file?id='+encodeURIComponent(m[1]):s;}
  function ownLinks(){const el=document.querySelector('[name="set[short_music_url]"]');
    return (el&&el.value||'').split(/\\r?\\n/).map(function(l){return l.split('|')[0];}).join(' ').split(/[\\s,]+/).filter(function(s){return /^https?:/i.test(s);});}
  // Your links, with each Drive folder swapped for its audio files (read by the app).
  async function ownItems(){const out=[];
    for(const raw of ownLinks()){
      if(raw.indexOf('/folders/')<0){out.push({url:raw,label:''});continue;}
      st.textContent=' Reading the folder...';
      try{const r=await fetch('/api/v1/admin/settings/music-folder?link='+encodeURIComponent(raw));const j=await r.json();
        if(!j.ok)throw new Error(j.error||'could not read');
        if(!j.files.length)out.push({url:'',label:'folder: no audio files in it'});
        j.files.forEach(function(f){out.push({url:f.url,label:f.name+(f.credit?' (credit: '+f.credit+')':' (no .txt credit)')});});
      }catch(e){out.push({url:'',label:'folder could not be read, check it is shared Anyone with the link: '+e.message});}}
    return out;}
  async function playOwn(){
    const all=await ownItems();if(!all.length){st.textContent=' 🟡 Paste your music links below first.';return;}
    const i=pi%all.length;pi++;const it=all[i],tag=(all.length>1?' '+(i+1)+' of '+all.length+': ':' ')+(it.label?it.label+', ':'');
    if(!it.url){st.textContent=' 🟡'+tag;return;}
    if(PAGE.test(it.url)){st.textContent=' 🟡'+tag+'a web page, not a music file, so it is skipped. Upload an mp3 to Google Drive and paste its share link.';return;}
    aud=new Audio(fileLink(it.url));aud.onended=stop;aud.play().then(function(){btn.textContent='■ Stop';st.textContent=' 🟢'+tag+'playing.'+(all.length>1?' Stop, then Play again for the next one.':'');}).catch(function(e){st.textContent=' 🟡'+tag+'could not play: '+e.message;aud=null;});}
  btn.addEventListener('click',function(){
    if(src||aud){stop();return;}
    st.textContent='';
    playOwn();
  });
})();</script>`;
}

/**
 * Your music as rows: a link and its credit, + Add music for another. The
 * rows and the one-per-line box below ("link | credit") are the same list:
 * change either and the other follows. The box is what is saved.
 */
function musicListEditor(key) {
  const k = JSON.stringify(`set[${String(key)}]`);
  return `
<div id="mlist" style="margin:6px 0"></div>
<button type="button" class="btn" id="mlist-add">+ Add music</button>
<p class="hint" style="margin-top:8px">Or paste many at once below, one per line: link | credit</p>
<script>(function(){
function init(){
  const box=document.querySelector('[name='+JSON.stringify(${k})+']'),list=document.getElementById('mlist');
  if(!box||!list)return;
  function parse(){return box.value.split(/\\r?\\n/).map(function(l){const i=l.indexOf('|');
    return i>=0?{url:l.slice(0,i).trim(),credit:l.slice(i+1).trim()}:{url:l.trim(),credit:''};}).filter(function(r){return r.url||r.credit;});}
  function save(){const lines=[];list.querySelectorAll('.mrow').forEach(function(r){
    const u=r.querySelector('.murl').value.replace(/[|\\r\\n]/g,' ').trim(),c=r.querySelector('.mcred').value.replace(/[\\r\\n]/g,' ').trim();
    if(u||c)lines.push(c?u+' | '+c:u);});box.value=lines.join('\\n');}
  function row(r){const d=document.createElement('div');d.className='mrow';
    d.style.cssText='display:grid;grid-template-columns:3fr 2fr auto;gap:6px;margin-bottom:6px';
    const u=document.createElement('input');u.type='text';u.className='murl';u.placeholder='Music file link, or a Drive folder link (credits from its .txt files)';u.value=r.url||'';
    const c=document.createElement('input');c.type='text';c.className='mcred';c.placeholder='Credit, as the licence asks (e.g. Song by Artist, CC BY 4.0)';c.value=r.credit||'';
    const x=document.createElement('button');x.type='button';x.className='btn';x.textContent='✕';x.title='Remove';
    x.onclick=function(){d.remove();save();};u.oninput=save;c.oninput=save;
    d.append(u,c,x);list.append(d);return d;}
  function draw(){list.innerHTML='';parse().forEach(row);}
  document.getElementById('mlist-add').onclick=function(){row({}).querySelector('.murl').focus();};
  box.addEventListener('input',draw);
  draw();
}
// The box comes after this script on the page: wait until it is there.
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();</script>`;
}

function fieldRow(field, configMap, tenantId = 'default') {
  // The owner's own content (the Assess360 facts) is no default for another tenant.
  if (field.ownerDefault && String(tenantId || 'default') !== 'default') field = { ...field, default: '' };
  const current = configMap[field.key];
  const has = current !== undefined && current !== null && current !== '';
  if (field.type === 'time') {
    const val = has ? current : (field.default || '');
    return `<div class="field"><label>${esc(field.label)}</label>
      <input type="time" name="set[${esc(field.key)}]" value="${esc(val)}" step="60" class="pick">
      ${field.help ? `<p class="hint">${esc(field.help)}</p>` : ''}</div>`;
  }
  if (field.type === 'time_list') {
    const val = has ? current : (field.default || '');
    return `<div class="field"><label>${esc(field.label)}</label>
      <input type="text" name="set[${esc(field.key)}]" value="${esc(val)}" placeholder="${field.placeholder ? esc(field.placeholder) : ''}">
      ${field.help ? `<p class="hint">${esc(field.help)}</p>` : ''}</div>`;
  }
  if (field.type === 'wake_sync') {
    // The owner deploys the waker on the Tenants panel; everyone sees whether it is on.
    return `<div class="field"><label>${esc(field.label)}</label>
      <p id="wake-st" class="hint">Checking…</p>
      <script>
        (async function(){
          const st=document.getElementById('wake-st');
          try{ const j=await (await fetch('/api/v1/admin/wake-timer')).json(); st.textContent=j.ok?('🟢 On: the app wakes once a day at your Daily time ('+(j.time||'19:00')+' IST). Last run: '+(j.last||'🟡 never')):'🟡 The wake-up timer is not set up yet, so nothing runs on its own. The owner sets it up under Tenants.'; }
          catch(e){ st.textContent='🟡 Could not check: '+e.message; }
        })();
      </script></div>`;
  }
  if (field.type === 'select') {
    const val = has ? current : (field.default || '');
    const opts = (field.options || [])
      .map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return `<option value="${esc(v)}"${String(val) === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
      })
      .join('');
    return `<div class="field"><label>${esc(field.label)}</label>
      <select name="set[${esc(field.key)}]" class="pick">${opts}</select>
      ${field.help ? `<p class="hint">${esc(field.help)}</p>` : ''}</div>`;
  }
  if (field.type === 'model_select') {
    const val = has ? current : (field.default || field.placeholder || '');
    let cat = {};
    try { cat = JSON.parse(configMap.models_catalog || '{}') || {}; } catch { cat = {}; }
    const list = Array.isArray(cat[field.catalog]) ? cat[field.catalog] : [];
    const provider = String(field.catalog || '').startsWith('gemini') ? 'gemini' : 'openai';
    const pname = provider === 'gemini' ? 'Gemini' : 'OpenAI';
    const opts2 = [...new Set([val, ...list].filter(Boolean))]
      .map((v) => `<option value="${esc(v)}"${String(val) === String(v) ? ' selected' : ''}>${esc(v)}</option>`)
      .join('');
    const hint = list.length
      ? `${list.length} model${list.length === 1 ? '' : 's'} available on your ${pname} key: pick one.`
      : `Save your ${pname} key above, then click Refresh to load the list.`;
    return `<div class="field"><label>${esc(field.label)}</label>
      <div class="row" style="gap:.4rem">
        <select name="set[${esc(field.key)}]" class="pick" style="flex:1">${opts2 || '<option value="">click Refresh:</option>'}</select>
        <button type="button" class="act" onclick="refreshModels('${provider}')">↻ Refresh</button>
        <span id="mdl-${esc(provider)}" class="hint"></span>
      </div>
      <p class="hint">${hint}</p></div>`;
  }
  if (field.type === 'voice_select') {
    // The saved id is the text input (what gets saved); the dropdown is filled
    // from /admin/tts/voices after load and just writes its choice into it.
    const val = has ? String(current) : '';
    const k = esc(field.key);
    return `<div class="field voice-pick"><label>${esc(field.label)}</label>
      <select id="vsel-${k}" class="pick" style="display:none" onchange="pickVoice('${k}')"></select>
      <input id="vid-${k}" type="text" name="set[${k}]" value="${esc(val)}"
        placeholder="${field.placeholder ? esc(field.placeholder) : ''}">
      <p style="margin:.3rem 0 0"><button type="button" id="vplay-${k}" class="act" style="display:none" onclick="playVoice('${k}')">▶ Preview</button></p>
      <audio id="vaud-${k}" preload="none"></audio>
      <p id="vmsg-${k}" class="hint">Loading your ElevenLabs voices…</p>
      <script>
        function voicePreview(k){const o=document.getElementById('vsel-'+k).selectedOptions[0];return o?(o.dataset.preview||''):'';}
        function syncPlay(k){const b=document.getElementById('vplay-'+k);b.style.display=voicePreview(k)?'':'none';}
        function playVoice(k){const a=document.getElementById('vaud-'+k),b=document.getElementById('vplay-'+k),u=voicePreview(k);if(!u)return;
          if(!a.paused&&a.src===u){a.pause();b.textContent='▶ Preview';return;}
          a.src=u;b.textContent='■ Stop';a.onended=()=>{b.textContent='▶ Preview';};a.play().catch(()=>{b.textContent='▶ Preview';});}
        function pickVoice(k){const s=document.getElementById('vsel-'+k),i=document.getElementById('vid-'+k),a=document.getElementById('vaud-'+k);
          a.pause();document.getElementById('vplay-'+k).textContent='▶ Preview';
          if(s.value==='__type__'){i.style.display='';i.focus();}else{i.value=s.value;i.style.display='none';}syncPlay(k);}
        (async function(k){
          const s=document.getElementById('vsel-'+k),i=document.getElementById('vid-'+k),m=document.getElementById('vmsg-'+k);
          const esc=(x)=>String(x).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
          let j;
          try{ j=await (await fetch('/api/v1/admin/tts/voices')).json(); }catch(e){ j={ok:false,error:e.message}; }
          if(!j.ok){ m.textContent=(j.missingKey?'🟡 ':'🟡 Could not load voices: ')+(j.error||'failed')+(/voice ID/.test(j.error||'')?'':' Type a voice ID instead.'); return; }
          const cur=i.value.trim(), vs=j.voices||[];
          const known=vs.some((v)=>v.voice_id===cur);
          let h=cur?'':'<option value="" selected>Choose a voice…</option>';
          if(cur&&!known) h+='<option value="'+esc(cur)+'" selected>'+esc(cur)+' (saved, not on this key)</option>';
          h+=vs.map((v)=>'<option value="'+esc(v.voice_id)+'" data-preview="'+esc(v.preview_url||'')+'"'+(v.voice_id===cur?' selected':'')+'>'+esc(v.name)+(v.category?' ('+esc(v.category)+')':'')+'</option>').join('');
          h+='<option value="__type__">✎ Type an ID…</option>';
          s.innerHTML=h; s.style.display=''; i.style.display='none'; syncPlay(k);
          m.textContent=vs.length?('🟢 '+vs.length+' voice'+(vs.length===1?'':'s')+' on your ElevenLabs key.'):'🟡 No voices on your ElevenLabs key. Type a voice ID instead.';
          if(!vs.length){ s.style.display='none'; i.style.display=''; }
        })('${k}');
      </script></div>`;
  }
  if (field.type === 'weekdays') {
    const gid = uniqueId('days');
    const cur = String(has ? current : '').split(',').map((s) => s.trim()).filter(Boolean);
    const days = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];
    const chips = days
      .map(([v, l]) => `<label class="daychip"><input type="checkbox" value="${v}" data-daygroup="${gid}"${cur.includes(v) ? ' checked' : ''} onchange="syncDays('${gid}')"> ${l}</label>`)
      .join('');
    return `<div class="field"><label>${esc(field.label)}</label>
      <input type="hidden" id="${gid}" name="set[${esc(field.key)}]" value="${esc(cur.join(','))}">
      <div class="daychips">${chips}</div>
      <p class="hint">Tick the days this funnel runs. All unchecked = every day.</p></div>`;
  }
  if (field.type === 'smtp_test') {
    const prefill = parseFrom(configMap.mail_from).email || configMap.smtp_from || configMap.smtp_user || '';
    return `<div class="field"><label>Send a test email</label>
      <div class="row" style="gap:.4rem">
        <input id="smtp-test-to" type="email" placeholder="recipient (defaults to your From)" value="${esc(prefill)}" style="flex:1;min-width:220px">
        <button type="button" class="act" onclick="testEmail()">Send test</button>
        <span id="smtp-test-result" class="hint"></span>
      </div>
      <p class="hint">Save your email settings first, then send a test to confirm delivery (check spam once).</p></div>
      <div class="field"><label>Email health</label>
        <div id="email-health" class="hint">Checking…</div></div>
      <script>
        async function loadEmailHealth(){
          const box=document.getElementById('email-health');
          try{
            const j=await (await fetch('/api/v1/admin/email-health',{headers:{'X-Admin-Key':KEY}})).json();
            box.innerHTML=(j.lines||[]).map(function(l){ return '<div>'+esc2(l.dot+' '+l.text)+'</div>'; }).join('') || '🟡 '+esc2(j.error||'unavailable');
          }catch(e){ box.textContent='🟡 '+e.message; }
        }
        window.addEventListener('DOMContentLoaded', loadEmailHealth);
      </script>`;
  }
  if (field.type === 'drive_connect') {
    // Status is fetched live (the refresh token itself never reaches the page).
    return `<div class="field"><label>${esc(field.label)}</label>
      <div class="row" style="gap:.4rem;align-items:center">
        <a class="act" href="/api/v1/admin/drive/connect" style="text-decoration:none">🔗 Connect Google (Drive + Gmail)</a>
        <button type="button" class="act" id="drive-dc" style="display:none" onclick="driveDisconnect()">Disconnect</button>
        <span id="drive-st" class="hint">Checking…</span>
      </div>
      <p class="hint">Save the client ID and secret above first. In Google Cloud → Credentials → this OAuth client, add the redirect URI
        <b id="drive-ru"></b>. Set the OAuth consent screen to <b>In production</b>: in "Testing" Google expires the connection after 7 days.
        Cleaned videos go to the folder "content-engine clean" in that Drive and are deleted once every channel has posted.</p>
      <p class="hint">Gmail: approval and status emails go out from this account, free. First turn on the
        <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API</a>
        in the same Google Cloud project. If Google says the app is not verified, it is your own app: choose Advanced, then continue. Already connected? Press Connect once more to allow sending.</p>
      <script>
        document.getElementById('drive-ru').textContent=location.origin+'/api/v1/admin/drive/callback';
        (async function(){
          const st=document.getElementById('drive-st');
          try{
            const j=await (await fetch('/api/v1/admin/drive/status')).json();
            st.textContent=j.connected?('🟢 Connected as '+(j.email||'your Google account')+(j.gmail?' · 🟢 Gmail can send':' · 🟡 Gmail not allowed yet: press Connect')):'🟡 Not connected';
            if(j.connected) document.getElementById('drive-dc').style.display='';
          }catch(e){ st.textContent='🟡 Could not check: '+e.message; }
        })();
        async function driveDisconnect(){
          if(!confirm('Disconnect Google? GitHub cleans and Gmail sending stop until you connect again.')) return;
          await fetch('/api/v1/admin/drive/disconnect',{method:'POST'}); location.reload();
        }
      </script></div>`;
  }
  if (field.type === 'generated_secret') {
    const fid = `gs-${field.key}`;
    return `<div class="field"><label>${esc(field.label)}</label>
      <div class="row" style="gap:.4rem">
        <input id="${fid}" type="text" name="set[${esc(field.key)}]" value="${esc(has ? current : '')}"
          placeholder="click Generate" autocomplete="off" style="flex:1;min-width:220px">
        <button type="button" class="act" onclick="genSecret('${fid}')">Generate</button>
        <button type="button" class="act" onclick="copyField('${fid}')">Copy</button>
      </div>
      ${field.help ? `<p class="hint">${esc(field.help)}</p>` : ''}</div>`;
  }
  if (field.type === 'secret') {
    return `<div class="field"><label>${esc(field.label)}</label>
      <input type="password" name="set[${esc(field.key)}]" autocomplete="new-password" data-lpignore="true" data-1p-ignore
        placeholder="${has ? '•••• (set: blank keeps current)' : (field.placeholder ? esc(field.placeholder) : 'unset')}"></div>`;
  }
/**
 * What a stored secret_json may reveal about itself: the Google service-account
 * identity when it holds one, otherwise the map’s own keys. Ids are not secret:
 * the tokens they point at are, and those are never rendered.
 */
function secretJsonSummary(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return 'Configured.'; }
  if (parsed && parsed.client_email) {
    return `Configured. Share your sheets &amp; Drive folders (Editor) with: <b>${esc(parsed.client_email)}</b>`;
  }
  const ids = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  if (!ids.length) return 'Configured.';
  return `Configured for ${ids.length} id${ids.length === 1 ? '' : 's'}: <b>${esc(ids.join(', '))}</b>`;
}
  if (field.type === 'secret_json') {
    // Write-only: never echo the JSON (it holds private keys or access tokens).
    // Only the non-secret shape is surfaced, so the user can still tell what is set.
    return `<div class="field"><label>${esc(field.label)}</label>
      ${has ? `<p class="hint">🟢 ${secretJsonSummary(current)}</p>` : ''}
      <textarea name="set[${esc(field.key)}]" autocomplete="off"
        placeholder="${has ? '•••• (set: paste new JSON to replace; blank keeps current)' : (field.placeholder ? esc(field.placeholder) : 'paste the JSON here')}"></textarea>
      ${field.help ? `<p class="hint">${esc(field.help)}</p>` : ''}</div>`;
  }
  if (field.type === 'json' || field.type === 'textarea') {
    // A field with a built-in default shows it pre-filled until it's changed.
    const rows = field.rows ? ` rows="${Number(field.rows)}"` : field.default ? ' rows="12"' : '';
    return `<div class="field"><label>${esc(field.label)}</label>${field.musicPreview ? `<div>${musicPreviewButton()}</div>` : ''}${field.musicList ? musicListEditor(field.key) : ''}
      <textarea name="set[${esc(field.key)}]"${rows} placeholder="${field.placeholder ? esc(field.placeholder) : ''}">${esc(has ? current : (field.default || ''))}</textarea>
      ${field.help ? `<p class="hint">${esc(field.help)}</p>` : ''}</div>`;
  }
  return `<div class="field"><label>${esc(field.label)}</label>
    <input type="text" name="set[${esc(field.key)}]" value="${esc(has ? current : '')}" autocomplete="off"
      placeholder="${field.placeholder ? esc(field.placeholder) : ''}">
    ${field.help ? `<p class="hint">${esc(field.help)}</p>` : ''}</div>`;
}

// Monotonic id source for widgets that need unique DOM ids within a page.
let _uidSeq = 0;
function uniqueId(prefix = 'u') {
  _uidSeq += 1;
  return `${prefix}-${_uidSeq.toString(36)}`;
}

// Funnel Post-for-Me API key: a normal secret input, but with a stable id so
// the "Fetch accounts" button can read a freshly pasted key before it is saved.
function funnelKeyRow(field, cfg, fid) {
  const has = !!(cfg && cfg[field.key]);
  return `<div class="field"><label>${esc(field.label)}</label>
    <input id="pfmkey-${fid}" type="password" name="set[${esc(field.key)}]" autocomplete="new-password" data-lpignore="true" data-1p-ignore
      placeholder="${has ? '•••• (set: blank keeps current)' : 'paste your Post for Me API key'}"></div>`;
}

// Account picker: a Fetch button + checkbox list, backed by two hidden inputs
// (the id array and the id→{platform,account_name} map) the page keeps in JSON.
function pfmAccountsRow(cfg, fid) {
  let ids = [];
  let map = {};
  try { ids = JSON.parse((cfg && cfg.postforme_accounts) || '[]'); } catch { ids = []; }
  try { map = JSON.parse((cfg && cfg.account_map) || '{}'); } catch { map = {}; }
  if (!Array.isArray(ids)) ids = [];
  if (!map || typeof map !== 'object') map = {};
  const pre = ids
    .map((id) => {
      const m = map[id] || {};
      const plat = m.platform || '';
      const name = m.account_name || id;
      return `<label class="acct"><input type="checkbox" value="${esc(id)}" data-pfm="${fid}" data-plat="${esc(plat)}" data-name="${esc(name)}" onchange="syncPfm('${fid}')" checked> <b>${esc(plat)}</b>, ${esc(name)}</label>`;
    })
    .join('');
  return `<div class="field"><label>Post for Me accounts</label>
    <div class="row" style="gap:.4rem;align-items:center">
      <button type="button" class="act" onclick="fetchPfm('${fid}')">↻ Fetch accounts from Post for Me</button>
      <span id="pfmstatus-${fid}" class="hint"></span>
    </div>
    <div class="row" style="gap:.4rem;align-items:center;margin-top:.4rem">
      <select id="pfmplat-${fid}">${PFM_PLATFORMS.map((p) => `<option value="${p}">${esc(PFM_PLATFORM_LABELS[p] || p)}</option>`).join('')}</select>
      <button type="button" class="act" onclick="connectPfm('${fid}')">🔗 Connect an account</button>
      <span id="pfmconn-${fid}" class="hint"></span>
    </div>
    <script>
      window.connectPfm = window.connectPfm || async function(fid){
        const st=document.getElementById('pfmconn-'+fid);
        const platform=(document.getElementById('pfmplat-'+fid)||{}).value||'';
        st.textContent='Getting the link…'; st.style.color='';
        try{
          const h={'Content-Type':'application/json'}; if(typeof KEY!=='undefined'&&KEY) h['X-Admin-Key']=KEY;
          const r=await fetch('/api/v1/admin/funnels/connect-url',{method:'POST',headers:h,body:JSON.stringify({platform})});
          const j=await r.json();
          if(!j.ok||!j.url){ st.textContent='🔴 '+(j.error||'failed'); st.style.color='#ff9a9a'; return; }
          window.open(j.url,'_blank','noopener');
          st.textContent='🟢 Sign in on the new tab, then press Fetch accounts.'; st.style.color='#5bd08a';
        }catch(e){ st.textContent='🔴 '+(e.message||'failed'); st.style.color='#ff9a9a'; }
      };
    </script>
    <div id="pfmlist-${fid}" class="acctlist">${pre || '<span class="hint">No accounts yet: click Fetch (uses the Post for Me key from Keys and credit) and tick the accounts.</span>'}</div>
    <input type="hidden" id="pfmaccts-${fid}" name="set[postforme_accounts]" value="${esc(JSON.stringify(ids))}">
    <input type="hidden" id="pfmmap-${fid}" name="set[account_map]" value="${esc(JSON.stringify(map))}">
    <p class="hint">One click: no JSON. Tick the accounts this funnel posts to.</p></div>`;
}

/** '' or why a funnel cannot tick this many accounts on its tenant's plan. */
async function channelsReason(tenantId, accountsJson) {
  if (accountsJson === undefined || accountsJson === null || accountsJson === '') return '';
  let ids = [];
  try { ids = JSON.parse(String(accountsJson)); } catch { return ''; }
  if (!Array.isArray(ids) || !ids.length) return '';
  return planService.limitReason(tenantId, 'channels', { used: 0, adding: ids.length });
}

// The platforms a connect link can be made for (Post for Me's platform names).
const PFM_PLATFORMS = ['facebook', 'instagram', 'youtube', 'tiktok', 'tiktok_business', 'linkedin', 'x', 'threads', 'pinterest', 'bluesky'];
const PFM_PLATFORM_LABELS = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', tiktok_business: 'TikTok Business', linkedin: 'LinkedIn', x: 'X', threads: 'Threads', pinterest: 'Pinterest', bluesky: 'Bluesky' };

// Flatten Post for Me's list response into { id, platform, name } rows.
function normalizeAccounts(data) {
  const arr = Array.isArray(data)
    ? data
    : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.accounts) ? data.accounts : []));
  return arr
    .map((a) => ({
      id: String(a.id ?? a.account_id ?? a.uuid ?? ''),
      platform: String(a.platform ?? a.provider ?? a.type ?? ''),
      name: String(a.username ?? a.name ?? a.display_name ?? a.external_name ?? a.handle ?? a.id ?? ''),
    }))
    .filter((a) => a.id);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escJs(s) {
  return String(s ?? '').replace(/['\\]/g, '\\$&');
}

export default { register };
