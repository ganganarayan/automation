/**
 * Agency service.
 *
 * Purpose:      An agency's own screen (docs/agency-build-plan.md, phase 3):
 *               its clients with today's numbers, Add client, Archive and
 *               Bring back, and which clients each staff member may open.
 * Responsibility:
 *               - overview(agencyId): clients, their numbers, the plan pool, the team
 *               - addClient(agencyId, form): a new client workspace and its owner's sign-in
 *               - setArchived(agencyId, clientId, archived)
 *               - setTeam(agencyId, me, form)
 * Dependencies: tenantRepository, usersRepository, funnelsRepository,
 *               tenantConfigRepository, membershipRepository, workViewRepository,
 *               planService, tenantSettings, accessService, cloudflareWakeService.
 *
 * Every action names the agency from the session (never from the request), and
 * every client it touches must be a child of that agency.
 */
import { randomBytes } from 'node:crypto';
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as users from '../repositories/usersRepository.js';
import * as funnelsRepo from '../repositories/funnelsRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as membership from '../repositories/membershipRepository.js';
import * as views from '../repositories/workViewRepository.js';
import * as planService from './planService.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { invalidateWorkspaces } from './accessService.js';
import * as cloudflareWake from './cloudflareWakeService.js';
import { hashPassword, hashToken } from '../utils/passwordSpec.js';
import { sendInvite } from './inviteService.js';
import { settings } from '../settings/index.js';
import { formatIst } from '../utils/time.js';
import { monthRange, costCsv, rollupMail, rollupDue } from '../utils/agencyReport.js';
import { buildProviders } from './providerFactory.js';
import { limitsFor, validTenantId } from '../utils/planSpec.js';
import { AGENCY_PLAN, templateTenantKey, templateFunnelKey, teamRole, teamProblem } from '../utils/workspaceSpec.js';
import { DAILY_KEY, dailyTimeOf } from '../utils/cloudflareWake.js';
import { NEEDS_YOU_STATUSES } from '../utils/libraryStatus.js';
import { nowIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'agency' });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function agencyRow(agencyId) {
  const row = agencyId ? await tenantRepo.findById(String(agencyId)) : null;
  if (!row || row.parent_id || row.plan !== AGENCY_PLAN) throw new Error('This workspace is not an agency.');
  return row;
}

async function clientOf(agencyId, clientId) {
  const row = clientId ? await tenantRepo.findById(String(clientId)) : null;
  if (!row || String(row.parent_id || '') !== String(agencyId)) throw new Error('That client is not yours.');
  return row;
}

/** Everything the Clients page shows. */
export async function overview(agencyId) {
  const agency = await agencyRow(agencyId);
  const clients = await tenantRepo.childrenOf(agency.id);
  const now = nowIst();
  const day = now.startOf('day');
  const month = now.startOf('month');
  const stats = await views.clientStats({
    tenantIds: [agency.id, ...clients.map((c) => String(c.id))],
    dayFromUtc: day.toUTC().toISO(),
    dayToUtc: day.plus({ days: 1 }).toUTC().toISO(),
    monthFromUtc: month.toUTC().toISO(),
    monthToUtc: month.plus({ months: 1 }).toUTC().toISO(),
    needsYou: NEEDS_YOU_STATUSES,
  }).catch((err) => { log.warn({ err: err.message }, 'client numbers not read'); return []; });
  const byId = new Map(stats.map((s) => [String(s.tenant_id), s]));
  const times = {};
  for (const c of clients) times[c.id] = dailyTimeOf(await tenantConfig.get(String(c.id), DAILY_KEY).catch(() => ''));
  const usage = await planService.monthUsage(agency.id).catch(() => null);
  const lim = limitsFor(agency.plan);
  return {
    agency,
    clients: clients.map((c) => ({ ...c, dailyTime: times[c.id], stats: byId.get(String(c.id)) || null })),
    own: byId.get(String(agency.id)) || null,
    active: clients.filter((c) => c.status !== 'archived').length,
    limit: lim.clients,
    posts: usage ? usage.posts : null,
    postsLimit: lim.posts,
    funnels: await funnelsRepo.listByTenant(agency.id).catch(() => []),
    team: await membership.teamOf(agency.id).catch(() => []),
    month: month.toFormat('yyyy-MM'),
  };
}

/**
 * Copy the agency's house rules into a new client: system prompts and the
 * Music box, and optionally one of its funnels as the client's first funnel
 * (style and times only: never accounts, sheets, Drive, emails, links or leads).
 * @returns {Promise<{ settings: number, funnel: string|null }>}
 */
export async function copyTemplate(agencyId, clientId, templateFunnelId = null) {
  let settings = 0;
  const all = await tenantConfig.getAll(String(agencyId)).catch(() => ({}));
  for (const [k, v] of Object.entries(all || {})) {
    if (!templateTenantKey(k) || v === null || v === undefined || v === '') continue;
    await tenantConfig.set(String(clientId), k, v);
    settings += 1;
  }
  let funnel = null;
  if (templateFunnelId) {
    const f = await funnelsRepo.get(Number(templateFunnelId)).catch(() => null);
    if (f && String(f.tenant_id) === String(agencyId)) {
      const made = await funnelsRepo.create({ tenantId: String(clientId), name: f.name });
      const cfg = await funnelsRepo.getConfig(f.id);
      for (const [k, v] of Object.entries(cfg || {})) {
        if (templateFunnelKey(k) && v !== null && v !== undefined && v !== '') await funnelsRepo.setConfig(made.id, k, v);
      }
      funnel = made.name;
    }
  }
  return { settings, funnel };
}

/**
 * A new client workspace on the agency's plan, its owner's sign-in (a one-time
 * password, shown once) and the template.
 */
export async function addClient(agencyId, b = {}) {
  const agency = await agencyRow(agencyId);
  const id = String(b.id || '').trim().toLowerCase();
  const email = String(b.owner_email || '').trim().toLowerCase();
  const name = String(b.name || id).trim().slice(0, 80);
  if (!validTenantId(id)) throw new Error('Client id: 2 to 31 lower-case letters, digits or dashes');
  if (!EMAIL_RE.test(email)) throw new Error("The client owner's email is not valid");
  if (await users.findByEmail(email)) throw new Error('That email already has an account');
  if (await tenantRepo.findById(id)) throw new Error('That client id is taken');
  const why = await planService.clientReason(agency.id);
  if (why) throw new Error(why);
  const tenant = await tenantRepo.createNew({ id, name, ownerEmail: email, phone: String(b.phone || '').trim().slice(0, 30), plan: AGENCY_PLAN, expiresAt: null, parentId: agency.id });
  const tempPassword = randomBytes(9).toString('base64url');
  await users.createForTenant({ email, tenantId: tenant.id, role: 'admin', passwordHash: await hashPassword(tempPassword) });
  await tenantConfig.set(tenant.id, DAILY_KEY, dailyTimeOf(b.daily_time));
  const copied = await copyTemplate(agency.id, tenant.id, b.template ? String(b.template) : null)
    .catch((err) => { log.warn({ err: err.message, client: tenant.id }, 'template not copied'); return { settings: 0, funnel: null }; });
  afterChange();
  const invite = await sendInvite({ tenantId: tenant.id, email, tempPassword, access: 'owner' });
  log.info({ agency: agency.id, client: tenant.id, copied, emailed: invite.sent }, 'client added');
  return { tenant: tenant.id, email, tempPassword, copied, emailed: invite.sent, emailError: invite.error || '' };
}

/** Archive (look-only, no jobs, not counted in the 10) or bring a client back. */
export async function setArchived(agencyId, clientId, archived) {
  const agency = await agencyRow(agencyId);
  const client = await clientOf(agency.id, clientId);
  if (archived) {
    if (client.status !== 'archived') await tenantRepo.setStatus(client.id, 'archived');
  } else if (client.status === 'archived') {
    const why = await planService.clientReason(agency.id);
    if (why) throw new Error(why);
    await tenantRepo.setStatus(client.id, 'active');
  }
  afterChange();
  log.info({ agency: agency.id, client: client.id, archived: !!archived }, 'client archive changed');
  return { ok: true };
}

/** Make someone admin or staff; staff get the ticked clients only. */
export async function setTeam(agencyId, me, b = {}) {
  const agency = await agencyRow(agencyId);
  const email = String(b.email || '').trim().toLowerCase();
  const role = teamRole(b.role);
  const team = await membership.teamOf(agency.id);
  const why = teamProblem({ team, email, role, me: String(me || '').toLowerCase() });
  if (why) throw new Error(why);
  const kids = new Set((await tenantRepo.childrenOf(agency.id)).map((c) => String(c.id)));
  const picked = (Array.isArray(b.clients) ? b.clients : [b.clients]).map((c) => String(c || '')).filter((c) => kids.has(c));
  await membership.setTeamMember(agency.id, email, role, picked);
  invalidateWorkspaces(email);
  return { ok: true, role, clients: role === 'staff' ? picked : [] };
}

/** The cost CSV of the agency and every client for one IST month ('YYYY-MM'). */
export async function costCsvFor(agencyId, ym = '') {
  const agency = await agencyRow(agencyId);
  const clients = await tenantRepo.childrenOf(agency.id);
  const names = { [agency.id]: `${agency.name} (own)` };
  for (const c of clients) names[c.id] = c.name;
  const range = monthRange(ym);
  const rows = await views.costRows({ tenantIds: Object.keys(names), fromUtc: range.fromUtc, toUtc: range.toUtc });
  return { csv: costCsv(rows, names), filename: `${agency.id}-costs-${range.label}.csv`, rows: rows.length };
}

// A moved-out client gets a week on its new plan: the owner then renews it on Tenants.
const MOVE_OUT_DAYS = 7;
const MOVE_OUT_PLANS = ['starter', 'growth'];

/**
 * Move a client out: it becomes its own workspace on Starter or Growth, keeps
 * its funnels, posts, people and history, and stops using the agency's keys.
 * Channels connected on the agency's own Post for Me key must be connected again.
 */
export async function detachClient(agencyId, clientId, plan = 'starter') {
  const agency = await agencyRow(agencyId);
  const client = await clientOf(agency.id, clientId);
  const p = MOVE_OUT_PLANS.includes(String(plan)) ? String(plan) : 'starter';
  const expires = new Date(Date.now() + MOVE_OUT_DAYS * 86400000);
  await tenantRepo.detach(client.id, p, expires);
  await tenantConfig.set(String(client.id), 'connect_link', '').catch(() => {});
  afterChange();
  log.info({ agency: agency.id, client: client.id, plan: p }, 'client moved out');
  return { ok: true, plan: p, expires: formatIst(expires, { withTime: false }) };
}

/**
 * Each agency's evening roll-up: once a day after 20:00 IST, to the agency's
 * notification email, else its owner. Called after the daily emails.
 */
export async function rollupAll(now = new Date()) {
  const list = await tenantRepo.list().catch(() => []);
  for (const t of list) {
    const row = await tenantRepo.findById(String(t.id)).catch(() => null);
    if (!row || row.parent_id || row.plan !== AGENCY_PLAN || row.status !== 'active') continue;
    await rollupOne(row, now).catch((err) => log.warn({ agency: row.id, err: err.message }, 'agency roll-up not sent'));
  }
}

async function rollupOne(agency, now) {
  const when = rollupDue({ now, lastDay: await tenantConfig.get(agency.id, 'agency_rollup_on').catch(() => '') });
  if (!when.due) return false;
  const data = await overview(agency.id);
  const mail = rollupMail({ agencyName: agency.name, clients: data.clients, stats: data.clients.map((c) => c.stats).filter(Boolean), day: when.label, base: settings.app.publicBaseUrl });
  if (!mail) { await tenantConfig.set(agency.id, 'agency_rollup_on', when.day); return false; }
  const providers = await buildProviders(agency.id);
  const to = (providers.resolved && providers.resolved.emails && providers.resolved.emails.notify) || agency.owner_email || '';
  if (!to) return false;
  await providers.mail.send({ to, subject: mail.subject, html: mail.html });
  await tenantConfig.set(agency.id, 'agency_rollup_on', when.day);
  log.info({ agency: agency.id, ...mail.counts }, 'agency roll-up sent');
  return true;
}

const CONNECT_DAYS = 7;

/**
 * A link the client opens without signing in to connect its own channels
 * (each platform's own sign-in; nobody shares a password). Only the token's
 * sha256 is kept; a new link replaces the old one. Valid 7 days.
 */
export async function connectLink(agencyId, clientId) {
  const agency = await agencyRow(agencyId);
  const client = await clientOf(agency.id, clientId);
  const token = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + CONNECT_DAYS * 86400000);
  await tenantConfig.set(String(client.id), 'connect_link', `${hashToken(token)}|${expires.toISOString()}`);
  const base = String(settings.app.publicBaseUrl || '').replace(/\/+$/, '');
  return { url: `${base}/api/v1/connect/${token}`, expires: formatIst(expires) };
}

function afterChange() {
  tenantSettings.invalidate();
  planService.invalidate();
  invalidateWorkspaces();
  cloudflareWake.syncTimes().catch((err) => log.warn({ err: err.message }, 'daily times not synced to Cloudflare (the next daily run syncs it)'));
}

export default { overview, copyTemplate, addClient, setArchived, setTeam, connectLink, costCsvFor, detachClient, rollupAll };
