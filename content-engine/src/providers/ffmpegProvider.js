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
 *                      { buffer, durationSeconds },
 *                    extractAudio(...), extractFrame({ videoBuffer | url }): jpg Buffer }
 *               The pure argv building + SRT live in utils/stageSpec; this runs it
 *               in a scratch dir and reads the result back.
 * Dependencies: node:child_process / fs / os / path, utils/stageSpec,
 *               utils/videoSpec (duration probe), core/errors.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegConcatArgs } from '../utils/stageSpec.js';
import { extractAudioArgs } from '../utils/aiCopySpec.js';
import { cleanVideoArgs, progressSeconds } from '../utils/cleanSpec.js';
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

    /** Pull a small mono mp3 out of a video, for transcription. Returns the mp3 Buffer. */
    async extractAudio({ videoBuffer, ext = 'mp4' }) {
      if (!videoBuffer || !videoBuffer.length) throw new ExternalAPIError('extractAudio needs video bytes');
      const dir = await mkdtemp(join(tmpdir(), 'aud-'));
      try {
        const inPath = join(dir, `in.${ext}`);
        const outPath = join(dir, 'audio.mp3');
        await writeFile(inPath, videoBuffer);
        await run(bin, extractAudioArgs({ inPath, outPath }), { maxBuffer: 64 * 1024 * 1024 });
        const buffer = await readFile(outPath);
        log?.info?.({ bytes: buffer.length }, 'ffmpeg audio extracted');
        return buffer;
      } catch (err) {
        // No audio stream => ffmpeg writes nothing; treat as a silent video.
        if (err.stderr && /does not contain any stream|Output file is empty|matches no streams/i.test(String(err.stderr))) return Buffer.alloc(0);
        throw new ExternalAPIError(`ffmpeg audio extract failed: ${err.stderr ? String(err.stderr).slice(0, 300) : err.message}`);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    /**
     * Grab one video frame as a JPEG — from video bytes, or straight from a
     * public URL (ffmpeg range-reads only what it needs). Tries `atSec`, then
     * the very first frame for clips shorter than that.
     */
    async extractFrame({ videoBuffer, url = '', ext = 'mp4', atSec = 1 }) {
      const dir = await mkdtemp(join(tmpdir(), 'frm-'));
      try {
        let input = url;
        if (videoBuffer && videoBuffer.length) {
          input = join(dir, `in.${ext}`);
          await writeFile(input, videoBuffer);
        }
        if (!input) throw new ExternalAPIError('extractFrame needs video bytes or a URL');
        const outPath = join(dir, 'frame.jpg');
        for (const at of [atSec, 0]) {
          await run(bin, ['-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-q:v', '2', outPath], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }).catch(() => {});
          const buf = await readFile(outPath).catch(() => null);
          if (buf && buf.length) return buf;
        }
        throw new ExternalAPIError('ffmpeg could not read a frame from the video');
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    /**
     * Zoom from the top + trim the end (see utils/cleanSpec) into `outPath`.
     * Reads the source straight from its URL — the video is never held in memory.
     */
    /**
     * Re-encode a video (zoom from the top, cut the end). ffmpeg streams the
     * URL, so download and encode run together; `onProgress(seconds)` gets the
     * output time written so far, from ffmpeg's own -progress report.
     */
    cleanVideo({ url, outPath, zoomPct, keepSec, onProgress = null, args: custom = null }) {
      const args = ['-progress', 'pipe:1', '-nostats', ...(custom || cleanVideoArgs({ input: url, output: outPath, zoomPct, keepSec }))];
      return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let errTail = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000);
        child.stdout.on('data', (d) => {
          const sec = progressSeconds(d);
          if (sec >= 0 && onProgress) onProgress(sec);
        });
        child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-600); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new ExternalAPIError(`ffmpeg clean failed (${signal || code}): ${errTail.slice(-300)}`));
        });
      });
    },

    /**
     * A video's length in seconds, read by ffprobe from a public URL (range
     * reads of the header only). 0 when it can't be read.
     */
    /** Size, frame rate and whether there's sound (for the end card); zeros when unknown. */
    async probeVideo({ url }) {
      const probe = cfg.probeBin || process.env.FFPROBE_PATH || bin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
      try {
        const { stdout } = await run(probe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate', '-of', 'json', url], { timeout: 20000 });
        const streams = (JSON.parse(String(stdout)) || {}).streams || [];
        const v = streams.find((x) => x.codec_type === 'video') || {};
        const [n, d] = String(v.r_frame_rate || '').split('/').map(Number);
        return { width: Number(v.width) || 0, height: Number(v.height) || 0, fps: n > 0 && d > 0 ? n / d : 0, hasAudio: streams.some((x) => x.codec_type === 'audio') };
      } catch (err) {
        log?.warn?.({ err: err.message }, 'ffprobe video info failed');
        return { width: 0, height: 0, fps: 0, hasAudio: true };
      }
    },

    async probeDuration({ url }) {
      const probe = cfg.probeBin || process.env.FFPROBE_PATH || bin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
      try {
        const { stdout } = await run(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url], { timeout: 20000 });
        const sec = Number(String(stdout).trim());
        return Number.isFinite(sec) && sec > 0 ? sec : 0;
      } catch (err) {
        log?.warn?.({ err: err.message }, 'ffprobe duration failed');
        return 0;
      }
    },
  };
}

export default { createFfmpegProvider };
