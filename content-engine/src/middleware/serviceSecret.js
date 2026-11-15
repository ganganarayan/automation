/**
 * Service-secret guard for the internal MCP endpoint (/mcp-internal).
 *
 * Purpose:      Only the gateway may call it. The gateway proves itself with
 *               X-Service-Secret (env GATEWAY_SERVICE_SECRET) and says who the
 *               person is with X-User-Email, which is mapped to their home
 *               workspace here.
 * Responsibility:
 *               - requireServiceSecret(getSecret): 401 unless the header matches.
 *                 No secret configured = every call refused (closed by default).
 *               - resolveAccount(findByEmail): req.mcpAccount = { email, tenantId, role },
 *                 or a JSON-RPC error "no_account" when the email has no account.
 * Dependencies: node:crypto, settings, usersRepository.
 */
import { timingSafeEqual } from 'node:crypto';
import { settings } from '../settings/index.js';
import * as usersRepo from '../repositories/usersRepository.js';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/** A JSON-RPC error body (the MCP client reads these, not HTML). */
export function rpcError(req, code, message, data) {
  const id = req && req.body && !Array.isArray(req.body) && req.body.id !== undefined ? req.body.id : null;
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

export function requireServiceSecret(getSecret = () => settings.auth.gatewaySecret) {
  return (req, res, next) => {
    const expected = getSecret();
    if (!expected || !safeEqual(req.headers['x-service-secret'], expected)) {
      return res.status(401).json(rpcError(req, -32001, 'unauthorized'));
    }
    next();
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveAccount(findByEmail = usersRepo.findByEmail) {
  return async (req, res, next) => {
    const email = String(req.headers['x-user-email'] || '').trim().toLowerCase();
    try {
      const user = EMAIL.test(email) ? await findByEmail(email) : null;
      if (!user || !user.tenant_id) return res.status(403).json(rpcError(req, -32002, 'no_account', { error: 'no_account' }));
      req.mcpAccount = { email, tenantId: String(user.tenant_id), role: user.tenant_role || 'admin' };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export default { requireServiceSecret, resolveAccount, rpcError };
