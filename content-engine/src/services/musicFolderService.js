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

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A credit file's text. Drive sometimes answers a burst of downloads with a web
 * page instead of the file, so each file is tried on both of Drive's download
 * addresses, twice, before it counts as having no credit.
 */
async function readText(fileId) {
  const urls = [publicDlUrl(fileId), `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`];
  for (let round = 0; round < 2; round++) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (content-engine)' }, signal: AbortSignal.timeout(15000) });
        const type = res.headers.get('content-type') || '';
        if (res.ok && !type.includes('text/html')) return (await res.text()).slice(0, 4000);
      } catch { /* the next address, or the next round */ }
    }
    await pause(800);
  }
  log.warn({ fileId }, 'credit file could not be read (Drive gave a web page); the track has no credit');
  return '';
}

/** The audio files of one folder with their credits: [{ name, url, credit }]. */
/** A credit file's text: every line kept, spaces tidied, empty lines dropped. */
export function creditText(text = '') {
  return String(text || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

export async function folderMusic(link) {
  const id = parseDriveFolderId(link);
  if (!id) return [];
  const files = await createPublicDriveProvider(log).listFiles(id);
  const pairs = musicFolderPairs(files);
  // One file at a time: Drive refuses bursts of downloads.
  const out = [];
  for (const p of pairs) {
    out.push({
      name: p.name,
      url: publicDlUrl(p.id),
      // The whole .txt, its own line breaks kept (blank lines and stray spaces tidied).
      credit: p.textId ? creditText(await readText(p.textId).catch(() => '')) : '',
    });
  }
  return out;
}

/** { track, url } with each folder line swapped for its files' "link | credit" lines. */
export async function expandMusic(shortMusic = {}) {
  const text = String((shortMusic && shortMusic.url) || '');
  if (!text.split(/\r?\n/).some((l) => isMusicFolder(l.split('|')[0]))) return shortMusic;
  const lines = await Promise.all(text.split(/\r?\n/).map(async (line) => {
    const link = line.split('|')[0].trim();
    if (!isMusicFolder(link)) return [line];
    try {
      // The setting is one track per line, so the credit's line breaks travel as \\n.
      return (await folderMusic(link)).map((m) => (m.credit ? `${m.url} | ${m.credit.replace(/\n/g, '\\n')}` : m.url));
    } catch (err) {
      log.warn({ err: err.message }, 'music folder could not be read; its files are left out');
      return [];
    }
  }));
  return { ...shortMusic, url: lines.flat().join('\n') };
}

export default { expandMusic, folderMusic };
