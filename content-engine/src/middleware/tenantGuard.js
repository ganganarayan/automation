/**
 * Tenant guard.
 *
 * Purpose:      A signed-in person works in their own tenant only. The tenant
 *               comes from the session, not from a header, a /t/{id} path, a
 *               ?tenant= or a body.tenant: only the super admin (and the machine
 *               admin key) may ask for another tenant. Every funnel, instance,
 *               capture rule or lead id a request names must be the tenant's.
 * Responsibility:
 *               - bindTenant: set req.tenantId from the session; 403 on a foreign ask.
 *               - guardRecords: check ids in the query and body.
 *               - guardParamId: check the :id of /admin/{instances,funnels,capture/...}.
 *               - decide / recordDecision: the pure rules (tested).
 * Dependencies: accessService, ownershipRepository.
 *
 * Requests with no session (public pages, webhooks with their own secret, the
 * machine admin key) keep the tenant they resolved to, as before.
 */
import { currentSession, adminKeyOk } from '../services/accessService.js';
import * as ownership from '../repositories/ownershipRepository.js';
import { tenantInfo } from '../services/planService.js';
import { workspaceRole, roleGate } from '../utils/workspaceSpec.js';

const OWNER = 'default';

/** DD-MM-YYYY in IST (fixed +05:30), for the expired message. */
export function istDate(at) {
  const d = new Date(new Date(at).getTime() + 330 * 60000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** Body and query fields that name a record, and which table they point at. */
export const RECORD_FIELDS = [
  ['funnelId', 'funnel'], ['funnel_id', 'funnel'], ['funnel', 'funnel'],
  ['instanceId', 'instance'], ['instance_id', 'instance'],
];

/** Path prefixes whose :id is a record of this kind. */
export const PARAM_KINDS = [
  ['/admin/instances/', 'instance'],
  ['/admin/funnels/', 'funnel'],
  ['/admin/capture/rules/', 'rule'],
  ['/admin/capture/leads/', 'lead'],
];

/**
 * Which tenant a request works in.
 * @returns {{ tenantId: string, superAdmin: boolean } | { refuse: true }}
 */
export function decide({ session, resolved = OWNER, asked = [] }) {
  if (!session) return { tenantId: resolved || OWNER, superAdmin: false };
  if (session.role === 'super_admin' && !session.mustChange) return { tenantId: resolved || OWNER, superAdmin: true };
  const own = String(session.tenantId || OWNER);
  const foreign = asked.map((t) => String(t ?? '').trim()).filter(Boolean).some((t) => t !== own);
  if (foreign) return { refuse: true };
  return { tenantId: own, superAdmin: false };
}

/**
 * What to do with a record that belongs to recordTenant.
 * 'ok' | 'switch' (the operator acts in the record's tenant) | 'deny' (404).
 */
export function recordDecision({ recordTenant, tenantId, operator }) {
  if (!recordTenant) return 'ok'; // no such record: the route says not found
  if (String(recordTenant) === String(tenantId)) return 'ok';
  return operator ? 'switch' : 'deny';
}

/** Sign-in pages stay open to an expired workspace (to sign out or change a password). */
const ALWAYS_OPEN = /^\/admin\/(login|logout|password|signout|reset|workspace)(\/|$)/;

/**
 * An expired or suspended workspace may still look (GET) but not act: every
 * other admin request is refused. 'ok' | 'refuse'.
 */
export function liveGate({ method = 'GET', path = '', live = true }) {
  if (live) return 'ok';
  const p = String(path || '');
  if (!p.startsWith('/api/v1/admin/') && !p.startsWith('/admin/')) return 'ok';
  if (ALWAYS_OPEN.test(p.replace(/^\/api\/v1/, ''))) return 'ok';
  return String(method).toUpperCase() === 'GET' || String(method).toUpperCase() === 'HEAD' ? 'ok' : 'refuse';
}

/** The record ids a request names in its query and body: [[kind, id]]. */
export function namedRecords(req) {
  const out = [];
  for (const src of [req.query || {}, req.body && typeof req.body === 'object' ? req.body : {}]) {
    for (const [field, kind] of RECORD_FIELDS) {
      const v = src[field];
      if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
      out.push([kind, String(v)]);
    }
  }
  return out;
}

export function paramKind(path) {
  const p = String(path || '');
  const hit = PARAM_KINDS.find(([prefix]) => p.startsWith(prefix));
  return hit ? hit[1] : null;
}

function refuse(req, res, status) {
  const msg = status === 403 ? 'That workspace is not yours' : 'not found';
  if (req.accepts(['json', 'html']) === 'html' && req.method === 'GET') return res.status(status).type('html').send(`<p>${msg}</p>`);
  return res.status(status).json({ ok: false, error: msg });
}

/** After the body parsers: the session's tenant wins. */
export async function bindTenant(req, res, next) {
  try {
    const session = await currentSession(req);
    const asked = [req.tenantAsked, req.query && req.query.tenant, req.body && typeof req.body === 'object' ? req.body.tenant : ''];
    const d = decide({ session, resolved: req.tenantId, asked: asked.filter((v) => typeof v === 'string' || typeof v === 'number') });
    if (d.refuse) return refuse(req, res, 403);
    req.tenantId = d.tenantId;
    req.tenantOperator = d.superAdmin || (!session && adminKeyOk(req));
    // An expired or suspended workspace can look but not act.
    if (session && !d.superAdmin) {
      const info = await tenantInfo(d.tenantId).catch(() => ({ live: true }));
      if (liveGate({ method: req.method, path: req.path, live: info.live }) === 'refuse') {
        const when = info.expiresAt && info.reason === 'expired' ? ` on ${istDate(info.expiresAt)}` : '';
        return res.status(402).json({ ok: false, error: `Your plan ended${when} (${info.reason}). You can still look around; ask the owner to renew to make changes.` });
      }
    }
    // What this person is here (admin, staff, owner, viewer) and what that allows.
    req.workspaceRole = session && !d.superAdmin ? workspaceRole(session, d.tenantId) : 'admin';
    if (session && !d.superAdmin) {
      const why = roleGate({ role: req.workspaceRole, method: req.method, path: req.path, body: req.body });
      if (why) {
        if (req.accepts(['json', 'html']) === 'html' && !req.is('application/json')) return res.status(403).type('html').send(`<p>${why}</p><p><a href="javascript:history.back()">Back</a></p>`);
        return res.status(403).json({ ok: false, error: why });
      }
    }
    // Routes that read ?tenant= / body.tenant see the session's tenant too.
    if (session && !d.superAdmin) {
      if (req.query && 'tenant' in req.query) req.query.tenant = d.tenantId;
      if (req.body && typeof req.body === 'object' && 'tenant' in req.body) req.body.tenant = d.tenantId;
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

async function check(req, res, kind, id) {
  const recordTenant = await ownership.tenantOf(kind, id);
  const what = recordDecision({ recordTenant, tenantId: req.tenantId, operator: req.tenantOperator });
  if (what === 'deny') {
    req.log?.warn?.({ tenant: req.tenantId, kind, id }, 'refused another tenant\'s record');
    refuse(req, res, 404);
    return false;
  }
  if (what === 'switch') req.tenantId = recordTenant;
  return true;
}

/** Router middleware: every funnel / instance id in the query or body is the tenant's. */
export async function guardRecords(req, res, next) {
  try {
    if (!String(req.path || '').startsWith('/admin/')) return next();
    for (const [kind, id] of namedRecords(req)) {
      if (!ownership.validId(kind, id)) continue;
      if (!(await check(req, res, kind, id))) return undefined;
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/** router.param('id'): the :id of an admin record route is the tenant's. */
export async function guardParamId(req, res, next, id) {
  try {
    const kind = paramKind(req.path);
    if (!kind || !ownership.validId(kind, id)) return next();
    if (!(await check(req, res, kind, id))) return undefined;
    return next();
  } catch (err) {
    return next(err);
  }
}

export default { liveGate, bindTenant, guardRecords, guardParamId, decide, recordDecision, namedRecords, paramKind };
