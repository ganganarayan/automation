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
import { imageShortArgs, pickMusic } from '../utils/shortSpec.js';

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

export default { make };
