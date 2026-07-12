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
 * Dependencies: googleapis, logger.
 */
import { Readable } from 'node:stream';
import { google } from 'googleapis';

const thumbUrl = (id) => `https://drive.google.com/thumbnail?id=${id}&sz=w1000`;
const dlUrl = (id) => `https://drive.google.com/uc?export=download&id=${id}`;

export function createGoogleDriveProvider(cfg, log) {
  if (!cfg.serviceAccount) {
    const noop = async () => {
      log.warn('Google service account not configured; Drive op skipped');
    };
    return {
      async uploadPng() {
        log.warn('Drive not configured; upload skipped');
        return { id: null, thumbnailUrl: null, downloadUrl: null };
      },
      shareAnyone: noop,
      async listFiles() {
        return [];
      },
      renameFile: noop,
      async download() {
        return Buffer.alloc(0);
      },
    };
  }

  const auth = new google.auth.GoogleAuth({
    credentials: cfg.serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  return {
    async uploadPng(folderId, name, buffer) {
      const res = await drive.files.create({
        requestBody: { name, parents: folderId ? [folderId] : undefined },
        media: { mimeType: 'image/png', body: Readable.from(buffer) },
        fields: 'id',
      });
      const id = res.data.id;
      await this.shareAnyone(id);
      return { id, thumbnailUrl: thumbUrl(id), downloadUrl: dlUrl(id) };
    },

    async shareAnyone(fileId) {
      if (!fileId) return;
      await drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    },

    async listFiles(folderId) {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name, createdTime, mimeType)',
        orderBy: 'createdTime',
        pageSize: 200,
      });
      return res.data.files || [];
    },

    async renameFile(fileId, name) {
      await drive.files.update({ fileId, requestBody: { name } });
    },

    async download(fileId) {
      const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
      return Buffer.from(res.data);
    },
  };
}

export { thumbUrl, dlUrl };
export default { createGoogleDriveProvider };
