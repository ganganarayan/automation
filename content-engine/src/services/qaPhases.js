/**
 * QA check, one group per multi-tenant phase (docs/multi-tenant-build-plan.md).
 *
 * Purpose:      Prove each phase on the live server, as a QA workspace, against
 *               your real records: the doors (sessions, record ids, Drive ids,
 *               Post for Me), no leaks, lifecycle and limits, billing, and the
 *               shared Meta / Google / Clean integrations.
 * Responsibility: doorChecks, leakChecks, lifecycleChecks, billingChecks,
 *               sharedChecks, EXPIRED_ID.
 * Dependencies: the real guards and repositories (never a copy of their logic).
 *
 * Reads only, except: the qa-expired fixture workspace (made once, already
 * expired, no sign-in), the QA workspace's own key history and Google ticket secret.
 */
import { randomBytes } from 'node:crypto';
import * as tenantSettings from '../core/tenantSettings.js';
import { query } from '../core/db.js';
import { buildProviders } from './providerFactory.js';
import * as planService from './planService.js';
import * as captureConfig from './captureConfig.js';
import * as creditService from './creditService.js';
import * as driveConnect from './driveConnectService.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as funnelsRepo from '../repositories/funnelsRepository.js';
import * as ownership from '../repositories/ownershipRepository.js';
import * as usage from '../repositories/usageRepository.js';
import * as users from '../repositories/usersRepository.js';
import { recordDecision, decide, liveGate } from '../middleware/tenantGuard.js';
import { guardDrive, NOT_YOURS } from '../utils/driveGuard.js';
import { claimedIds } from '../utils/metaRoute.js';
import { signTicket } from '../utils/cleanHookSpec.js';
import { limitsFor } from '../utils/planSpec.js';
import { leakedSettings, keyFindings, accountFindings, metaFindings, keyHistoryFinding } from '../utils/qaSpec.js';

export const EXPIRED_ID = 'qa-expired';
const TIMEOUT = 60_000;

const check = (group, name, status, detail = '') => ({ group, name, status, detail: String(detail || '') });
const errText = (err) => String((err && err.message) || err || 'failed').slice(0, 240);
const timed = (fn) => Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), TIMEOUT))]);

// ---- phase 1: lock the doors ----------------------------------------------------

const OWNER_RECORDS = [['funnel', 'funnels'], ['instance', 'instances'], ['rule', 'keyword_rules'], ['lead', 'captured_leads']];

export async function doorChecks(tenantId, p) {
  const G = 'Phase 1 doors';
  const out = [];

  // Which workspace a request works in: the session's, whatever it asks for.
  const user = { role: 'admin', tenantId, mustChange: false };
  const asks = decide({ session: user, resolved: 'default', asked: ['default'] });
  const plain = decide({ session: user, resolved: 'default', asked: [] });
  const sup = decide({ session: { role: 'super_admin', tenantId: 'default', mustChange: false }, resolved: tenantId, asked: [tenantId] });
  out.push(check(G, 'Asking for your workspace', asks.refuse ? 'ok' : 'fail', asks.refuse ? 'a QA user asking for yours by header, path, ?tenant= or body gets 403' : 'a QA user could ask for your workspace'));
  out.push(check(G, 'Session decides the workspace', plain.tenantId === tenantId ? 'ok' : 'fail', plain.tenantId === tenantId ? 'a QA user on the plain URL works in its own workspace' : `a QA user on the plain URL lands in "${plain.tenantId}"`));
  out.push(check(G, 'Super admin may switch', !sup.refuse && sup.tenantId === tenantId ? 'ok' : 'fail', !sup.refuse ? `you opening ${tenantId} work there` : 'you were refused'));

  // One record of each kind of yours, asked for by id by a QA user.
  for (const [kind, table] of OWNER_RECORDS) {
    try {
      const { rows } = await query(`SELECT id FROM ${table} WHERE tenant_id = 'default' LIMIT 1`);
      if (!rows[0]) { out.push(check(G, `Your ${kind} by id`, 'skip', `you have no ${kind} to try`)); continue; }
      const d = recordDecision({ recordTenant: await ownership.tenantOf(kind, rows[0].id), tenantId, operator: false });
      out.push(check(G, `Your ${kind} by id`, d === 'deny' ? 'ok' : 'fail', d === 'deny' ? 'a QA user gets "not found"' : `a QA user would get "${d}"`));
    } catch (err) { out.push(check(G, `Your ${kind} by id`, 'fail', errText(err))); }
  }

  const funnels = await funnelsRepo.listByTenant(tenantId);
  const stray = funnels.filter((f) => String(f.tenant_id) !== String(tenantId));
  out.push(check(G, 'Funnel list', stray.length ? 'fail' : 'ok', stray.length ? `${stray.length} funnel(s) of another tenant listed` : `${funnels.length} funnel(s), all its own`));
  const people = await users.list({ tenantId });
  const strayUsers = people.filter((u) => String(u.tenant_id) !== String(tenantId));
  out.push(check(G, 'Users list', strayUsers.length ? 'fail' : 'ok', strayUsers.length ? `${strayUsers.length} user(s) of another tenant listed` : `${people.length} user(s), all its own, none of yours`));

  out.push(...(await driveChecks(tenantId, p, funnels)));

  // Post for Me: what this tenant sees, and how many the owner has on the same key.
  try {
    if (!p.resolved.postformeKey) {
      out.push(check(G, 'Post for Me accounts', 'warn', 'no Post for Me key at all (yours is not set either)'));
    } else {
      const seen = await timed(() => p.publish.listAccounts());
      let ownerCount = null;
      try { ownerCount = ((await timed(async () => (await buildProviders('default')).publish.listAccounts())).data || []).length; } catch { ownerCount = null; }
      out.push(...accountFindings(seen.data || [], tenantId, { ownerCount }));
      out.push(check(G, 'Post for Me key', 'ok', p.resolved.postformeShared ? 'uses your shared key, scoped to its own accounts' : 'its own key'));
    }
  } catch (err) { out.push(check(G, 'Post for Me accounts', 'fail', errText(err))); }
  return out;
}

/** On the shared service account a Drive id outside its funnel folders is refused. */
async function driveChecks(tenantId, p, funnels) {
  const G = 'Phase 1 doors';
  const g = p.resolved.google || {};
  if (!g.serviceAccount) return [check(G, 'Your Drive file by id', 'skip', 'no service account at all')];
  if (!g.serviceAccountShared) return [check(G, 'Your Drive file by id', 'ok', 'it has its own service account: it only opens what is shared with it')];
  try {
    const { rows } = await query(`SELECT c.value FROM funnel_config c JOIN funnels f ON f.id = c.funnel_id
       WHERE f.tenant_id = 'default' AND c.key IN ('drive_folder_id', 'direct_drive_folder') AND c.value <> '' LIMIT 1`);
    const folder = rows[0] ? (String(rows[0].value).match(/[A-Za-z0-9_-]{20,}/) || [''])[0] : '';
    if (!folder) return [check(G, 'Your Drive file by id', 'skip', 'none of your funnels has a Drive folder to try')];
    const mineFolders = async () => {
      const list = [];
      for (const f of funnels) {
        const cfg = await funnelsRepo.getConfig(f.id).catch(() => ({}));
        list.push(cfg.direct_drive_folder, cfg.drive_folder_id);
      }
      return list;
    };
    let refused = false;
    let why = 'it downloaded';
    try { await timed(() => guardDrive(p.storage, mineFolders).download(folder)); } catch (err) { refused = err.message === NOT_YOURS; why = errText(err); }
    const claim = await ownership.driveFolderTenants(folder);
    return [
      check(G, 'Your Drive file by id', refused ? 'ok' : 'fail', refused ? 'an id from your funnel folder is refused before any download' : `not refused by the guard: ${why}`),
      check(G, 'Pasting your Drive folder', claim.includes('default') && !claim.includes(tenantId) ? 'ok' : 'warn', `that folder belongs to: ${claim.join(', ') || 'nobody'}, so another tenant pasting it is refused`),
    ];
  } catch (err) { return [check(G, 'Your Drive file by id', 'fail', errText(err))]; }
}

// ---- phase 2: stop leaks ----------------------------------------------------------

export async function leakChecks(tenantId, mine, owner) {
  const G = 'Phase 2 leaks';
  const overrides = await tenantConfig.getAll(tenantId).catch(() => ({}));
  const leaks = leakedSettings(mine, owner);
  const ids = await tenantRepo.activeIds();
  return [
    check(G, 'Owner settings', leaks.length ? 'fail' : 'ok', leaks.length ? `your values show here: ${leaks.join(', ')}` : `none of yours show here (${Object.keys(overrides).length} own setting(s))`),
    check(G, 'Background jobs reach it', ids.includes(tenantId) ? 'ok' : 'warn', ids.includes(tenantId) ? `daily jobs loop over ${ids.length} live workspace(s), this one included` : 'not in the live list (expired or suspended?)'),
  ];
}

// ---- phase 3: lifecycle -----------------------------------------------------------

async function expiredFixture() {
  if (await tenantRepo.findById(EXPIRED_ID)) return;
  await tenantRepo.createNew({ id: EXPIRED_ID, name: 'QA expired', ownerEmail: '', plan: 'starter', expiresAt: new Date(Date.now() - 24 * 3600 * 1000) });
  tenantSettings.invalidate();
  planService.invalidate();
}

export async function lifecycleChecks(tenantId) {
  const G = 'Phase 3 lifecycle';
  const out = [];
  planService.invalidate(tenantId);
  const info = await planService.tenantInfo(tenantId);
  out.push(check(G, 'Workspace live', info.live ? 'ok' : 'warn', info.live ? `${limitsFor(info.plan).label}, live` : `not live: ${info.reason}`));
  const lim = limitsFor(info.plan);
  const now = { funnels: await funnelsRepo.countByTenant(tenantId), users: await users.countForTenant(tenantId), channels: 0, posts: null, aiVideos: null };
  for (const what of ['funnels', 'channels', 'posts', 'aiVideos', 'users']) {
    const max = lim[what];
    if (max === null || max === undefined) { out.push(check(G, `Limit: ${what}`, 'ok', 'no limit on this plan')); continue; }
    const over = await planService.limitReason(tenantId, what, { used: max, adding: 1 });
    const full = await planService.limitReason(tenantId, what, { used: now[what], adding: 1 });
    out.push(check(G, `Limit: ${what}`, over ? 'ok' : 'fail', over ? `one past ${max} is refused${full ? ' (already full now)' : ''}` : `number ${max + 1} would be allowed`));
  }
  const mu = await planService.monthUsage(tenantId).catch(() => null);
  if (mu) out.push(check(G, 'This month', 'ok', `${mu.posts} post(s), ${mu.aiVideos} AI video day(s) counted`));

  // An expired workspace may look, may not act, and gets no jobs.
  try {
    await expiredFixture();
    planService.invalidate(EXPIRED_ID);
    const ex = await planService.tenantInfo(EXPIRED_ID);
    const act = liveGate({ method: 'POST', path: '/api/v1/admin/funnels', live: ex.live });
    const look = liveGate({ method: 'GET', path: '/api/v1/admin/settings', live: ex.live });
    const jobs = (await tenantRepo.activeIds()).includes(EXPIRED_ID);
    const posting = await planService.limitReason(EXPIRED_ID, 'posts', { used: 0, adding: 1 });
    out.push(check(G, 'Expired: not live', !ex.live ? 'ok' : 'fail', !ex.live ? `${EXPIRED_ID} reads "${ex.reason}"` : `${EXPIRED_ID} still counts as live`));
    out.push(check(G, 'Expired: looks, cannot act', look === 'ok' && act === 'refuse' ? 'ok' : 'fail', `pages ${look === 'ok' ? 'open' : 'refused'}, changes ${act === 'refuse' ? 'refused' : 'allowed'}`));
    out.push(check(G, 'Expired: no jobs, no posts', !jobs && posting ? 'ok' : 'fail', `${jobs ? 'still in' : 'left out of'} the daily jobs; posting ${posting ? 'refused' : 'allowed'}`));
  } catch (err) { out.push(check(G, 'Expired workspace', 'fail', errText(err))); }
  return { out, plan: info.plan };
}

// ---- phase 4: billing -------------------------------------------------------------

export async function billingChecks(tenantId, mine, plan) {
  const G = 'Phase 4 billing';
  const out = [...keyFindings(mine.keyOwners, plan)];
  // The key history is written in the background on a read that sees a change.
  await new Promise((r) => setTimeout(r, 1500));
  tenantSettings.invalidate(tenantId);
  const again = await tenantSettings.forTenant(tenantId);
  out.push(keyHistoryFinding(again.keyHistory, again.keyOwners));
  try {
    const items = await creditService.balances(tenantId);
    const yours = items.filter((it) => (mine.keyOwners || {})[it.key] === 'platform');
    out.push(check(G, 'Your balances hidden', yours.length ? 'fail' : 'ok', yours.length ? `shows your balance for ${yours.map((i) => i.key).join(', ')}` : `${items.length} balance(s) shown, none for your keys`));
  } catch (err) { out.push(check(G, 'Your balances hidden', 'warn', errText(err))); }
  try {
    const rows = (await usage.monthCosts({ months: 1 })).filter((r) => String(r.tenant_id) === tenantId);
    const usd = rows.reduce((t, r) => t + (Number(r.usd) || 0), 0);
    out.push(check(G, 'Cost report', 'ok', `reads; this month $${usd.toFixed(4)} on this workspace (${rows.length} row(s))`));
  } catch (err) { out.push(check(G, 'Cost report', 'fail', errText(err))); }
  return out;
}

/** After paid calls: they are on the ledger, on this workspace. */
export async function ledgerCheck(tenantId, spent = []) {
  try {
    const { rows } = await query(`SELECT count(*)::int AS n, coalesce(sum(cost_usd), 0)::float AS usd FROM usage_ledger
       WHERE tenant_id = $1 AND source = 'qa check' AND at > now() - interval '15 minutes'`, [tenantId]);
    const want = spent.filter((n) => Number(n) > 0).length;
    return check('Phase 4 billing', 'Paid calls on the ledger', rows[0].n >= want ? 'ok' : 'fail', `${rows[0].n} row(s) in the last 15 min, $${Number(rows[0].usd).toFixed(4)}, on ${tenantId}`);
  } catch (err) { return check('Phase 4 billing', 'Paid calls on the ledger', 'fail', errText(err)); }
}

// ---- phase 5: shared integrations ---------------------------------------------------

export async function sharedChecks(tenantId, mine, owner) {
  const G = 'Phase 5 shared';
  const out = [];
  try {
    captureConfig.forgetOwners();
    const owners = await captureConfig.accountOwners();
    out.push(metaFindings(claimedIds(await captureConfig.forTenant('default')), owners));
    const qaIds = claimedIds(await captureConfig.forTenant(tenantId));
    out.push(check(G, 'Meta ids it claims', 'ok', qaIds.length ? `${qaIds.length} id(s), routed to it` : 'none, so every delivery stays yours'));
  } catch (err) { out.push(check(G, 'Meta webhook routing', 'fail', errText(err))); }

  const g = mine.google || {};
  out.push(check(G, 'Google sign-in', g.oauthShared && !g.oauthClientId ? 'warn' : 'ok', g.oauthShared ? (g.oauthClientId ? 'uses your OAuth client set (never mixed)' : 'shared, but you have no OAuth client set') : 'its own OAuth client'));
  try {
    const secret = await driveConnect.hookSecret(tenantId);
    const own = signTicket({ t: tenantId, k: 'drive' }, secret, Date.now(), 60_000);
    const forged = signTicket({ t: tenantId, k: 'drive' }, randomBytes(32).toString('base64url'), Date.now(), 60_000);
    const okOwn = (await driveConnect.stateTenant(own, tenantId)) === tenantId;
    const okForged = (await driveConnect.stateTenant(forged, tenantId)) === null;
    out.push(check(G, 'Google connect ticket', okOwn && okForged ? 'ok' : 'fail', `its own ticket ${okOwn ? 'accepted' : 'refused'}, one signed elsewhere ${okForged ? 'refused' : 'accepted'}`));
  } catch (err) { out.push(check(G, 'Google connect ticket', 'fail', errText(err))); }

  const c = mine.clean || {};
  const whole = !c.shared || (c.githubToken === ((owner.clean || {}).githubToken || '') && c.githubRepo === ((owner.clean || {}).githubRepo || ''));
  out.push(check(G, 'Clean runner', !whole ? 'fail' : (c.shared && !c.githubToken ? 'warn' : 'ok'), !whole ? 'not your whole set (token and repo mixed)' : (c.shared ? (c.githubToken ? `your GitHub runner (${c.githubRepo || 'default repo'}); its job tickets carry ${tenantId}` : 'shared, but you have no GitHub token set') : 'its own GitHub token')));
  const cmp = mine.comparison || {};
  out.push(check(G, 'Your comparison list', !cmp.builtIn ? 'ok' : 'fail', !cmp.builtIn ? 'the built-in Assess360 list stays yours' : 'it gets your built-in comparison list'));
  return out;
}

// ---- the real front door: HTTP through every middleware, as a stranger ------------

/**
 * Loopback requests to this server with no cookie and no key: admin pages, a QA
 * workspace's pages, the QA check itself and a job route must all turn it away.
 * Nothing here can change anything: every request is refused before any work.
 */
export async function httpChecks(tenantId, port) {
  const G = 'HTTP front door';
  const base = `http://127.0.0.1:${port}`;
  const hit = async (method, path, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? '{}' : undefined, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return { status: res.status, to: res.headers.get('location') || '' };
  };
  const turnedAway = (r) => r.status === 401 || r.status === 403 || ((r.status === 302 || r.status === 303) && /login/.test(r.to));
  const cases = [
    ['Your settings page', 'GET', '/api/v1/admin/settings', {}],
    ['QA settings by path', 'GET', `/t/${tenantId}/api/v1/admin/settings`, {}],
    ['QA settings by header', 'GET', '/api/v1/admin/settings', { 'X-Tenant': tenantId }],
    ['Make a funnel', 'POST', `/t/${tenantId}/api/v1/admin/funnels`, {}],
    ['Run the QA check', 'POST', '/api/v1/admin/qa/run', {}],
    ['Make a tenant', 'POST', '/api/v1/admin/tenants/new', {}],
    ['Wake the router', 'POST', '/api/v1/jobs/router-check', {}],
    ['Wrong machine key', 'POST', '/api/v1/jobs/router-check', { 'X-Admin-Key': 'qa-wrong-key' }],
  ];
  const out = [];
  for (const [name, method, path, headers] of cases) {
    try {
      const r = await hit(method, path, headers);
      out.push(check(G, `Stranger: ${name}`, turnedAway(r) ? 'ok' : 'fail', turnedAway(r) ? `turned away (${r.status}${r.to ? ' to sign-in' : ''})` : `got ${r.status} ${r.to}`));
    } catch (err) { out.push(check(G, `Stranger: ${name}`, 'warn', errText(err))); }
  }
  for (const path of ['/health', '/ready', '/api/version']) {
    try {
      const r = await hit('GET', path);
      out.push(check(G, `Open: ${path}`, r.status === 200 ? 'ok' : 'fail', `answered ${r.status}`));
    } catch (err) { out.push(check(G, `Open: ${path}`, 'fail', errText(err))); }
  }
  return out;
}

export default { EXPIRED_ID, doorChecks, leakChecks, lifecycleChecks, billingChecks, ledgerCheck, sharedChecks, httpChecks };
