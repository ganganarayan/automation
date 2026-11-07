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
import {
  imageShortArgs, pickMusic, voiceText, imageVideoSeconds, alignmentCues, evenCues, IMAGE_VIDEO_SIZES, PRIMARY_SIZE,
} from '../utils/shortSpec.js';
import { buildSrt } from '../utils/stageSpec.js';

/** Your own music, on disk so ffmpeg can loop it. A link that fails falls back to the default track. */
async function musicFor(choice, dir, log) {
  const picked = pickMusic(choice);
  if (!picked.url) return picked;
  try {
    const res = await fetch(picked.url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const file = join(dir, 'music');
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return { file };
  } catch (err) {
    if (log) log.warn({ err: err.message }, 'own Short music unreadable, using the default track');
    return pickMusic({});
  }
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
 * Image post → videos for every channel, one per size it needs: each size's
 * own picture (else the primary one, fitted on a blurred copy) with music and,
 * when a voice is given, the caption read aloud with burned subtitles.
 * A voice that fails leaves the music only (voiceError says why); subtitles
 * that fail to burn leave them out (subtitleError); a render that fails throws.
 * images: size -> URL (the primary size must be there, or imageUrl is used).
 * Returns { videos: size -> URL, seconds, chars, voiced, subtitled, voiceError, subtitleError }.
 */
export async function makeVideo({ imageUrl = '', images = {}, sizes = [PRIMARY_SIZE], publish, music = {}, text = '', tts = null, log }) {
  const pics = { ...images };
  if (!pics[PRIMARY_SIZE] && imageUrl) pics[PRIMARY_SIZE] = imageUrl;
  if (!pics[PRIMARY_SIZE]) throw new Error('no image to make the video from');
  const dir = await mkdtemp(join(tmpdir(), 'imgvid-'));
  try {
    const ffmpeg = createFfmpegProvider({}, log);
    let voicePath = '';
    let voiceSec = 0;
    let chars = 0;
    let voiceError = '';
    let cues = [];
    const spoken = tts ? voiceText(text) : '';
    if (tts && !spoken) voiceError = 'the caption has nothing to read aloud';
    if (spoken) {
      try {
        const out = tts.synthesizeTimed ? await tts.synthesizeTimed({ text: spoken }) : await tts.synthesize({ text: spoken });
        chars = out.chars || spoken.length;
        voicePath = join(dir, 'voice.mp3');
        await writeFile(voicePath, out.buffer);
        voiceSec = (await ffmpeg.probeDuration({ url: voicePath })) || spoken.length / 14;
        cues = out.alignment ? alignmentCues(out.alignment) : [];
        if (!cues.length) cues = evenCues(spoken, voiceSec);
      } catch (err) {
        voiceError = String(err.message).slice(0, 200);
        voicePath = '';
        if (log) log.warn({ err: err.message }, 'image video voice failed, music only');
      }
    }
    const seconds = imageVideoSeconds(voiceSec);
    let subPath = '';
    if (voicePath && cues.length) {
      subPath = 'subs.srt';
      await writeFile(join(dir, subPath), buildSrt(cues), 'utf8');
    }
    const track = await musicFor(music, dir, log);
    const local = {};
    const videos = {};
    let subtitleError = '';
    for (const size of [...new Set([PRIMARY_SIZE, ...sizes])]) {
      const spec = IMAGE_VIDEO_SIZES[size];
      if (!spec) continue;
      const src = pics[size] || pics[PRIMARY_SIZE];
      if (!local[src]) local[src] = await localPng(src, join(dir, `in-${Object.keys(local).length}.png`));
      const outPath = join(dir, `video-${size}.mp4`);
      const args = (withSubs) => imageShortArgs({
        imagePath: local[src], outPath, music: track, seconds, voicePath, width: spec.w, height: spec.h, subPath: withSubs ? subPath : '',
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
      videos[size] = await publish.uploadFile(outPath, 'video/mp4');
    }
    return { videos, url: videos[PRIMARY_SIZE], seconds, chars, voiced: !!voicePath, subtitled: !!subPath, voiceError, subtitleError };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export default { make, makeVideo };
