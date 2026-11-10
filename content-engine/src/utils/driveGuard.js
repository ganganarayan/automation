/**
 * Drive file guard for tenants on the shared service account.
 *
 * Purpose:      Every tenant without its own service account uses the platform's
 *               one, which can open every file shared with it, the owner's too.
 *               A Drive id a request names must sit in one of the tenant's own
 *               funnel folders before that account downloads, shares or renames it.
 * Responsibility: inFolders (pure), guardDrive (wraps a Drive provider).
 * Dependencies: none.
 */

export const NOT_YOURS = 'That Drive file is not in one of your funnel folders.';
export const NOT_YOURS_FOLDER = 'That folder belongs to another workspace.';

/** True when any parent is one of the folders. */
export function inFolders(parents = [], folders = []) {
  const set = new Set((folders || []).map((f) => String(f || '').trim()).filter(Boolean));
  return (parents || []).some((p) => set.has(String(p)));
}

/**
 * The same Drive provider, but download / shareAnyone / renameFile first check
 * the file's parents against folders() (an async list, read once), and
 * listFiles asks listOk(folderId) first when it is given.
 */
export function guardDrive(drive, folders, { listOk = null } = {}) {
  let list = null;
  const ok = new Set();
  async function check(fileId) {
    const id = String(fileId || '');
    if (!id || ok.has(id)) return;
    if (!list) list = await folders();
    const parents = typeof drive.parentsOf === 'function' ? await drive.parentsOf(id).catch(() => []) : [];
    if (!inFolders(parents, list)) {
      const err = new Error(NOT_YOURS);
      err.status = 404;
      throw err;
    }
    ok.add(id);
  }
  return {
    ...drive,
    async download(id) { await check(id); return drive.download(id); },
    async shareAnyone(id) { await check(id); return drive.shareAnyone(id); },
    async renameFile(id, name) { await check(id); return drive.renameFile(id, name); },
    async listFiles(folderId) {
      if (listOk && !(await listOk(folderId))) {
        const err = new Error(NOT_YOURS_FOLDER);
        err.status = 404;
        throw err;
      }
      return drive.listFiles(folderId);
    },
  };
}

export default { inFolders, guardDrive, NOT_YOURS, NOT_YOURS_FOLDER };
