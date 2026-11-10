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

const OWNER = 'default';

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

export default { bindTenant, guardRecords, guardParamId, decide, recordDecision, namedRecords, paramKind };
