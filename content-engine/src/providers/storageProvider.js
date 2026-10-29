/**
 * Storage provider (interface + Google Drive implementation).
 *
 * Purpose:      Upload generated media, share it, list/rename source files, and
 *               download source assets (voiceovers, brand strip, reels).
 * Responsibility:
 *               - uploadPng(folderId, name, buffer): { id, thumbnailUrl, downloadUrl }
 *               - shareAnyone(fileId)
 *               - listFiles(folderId): [{ id, name, createdTime }]
 *               - renameFile(fileId, name)
 *               - download(fileId): Buffer
 *
 *               Two identities: the workspace service account (cfg.serviceAccount),
 *               or — for files the operator picked with "Sign in with Google" —
 *               the operator's own short-lived access token (cfg.accessToken,
 *               drive.file scope: only the picked files are reachable).
 * Dependencies: googleapis, logger.
 */
import { Readable } from 'node:stream';
import { google } from 'googleapis';

const thumbUrl = (id) => `https://drive.google.com/thumbnail?id=${id}&sz=w1000`;
const dlUrl = (id) => `https://drive.google.com/uc?export=download&id=${id}`;

const NOT_CONNECTED = 'Google Drive is not connected — use 📂 Pick from Drive (Sign in with Google), or paste the service-account JSON under Settings → Workspace → Google (Sheets & Drive access)';

export function createGoogleDriveProvider(cfg, log) {
  if (!cfg.serviceAccount && !cfg.accessToken) {
    const noop = async () => {
      log.warn('Google service account not configured; Drive op skipped');
    };
    return {
      async uploadPng() {
        log.warn('Drive not configured; upload skipped');
        return { id: null, thumbnailUrl: null, downloadUrl: null };
      },
      async uploadMedia() {
        log.warn('Drive not configured; upload skipped');
        return { id: null, thumbnailUrl: null, downloadUrl: null };
      },
      shareAnyone: noop,
      // Reads can't be skipped quietly — an empty list / empty file looks like
      // "no videos" and hides the real problem, so say what to set.
      async listFiles() {
        throw new Error(NOT_CONNECTED);
      },
      renameFile: noop,
      async download() {
        throw new Error(NOT_CONNECTED);
      },
    };
  }

  let auth;
  if (cfg.accessToken) {
    auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: cfg.accessToken });
  } else {
    auth = new google.auth.GoogleAuth({
      credentials: cfg.serviceAccount,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  }
  const drive = google.drive({ version: 'v3', auth });

  return {
    /** Upload any media buffer (mp3 / mp4 / png / …) and share it. */
    async uploadMedia(folderId, name, mimeType, buffer) {
      const res = await drive.files.create({
        requestBody: { name, parents: folderId ? [folderId] : undefined },
        media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buffer) },
        fields: 'id',
      });
      const id = res.data.id;
      await this.shareAnyone(id);
      return { id, thumbnailUrl: thumbUrl(id), downloadUrl: dlUrl(id) };
    },

    async uploadPng(folderId, name, buffer) {
      return this.uploadMedia(folderId, name, 'image/png', buffer);
    },

    async shareAnyone(fileId) {
      if (!fileId) return;
      await drive.permissions.create({
        fileId,
        supportsAllDrives: true,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    },

    async listFiles(folderId) {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name, createdTime, mimeType)',
        orderBy: 'createdTime',
        pageSize: 200,
        // Folders on a shared drive only list with these set.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return res.data.files || [];
    },

    async renameFile(fileId, name) {
      await drive.files.update({ fileId, supportsAllDrives: true, requestBody: { name } });
    },

    async download(fileId) {
      const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      return Buffer.from(res.data);
    },
  };
}

export { thumbUrl, dlUrl };
export default { createGoogleDriveProvider };
