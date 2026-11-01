/**
 * ✂ Clean, run by GitHub Actions (.github/workflows/clean-video.yml).
 *
 * Purpose:      Do on a GitHub runner what ✂ Clean does on Railway — zoom in
 *               from the top so the corner watermark leaves the frame, cut the
 *               outro, add the end card — then put the file in the user's
 *               Google Drive app folder and tell the app.
 * Responsibility:
 *               1. GET  hooks/clean/job       → options, Drive download URL, Drive token
 *               2. download (curl) + ffprobe
 *               3. ffmpeg with the SAME args as Railway (src/utils/cleanSpec.js)
 *               4. upload to Drive (resumable) with a fresh token
 *               5. POST hooks/clean/done      (or hooks/clean/fail on any error)
 * Dependencies: Node 20 (global fetch), ffmpeg + ffprobe + curl on PATH.
 *
 * Env: HOOK (the app's https address), TICKET (signed job ticket — the only
 * credential this run holds; it expires in a few hours).
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { cleanVideoArgs, cleanWithCardArgs, progressSeconds, progressPct } from '../src/utils/cleanSpec.js';
import { keepSecFor } from '../src/utils/cleanHookSpec.js';

const HOOK = String(process.env.HOOK || '').replace(/\/+$/, '');
const TICKET = String(process.env.TICKET || '');
const base = `${HOOK}/api/v1/hooks/clean`;

async function hook(path, body) {
  const res = await fetch(`${base}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Clean-Ticket': TICKET, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(`app ${path}: ${j.error || res.status}`);
  return j;
}

const progress = (p) => hook('progress', p).catch((e) => console.log(`progress not sent: ${e.message}`));

function run(bin, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errTail = '';
    child.stdout.on('data', (d) => { out += d; if (onStdout) onStdout(String(d)); });
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-1500); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${errTail.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

async function probe(file) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]));
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video') || {};
  const [n, d] = String(v.r_frame_rate || '30/1').split('/').map(Number);
  return {
    durationSec: Number((j.format || {}).duration) || 0,
    width: v.width || 1080,
    height: v.height || 1920,
    fps: n && d ? n / d : 30,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

async function uploadToDrive({ file, name, folderId, token }) {
  const size = (await stat(file)).size;
  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify({ name, parents: folderId ? [folderId] : undefined, mimeType: 'video/mp4' }),
  });
  if (!init.ok) throw new Error(`Drive upload start ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const where = init.headers.get('location');
  const put = await fetch(where, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: await readFile(file) });
  if (!put.ok) throw new Error(`Drive upload ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return (await put.json()).id;
}

async function main() {
  if (!/^https:\/\//.test(HOOK) || !TICKET) throw new Error('HOOK (https) and TICKET are required');
  const job = await hook('job');
  console.log(`::add-mask::${job.accessToken}`);
  console.log(`Cleaning Drive file ${job.driveId}: zoom ${job.zoomPct}%, cut last ${job.trimEndSec}s, end card ${job.endSec}s`);

  await run('curl', ['-fsSL', '--retry', '3', '-o', 'in.mp4', job.downloadUrl]);
  const head = (await readFile('in.mp4')).subarray(0, 200).toString('latin1');
  if (/<html|<!doctype/i.test(head)) throw new Error('Drive sent a web page, not the video — is its folder shared "Anyone with the link"?');
  const info = await probe('in.mp4');
  const keepSec = keepSecFor(info.durationSec, job.trimEndSec);
  const outSec = (keepSec || info.durationSec) + (job.endSec || 0);

  let args;
  if (job.endSec > 0) {
    const res = await fetch(`${base}/card.png?w=${info.width}&h=${info.height}`, { headers: { 'X-Clean-Ticket': TICKET } });
    if (!res.ok) throw new Error(`end card ${res.status}`);
    await writeFile('card.png', Buffer.from(await res.arrayBuffer()));
    args = cleanWithCardArgs({ input: 'in.mp4', card: 'card.png', output: 'out.mp4', zoomPct: job.zoomPct, keepSec, cardSec: job.endSec, w: info.width, h: info.height, fps: info.fps, hasAudio: info.hasAudio });
  } else {
    args = cleanVideoArgs({ input: 'in.mp4', output: 'out.mp4', zoomPct: job.zoomPct, keepSec });
  }

  await progress({ phase: 'encoding', pct: 0, totalSec: Math.round(outSec) });
  let last = 0;
  await run('ffmpeg', ['-progress', 'pipe:1', '-nostats', ...args], {
    onStdout: (chunk) => {
      const sec = progressSeconds(chunk);
      if (sec < 0 || Date.now() - last < 10000) return;
      last = Date.now();
      progress({ phase: 'encoding', pct: progressPct(sec, outSec), doneSec: Math.round(sec), totalSec: Math.round(outSec) });
    },
  });
  const done = await probe('out.mp4');

  await progress({ phase: 'uploading', pct: 100 });
  const fresh = await hook('token');
  console.log(`::add-mask::${fresh.accessToken}`);
  const fileId = await uploadToDrive({ file: 'out.mp4', name: job.fileName, folderId: fresh.folderId || job.folderId, token: fresh.accessToken });
  await hook('done', { fileId, durationSec: Math.round(done.durationSec || outSec) });
  console.log(`Done: Drive file ${fileId}, ${Math.round(done.durationSec)} s`);
}

main().catch(async (err) => {
  console.error(`::error::${err.message}`);
  await hook('fail', { error: err.message }).catch(() => {});
  process.exit(1);
});
