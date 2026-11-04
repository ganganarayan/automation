/**
 * ✂ Clean on GitHub Actions + one-time Google Drive connect (pure: no I/O).
 *
 * Purpose:      Everything the GitHub clean runner and the Drive connect need
 *               that can be tested without a network: the signed job ticket the
 *               workflow carries back to the app, the Drive OAuth URLs, and the
 *               workflow_dispatch request.
 * Responsibility:
 *               - signTicket / readTicket: an HMAC-signed, expiring job ticket
 *                 (base64url JSON + "." + sha256 HMAC). The workflow holds only
 *                 this: no app key, no Post for Me key.
 *               - driveAuthUrl / DRIVE_SCOPE: the consent-screen link
 *               - dispatchRequest: the GitHub API call that starts the workflow
 *               - keepSecFor: seconds to keep after cutting the outro
 *               - normalizeRunner: 'railway' | 'github'
 * Dependencies: node:crypto.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const CLEAN_WORKFLOW = 'clean-video.yml';
export const DEFAULT_REPO = 'ganganarayan/automation';
// A ticket outlives a slow runner queue + a 10-minute video encode, not much more.
export const TICKET_TTL_MS = 3 * 60 * 60 * 1000;

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const mac = (secret, body) => createHmac('sha256', String(secret)).update(body).digest('base64url');

/** A signed job ticket: payload + expiry, readable only by whoever holds the secret. */
export function signTicket(payload, secret, now = Date.now(), ttlMs = TICKET_TTL_MS) {
  if (!secret) throw new Error('signTicket needs a secret');
  const body = b64u(JSON.stringify({ ...payload, exp: now + ttlMs }));
  return `${body}.${mac(secret, body)}`;
}

/** The ticket's payload without checking it, only to find which tenant's secret to check it with. */
export function peekTicket(ticket) {
  const [body] = String(ticket || '').split('.');
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) || null; } catch { return null; }
}

/** The payload when the signature matches and it hasn't expired, else null. */
export function readTicket(ticket, secret, now = Date.now()) {
  if (!secret) return null;
  const [body, sig, extra] = String(ticket || '').split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const p = peekTicket(ticket);
  if (!p || !(Number(p.exp) > now)) return null;
  return p;
}

/** Google's consent screen for the one-time connect, Drive + send-only Gmail (offline = a refresh token). */
export function driveAuthUrl({ clientId, redirectUri, state }) {
  if (!clientId) throw new Error('Set the OAuth client ID first (Setup → Settings → Google)');
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `${DRIVE_SCOPE} ${GMAIL_SCOPE}`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

/** owner/name, or '' when it doesn't look like one. */
export function normalizeRepo(repo) {
  const r = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : '';
}

/** The GitHub REST call that starts the clean workflow on `ref`. */
export function dispatchRequest({ repo, token, ref, hook, ticket }) {
  const r = normalizeRepo(repo);
  if (!r) throw new Error('GitHub repo must look like owner/name');
  if (!token) throw new Error('No GitHub token: set it under Setup → Keys and credit → Video clean');
  return {
    url: `https://api.github.com/repos/${r}/actions/workflows/${CLEAN_WORKFLOW}/dispatches`,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: ref || 'main', inputs: { hook, ticket } }),
    },
  };
}

/** Seconds to keep once the last `trimEndSec` are cut (0 = keep it all). */
export function keepSecFor(totalSec, trimEndSec) {
  if (!(Number(trimEndSec) > 0)) return 0;
  if (!(Number(totalSec) > 0)) throw new Error("couldn't read the video's length to trim its end");
  return Math.max(1, Math.round((Number(totalSec) - Number(trimEndSec)) * 10) / 10);
}

/** Where ✂ Clean runs: 'railway' (default) or 'github'. */
export function normalizeRunner(v) {
  return String(v || '').trim().toLowerCase() === 'github' ? 'github' : 'railway';
}

export default { DRIVE_SCOPE, GMAIL_SCOPE, CLEAN_WORKFLOW, DEFAULT_REPO, signTicket, peekTicket, readTicket, driveAuthUrl, normalizeRepo, dispatchRequest, keepSecFor, normalizeRunner };
