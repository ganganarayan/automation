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
 *               - workspaceRole(session, tenantId): admin | staff | owner | viewer
 *               - roleGate({ role, method, path, body }): '' or why it is refused
 *               - accessChoices / accessRole: what Users may add in a workspace
 * Dependencies: none.
 *
 * Roles (docs/agency-build-plan.md, phase 4): admin does everything; staff
 * (an agency's, in its own or an assigned client's workspace) and owner (a
 * client's own people) work but never change keys, plans, QA or the waker;
 * viewer only looks.
 */

export const AGENCY_PLAN = 'agency';

/**
 * Rows from membershipRepository.workspacesFor ({ id, name, parent_id, via })
 * as one list: the home workspace first, then by name, each id once (reaching
 * it as the agency's admin wins over a direct membership: it carries more rights).
 */
export function mergeWorkspaces(rows = [], home = '') {
  const byId = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = String((r && r.id) || '').trim();
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || (prev.via !== 'agency' && r.via === 'agency')) {
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

export const ROLE_LABEL = { admin: 'admin', staff: 'agency staff', owner: 'client owner', viewer: 'client viewer' };

/**
 * What the signed-in person is in the workspace they work in. No session (the
 * machine key, public pages) is left to each route. A workspace missing from
 * the list (it could not be read) is look-only: fail closed.
 */
export function workspaceRole(session = null, tenantId = '') {
  if (!session) return 'admin';
  if (session.role === 'super_admin') return 'admin';
  // A session built without a workspace list (older callers, the QA check) keeps its rights.
  if (!Array.isArray(session.workspaces)) return 'admin';
  const w = session.workspaces.find((x) => x && x.id === String(tenantId || ''));
  if (!w) return 'viewer';
  if (w.via === 'agency') return 'admin';
  if (w.role === 'staff') return 'staff';
  if (w.role === 'viewer') return 'viewer';
  return w.parentId ? 'owner' : 'admin';
}

const OPEN = /^\/admin\/(login|logout|password|signout|reset|workspace)(\/|$)/;
const ADMIN_ONLY = /^\/admin\/(tenants|qa|users\/(role|plan)|credit|cloudflare-wake|wake-schedule|router\/rerun|clients)(\/|$)/;

/** '' when `role` may make this request, else the reason a person reads. */
export function roleGate({ role = 'admin', method = 'GET', path = '', body = null } = {}) {
  if (role === 'admin') return '';
  const p = String(path || '').replace(/^\/api\/v1/, '');
  if (!p.startsWith('/admin/')) return '';
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || OPEN.test(p)) return '';
  if (role === 'viewer') return 'You can look around this workspace but not change anything. Ask its owner.';
  if (ADMIN_ONLY.test(p)) return 'Only an admin can do that.';
  const app = body && typeof body === 'object' ? String(body.app || '') : '';
  if (p === '/admin/settings/save' && app === 'api-keys') return 'Only an admin changes keys.';
  if (p === '/admin/users/add' && role === 'staff') return 'Ask an agency admin to add people.';
  return '';
}

/**
 * What a person may give someone they add in Users: [] = the old plain user
 * form (a standalone workspace). kind: 'agency' | 'client' | 'standalone'.
 */
export function accessChoices(kind = 'standalone', role = 'admin') {
  if (kind === 'client') return role === 'admin' ? ['owner', 'viewer'] : role === 'owner' ? ['viewer'] : [];
  if (kind === 'agency') return role === 'admin' ? ['admin', 'staff'] : [];
  return [];
}

/** The tenant_role to store for a picked access ('' = not allowed). */
export function accessRole(kind, role, picked) {
  const choices = accessChoices(kind, role);
  if (!choices.length) return kind === 'standalone' ? 'admin' : '';
  return choices.includes(String(picked || '')) ? String(picked) : '';
}

/** A workspace row's kind. */
export function kindOf(row) {
  if (!row) return 'standalone';
  if (row.parent_id) return 'client';
  return String(row.plan || '') === AGENCY_PLAN ? 'agency' : 'standalone';
}

export default { ROLE_LABEL, workspaceRole, roleGate, accessChoices, accessRole, kindOf, agencyAdminOf, templateTenantKey, templateFunnelKey, TEAM_ROLES, teamRole, teamProblem, AGENCY_PLAN, mergeWorkspaces, mayEnter, pickWorkspace, clientProblem, planChangeProblem, combineLive };
