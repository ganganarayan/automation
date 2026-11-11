/**
 * Workspaces and agency clients (pure).
 *
 * Purpose:      The rules for which workspaces a signed-in person may work in,
 *               and for agency clients (a tenant whose parent is an Agency).
 *               docs/agency-build-plan.md, phases 1 and 2.
 * Responsibility:
 *               - mergeWorkspaces(rows, home): one list, home first, no repeats
 *               - pickWorkspace({ home, active, workspaces }): the one to work in
 *               - mayEnter(workspaces, id)
 *               - clientProblem({ parent, clients, limit }): '' or why a new client is refused
 *               - planChangeProblem({ tenant, plan, clients }): '' or why a plan change is refused
 *               - combineLive(own, parent): a client is live only while its agency is
 *               - agencyAdminOf(workspaces, home): the agency a person runs, or null
 *               - templateTenantKey / templateFunnelKey: what Add client copies
 *               - teamRole / teamProblem: agency staff
 * Dependencies: none.
 */

export const AGENCY_PLAN = 'agency';

/**
 * Rows from membershipRepository.workspacesFor ({ id, name, parent_id, via })
 * as one list: the home workspace first, then by name, each id once (a direct
 * membership wins over reaching it through the agency).
 */
export function mergeWorkspaces(rows = [], home = '') {
  const byId = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = String((r && r.id) || '').trim();
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || (prev.via !== 'member' && r.via === 'member')) {
      byId.set(id, {
        id,
        name: String(r.name || id),
        parentId: r.parent_id ? String(r.parent_id) : null,
        plan: String(r.plan || ''),
        role: String(r.role || 'admin'),
        via: r.via === 'agency' ? 'agency' : 'member',
      });
    }
  }
  const list = [...byId.values()];
  const h = String(home || '');
  return list.sort((a, b) => (a.id === h ? -1 : b.id === h ? 1 : a.name.localeCompare(b.name)));
}

export function mayEnter(workspaces = [], id = '') {
  const want = String(id || '');
  return !!want && (workspaces || []).some((w) => w && w.id === want);
}

/**
 * The workspace a session works in: the one chosen in the switcher while the
 * person may still enter it, else their home. Fails closed to home.
 */
export function pickWorkspace({ home = 'default', active = null, workspaces = [] } = {}) {
  if (active && mayEnter(workspaces, active)) return String(active);
  return String(home || 'default');
}

/**
 * Why a new client under `parent` is refused ('' = allowed).
 * @param {object} a
 * @param {object|null} a.parent  - the agency's tenants row
 * @param {number} a.clients      - how many clients it has now
 * @param {number|null} a.limit   - the plan's clients limit (null = no limit)
 */
export function clientProblem({ parent = null, clients = 0, limit = null } = {}) {
  if (!parent) return 'That agency workspace does not exist.';
  if (parent.parent_id) return 'A client cannot have clients of its own.';
  if (String(parent.plan || '') !== AGENCY_PLAN) return 'Only a workspace on the Agency plan can have clients.';
  if (limit !== null && limit !== undefined && (Number(clients) || 0) + 1 > limit) {
    return `The Agency plan allows ${limit} client${limit === 1 ? '' : 's'}. Archive one first.`;
  }
  return '';
}

/** Why changing `tenant` to `plan` is refused ('' = allowed). */
export function planChangeProblem({ tenant = null, plan = '', clients = 0 } = {}) {
  if (!tenant) return 'tenant not found';
  if (tenant.parent_id) return "A client follows its agency's plan. Change the agency's plan instead.";
  if (String(tenant.plan || '') === AGENCY_PLAN && plan !== AGENCY_PLAN && (Number(clients) || 0) > 0) {
    return `This agency has ${clients} client${clients === 1 ? '' : 's'}. Move or archive them before leaving the Agency plan.`;
  }
  return '';
}

/**
 * A client is live only while its agency is. own / parent are tenantLive()
 * results ({ live, reason }); parent is null for a top-level workspace.
 */
export function combineLive(own, parent = null) {
  if (!own || !own.live) return { live: false, reason: (own && own.reason) || 'no such workspace', by: 'own' };
  if (parent && !parent.live) return { live: false, reason: parent.reason === 'expired' ? 'expired' : `your agency's workspace is not active (${parent.reason})`, by: 'agency' };
  return { live: true, reason: '', by: '' };
}

/**
 * The agency a person runs: their home workspace when it is a top-level Agency
 * workspace and they are its admin (not staff). null otherwise.
 */
export function agencyAdminOf(workspaces = [], home = '') {
  const w = (workspaces || []).find((x) => x && x.id === String(home || ''));
  if (!w || w.parentId || w.plan !== AGENCY_PLAN || w.role !== 'admin') return null;
  return w.id;
}

// Add client copies the agency's house rules, never anything that points at the
// agency's own accounts, files, people or pages.
const TENANT_TEMPLATE = [/^system_prompt_[a-z_]+$/, /^short_music_url$/, /^music_volume$/];
const FUNNEL_NEVER = /(sheet|drive|folder|account|webhook|email|_link$|_url$|url$|landing|leads?$|_id$)/;

/** Is this tenant_config key copied from the agency to a new client? */
export function templateTenantKey(key = '') {
  return TENANT_TEMPLATE.some((re) => re.test(String(key)));
}

/** Is this funnel_config key copied from the agency's template funnel? */
export function templateFunnelKey(key = '') {
  const k = String(key || '');
  return !!k && !FUNNEL_NEVER.test(k);
}

export const TEAM_ROLES = ['admin', 'staff'];

/** A team role from a form value ('admin' unless it says staff). */
export function teamRole(v) {
  return String(v || '') === 'staff' ? 'staff' : 'admin';
}

/** Why a team change is refused ('' = allowed). Nobody demotes the last admin or themselves. */
export function teamProblem({ team = [], email = '', role = 'admin', me = '' } = {}) {
  const who = (team || []).find((t) => t.email === email);
  if (!who) return 'That person is not on your team.';
  if (role === 'staff' && email === me) return 'You cannot make yourself staff. Ask another admin.';
  const admins = (team || []).filter((t) => (t.tenant_role || 'admin') === 'admin' && t.email !== email).length;
  if (role === 'staff' && admins < 1) return 'The agency needs at least one admin.';
  return '';
}

export default { agencyAdminOf, templateTenantKey, templateFunnelKey, TEAM_ROLES, teamRole, teamProblem, AGENCY_PLAN, mergeWorkspaces, mayEnter, pickWorkspace, clientProblem, planChangeProblem, combineLive };
