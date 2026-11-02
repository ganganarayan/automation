/**
 * Image -> video animation: pure helpers.
 *
 * Purpose:      Deterministic, side-effect-free pieces of the animation provider
 *. JWT signing, prompt/duration mapping, response normalization,
 *               provider selection, and funnel-config resolution, kept apart
 *               from the HTTP backends so they can be unit-tested without pulling
 *               in settings/logger (mirrors utils/videoSpec.js vs videoProvider).
 * Responsibility: Pure functions only.
 * Dependencies: node:crypto, core/errors (error classes only, no I/O).
 */
import { createHmac } from 'node:crypto';
import { ExternalAPIError } from '../core/errors.js';

export const MOTION_PROMPTS = {
  subtle: 'subtle slow camera drift, gentle parallax, natural motion',
  cinematic: 'cinematic slow push-in, shallow depth of field, smooth motion',
  energetic: 'dynamic energetic camera movement, lively motion',
};

export function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Kling auth: a short-lived HS256 JWT signed with the account secret. */
export function signKlingToken(accessKey, secretKey, nowSec = Math.floor(Date.now() / 1000)) {
  if (!accessKey || !secretKey) throw new ExternalAPIError('Kling not configured (access key / secret key missing)');
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iss: accessKey, exp: nowSec + 1800, nbf: nowSec - 5 }));
  const sig = createHmac('sha256', secretKey)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${payload}.${sig}`;
}

/** Append the motion style to the clip prompt. */
export function composePrompt(prompt, motion) {
  const extra = MOTION_PROMPTS[motion] || '';
  return [String(prompt || '').trim(), extra].filter(Boolean).join(', ');
}

/** The funnel's clip length in whole seconds, 5 to 10 (default 5). */
export function clipSeconds(clipLength) {
  const n = Math.round(Number(clipLength));
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(10, Math.max(5, n));
}

/**
 * What a provider actually renders (and bills) for a clip length: Kling and
 * Runway make 5 or 10 second clips, MiniMax Hailuo-02 makes 6 or 10. A length
 * in between renders the next size up and the stitch trims it to length
 * (stageSpec.ffmpegConcatArgs clipSec).
 */
export function renderSeconds(provider, clipLength) {
  const want = clipSeconds(clipLength);
  const short = provider === 'hailuo' ? 6 : 5;
  return want <= short ? short : 10;
}

export function klingDuration(clipLength) {
  return String(renderSeconds('kling', clipLength));
}
export function runwayDuration(clipLength) {
  return renderSeconds('runway', clipLength);
}
export function hailuoDuration(clipLength) {
  return renderSeconds('hailuo', clipLength);
}

export function normalizeKling(body) {
  const d = (body && body.data) || {};
  const status = d.task_status || (body && body.status) || 'unknown';
  const url = d.task_result && Array.isArray(d.task_result.videos) ? d.task_result.videos[0] && d.task_result.videos[0].url : null;
  return {
    status,
    url: url || null,
    done: status === 'succeed' && !!url,
    failed: status === 'failed',
    error: d.task_status_msg || null,
  };
}

export function normalizeRunway(body) {
  const status = (body && body.status) || 'unknown';
  const url = body && Array.isArray(body.output) ? body.output[0] : null;
  return {
    status,
    url: url || null,
    done: status === 'SUCCEEDED' && !!url,
    failed: status === 'FAILED' || status === 'CANCELLED',
    error: (body && body.failure) || null,
  };
}

export function normalizeHailuoQuery(body) {
  const status = (body && body.status) || 'unknown';
  return {
    status,
    fileId: (body && body.file_id) || null,
    done: status === 'Success',
    failed: status === 'Fail',
    error: body && body.base_resp ? body.base_resp.status_msg : null,
  };
}

/** The provider name a funnel's config selects (defaults to kling). */
export function selectProvider(cfg) {
  const p = (cfg && cfg.provider) || 'kling';
  return ['kling', 'runway', 'hailuo'].includes(p) ? p : 'kling';
}

/** Map a funnel's flat config into the animation provider cfg shape. */
export function resolveAnimationConfig(funnelCfg = {}) {
  return {
    provider: funnelCfg.animation_provider || 'kling',
    clipLength: funnelCfg.clip_length || '5',
    motion: funnelCfg.motion || 'subtle',
    kling: { accessKey: funnelCfg.kling_access_key || '', secretKey: funnelCfg.kling_secret_key || '' },
    runway: { apiKey: funnelCfg.runway_api_key || '' },
    hailuo: { apiKey: funnelCfg.hailuo_api_key || '', groupId: funnelCfg.hailuo_group_id || '' },
  };
}

export default {
  MOTION_PROMPTS,
  base64url,
  signKlingToken,
  composePrompt,
  clipSeconds,
  renderSeconds,
  klingDuration,
  runwayDuration,
  hailuoDuration,
  normalizeKling,
  normalizeRunway,
  normalizeHailuoQuery,
  selectProvider,
  resolveAnimationConfig,
};
