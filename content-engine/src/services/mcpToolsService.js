/**
 * Internal MCP tools: what the gateway's assistant may do in one workspace.
 *
 * Purpose:      The tool bodies behind /mcp-internal (modules/mcpInternal.js).
 *               Each is a thin call into the pipeline the app already uses:
 *               planService for the plan, the Post for Me provider for accounts,
 *               links, posts and results, instanceRepository for the queue,
 *               readyPostService for unscheduling and thumbnails, the image and
 *               AI lanes for sheet posts and videos, jobRunner for slow work.
 * Responsibility:
 *               - Every call is scoped to ctx.tenantId (the email's workspace).
 *               - Writes (schedule_post, edit_post, cancel_post) only act with
 *                 confirm=true; without it they return { preview: true, ... }.
 *               - Compact JSON: ISO-8601 UTC for machines, *_ist
 *                 (DD-MM-YYYY HH:MM, IST) for anything a person reads.
 * Dependencies: planService, providerFactory, instanceRepository, instanceService,
 *               instanceSpec, readyPostService, imageLaneService, aiLaneService,
 *               funnelsRepository, jobRepository, jobRunner, connectPage, time.
 */
import { DateTime } from 'luxon';
import * as plan from './planService.js';
import { buildProviders } from './providerFactory.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as instanceService from './instanceService.js';
import { buildInitialSteps, patchStep, sumInstanceCost } from '../utils/instanceSpec.js';
import * as readyPost from './readyPostService.js';
import * as imageLane from './imageLaneService.js';
import * as aiLane from './aiLaneService.js';
import * as funnels from '../repositories/funnelsRepository.js';
import * as jobRepo from '../repositories/jobRepository.js';
import * as jobRunner from '../core/jobRunner.js';
import { CONNECT_PLATFORMS } from '../modules/connectPage.js';
import { formatIst, ZONE } from '../utils/time.js';
import { targetPostAt, postDateKey } from '../utils/videoSchedule.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'mcpTools' });

export const PLATFORMS = CONNECT_PLATFORMS.map(([p]) => p);
export const VIDEO_MODELS = ['kling', 'runway', 'hailuo'];
export const JOB_TYPES = { thumbnail: 'mcp_thumbnail', video: 'mcp_create_video', sheetPost: 'mcp_sheet_post' };

/** A refusal the caller can act on: { error, message }. Never retried. */
export class ToolError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.retryable = false;
  }
}

const ist = (v) => (v ? formatIst(v) : null);
const iso = (v) => (v ? new Date(v).toISOString() : null);
const parse = (v, fallback) => {
  if (v && typeof v === 'object') return v;
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const steps = (row) => instanceService.parseSteps(row);
const art = (row, key) => ((steps(row).find((s) => s.key === key) || {}).artifacts) || {};
const refsOf = (row) => parse(row.post_refs, []).filter(Boolean);

/** ISO-8601 time or "now" -> Date | null (now). Refuses the past. */
export function parseWhen(value, now = new Date()) {
  const v = String(value || '').trim();
  if (!v || v.toLowerCase() === 'now') return null;
  const dt = DateTime.fromISO(v, { zone: ZONE });
  if (!dt.isValid) throw new ToolError('bad_time', 'time must be ISO-8601 (for example 2026-11-20T18:30:00+05:30) or "now"');
  if (dt.toMillis() < now.getTime() - 60_000) throw new ToolError('bad_time', 'time is in the past');
  return dt.toJSDate();
}

async function publisherFor(tenantId) {
  const providers = await buildProviders(tenantId);
  if (!providers.resolved.postformeKey) throw new ToolError('not_configured', 'Post for Me is not set up for this workspace');
  return providers.publish;
}

async function accountsOf(tenantId) {
  const publish = await publisherFor(tenantId);
  const { data } = await publish.listAccounts();
  return { publish, accounts: (data || []).filter((a) => a && a.id) };
}

async function ownInstance(tenantId, postId) {
  const row = postId ? await instanceRepo.get(String(postId)).catch(() => null) : null;
  if (!row || String(row.tenant_id) !== String(tenantId)) throw new ToolError('not_found', 'no post with that id in this workspace');
  return row;
}

async function ownFunnel(tenantId, funnelId) {
  const row = funnelId ? await funnels.get(String(funnelId)).catch(() => null) : null;
  if (!row || String(row.tenant_id) !== String(tenantId)) throw new ToolError('not_found', 'no funnel with that id in this workspace');
  return row;
}

async function mustPost(tenantId, what = 'posts') {
  const why = await plan.limitReason(tenantId, what);
  if (why) throw new ToolError('not_entitled', why);
}

function postView(row, { full = false } = {}) {
  const pub = art(row, 'publish');
  const channels = (pub.channels || []).map((c) => ({ platform: c.platform, name: c.name, state: c.state || null }));
  const out = {
    post_id: row.id,
    title: row.title,
    status: row.status,
    funnel: row.funnel_name || null,
    scheduled_at: iso(row.scheduled_for),
    scheduled_ist: ist(row.scheduled_for),
    posted_ist: ist(row.posted_at),
    platforms: [...new Set(channels.map((c) => c.platform).filter(Boolean))],
  };
  if (!full) return out;
  return {
    ...out,
    caption: (pub.request && pub.request.caption) || pub.caption || null,
    media_url: (pub.request && pub.request.mediaUrl) || null,
    channels,
    note: row.note || null,
    editable: !row.locked && row.status === 'scheduled',
  };
}

// ---- read tools ------------------------------------------------------------

export async function getEntitlement(ctx) {
  const info = await plan.tenantInfo(ctx.tenantId);
  return { active: !!info.live, plan: info.plan, ...(info.live ? {} : { reason: info.reason }), expires_ist: ist(info.expiresAt) };
}

export async function connectionStatus(ctx) {
  const { accounts } = await accountsOf(ctx.tenantId);
  const connected = accounts.map((a) => ({ platform: a.platform, name: a.username || a.account_name || a.name || a.id, account_id: a.id }));
  const have = new Set(connected.map((c) => c.platform));
  const rows = await funnels.listByTenant(ctx.tenantId).catch(() => []);
  return {
    connected,
    not_connected: PLATFORMS.filter((p) => !have.has(p)),
    funnels: rows.map((f) => ({ funnel_id: f.id, name: f.name, active: !!f.active })),
  };
}

export async function getConnectLink(ctx, { platform }) {
  if (!PLATFORMS.includes(platform)) throw new ToolError('bad_platform', `platform must be one of ${PLATFORMS.join(', ')}`);
  const { publish, accounts } = await accountsOf(ctx.tenantId);
  const why = await plan.limitReason(ctx.tenantId, 'channels', { used: accounts.length });
  if (why) throw new ToolError('not_entitled', why);
  // The scoped provider stamps this workspace's external_id; no token leaves the server.
  const { url } = await publish.authUrl({ platform });
  return { platform, url };
}

const QUEUE = ['scheduled', 'script_review', 'transcript_review', 'final_review', 'image_review', 'video_review', 'review', 'manual', 'running', 'draft', 'failed', 'partial'];

export async function listQueue(ctx, { status = '', limit = 20 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const rows = await instanceRepo.list({ tenantId: ctx.tenantId, status: status || null, limit: status ? n : 200 });
  const queued = status ? rows : rows.filter((r) => QUEUE.includes(r.status));
  return { posts: queued.slice(0, n).map((r) => postView(r)) };
}

export async function getPost(ctx, { post_id: postId }) {
  return postView(await ownInstance(ctx.tenantId, postId), { full: true });
}

// ---- write tools (confirm gate) --------------------------------------------

export async function schedulePost(ctx, args) {
  const { media_url: mediaUrl, sheet_row: sheetRow, caption = '', platforms = [], time, confirm = false } = args || {};
  if (!!mediaUrl === !!sheetRow) throw new ToolError('bad_source', 'give exactly one of media_url or sheet_row');
  const when = parseWhen(time);
  await mustPost(ctx.tenantId);

  if (sheetRow) {
    const funnel = await ownFunnel(ctx.tenantId, sheetRow.funnel_id);
    const at = when ? DateTime.fromJSDate(when).setZone(ZONE) : DateTime.now().setZone(ZONE).plus({ minutes: 5 });
    const brief = {
      source: 'sheet_row', funnel: funnel.name, row_key: sheetRow.row_key || 'next Ready row',
      platforms: 'the funnel\'s ticked channels', caption: 'written from the sheet row', scheduled_ist: ist(at.toJSDate()),
    };
    if (!confirm) return { preview: true, will_schedule: brief, to_confirm: 'call again with confirm=true' };
    const job = await jobRunner.enqueueJob({
      tenantId: ctx.tenantId, type: JOB_TYPES.sheetPost,
      payload: { by: ctx.email, funnelId: funnel.id, rowKey: sheetRow.row_key || '', scheduledFor: at.toISO() },
    });
    return { queued: true, job_id: String(job.id), will_schedule: brief };
  }

  if (!String(caption).trim()) throw new ToolError('bad_caption', 'caption is required with media_url');
  if (!/^https:\/\//i.test(String(mediaUrl))) throw new ToolError('bad_media', 'media_url must be a public https URL');
  const wanted = [...new Set(platforms)];
  if (!wanted.length) throw new ToolError('bad_platform', 'pick at least one platform');
  const { publish, accounts } = await accountsOf(ctx.tenantId);
  const picked = accounts.filter((a) => wanted.includes(a.platform));
  const missing = wanted.filter((p) => !picked.some((a) => a.platform === p));
  if (missing.length) throw new ToolError('not_connected', `not connected: ${missing.join(', ')} (use get_connect_link)`);
  const preview = {
    source: 'media_url', media_url: mediaUrl, caption: String(caption),
    channels: picked.map((a) => ({ platform: a.platform, name: a.username || a.account_name || a.name || a.id })),
    scheduled_ist: when ? ist(when) : 'now',
  };
  if (!confirm) return { preview: true, will_schedule: preview, to_confirm: 'call again with confirm=true' };

  const request = { caption: String(caption), mediaUrl: String(mediaUrl) };
  const made = await publish.createPost({ accountIds: picked.map((a) => a.id), scheduledAt: when ? when.toISOString() : undefined, ...request });
  const ref = made && made.id ? made.id : null;
  const inst = await instanceService.createForFunnel({
    tenantId: ctx.tenantId, funnel: null, title: `${String(caption).split('\n')[0].slice(0, 60) || 'Post'} · ${when ? formatIst(when, { withTime: false }) : 'now'}`,
    scheduledFor: when, status: 'draft', sourceType: 'mcp', sourceRef: String(mediaUrl).slice(0, 500),
  });
  let s = buildInitialSteps();
  for (const k of ['script', 'images', 'animate', 'voiceover', 'transcript', 'stitch']) s = patchStep(s, k, { status: 'skipped' });
  const channels = picked.map((a) => ({ id: a.id, platform: a.platform, name: a.username || a.account_name || a.name || a.id, state: 'waiting' }));
  s = patchStep(s, 'publish', { status: 'done', artifacts: { posts: ref ? [ref] : [], caption: request.caption, channels, request, by: ctx.email } });
  await instanceRepo.saveSteps(inst.id, s, sumInstanceCost(s));
  await instanceRepo.markScheduled(inst.id, { postRefs: ref ? [ref] : [], scheduledFor: when, postNow: !when });
  log.info({ tenant: ctx.tenantId, instance: inst.id, ref }, 'mcp post scheduled');
  return { scheduled: true, post_id: inst.id, scheduled_ist: when ? ist(when) : 'now', platforms: wanted };
}

/** Drop each platform's own caption when the caption is replaced (other settings, e.g. a YouTube title, stay). */
function withoutCaptions(configs) {
  if (!configs) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(configs)) {
    const { caption: _c, ...rest } = v || {};
    if (Object.keys(rest).length) out[k] = rest;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function editPost(ctx, { post_id: postId, caption, time, confirm = false }) {
  const row = await ownInstance(ctx.tenantId, postId);
  if (row.locked || row.status !== 'scheduled') throw new ToolError('not_editable', `only a scheduled post can be edited (this one is ${row.status})`);
  if (caption === undefined && time === undefined) throw new ToolError('nothing_to_change', 'give a new caption, a new time, or both');
  const pub = art(row, 'publish');
  const req = pub.request;
  const accountIds = (pub.channels || []).map((c) => c.id).filter(Boolean);
  if (!req || !req.mediaUrl || !accountIds.length) throw new ToolError('not_editable', 'this post has no saved request to edit; change it in the app');
  const when = time === undefined ? (row.scheduled_for ? new Date(row.scheduled_for) : null) : parseWhen(time);
  const next = {
    caption: caption === undefined ? req.caption : String(caption),
    mediaUrl: req.mediaUrl,
    platformConfigurations: caption === undefined ? req.platformConfigurations : withoutCaptions(req.platformConfigurations),
  };
  const change = {
    post_id: row.id,
    ...(caption === undefined ? {} : { caption_from: req.caption, caption_to: next.caption }),
    ...(time === undefined ? {} : { time_from_ist: ist(row.scheduled_for), time_to_ist: when ? ist(when) : 'now' }),
  };
  if (!confirm) return { preview: true, will_change: change, to_confirm: 'call again with confirm=true' };

  const publish = await publisherFor(ctx.tenantId);
  const refs = refsOf(row);
  for (const ref of refs) {
    const live = await publish.getPost(ref).catch(() => null);
    if (live && ['processing', 'processed'].includes(live.status)) throw new ToolError('not_editable', 'Post for Me is already publishing this post');
  }
  for (const ref of refs) await publish.updatePost(ref, { accountIds, scheduledAt: when ? when.toISOString() : undefined, ...next });
  const s = patchStep(steps(row), 'publish', { artifacts: { ...pub, caption: next.caption, request: { ...req, ...next } } });
  await instanceRepo.saveSteps(row.id, s, sumInstanceCost(s));
  await instanceRepo.markScheduled(row.id, { postRefs: refs, scheduledFor: when, postNow: !when });
  log.info({ tenant: ctx.tenantId, instance: row.id }, 'mcp post edited');
  return { edited: true, ...change };
}

export async function cancelPost(ctx, { post_id: postId, confirm = false }) {
  const row = await ownInstance(ctx.tenantId, postId);
  if (row.locked || row.status !== 'scheduled') throw new ToolError('not_cancellable', `only a scheduled post can be cancelled (this one is ${row.status})`);
  const view = postView(row);
  if (!confirm) return { preview: true, will_cancel: view, effect: 'removed from Post for Me; the post goes back to a draft in the app', to_confirm: 'call again with confirm=true' };
  await readyPost.unscheduleInstance({ instanceId: row.id });
  return { cancelled: true, post_id: row.id };
}

// ---- jobs ------------------------------------------------------------------

export async function generateThumbnail(ctx, args) {
  const funnel = await ownFunnel(ctx.tenantId, args.funnel_id);
  if (!args.drive_id) throw new ToolError('bad_input', 'drive_id (the ready video in the funnel\'s Drive folder) is required');
  const job = await jobRunner.enqueueJob({
    tenantId: ctx.tenantId, type: JOB_TYPES.thumbnail,
    payload: { by: ctx.email, funnelId: funnel.id, driveId: String(args.drive_id), headline: args.headline, subhead: args.subhead, audience: args.audience, imagePrompt: args.image_prompt },
  });
  return { job_id: String(job.id), status: 'pending' };
}

export async function createVideo(ctx, { funnel_id: funnelId, prompt, model = '', time }) {
  const funnel = await ownFunnel(ctx.tenantId, funnelId);
  if (!String(prompt || '').trim()) throw new ToolError('bad_input', 'prompt is required');
  if (model && !VIDEO_MODELS.includes(model)) throw new ToolError('bad_model', `model must be one of ${VIDEO_MODELS.join(', ')}`);
  await mustPost(ctx.tenantId, 'aiVideos');
  const when = parseWhen(time);
  const job = await jobRunner.enqueueJob({
    tenantId: ctx.tenantId, type: JOB_TYPES.video,
    payload: { by: ctx.email, funnelId: funnel.id, prompt: String(prompt).slice(0, 300), model, scheduledFor: when ? when.toISOString() : null },
  });
  return { job_id: String(job.id), status: 'pending', note: 'the script waits for approval in the app before the video is made' };
}

export async function getJobStatus(ctx, { job_id: jobId }) {
  const job = await jobRepo.getForTenant(jobId, ctx.tenantId);
  if (!job) throw new ToolError('not_found', 'no job with that id in this workspace');
  const result = parse(job.payload, {}).result || null;
  let post = null;
  if (result && result.post_id) {
    const row = await instanceRepo.get(result.post_id).catch(() => null);
    if (row && String(row.tenant_id) === String(ctx.tenantId)) post = { post_id: row.id, status: row.status };
  }
  return {
    job_id: String(job.id),
    kind: Object.keys(JOB_TYPES).find((k) => JOB_TYPES[k] === job.type) || job.type,
    status: job.status,
    ...(job.error ? { error: job.error } : {}),
    ...(result ? { result } : {}),
    ...(post ? { post } : {}),
    created_ist: ist(job.created_at),
    finished_ist: ist(job.finished_at),
  };
}

// ---- results ---------------------------------------------------------------

const pickNum = (...vals) => {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
};

/** Each platform's metrics as { reach, views, likes, comments, shares } (pure; null = the platform does not report it). */
export function compactMetrics(platform, m) {
  if (!m || typeof m !== 'object') return null;
  const tw = m.public_metrics || m.organic_metrics || {};
  const p = String(platform || '');
  const life = m.lifetime_metrics || m['90d'] || {};
  return {
    reach: pickNum(m.reach, m.impressionCount, tw.impression_count, life.impression),
    views: pickNum(m.views, m.view_count, m.video_views, m.media_views, m.videoView, life.video_views),
    likes: pickNum(m.likes, m.like_count, m.likeCount, m.reactions_total, tw.like_count, life.reaction),
    comments: pickNum(m.comments, m.comment_count, m.commentCount, m.replies, m.replyCount, tw.reply_count, life.comment),
    shares: pickNum(m.shares, m.share_count, m.shareCount, m.reposts, m.repostCount, tw.retweet_count, life.save),
    ...(p === 'linkedin' && typeof m.engagement === 'number' ? { engagement_rate: m.engagement } : {}),
  };
}

export async function getPostResults(ctx, { post_id: postId }) {
  const row = await ownInstance(ctx.tenantId, postId);
  const refs = refsOf(row);
  if (!refs.length) return { post_id: row.id, status: row.status, platforms: [] };
  const publish = await publisherFor(ctx.tenantId);
  const channels = new Map((art(row, 'publish').channels || []).map((c) => [String(c.id), c]));
  const out = [];
  for (const ref of refs) {
    const results = await publish.postResults(ref);
    for (const r of results) {
      const ch = channels.get(String(r.social_account_id)) || {};
      const item = { platform: ch.platform || null, name: ch.name || null, success: !!r.success, url: (r.platform_data && r.platform_data.url) || null };
      if (!r.success) item.error = String(r.error || 'failed').slice(0, 200);
      else {
        const feed = await publish.postMetrics({ accountId: r.social_account_id, postId: ref }).catch(() => null);
        item.platform = item.platform || (feed && feed.platform) || null;
        item.url = item.url || (feed && feed.platform_url) || null;
        item.metrics = feed ? compactMetrics(item.platform, feed.metrics) : null;
      }
      out.push(item);
    }
  }
  return { post_id: row.id, status: row.status, posted_ist: ist(row.posted_at), platforms: out };
}

// ---- job handlers (registered by modules/mcpInternal.js) -------------------

export async function runThumbnailJob(job) {
  const p = parse(job.payload, {});
  const r = await readyPost.generateThumbnail({
    tenantId: job.tenant_id, funnelId: p.funnelId, driveId: p.driveId,
    headline: p.headline, subhead: p.subhead, audience: p.audience, imagePrompt: p.imagePrompt,
  });
  await jobRepo.setResult(job.id, {
    post_id: r.instanceId, sizes: (r.sizes || []).map((x) => ({ size: x.label || x.size, url: x.url })), ...(r.thumbError ? { warning: String(r.thumbError) } : {}),
  });
}

export async function runVideoJob(job) {
  const p = parse(job.payload, {});
  const funnelRow = await funnels.get(p.funnelId);
  if (!funnelRow || String(funnelRow.tenant_id) !== String(job.tenant_id)) throw new ToolError('not_found', 'funnel gone');
  const f = await funnels.resolve(funnelRow);
  const scheduledFor = p.scheduledFor ? DateTime.fromISO(p.scheduledFor).setZone(ZONE) : targetPostAt({ publishTime: f.publishTime });
  const inst = await aiLane.prepare({ funnelRow, scheduledFor, postDate: postDateKey(scheduledFor), prompt: p.prompt, model: p.model });
  await jobRepo.setResult(job.id, { post_id: inst.id, scheduled_ist: ist(scheduledFor.toJSDate()), waiting_for: 'script approval in the app' });
}

export async function runSheetPostJob(job) {
  const p = parse(job.payload, {});
  const funnelRow = await funnels.get(p.funnelId);
  if (!funnelRow || String(funnelRow.tenant_id) !== String(job.tenant_id)) throw new ToolError('not_found', 'funnel gone');
  const scheduledFor = DateTime.fromISO(p.scheduledFor).setZone(ZONE);
  const inst = await imageLane.prepare({ funnelRow, scheduledFor, rowKey: p.rowKey || '' });
  await jobRepo.setResult(job.id, { post_id: inst.id, scheduled_ist: ist(scheduledFor.toJSDate()) });
}

export default {
  getEntitlement, connectionStatus, getConnectLink, listQueue, getPost, schedulePost, editPost, cancelPost,
  generateThumbnail, createVideo, getJobStatus, getPostResults, compactMetrics, parseWhen,
  runThumbnailJob, runVideoJob, runSheetPostJob, ToolError, JOB_TYPES,
};
