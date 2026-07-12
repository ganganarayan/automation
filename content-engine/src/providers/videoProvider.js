/**
 * Video provider (interface + JSON2Video implementation).
 *
 * Purpose:      Render a movie spec and poll until it is ready.
 * Responsibility:
 *               - render(spec): projectId
 *               - poll(projectId): { done, url }
 *               - renderAndWait(spec, { intervalMs, timeoutMs }): url
 * Dependencies: httpClient, errors.
 */
import { request } from '../core/httpClient.js';
import { ExternalAPIError } from '../core/errors.js';

const BASE = 'https://api.json2video.com/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createJson2VideoProvider(cfg, log) {
  const requireKey = () => {
    if (!cfg.json2videoApiKey) throw new ExternalAPIError('JSON2Video not configured (JSON2VIDEO_API_KEY missing)');
    return { 'x-api-key': cfg.json2videoApiKey };
  };

  return {
    async render(spec) {
      const headers = requireKey();
      const res = await request(`${BASE}/movies`, {
        method: 'POST',
        headers,
        body: spec,
        label: 'json2video.render',
        log,
        retries: 1,
      });
      const project = res.data?.project;
      if (!project) throw new ExternalAPIError('JSON2Video render returned no project id');
      return project;
    },

    async poll(projectId) {
      const headers = requireKey();
      const res = await request(`${BASE}/movies?project=${encodeURIComponent(projectId)}`, {
        method: 'GET',
        headers,
        label: 'json2video.poll',
        log,
        retries: 1,
      });
      const movie = res.data?.movie || {};
      return { done: movie.status === 'done', url: movie.url || null, status: movie.status };
    },

    async renderAndWait(spec, { intervalMs = 60000, timeoutMs = 15 * 60000 } = {}) {
      const project = await this.render(spec);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(intervalMs);
        const { done, url } = await this.poll(project);
        if (done && url) return url;
      }
      throw new ExternalAPIError('JSON2Video render timed out');
    },
  };
}

export default { createJson2VideoProvider };
