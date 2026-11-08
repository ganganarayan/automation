/**
 * Your music from a Drive folder.
 *
 * Purpose:      Let the own-music box hold a folder link: every audio file in
 *               it can play, and a .txt with the same name holds its credit,
 *               the way the ready-video folder pairs a video with its .txt.
 * Responsibility:
 *               - expandMusic(shortMusic): folder lines become "link | credit"
 *                 lines, so pickMusic works as before. Other lines stay.
 *               - folderMusic(link): [{ name, url, credit }] for one folder.
 * Dependencies: publicDriveProvider (the folder is shared "Anyone with the
 *               link", like the ready-video folder), utils/{readyPostSpec,shortSpec}.
 *
 * A folder that cannot be read is left out (the other links, then the
 * built-in track, play instead), so a post never fails over music.
 */
import { createPublicDriveProvider, publicDlUrl } from '../providers/publicDriveProvider.js';
import { parseDriveFolderId } from '../utils/readyPostSpec.js';
import { isMusicFolder, musicFolderPairs } from '../utils/shortSpec.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'musicFolder' });

async function readText(fileId) {
  const res = await fetch(publicDlUrl(fileId), { headers: { 'User-Agent': 'Mozilla/5.0 (content-engine)' } });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || type.includes('text/html')) return '';
  return (await res.text()).slice(0, 2000);
}

/** The audio files of one folder with their credits: [{ name, url, credit }]. */
export async function folderMusic(link) {
  const id = parseDriveFolderId(link);
  if (!id) return [];
  const files = await createPublicDriveProvider(log).listFiles(id);
  const pairs = musicFolderPairs(files);
  return Promise.all(pairs.map(async (p) => ({
    name: p.name,
    url: publicDlUrl(p.id),
    credit: p.textId ? (await readText(p.textId).catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300) : '',
  })));
}

/** { track, url } with each folder line swapped for its files' "link | credit" lines. */
export async function expandMusic(shortMusic = {}) {
  const text = String((shortMusic && shortMusic.url) || '');
  if (!text.split(/\r?\n/).some((l) => isMusicFolder(l.split('|')[0]))) return shortMusic;
  const lines = await Promise.all(text.split(/\r?\n/).map(async (line) => {
    const link = line.split('|')[0].trim();
    if (!isMusicFolder(link)) return [line];
    try {
      return (await folderMusic(link)).map((m) => (m.credit ? `${m.url} | ${m.credit}` : m.url));
    } catch (err) {
      log.warn({ err: err.message }, 'music folder could not be read; its files are left out');
      return [];
    }
  }));
  return { ...shortMusic, url: lines.flat().join('\n') };
}

export default { expandMusic, folderMusic };
