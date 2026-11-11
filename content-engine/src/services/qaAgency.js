/**
 * QA phase 6: agency clients (docs/agency-build-plan.md, QA).
 *
 * Purpose:      On an Agency QA workspace (qa-agency), check that its clients
 *               stay apart: from each other, from another agency's clients and
 *               from the owner's keys; that they share the agency's plan and end
 *               with it; that the 11th client and the roles are refused.
 * Responsibility: agencyChecks(tenantId) -> check rows; the fixtures it needs.
 * Dependencies: tenantRepository, funnelsRepository, ownershipRepository,
 *               tenantSettings, planService, tenantGuard, workspaceSpec, qaSpec.
 *
 * Fixtures (no sign-in, made once): <qa>-c1 and <qa>-c2 under the QA agency,
 * qa-agency2 with qa-agency2-c1, and an expired qa-agency-exp with
 * qa-agency-exp-c1. The sibling c2 gets one switched-off funnel so a record
 * check has something to ask for. Nothing is posted and nothing is paid.
 */
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as funnelsRepo from '../repositories/funnelsRepository.js';
import * as ownership from '../repositories/ownershipRepository.js';
import * as tenantSettings from '../core/tenantSettings.js';
import * as planService from './planService.js';
import { decide, recordDecision, liveGate } from '../middleware/tenantGuard.js';
import { mergeWorkspaces, pickWorkspace, clientProblem, workspaceRole, roleGate, templateFunnelKey, AGENCY_PLAN } from '../utils/workspaceSpec.js';
import { leakedSettings } from '../utils/qaSpec.js';
import { limitsFor } from '../utils/planSpec.js';

const G = 'Phase 6 agency';
const check = (name, status, detail = '') => ({ group: G, name, status, detail: String(detail || '') });
const errText = (err) => String((err && err.message) || err || 'failed').slice(0, 240);

export const OTHER_AGENCY = 'qa-agency2';
export const EXPIRED_AGENCY = 'qa-agency-exp';
const SIBLING_FUNNEL = 'QA sibling funnel (off)';

async function ensure(id, { name, plan = AGENCY_PLAN, parentId = null, expiresAt = null }) {
  const row = await tenantRepo.findById(id);
  if (row) return row;
  return tenantRepo.createNew({ id, name, ownerEmail: '', plan, expiresAt, parentId });
}

async function fixtures(agencyId) {
  const c1 = `${agencyId}-c1`.slice(0, 31);
  const c2 = `${agencyId}-c2`.slice(0, 31);
  await ensure(c1, { name: 'QA client 1', parentId: agencyId });
  await ensure(c2, { name: 'QA client 2', parentId: agencyId });
  await ensure(OTHER_AGENCY, { name: 'QA agency 2' });
  await ensure(`${OTHER_AGENCY}-c1`, { name: 'QA agency 2 client', parentId: OTHER_AGENCY });
  await ensure(EXPIRED_AGENCY, { name: 'QA expired agency', expiresAt: new Date(Date.now() - 86400000) });
  await ensure(`${EXPIRED_AGENCY}-c1`, { name: 'QA expired agency client', parentId: EXPIRED_AGENCY });
  let funnel = await funnelsRepo.findByName(c2, SIBLING_FUNNEL);
  if (!funnel) {
    funnel = await funnelsRepo.create({ tenantId: c2, name: SIBLING_FUNNEL });
    await funnelsRepo.setActive(funnel.id, false);
  }
  tenantSettings.invalidate();
  planService.invalidate();
  return { c1, c2, other: `${OTHER_AGENCY}-c1`, expired: `${EXPIRED_AGENCY}-c1`, siblingFunnel: funnel.id };
}

/** The phase 6 rows for one QA workspace. */
export async function agencyChecks(tenantId) {
  const agency = await tenantRepo.findById(tenantId);
  if (!agency || agency.parent_id || agency.plan !== AGENCY_PLAN || tenantId === OTHER_AGENCY || tenantId === EXPIRED_AGENCY) {
    return [check('Agency clients', 'skip', 'runs on a top-level Agency QA workspace, e.g. qa-agency')];
  }
  const out = [];
  let f;
  try {
    f = await fixtures(tenantId);
  } catch (err) {
    return [check('Agency fixtures', 'fail', errText(err))];
  }

  // Who may enter which workspace (the session rules, as the switcher uses them).
  const kids = await tenantRepo.childrenOf(tenantId);
  const adminWs = mergeWorkspaces([
    { id: tenantId, name: agency.name, parent_id: null, plan: AGENCY_PLAN, role: 'admin', via: 'member' },
    ...kids.map((k) => ({ id: k.id, name: k.name, parent_id: tenantId, plan: k.plan, role: 'admin', via: 'agency' })),
  ], tenantId);
  const opens = pickWorkspace({ home: tenantId, active: f.c1, workspaces: adminWs }) === f.c1;
  out.push(check('Agency admin opens its client', opens ? 'ok' : 'fail', opens ? `the switcher moves into ${f.c1}` : `${f.c1} could not be opened`));
  const foreign = pickWorkspace({ home: tenantId, active: f.other, workspaces: adminWs }) === tenantId;
  out.push(check("Another agency's client", foreign ? 'ok' : 'fail', foreign ? `${f.other} is refused, the session stays home` : `${f.other} could be opened`));
  const clientWs = mergeWorkspaces([{ id: f.c1, name: 'c1', parent_id: tenantId, plan: AGENCY_PLAN, role: 'admin', via: 'member' }], f.c1);
  const sib = pickWorkspace({ home: f.c1, active: f.c2, workspaces: clientWs }) === f.c1
    && decide({ session: { role: 'admin', tenantId: f.c1, mustChange: false }, resolved: f.c1, asked: [f.c2] }).refuse === true;
  out.push(check('Client and its sibling', sib ? 'ok' : 'fail', sib ? `${f.c1} cannot open or ask for ${f.c2}` : `${f.c1} reached ${f.c2}`));
  try {
    const d = recordDecision({ recordTenant: await ownership.tenantOf('funnel', f.siblingFunnel), tenantId: f.c1, operator: false });
    out.push(check("Sibling's funnel by id", d === 'deny' ? 'ok' : 'fail', d === 'deny' ? `${f.c1} gets "not found" for ${f.c2}'s funnel` : `${f.c1} would get "${d}"`));
  } catch (err) { out.push(check("Sibling's funnel by id", 'fail', errText(err))); }

  // Keys: a client never uses the owner's.
  try {
    const [c, owner] = await Promise.all([tenantSettings.forTenant(f.c1), tenantSettings.forTenant('default')]);
    const yours = Object.entries(c.keyOwners || {}).filter(([p, who]) => who === 'platform' && p !== 'google' && p !== 'github').map(([p]) => p);
    const leaks = leakedSettings(c, owner);
    out.push(check('Client keys', yours.length || leaks.length ? 'fail' : 'ok', yours.length ? `uses your key for ${yours.join(', ')}` : leaks.length ? `your values show: ${leaks.join(', ')}` : 'its own or the agency\'s keys only, none of yours'));
    const sc = c.postformeScope;
    const pfmOk = !c.postformeKey || (sc && sc.tenantId === f.c1 && !sc.owner) || (!sc && c.postformeKey !== (owner.postformeKey || ''));
    out.push(check('Client Post for Me accounts', pfmOk ? 'ok' : 'fail', !c.postformeKey ? 'no Post for Me key yet' : sc ? `scoped to ${sc.tenantId}'s own accounts, events on ${sc.keyTenant}'s webhook` : 'a key of its own'));
  } catch (err) { out.push(check('Client keys', 'fail', errText(err))); }

  // One plan, counted together; the clients end with the agency.
  try {
    planService.invalidate();
    const info = await planService.tenantInfo(f.c1);
    const pooled = info.plan === AGENCY_PLAN && [tenantId, f.c1, f.c2].every((t) => info.pool.includes(t)) && !info.pool.includes(f.other);
    out.push(check('Shared plan and posts', pooled ? 'ok' : 'fail', pooled ? `${f.c1} is on the Agency plan; posts counted across ${info.pool.length} workspace(s)` : `plan ${info.plan}, pool ${info.pool.join(', ')}`));
    const ex = await planService.tenantInfo(f.expired);
    const jobs = (await tenantRepo.activeIds()).includes(f.expired);
    const act = liveGate({ method: 'POST', path: '/api/v1/admin/funnels', live: ex.live });
    const ends = !ex.live && !jobs && act === 'refuse';
    out.push(check('Client ends with its agency', ends ? 'ok' : 'fail', ends ? `${f.expired} is look-only and out of the daily jobs` : `${f.expired}: live ${ex.live}, in jobs ${jobs}`));
  } catch (err) { out.push(check('Shared plan and posts', 'fail', errText(err))); }

  // Limits, roles and the template.
  const limit = limitsFor(AGENCY_PLAN).clients;
  const eleventh = clientProblem({ parent: agency, clients: limit, limit });
  const now = await planService.clientReason(tenantId).catch((err) => errText(err));
  out.push(check(`Client ${limit + 1}`, eleventh ? 'ok' : 'fail', eleventh ? `refused: "${eleventh}"${now ? ` (this agency is full now: ${now})` : ''}` : `number ${limit + 1} would be allowed`));
  const owner = workspaceRole({ role: 'admin', workspaces: clientWs }, f.c1);
  const gates = owner === 'owner'
    && !!roleGate({ role: 'owner', method: 'POST', path: '/api/v1/admin/settings/save', body: { app: 'api-keys' } })
    && !!roleGate({ role: 'viewer', method: 'POST', path: '/api/v1/admin/instances/x/approve' })
    && !roleGate({ role: 'owner', method: 'POST', path: '/api/v1/admin/instances/x/approve' });
  out.push(check('Roles', gates ? 'ok' : 'fail', gates ? 'a client user is its owner; owners approve but not change keys; viewers change nothing' : 'a role rule let something through'));
  const tpl = !templateFunnelKey('postforme_accounts') && !templateFunnelKey('drive_folder_id') && !templateFunnelKey('approval_email') && templateFunnelKey('publish_time');
  out.push(check('Add client template', tpl ? 'ok' : 'fail', tpl ? 'copies style and times, never accounts, Drive or emails' : 'the template copies something it must not'));
  return out;
}

export default { agencyChecks, OTHER_AGENCY, EXPIRED_AGENCY };
