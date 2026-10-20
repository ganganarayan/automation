/**
 * Image -> video animation provider (interface + direct backends).
 *
 * Purpose:      Animate a still image into a short clip, through the provider a
 *               funnel chooses: Kling (JWT), Runway (bearer), or Hailuo/MiniMax
 *               (bearer). Same submit -> poll -> url shape as videoProvider.
 * Responsibility:
 *               - createAnimationProvider(cfg, log): { provider, animate, poll,
 *                 animateAndWait }
 *               - the three HTTP backends (request-building + response handling).
 *               Pure helpers (JWT, mapping, normalization, config resolution)
 *               live in utils/animationSpec.js so they test without settings.
 * Dependencies: core/httpClient, core/errors, utils/animationSpec.
 *
 * Direct provider APIs differ per vendor and evolve; each backend builds its own
 * request and normalizes its own response. An unconfigured provider throws a
 * clear ExternalAPIError at call time (never at construction), so the service
 * starts without keys.
 */
import { request } from '../core/httpClient.js';
import { ExternalAPIError } from '../core/errors.js';
import {
  signKlingToken,
  composePrompt,
  klingDuration,
  runwayDuration,
  hailuoDuration,
  normalizeKling,
  normalizeRunway,
  normalizeHailuoQuery,
  selectProvider,
  resolveAnimationConfig,
} from '../utils/animationSpec.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KLING_BASE = 'https://api.klingai.com';
const RUNWAY_BASE = 'https://api.dev.runwayml.com';
const RUNWAY_VERSION = '2024-11-06';
const MINIMAX_BASE = 'https://api.minimax.io/v1';

// ---- backends --------------------------------------------------------------

function klingBackend(cfg, log) {
  return {
    async submit({ imageUrl, prompt }) {
      const token = signKlingToken(cfg.kling.accessKey, cfg.kling.secretKey);
      const res = await request(`${KLING_BASE}/v1/videos/image2video`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { model_name: 'kling-v1-6', mode: 'std', duration: klingDuration(cfg.clipLength), image: imageUrl, prompt },
        label: 'kling.submit',
        log,
        retries: 1,
      });
      const taskId = res.data && res.data.data && res.data.data.task_id;
      if (!res.ok || !taskId) throw new ExternalAPIError(`Kling submit failed (${res.status}): ${String(res.text).slice(0, 300)}`);
      return taskId;
    },
    async poll(taskId) {
      const token = signKlingToken(cfg.kling.accessKey, cfg.kling.secretKey);
      const res = await request(`${KLING_BASE}/v1/videos/image2video/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        label: 'kling.poll',
        log,
        retries: 1,
      });
      if (!res.ok) throw new ExternalAPIError(`Kling poll failed (${res.status})`);
      return normalizeKling(res.data);
    },
  };
}

function runwayBackend(cfg, log) {
  const headers = () => {
    if (!cfg.runway.apiKey) throw new ExternalAPIError('Runway not configured (API key missing)');
    return { Authorization: `Bearer ${cfg.runway.apiKey}`, 'X-Runway-Version': RUNWAY_VERSION };
  };
  return {
    async submit({ imageUrl, prompt }) {
      const res = await request(`${RUNWAY_BASE}/v1/image_to_video`, {
        method: 'POST',
        headers: headers(),
        body: { model: 'gen4_turbo', promptImage: imageUrl, promptText: prompt, duration: runwayDuration(cfg.clipLength), ratio: '720:1280' },
        label: 'runway.submit',
        log,
        retries: 1,
      });
      const id = res.data && res.data.id;
      if (!res.ok || !id) throw new ExternalAPIError(`Runway submit failed (${res.status}): ${String(res.text).slice(0, 300)}`);
      return id;
    },
    async poll(taskId) {
      const res = await request(`${RUNWAY_BASE}/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers: headers(),
        label: 'runway.poll',
        log,
        retries: 1,
      });
      if (!res.ok) throw new ExternalAPIError(`Runway poll failed (${res.status})`);
      return normalizeRunway(res.data);
    },
  };
}

function hailuoBackend(cfg, log) {
  const headers = () => {
    if (!cfg.hailuo.apiKey) throw new ExternalAPIError('Hailuo/MiniMax not configured (API key missing)');
    return { Authorization: `Bearer ${cfg.hailuo.apiKey}` };
  };
  return {
    async submit({ imageUrl, prompt }) {
      const res = await request(`${MINIMAX_BASE}/video_generation`, {
        method: 'POST',
        headers: headers(),
        body: { model: 'MiniMax-Hailuo-02', prompt, first_frame_image: imageUrl, duration: hailuoDuration(cfg.clipLength) },
        label: 'hailuo.submit',
        log,
        retries: 1,
      });
      const taskId = res.data && res.data.task_id;
      if (!res.ok || !taskId) throw new ExternalAPIError(`Hailuo submit failed (${res.status}): ${String(res.text).slice(0, 300)}`);
      return taskId;
    },
    async poll(taskId) {
      const res = await request(`${MINIMAX_BASE}/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
        headers: headers(),
        label: 'hailuo.poll',
        log,
        retries: 1,
      });
      if (!res.ok) throw new ExternalAPIError(`Hailuo poll failed (${res.status})`);
      const q = normalizeHailuoQuery(res.data);
      if (!q.done) return q;
      // Finished: resolve the file_id to a download URL (needs the GroupId).
      if (!cfg.hailuo.groupId) throw new ExternalAPIError('Hailuo file retrieve needs a GroupId');
      const f = await request(
        `${MINIMAX_BASE}/files/retrieve?GroupId=${encodeURIComponent(cfg.hailuo.groupId)}&file_id=${encodeURIComponent(q.fileId)}`,
        { headers: headers(), label: 'hailuo.file', log, retries: 1 },
      );
      if (!f.ok) throw new ExternalAPIError(`Hailuo file retrieve failed (${f.status})`);
      const url = f.data && f.data.file ? f.data.file.download_url : null;
      return { ...q, url: url || null, done: !!url };
    },
  };
}

function pickBackend(cfg, log) {
  const provider = selectProvider(cfg);
  if (provider === 'runway') return runwayBackend(cfg, log);
  if (provider === 'hailuo') return hailuoBackend(cfg, log);
  return klingBackend(cfg, log);
}

// ---- public interface ------------------------------------------------------

/**
 * @param {object} cfg - from resolveAnimationConfig()
 * @returns {{ provider: string, animate, poll, animateAndWait }}
 */
export function createAnimationProvider(cfg, log) {
  const provider = selectProvider(cfg);
  const backend = pickBackend(cfg, log);

  return {
    provider,

    /** Submit one still for animation; returns the provider task id. */
    async animate({ imageUrl, prompt = '' }) {
      if (!imageUrl) throw new ExternalAPIError('animate needs an imageUrl');
      return backend.submit({ imageUrl, prompt: composePrompt(prompt, cfg.motion) });
    },

    /** Poll a task; returns { done, url, status, failed, error }. */
    async poll(taskId) {
      return backend.poll(taskId);
    },

    /** Submit and poll until the clip is ready; returns the clip URL. */
    async animateAndWait({ imageUrl, prompt = '' }, { intervalMs = 10000, timeoutMs = 8 * 60000 } = {}) {
      const taskId = await this.animate({ imageUrl, prompt });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(intervalMs);
        const r = await backend.poll(taskId);
        if (r.failed) throw new ExternalAPIError(`${provider} animation failed: ${r.error || r.status}`);
        if (r.done && r.url) return r.url;
      }
      throw new ExternalAPIError(`${provider} animation timed out`);
    },
  };
}

export { resolveAnimationConfig };
export default { createAnimationProvider, resolveAnimationConfig };
