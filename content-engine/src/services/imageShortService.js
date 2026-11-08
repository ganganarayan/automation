/**
 * Image post → YouTube Short: render and upload.
 *
 * Purpose:      Turn an image post's picture into the short video YouTube needs
 *               and hand back a public link to it.
 * Responsibility: Fetch the image, run ffmpeg in a scratch dir, upload to Post
 *               for Me's storage. The argv and music choices are in utils/shortSpec.
 * Dependencies: ffmpegProvider, utils/shortSpec, sharp, logger.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createFfmpegProvider } from '../providers/ffmpegProvider.js';
import { expandMusic } from './musicFolderService.js';
import {
  imageShortArgs, pickMusic, notAudio, voiceText, imageVideoSeconds, alignmentCues, evenCues, IMAGE_VIDEO_SIZES, PRIMARY_SIZE,
} from '../utils/shortSpec.js';
import { buildSrt } from '../utils/stageSpec.js';

/** Your own music, on disk so ffmpeg can loop it. A link that fails falls back to the default track. */
async function musicFor(choice, dir, log) {
  const picked = pickMusic(await expandMusic(choice));
  if (!picked.url) return picked;
  for (const url of picked.urls || [picked.url]) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`status ${res.status}`);
      if (notAudio(res.headers.get('content-type'))) throw new Error('the link gave a web page, not a music file');
      const file = join(dir, 'music');
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      return { file, credit: (picked.credits || {})[url] || '' };
    } catch (err) {
      if (log) log.warn({ err: err.message, url }, 'own Short music unreadable, trying the next');
    }
  }
  if (log) log.warn('no own music link worked, using the default track');
  return pickMusic({});
}

/** Render the Short for this image; returns its public URL. Costs no AI. */
export async function make({ imageUrl, publish, music = {}, log }) {
  if (!imageUrl) throw new Error('no image to make the Short from');
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`could not read the image (${res.status})`);
  const dir = await mkdtemp(join(tmpdir(), 'short-'));
  try {
    // PNG first: ffmpeg's image loop needs a local file of a type it is sure of.
    const imagePath = join(dir, 'in.png');
    await sharp(Buffer.from(await res.arrayBuffer())).png().toFile(imagePath);
    const outPath = join(dir, 'short.mp4');
    await createFfmpegProvider({}, log).imageToShort({ args: imageShortArgs({ imagePath, outPath, music: await musicFor(music, dir, log) }) });
    return await publish.uploadFile(outPath, 'video/mp4');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Read an image link into a local PNG ffmpeg can loop. */
async function localPng(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not read the image (${res.status})`);
  await sharp(Buffer.from(await res.arrayBuffer())).png().toFile(path);
  return path;
}

/**
 * The caption read in the funnel's voice: { buffer, seconds, cues, chars }.
 * cues time the subtitles (ElevenLabs' character timings, else spread evenly).
 * Throws when there is nothing to read or the voice cannot be made.
 */
export async function makeVoice({ tts, text = '', log }) {
  if (!tts) throw new Error('no voice set up');
  const spoken = voiceText(text);
  if (!spoken) throw new Error('the caption has nothing to read aloud');
  let out;
  try {
    out = tts.synthesizeTimed ? await tts.synthesizeTimed({ text: spoken }) : await tts.synthesize({ text: spoken });
  } catch (err) {
    throw new Error(`the voice could not be made: ${String(err.message).slice(0, 200)}`);
  }
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  try {
    const path = join(dir, 'voice.mp3');
    await writeFile(path, out.buffer);
    const seconds = (await createFfmpegProvider({}, log).probeDuration({ url: path })) || spoken.length / 14;
    let cues = out.alignment ? alignmentCues(out.alignment) : [];
    if (!cues.length) cues = evenCues(spoken, seconds);
    return { buffer: out.buffer, seconds, cues, chars: out.chars || spoken.length };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One video per size: each size's own picture (else the primary one, fitted
 * on a blurred copy) with the music and the voice, subtitles burned in.
 * Subtitles that fail to burn are left out (subtitleError). upload(path) puts
 * a finished file somewhere public and returns its URL.
 * Returns { videos: size -> URL, seconds, subtitled, subtitleError }.
 */
export async function renderVideos({ images = {}, sizes = [PRIMARY_SIZE], voice, music = {}, upload, subMargins = {}, log }) {
  if (!images[PRIMARY_SIZE]) throw new Error('no image to make the video from');
  if (!voice || !voice.buffer) throw new Error('no voice to put on the video');
  const dir = await mkdtemp(join(tmpdir(), 'imgvid-'));
  try {
    const ffmpeg = createFfmpegProvider({}, log);
    const voicePath = join(dir, 'voice.mp3');
    await writeFile(voicePath, voice.buffer);
    const seconds = imageVideoSeconds(voice.seconds);
    let subPath = '';
    if (voice.cues && voice.cues.length) {
      subPath = 'subs.srt';
      await writeFile(join(dir, subPath), buildSrt(voice.cues), 'utf8');
    }
    const track = await musicFor(music, dir, log);
    const local = {};
    const videos = {};
    let subtitleError = '';
    for (const size of [...new Set([PRIMARY_SIZE, ...sizes])]) {
      const spec = IMAGE_VIDEO_SIZES[size];
      if (!spec) continue;
      const src = images[size] || images[PRIMARY_SIZE];
      if (!local[src]) local[src] = await localPng(src, join(dir, `in-${Object.keys(local).length}.png`));
      const outPath = join(dir, `video-${size}.mp4`);
      const args = (withSubs) => imageShortArgs({
        imagePath: local[src], outPath, music: track, seconds, voicePath, width: spec.w, height: spec.h, subPath: withSubs ? subPath : '', marginV: (subMargins || {})[size] || null,
      });
      try {
        await ffmpeg.imageToShort({ args: args(!!subPath), cwd: dir });
      } catch (err) {
        if (!subPath) throw err;
        // No subtitles beats no video: the font or libass may be missing on the server.
        subtitleError = String(err.stderr || err.message).slice(-200);
        if (log) log.warn({ err: subtitleError, size }, 'subtitles would not burn, rendering without them');
        subPath = '';
        await ffmpeg.imageToShort({ args: args(false), cwd: dir });
      }
      videos[size] = await upload(outPath);
    }
    return { videos, seconds, subtitled: !!subPath, subtitleError, musicCredit: track.credit || '' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Voice + videos in one go (an approval prepared before videos were made
 * ahead of it). Returns { videos, url, seconds, chars, voiced, subtitled, subtitleError }.
 */
export async function makeVideo({ imageUrl = '', images = {}, sizes = [PRIMARY_SIZE], publish, music = {}, text = '', tts = null, log }) {
  const pics = { ...images };
  if (!pics[PRIMARY_SIZE] && imageUrl) pics[PRIMARY_SIZE] = imageUrl;
  const voice = await makeVoice({ tts, text, log });
  const made = await renderVideos({ images: pics, sizes, voice, music, upload: (path) => publish.uploadFile(path, 'video/mp4'), log });
  return { ...made, url: made.videos[PRIMARY_SIZE], chars: voice.chars, voiced: true };
}

export default { make, makeVoice, renderVideos, makeVideo };
