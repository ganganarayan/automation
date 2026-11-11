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
      byId.set(id, { id, name: String(r.name || id), parentId: r.parent_id ? String(r.parent_id) : null, via: r.via === 'agency' ? 'agency' : 'member' });
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

export default { AGENCY_PLAN, mergeWorkspaces, mayEnter, pickWorkspace, clientProblem, planChangeProblem, combineLive };
