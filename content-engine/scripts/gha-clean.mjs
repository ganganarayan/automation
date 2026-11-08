/**
 * ✂ Clean, run by GitHub Actions (.github/workflows/clean-video.yml).
 *
 * Purpose:      Do on a GitHub runner what ✂ Clean does on Railway, zoom in
 *               from the top so the corner watermark leaves the frame, cut the
 *               outro, add the end card, then put the file in the user's
 *               Google Drive app folder and tell the app.
 * Responsibility:
 *               1. GET  hooks/clean/job       → options, Drive download URL, Drive token
 *               2. download (curl) + ffprobe
 *               3. ffmpeg with the SAME args as Railway (src/utils/cleanSpec.js),
 *                  subtitles burned when the job sends the transcript SRT
 *               4. upload to Drive (resumable) with a fresh token
 *               5. POST hooks/clean/done      (or hooks/clean/fail on any error)
 * Dependencies: Node 20 (global fetch), ffmpeg + ffprobe + curl on PATH.
 *
 * A ticket of kind 'assemble' is an AI video's final stitch instead (daily
 * router Lane 2): download the animated clips + the narrator voice-over, stitch
 * them with the SAME args as Railway (src/utils/stageSpec.js ffmpegConcatArgs,
 * captions burned when the job has them), upload, tell the app.
 *
 * A ticket of kind 'imagevideo' is an image post's whole video (Lane 3): draw
 * each size's picture (OpenAI), read the caption in the funnel's voice
 * (ElevenLabs, with timings), render one video per size with the SAME args as
 * Railway (src/utils/shortSpec.js imageShortArgs, subtitles burned), upload the
 * pictures and the videos, tell the app.
 *
 * Env: HOOK (the app's https address), TICKET (signed job ticket: the only
 * credential this run holds; it expires in a few hours).
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { cleanVideoArgs, cleanWithCardArgs, progressSeconds, progressPct, clipSrt } from '../src/utils/cleanSpec.js';
import { keepSecFor } from '../src/utils/cleanHookSpec.js';
import { ffmpegConcatArgs, buildSrt } from '../src/utils/stageSpec.js';
import { imageShortArgs, alignmentCues, evenCues, voiceText, imageVideoSeconds, aspectCropFilter, pickMusic, notAudio } from '../src/utils/shortSpec.js';

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

async function uploadToDrive({ file, name, folderId, token, mime = 'video/mp4' }) {
  const size = (await stat(file)).size;
  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify({ name, parents: folderId ? [folderId] : undefined, mimeType: mime }),
  });
  if (!init.ok) throw new Error(`Drive upload start ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const where = init.headers.get('location');
  const put = await fetch(where, { method: 'PUT', headers: { 'Content-Type': mime, 'Content-Length': String(size) }, body: await readFile(file) });
  if (!put.ok) throw new Error(`Drive upload ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return (await put.json()).id;
}

/** An AI video's final stitch: clips + voice-over (+ captions) → one reel. */
async function assemble(job) {
  console.log(`Assembling an AI video: ${job.clipUrls.length} clips, ${job.width}x${job.height}, captions ${job.srt ? 'on' : 'off'}`);
  const clipPaths = [];
  for (let i = 0; i < job.clipUrls.length; i += 1) {
    const p = `clip${i}.mp4`;
    await run('curl', ['-fsSL', '--retry', '3', '-o', p, job.clipUrls[i]]);
    clipPaths.push(p);
  }
  await run('curl', ['-fsSL', '--retry', '3', '-o', 'voice.mp3', job.audioUrl]);
  let subPath = '';
  if (job.srt && job.srt.trim()) {
    subPath = 'captions.srt';
    await writeFile(subPath, job.srt, 'utf8');
  }
  await progress({ phase: 'encoding', pct: 0 });
  await run('ffmpeg', ffmpegConcatArgs({ clipPaths, audioPath: 'voice.mp3', outPath: 'out.mp4', width: job.width, height: job.height, subPath }));
  const done = await probe('out.mp4');
  await progress({ phase: 'uploading', pct: 100 });
  const fresh = await hook('token');
  console.log(`::add-mask::${fresh.accessToken}`);
  const fileId = await uploadToDrive({ file: 'out.mp4', name: job.fileName, folderId: fresh.folderId || job.folderId, token: fresh.accessToken });
  await hook('done', { fileId, durationSec: Math.round(done.durationSec) });
  console.log(`Done: Drive file ${fileId}, ${Math.round(done.durationSec)} s`);
}

/** One picture from OpenAI for a size, cropped to its aspect by ffmpeg. */
async function drawPicture(job, size) {
  const spec = job.specs[size];
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${job.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: job.imageModel, prompt: job.prompts[size], size: spec.genSize, n: 1 }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI image (${size}) ${res.status}: ${((j.error || {}).message || '').slice(0, 200)}`);
  const item = (j.data || [])[0] || {};
  let buf;
  if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64');
  else if (item.url) buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
  else throw new Error(`OpenAI image (${size}) had no image data`);
  await writeFile(`raw-${size}.png`, buf);
  const crop = aspectCropFilter(spec.aspect);
  if (!crop) return `raw-${size}.png`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', `raw-${size}.png`, '-vf', crop, '-frames:v', '1', `pic-${size}.png`]);
  return `pic-${size}.png`;
}

/** The caption in the funnel's voice, with character timings for the subtitles. */
async function makeVoice(job) {
  const spoken = voiceText(job.text);
  if (!spoken) throw new Error('the caption has nothing to read aloud');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(job.voiceId)}/with-timestamps`, {
    method: 'POST',
    headers: { 'xi-api-key': job.elevenlabsKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text: spoken, model_id: job.voiceModel }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.audio_base64) throw new Error(`ElevenLabs voice ${res.status}: ${JSON.stringify(j.detail || j).slice(0, 200)}`);
  await writeFile('voice.mp3', Buffer.from(j.audio_base64, 'base64'));
  const seconds = (await probe('voice.mp3')).durationSec || spoken.length / 14;
  let cues = alignmentCues(j.alignment || j.normalized_alignment || {});
  if (!cues.length) cues = evenCues(spoken, seconds);
  return { seconds, cues, chars: spoken.length };
}

/** An image post's whole video: pictures, voice, subtitles, one video per size, all to Drive. */
async function imageVideo(job) {
  for (const k of [job.openaiKey, job.elevenlabsKey]) if (k) console.log(`::add-mask::${k}`);
  if (!job.openaiKey) throw new Error('no OpenAI key to draw the pictures');
  if (!job.elevenlabsKey || !job.voiceId) throw new Error('no ElevenLabs key or voice');
  console.log(`Image-post video: sizes ${job.sizes.join(', ')}`);
  await progress({ phase: 'pictures', pct: 0 });
  const pics = {};
  for (const size of job.sizes) pics[size] = await drawPicture(job, size);
  await progress({ phase: 'voice', pct: 30 });
  const voice = await makeVoice(job);
  const seconds = imageVideoSeconds(voice.seconds);
  let subPath = 'subs.srt';
  await writeFile(subPath, buildSrt(voice.cues), 'utf8');
  let music = job.music || {};
  if (music.url) {
    // A link that fails, or gives a web page, falls back to the default track: the post still goes.
    let got = null;
    for (const url of music.urls || [music.url]) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`status ${res.status}`);
        if (notAudio(res.headers.get('content-type'))) throw new Error('the link gave a web page, not a music file');
        await writeFile('music', Buffer.from(await res.arrayBuffer()));
        got = { file: 'music', credit: (music.credits || {})[url] || '' };
        break;
      } catch (err) {
        console.log(`Own music link unreadable (${err.message}), trying the next`);
      }
    }
    if (!got) console.log('No own music link worked, using the default track');
    music = got || pickMusic({});
  }
  await progress({ phase: 'encoding', pct: 40 });
  let subtitleError = '';
  for (const size of job.sizes) {
    const spec = job.specs[size];
    const args = (withSubs) => imageShortArgs({ imagePath: pics[size], outPath: `video-${size}.mp4`, music, seconds, voicePath: 'voice.mp3', width: spec.w, height: spec.h, subPath: withSubs ? subPath : '' });
    try {
      await run('ffmpeg', args(!!subPath));
    } catch (err) {
      if (!subPath) throw err;
      subtitleError = err.message.slice(-200);
      console.log(`Subtitles would not burn, rendering without them: ${subtitleError}`);
      subPath = '';
      await run('ffmpeg', args(false));
    }
  }
  await progress({ phase: 'uploading', pct: 90 });
  const fresh = await hook('token');
  console.log(`::add-mask::${fresh.accessToken}`);
  const folderId = fresh.folderId || job.folderId;
  const images = {};
  const videos = {};
  for (const size of job.sizes) {
    images[size] = await uploadToDrive({ file: pics[size], name: `${job.name} ${size}.png`, folderId, token: fresh.accessToken, mime: 'image/png' });
    videos[size] = await uploadToDrive({ file: `video-${size}.mp4`, name: `${job.name} ${size}.mp4`, folderId, token: fresh.accessToken });
  }
  await hook('done', { images, videos, seconds, chars: voice.chars, made: job.sizes.length, subtitled: !!subPath, subtitleError, musicCredit: music.credit || '' });
  console.log(`Done: ${job.sizes.length} sizes, ${seconds} s`);
}

async function main() {
  if (!/^https:\/\//.test(HOOK) || !TICKET) throw new Error('HOOK (https) and TICKET are required');
  const job = await hook('job');
  console.log(`::add-mask::${job.accessToken}`);
  if (job.kind === 'assemble') return assemble(job);
  if (job.kind === 'imagevideo') return imageVideo(job);
  console.log(`Cleaning Drive file ${job.driveId}: zoom ${job.zoomPct}%, cut last ${job.trimEndSec}s, end card ${job.endSec}s, subtitles ${job.srt ? 'on' : 'off'}`);

  await run('curl', ['-fsSL', '--retry', '3', '-o', 'in.mp4', job.downloadUrl]);
  const head = (await readFile('in.mp4')).subarray(0, 200).toString('latin1');
  if (/<html|<!doctype/i.test(head)) throw new Error('Drive sent a web page, not the video, is its folder shared "Anyone with the link"?');
  const info = await probe('in.mp4');
  const keepSec = keepSecFor(info.durationSec, job.trimEndSec);
  const outSec = (keepSec || info.durationSec) + (job.endSec || 0);

  // Burned subtitles: the transcript's cues up to the cut (the end card gets none).
  let subPath = '';
  if (job.srt) {
    const srt = clipSrt(job.srt, keepSec);
    if (!srt) throw new Error('the transcript has no subtitles before the cut, nothing to burn');
    subPath = 'subs.srt';
    await writeFile(subPath, srt, 'utf8');
    console.log(`Burning subtitles: ${srt.split('-->').length - 1} cues`);
  }

  let args;
  if (job.endSec > 0) {
    const res = await fetch(`${base}/card.png?w=${info.width}&h=${info.height}`, { headers: { 'X-Clean-Ticket': TICKET } });
    if (!res.ok) throw new Error(`end card ${res.status}`);
    await writeFile('card.png', Buffer.from(await res.arrayBuffer()));
    args = cleanWithCardArgs({ input: 'in.mp4', card: 'card.png', output: 'out.mp4', zoomPct: job.zoomPct, keepSec, cardSec: job.endSec, w: info.width, h: info.height, fps: info.fps, hasAudio: info.hasAudio, subPath });
  } else {
    args = cleanVideoArgs({ input: 'in.mp4', output: 'out.mp4', zoomPct: job.zoomPct, keepSec, subPath });
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
