/**
 * One-click cancel rules (pure).
 *
 * Purpose:      Who may cancel a workspace's plan, and where the exit
 *               assessment link sends them afterwards.
 * Responsibility: cancelProblem, exitLink, validExitUrl.
 * Dependencies: none.
 *
 * Cancelling stops the renewal only: the workspace keeps working until its
 * expiry (docs: /refund). A client workspace is paid for by its agency, and the
 * operator's own workspace ('default') has nothing to cancel.
 */

export const OWNER_TENANT = 'default';
export const EXIT_KEY = 'exit_assessment_url';

/**
 * Why this person may not cancel this workspace ('' = they may).
 * @param {{ tenant: object|null, role?: string, superAdmin?: boolean }} p
 */
export function cancelProblem({ tenant = null, role = 'admin', superAdmin = false } = {}) {
  if (!tenant) return 'No such workspace.';
  if (String(tenant.id) === OWNER_TENANT) return 'This is the owner\'s own workspace; there is no plan to cancel.';
  if (tenant.parent_id) return 'This workspace is on your agency\'s plan. Your agency cancels it.';
  if (tenant.status === 'archived') return 'This workspace is archived.';
  if (!superAdmin && role !== 'admin') return 'Only a workspace admin can cancel the plan.';
  return '';
}

/** An http(s) link the owner may save as the exit assessment ('' clears it). */
export function validExitUrl(url) {
  const s = String(url || '').trim();
  if (!s) return true;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The exit assessment link for one workspace: the owner's link with the
 * workspace id and plan added, so each answer is tied to its tenant. Nothing
 * personal (no email or name) goes in the address. '' when no link is set.
 */
export function exitLink(base, { tenantId = '', plan = '' } = {}) {
  if (!base || !validExitUrl(base)) return '';
  const u = new URL(String(base).trim());
  if (tenantId) u.searchParams.set('tenant', String(tenantId));
  if (plan) u.searchParams.set('plan', String(plan));
  return u.toString();
}

export default { OWNER_TENANT, EXIT_KEY, cancelProblem, validExitUrl, exitLink };
