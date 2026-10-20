/**
 * FFmpeg stitch provider (local binary).
 *
 * Purpose:      Combine the animated clips + the voiceover (+ optional burned-in
 *               captions) into one finished vertical reel, using the ffmpeg binary
 *               shipped in the image (see Dockerfile). No per-render AI cost — the
 *               stitch is local compute.
 * Responsibility:
 *               - createFfmpegProvider({ bin }, log)
 *                 => { stitch({ clipBuffers, audioBuffer, width, height, srtText }):
 *                      { buffer, durationSeconds } }
 *               The pure argv building + SRT live in utils/stageSpec; this runs it
 *               in a scratch dir and reads the result back.
 * Dependencies: node:child_process / fs / os / path, utils/stageSpec,
 *               utils/videoSpec (duration probe), core/errors.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegConcatArgs } from '../utils/stageSpec.js';
import { probeMp4DurationSeconds } from '../utils/videoSpec.js';
import { ExternalAPIError } from '../core/errors.js';

const run = promisify(execFile);

export function createFfmpegProvider(cfg = {}, log) {
  const bin = cfg.bin || process.env.FFMPEG_PATH || 'ffmpeg';

  return {
    async stitch({ clipBuffers, audioBuffer, width = 1080, height = 1920, srtText = '', audioExt = 'mp3' }) {
      const clips = (Array.isArray(clipBuffers) ? clipBuffers : []).filter((b) => b && b.length);
      if (!clips.length) throw new ExternalAPIError('stitch needs at least one clip');
      if (!audioBuffer || !audioBuffer.length) throw new ExternalAPIError('stitch needs audio');

      const dir = await mkdtemp(join(tmpdir(), 'reel-'));
      try {
        const clipPaths = [];
        for (let i = 0; i < clips.length; i += 1) {
          const p = join(dir, `clip${i}.mp4`);
          await writeFile(p, clips[i]);
          clipPaths.push(p);
        }
        const audioPath = join(dir, `voice.${audioExt}`);
        await writeFile(audioPath, audioBuffer);

        let subPath = '';
        if (srtText && srtText.trim()) {
          subPath = join(dir, 'captions.srt');
          await writeFile(subPath, srtText, 'utf8');
        }

        const outPath = join(dir, 'reel.mp4');
        const args = ffmpegConcatArgs({ clipPaths, audioPath, outPath, width, height, subPath });
        log?.info?.({ clips: clipPaths.length, captions: !!subPath }, 'ffmpeg stitch start');
        await run(bin, args, { maxBuffer: 64 * 1024 * 1024 });

        const buffer = await readFile(outPath);
        const durationSeconds = probeMp4DurationSeconds(buffer) || 0;
        log?.info?.({ bytes: buffer.length, durationSeconds }, 'ffmpeg stitch done');
        return { buffer, durationSeconds };
      } catch (err) {
        throw new ExternalAPIError(`ffmpeg stitch failed: ${err.stderr ? String(err.stderr).slice(0, 300) : err.message}`);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export default { createFfmpegProvider };
