/**
 * Google Drive as the signed-in user (OAuth, drive.file scope).
 *
 * Purpose:      The one-time "Connect Google Drive": swap the consent code for a
 *               refresh token, mint short-lived access tokens from it, and keep
 *               the cleaned videos in one app folder of the user's own Drive.
 *               drive.file = the app sees only the files it made, nothing else.
 * Responsibility:
 *               - exchangeCode / refreshAccess / userEmail
 *               - ensureFolder(name): the app folder's id (found or made)
 *               - makePublic(fileId): "Anyone with the link" can read (so Post
 *                 for Me can fetch it), deleteFile(fileId), fileMeta(fileId)
 * Dependencies: global fetch.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

async function json(res, what) {
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = (body.error && (body.error.message || body.error_description || body.error)) || body.error_description || body.raw || res.status;
    throw new Error(`Google ${what} failed (${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return body;
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  return json(res, 'sign-in'); // { access_token, expires_in, refresh_token?, scope }
}

export async function refreshAccess({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  return json(res, 'token refresh'); // { access_token, expires_in }
}

export function createDriveOAuthClient(accessToken) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  return {
    async userEmail() {
      const res = await fetch(`${API}/about?fields=user(emailAddress)`, { headers: auth });
      const b = await json(res, 'account lookup');
      return (b.user && b.user.emailAddress) || '';
    },

    async ensureFolder(name, knownId = '') {
      if (knownId) {
        const res = await fetch(`${API}/files/${encodeURIComponent(knownId)}?fields=id,trashed`, { headers: auth });
        if (res.ok) {
          const f = await res.json();
          if (f && f.id && !f.trashed) return f.id;
        }
      }
      const q = `name = '${String(name).replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const found = await json(await fetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`, { headers: auth }), 'folder lookup');
      if (found.files && found.files[0]) return found.files[0].id;
      const made = await json(await fetch(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
      }), 'folder create');
      return made.id;
    },

    /** Upload a buffer into a folder (resumable, so big clips work). Returns the file id. */
    async upload(folderId, name, mimeType, buffer) {
      const type = mimeType || 'application/octet-stream';
      const start = await fetch(`${UPLOAD_API}/files?uploadType=resumable&fields=id`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(buffer.length) },
        body: JSON.stringify({ name, parents: folderId ? [folderId] : undefined }),
      });
      if (!start.ok) await json(start, 'upload start');
      const put = await fetch(start.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': type }, body: buffer });
      return (await json(put, 'upload')).id;
    },

    async makePublic(fileId) {
      await json(await fetch(`${API}/files/${encodeURIComponent(fileId)}/permissions?fields=id`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      }), 'share');
    },

    async fileMeta(fileId) {
      return json(await fetch(`${API}/files/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType,parents`, { headers: auth }), 'file lookup');
    },

    async deleteFile(fileId) {
      const res = await fetch(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers: auth });
      if (!res.ok && res.status !== 404) await json(res, 'delete');
    },
  };
}

export default { exchangeCode, refreshAccess, createDriveOAuthClient };
