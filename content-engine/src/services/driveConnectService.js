/**
 * One-time Google Drive connect (one per tenant, not per funnel).
 *
 * Purpose:      Hold the tenant's Drive refresh token, hand out short-lived
 *               access tokens, and keep one app folder ("content-engine clean")
 *               where the GitHub clean runner drops the cleaned videos.
 * Responsibility:
 *               - hookSecret(tenantId): the per-tenant HMAC secret for clean job
 *                 tickets (made on first use, kept in tenant_config)
 *               - connectUrl / finishConnect / disconnect / status
 *               - accessToken(tenantId): a cached access token (refreshed ~5 min early)
 *               - drive(tenantId): a Drive client for that token
 * Dependencies: tenantConfigRepository, tenantSettings, driveOAuthProvider, cleanHookSpec.
 *
 * Stored in tenant_config (never shown in the UI): google_drive_refresh_token,
 * google_drive_email, google_drive_folder_id, clean_hook_secret.
 */
import { randomBytes } from 'node:crypto';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { exchangeCode, refreshAccess, createDriveOAuthClient } from '../providers/driveOAuthProvider.js';
import { driveAuthUrl, signTicket, readTicket } from '../utils/cleanHookSpec.js';

export const FOLDER_NAME = 'content-engine clean';
const K = {
  refresh: 'google_drive_refresh_token',
  email: 'google_drive_email',
  folder: 'google_drive_folder_id',
  secret: 'clean_hook_secret',
};

const MEDIA_FOLDER_NAME = 'content-engine media';
const mediaFolders = new Map(); // tenantId -> folder id
const tokens = new Map(); // tenantId -> { token, until }

export const redirectUri = (baseUrl) => `${String(baseUrl).replace(/\/+$/, '')}/api/v1/admin/drive/callback`;

/** The tenant's signing secret for clean job tickets and the connect `state`. */
export async function hookSecret(tenantId = 'default') {
  const have = await tenantConfig.get(tenantId, K.secret);
  if (have) return have;
  const made = randomBytes(32).toString('base64url');
  await tenantConfig.set(tenantId, K.secret, made);
  tenantSettings.invalidate(tenantId);
  return made;
}

async function client(tenantId) {
  const g = (await tenantSettings.forTenant(tenantId)).google;
  if (!g.oauthClientId || !g.oauthClientSecret) {
    throw new Error('Set the Google OAuth client ID and client secret first (Setup → Settings → Google)');
  }
  return { clientId: g.oauthClientId, clientSecret: g.oauthClientSecret };
}

/** Google's consent link; `state` is a short signed ticket so the callback knows it started here. */
export async function connectUrl({ tenantId = 'default', baseUrl, email = '' }) {
  const { clientId } = await client(tenantId);
  const state = signTicket({ t: tenantId, k: 'drive', e: email }, await hookSecret(tenantId), Date.now(), 15 * 60 * 1000);
  return driveAuthUrl({ clientId, redirectUri: redirectUri(baseUrl), state });
}

/** The tenant a callback's `state` belongs to, or null when it isn't ours / expired. */
export async function stateTenant(state, peekTenant) {
  const tenantId = peekTenant || 'default';
  const p = readTicket(state, await hookSecret(tenantId));
  return p && p.k === 'drive' ? p.t : null;
}

/** Swap the consent code for a refresh token, find/make the app folder, remember the account. */
export async function finishConnect({ tenantId = 'default', baseUrl, code }) {
  const c = await client(tenantId);
  const tok = await exchangeCode({ ...c, code, redirectUri: redirectUri(baseUrl) });
  const refresh = tok.refresh_token || (await tenantConfig.get(tenantId, K.refresh));
  if (!refresh) throw new Error('Google sent no refresh token, remove the app at myaccount.google.com/permissions and connect again');
  const drive = createDriveOAuthClient(tok.access_token);
  const email = await drive.userEmail().catch(() => '');
  const folderId = await drive.ensureFolder(FOLDER_NAME, await tenantConfig.get(tenantId, K.folder));
  await tenantConfig.set(tenantId, K.refresh, refresh);
  await tenantConfig.set(tenantId, K.email, email);
  await tenantConfig.set(tenantId, K.folder, folderId);
  tenantSettings.invalidate(tenantId);
  tokens.set(tenantId, { token: tok.access_token, until: Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 5 * 60 * 1000 });
  return { email, folderId };
}

export async function disconnect(tenantId = 'default') {
  for (const k of [K.refresh, K.email, K.folder]) await tenantConfig.del(tenantId, k);
  tokens.delete(tenantId);
  tenantSettings.invalidate(tenantId);
}

/** { connected, email, folderId }, for the settings page and the clean runner. */
export async function status(tenantId = 'default') {
  const [refresh, email, folderId] = await Promise.all([K.refresh, K.email, K.folder].map((k) => tenantConfig.get(tenantId, k)));
  return { connected: !!refresh, email: email || '', folderId: folderId || '' };
}

/** A live access token (cached until ~5 min before it expires). */
export async function accessToken(tenantId = 'default') {
  const hit = tokens.get(tenantId);
  if (hit && hit.until > Date.now()) return hit.token;
  const refresh = await tenantConfig.get(tenantId, K.refresh);
  if (!refresh) throw new Error('Google Drive is not connected. Setup → Settings → Google → Connect Google Drive');
  const tok = await refreshAccess({ ...(await client(tenantId)), refreshToken: refresh });
  tokens.set(tenantId, { token: tok.access_token, until: Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 5 * 60 * 1000 });
  return tok.access_token;
}

/** A Drive client acting as the connected account, plus the app folder id. */
export async function drive(tenantId = 'default') {
  const token = await accessToken(tenantId);
  const d = createDriveOAuthClient(token);
  let folderId = await tenantConfig.get(tenantId, K.folder);
  if (!folderId) {
    folderId = await d.ensureFolder(FOLDER_NAME);
    await tenantConfig.set(tenantId, K.folder, folderId);
  }
  return { token, folderId, client: d };
}

/**
 * Keep generated media in the connected account (its own app folder, apart from
 * the clean runner's) and share it by link. Returns the file id; throws when
 * Drive is not connected.
 */
export async function uploadMedia(tenantId, name, mimeType, buffer) {
  const client = createDriveOAuthClient(await accessToken(tenantId));
  const folderId = await client.ensureFolder(MEDIA_FOLDER_NAME, mediaFolders.get(tenantId) || '');
  mediaFolders.set(tenantId, folderId);
  const id = await client.upload(folderId, name, mimeType, buffer);
  await client.makePublic(id);
  return id;
}

export default { FOLDER_NAME, uploadMedia, redirectUri, hookSecret, connectUrl, stateTenant, finishConnect, disconnect, status, accessToken, drive };
