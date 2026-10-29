/**
 * Public Google Drive reader — no key, no sign-in.
 *
 * Purpose:      Read a Drive folder shared "Anyone with the link" without any
 *               Google credentials, so the ready-video lanes work from a pasted
 *               folder link alone.
 * Responsibility:
 *               - listFiles(folderId): [{ id, name, mimeType, createdTime }]
 *                 (Google's public embedded folder view, parsed)
 *               - download(fileId): Buffer (public download endpoint)
 *               - shareAnyone / renameFile: no-ops — the folder is already public,
 *                 and "posted" is tracked in the app's own instances instead.
 * Dependencies: global fetch, logger.
 */
import { parseEmbeddedFolder } from '../utils/readyPostSpec.js';

const ua = { 'User-Agent': 'Mozilla/5.0 (content-engine)' };

/** Direct public download URL — confirm=t skips the large-file virus-scan page. */
export const publicDlUrl = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

export function createPublicDriveProvider(log) {
  return {
    async listFiles(folderId) {
      const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`, { headers: ua });
      if (!res.ok) {
        throw new Error(`Drive returned ${res.status} — check the folder link, and that the folder is shared "Anyone with the link"`);
      }
      const files = parseEmbeddedFolder(await res.text());
      log.info({ folderId, files: files.length }, 'public drive folder listed');
      return files;
    },

    async download(fileId) {
      const res = await fetch(publicDlUrl(fileId), { headers: ua });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || type.includes('text/html')) {
        throw new Error('Could not download the video — make sure its folder is shared "Anyone with the link"');
      }
      return Buffer.from(await res.arrayBuffer());
    },

    async shareAnyone() {},
    async renameFile() {},
  };
}

export default { createPublicDriveProvider, publicDlUrl };
