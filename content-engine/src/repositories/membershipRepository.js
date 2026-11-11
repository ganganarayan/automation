/**
 * Workspace membership data access.
 *
 * Purpose:      Which workspaces a person may work in (docs/agency-build-plan.md).
 * Responsibility: The only place tenant_members SQL runs.
 * Dependencies: core/db.
 *
 * A person may work in: their home workspace (users.tenant_id), any workspace
 * in tenant_members, and, as an admin (users.tenant_role) of a top-level Agency
 * workspace, every client of that agency. Agency staff reach only the clients
 * listed for them here.
 */
import { query } from '../core/db.js';

/** Rows { id, name, parent_id, plan, role, via: 'member' | 'agency' } (may repeat an id). */
export async function workspacesFor(email) {
  const { rows } = await query(
    `WITH mine AS (
       SELECT u.tenant_id, u.tenant_role AS role FROM users u WHERE u.email = $1
       UNION
       SELECT m.tenant_id, m.role FROM tenant_members m WHERE m.email = $1
     )
     SELECT t.id, t.name, t.parent_id, t.plan, mine.role, 'member' AS via
       FROM mine JOIN tenants t ON t.id = mine.tenant_id
     UNION ALL
     SELECT c.id, c.name, c.parent_id, c.plan, mine.role, 'agency' AS via
       FROM mine
       JOIN tenants a ON a.id = mine.tenant_id AND a.plan = 'agency' AND a.parent_id IS NULL
       JOIN tenants c ON c.parent_id = a.id
      WHERE mine.role = 'admin'`,
    [String(email || '')],
  );
  return rows;
}

/** An agency's own people with their role and the clients each staff member may open. */
export async function teamOf(agencyId) {
  const { rows } = await query(
    `SELECT u.email, u.tenant_role, u.last_login_at,
            COALESCE(array_agg(m.tenant_id ORDER BY m.tenant_id) FILTER (WHERE m.tenant_id IS NOT NULL), '{}') AS clients
       FROM users u
       LEFT JOIN tenant_members m ON m.email = u.email
        AND m.tenant_id IN (SELECT id FROM tenants WHERE parent_id = $1)
      WHERE u.tenant_id = $1
      GROUP BY u.email, u.tenant_role, u.last_login_at
      ORDER BY u.email`,
    [agencyId],
  );
  return rows;
}

/**
 * Set a person's role in their agency and, for staff, the clients they may open.
 * Memberships in other workspaces are left alone. Admins keep no client rows
 * (they reach every client).
 */
export async function setTeamMember(agencyId, email, role, clientIds = []) {
  await query("UPDATE users SET tenant_role = $3 WHERE email = $1 AND tenant_id = $2", [email, agencyId, role]);
  await query('DELETE FROM tenant_members WHERE email = $1 AND tenant_id IN (SELECT id FROM tenants WHERE parent_id = $2)', [email, agencyId]);
  if (role !== 'staff') return;
  for (const id of clientIds) {
    await query(
      `INSERT INTO tenant_members (email, tenant_id, role)
       SELECT $1, t.id, 'staff' FROM tenants t WHERE t.id = $2 AND t.parent_id = $3
       ON CONFLICT (email, tenant_id) DO UPDATE SET role = 'staff'`,
      [email, id, agencyId],
    );
  }
}

export default { workspacesFor, teamOf, setTeamMember };
