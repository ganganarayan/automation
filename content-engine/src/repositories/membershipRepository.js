/**
 * Workspace membership data access.
 *
 * Purpose:      Which workspaces a person may work in (docs/agency-build-plan.md).
 * Responsibility: The only place tenant_members SQL runs.
 * Dependencies: core/db.
 *
 * A person may work in: their home workspace (users.tenant_id), any workspace
 * in tenant_members, and, as an admin of a top-level Agency workspace, every
 * client of that agency.
 */
import { query } from '../core/db.js';

/** Rows { id, name, parent_id, via: 'member' | 'agency' } (may repeat an id). */
export async function workspacesFor(email) {
  const { rows } = await query(
    `WITH mine AS (
       SELECT u.tenant_id, u.role FROM users u WHERE u.email = $1
       UNION
       SELECT m.tenant_id, m.role FROM tenant_members m WHERE m.email = $1
     )
     SELECT t.id, t.name, t.parent_id, 'member' AS via
       FROM mine JOIN tenants t ON t.id = mine.tenant_id
     UNION ALL
     SELECT c.id, c.name, c.parent_id, 'agency' AS via
       FROM mine
       JOIN tenants a ON a.id = mine.tenant_id AND a.plan = 'agency' AND a.parent_id IS NULL
       JOIN tenants c ON c.parent_id = a.id
      WHERE mine.role = 'admin'`,
    [String(email || '')],
  );
  return rows;
}

export default { workspacesFor };
