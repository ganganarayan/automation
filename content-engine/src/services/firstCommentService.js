/**
 * First comment: the post's link in its first comment. Instagram is the
 * exception: its link goes by comment-to-DM (captureRules), so it is skipped.
 *
 * Purpose:      Every publish path queues its Post for Me post here with the
 *               link. Post for Me has no first-comment option, so the moment it
 *               reports a channel live (its social.post.result.created webhook)
 *               that channel gets the link as its first comment, posted with the
 *               account's own token: before anyone else can comment. The
 *               5-minute timer is the backstop (a missed webhook, a retryable
 *               failure) and closes each job once the post is processed.
 * Responsibility: Queue + orchestration; platform calls in firstCommentSenders.
 * Dependencies: firstCommentsRepository, tenantConfigRepository, providerFactory,
 *               publishProvider, firstCommentSenders, laneSpec, settings, logger.
 *
 * Never blocks or fails a post: every error here is logged and kept on the row.
 * Each channel is claimed before it is commented, so it is commented once.
 */
import { timingSafeEqual } from 'node:crypto';
import * as repo from '../repositories/firstCommentsRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { buildProviders } from './providerFactory.js';
import { createPostForMeProvider, NotYourAccountError } from '../providers/publishProvider.js';
import { createFirstCommentSenders, commentPlatform, dmOnly } from './firstCommentSenders.js';
import * as captureConfig from './captureConfig.js';
import { postOutcome } from '../utils/laneSpec.js';
import { hookTenant, webhookMayAct } from '../utils/pfmScope.js';
import { settings } from '../settings/index.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'firstComment' });
const senders = createFirstCommentSenders({ log });

const CHECK_MINUTES = 5;
const MAX_ATTEMPTS = 6;
const HOOK_EVENT = 'social.post.result.created';

/** The first comment for a link ('' = nothing to comment). */
export function commentText(link) {
  const s = String(link || '').trim();
  return /^https?:\/\/\S+$/.test(s) ? s : '';
}

/**
 * Queue a just-created Post for Me post. A scheduled post is first checked at
 * its scheduled time. Safe on every path: no link or no post id → nothing.
 */
export async function queue({ tenantId = 'default', postformePostId, link, scheduledAt = null }) {
  const text = commentText(link);
  if (!text || !postformePostId) return null;
  try {
    const at = scheduledAt ? new Date(scheduledAt) : null;
    return await repo.enqueue({ tenantId, postformePostId, text, nextAt: at && !Number.isNaN(at.getTime()) ? at : null });
  } catch (err) {
    log.warn({ err: err.message, postformePostId }, 'first comment queue failed (posted anyway)');
    return null;
  }
}

const later = (minutes) => new Date(Date.now() + minutes * 60000);

/**
 * Tokens to comment with, in order. Facebook / Instagram: your own Meta token
 * (the one comment → DM already replies with) first, then Post for Me's.
 * Everything else: Post for Me's account token.
 */
export async function tokensFor(tenantId, platform, postId, account = {}) {
  const pfm = { via: 'postforme', token: account.access_token || '' };
  const key = commentPlatform(platform);
  if (key !== 'facebook' && key !== 'instagram') return [pfm];
  const cfg = await captureConfig.forTenant(tenantId).catch(() => null);
  // A Facebook post id is "{page-id}_{post-id}": the page id finds the token too.
  const ids = [account.user_id, account.external_id, key === 'facebook' ? String(postId || '').split('_')[0] : ''].filter(Boolean);
  const meta = ids.map((id) => captureConfig.tokenFor(cfg, id)).find(Boolean) || '';
  return [{ via: 'meta', token: meta }, pfm].filter((t) => t.token && !(t.via === 'postforme' && t.token === meta));
}

/**
 * Comment on one channel's result, if it succeeded and nobody has claimed it.
 * Returns 'ok' | 'skipped' | 'failed' | 'retry' | null (nothing to do).
 */
async function commentOn(publish, row, r, attempts) {
  const accountId = r && r.social_account_id;
  // A failed channel gets no comment; its retry is a new post with its own job.
  if (!r || !r.success || !accountId) return null;
  // The shared key: another tenant's channel is never claimed or commented.
  const account0 = publish.scope ? await publish.getAccount(accountId).catch((e) => (e instanceof NotYourAccountError ? null : undefined)) : undefined;
  if (account0 === null) return null;
  if (!(await repo.claim(row.id, accountId))) return null;
  let platform = '';
  try {
    const account = account0 || await publish.getAccount(accountId);
    platform = (account && account.platform) || '';
    if (dmOnly(platform)) {
      await repo.mark(row.id, accountId, { state: 'skipped', platform, error: 'Instagram sends the link by comment-to-DM' });
      return 'skipped';
    }
    const postId = r.platform_data && r.platform_data.id;
    const out = await senders.commentWithFallback({
      platform, postId, text: row.text, account,
      tokens: await tokensFor(row.tenant_id, platform, postId, account),
    });
    await repo.mark(row.id, accountId, {
      state: out.state, platform, ...(out.via ? { via: out.via } : {}), ...(out.error ? { error: out.error } : {}),
      ...(out.tried && out.tried.length ? { fallbackFrom: out.tried.join(' | ').slice(0, 200) } : {}),
    });
    log.info({ post: row.postforme_post_id, platform, state: out.state, via: out.via }, 'first comment');
    return out.state;
  } catch (err) {
    if (err.retryable && attempts < MAX_ATTEMPTS) {
      await repo.release(row.id, accountId);
      return 'retry';
    }
    await repo.mark(row.id, accountId, { state: 'failed', platform, error: String(err.message).slice(0, 200) });
    log.warn({ post: row.postforme_post_id, platform, err: err.message }, 'first comment failed');
    return 'failed';
  }
}

/** Work off one tenant's due jobs (the backstop). Returns how many comments went out. */
export async function runDue({ tenantId = 'default' } = {}) {
  const rows = await repo.due(tenantId).catch(() => []);
  if (!rows.length) return 0;
  const providers = await buildProviders(tenantId);
  if (!providers.resolved.postformeKey) return 0;
  const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey, scope: providers.resolved.postformeScope }, log);
  await ensureWebhook(tenantId, publish);
  let sent = 0;
  for (const row of rows) {
    const attempts = (row.attempts || 0) + 1;
    try {
      const post = await publish.getPost(row.postforme_post_id);
      if (postOutcome(post) === 'pending') {
        // Not out yet: look again at its scheduled time, else in a few minutes.
        const at = post && post.scheduled_at ? new Date(post.scheduled_at) : null;
        await repo.finish(row.id, { status: 'pending', attempts: row.attempts || 0, nextAt: at && at > later(CHECK_MINUTES) ? at : later(CHECK_MINUTES) });
        continue;
      }
      const results = await publish.postResults(row.postforme_post_id);
      let retry = !results.length && attempts < MAX_ATTEMPTS; // Post for Me can lag in writing results
      for (const r of results) {
        const state = await commentOn(publish, row, r, attempts);
        if (state === 'ok') sent += 1;
        if (state === 'retry') retry = true;
      }
      const fresh = await repo.getByPost(row.postforme_post_id);
      const states = Object.values((fresh && fresh.done) || {}).map((d) => d.state);
      // A channel still 'sending' is the webhook mid-comment: check once more.
      if (states.includes('sending') && attempts < MAX_ATTEMPTS) retry = true;
      await repo.finish(row.id, {
        status: retry ? 'pending' : (states.includes('failed') ? 'failed' : 'done'),
        attempts, nextAt: retry ? later(CHECK_MINUTES) : null,
      });
    } catch (err) {
      log.warn({ err: err.message, post: row.postforme_post_id }, 'first comment check failed (will retry)');
      await repo.finish(row.id, {
        status: attempts < MAX_ATTEMPTS ? 'pending' : 'failed', attempts, nextAt: later(CHECK_MINUTES), lastError: err.message,
      }).catch(() => {});
    }
  }
  return sent;
}

/** The URL Post for Me calls for this tenant ('' when the app has no public URL). */
export function webhookUrl(tenantId = 'default', base = settings.app.publicBaseUrl) {
  return base ? `${base}/api/v1/webhook/postforme/${encodeURIComponent(tenantId)}` : '';
}

/**
 * Register our webhook with Post for Me once per tenant (and again if the
 * app's URL changes). Its secret is kept in tenant_config to verify each call.
 */
export async function ensureWebhook(tenantId, publish) {
  // On the owner's shared key one webhook (the owner's) serves every tenant: a
  // webhook per tenant would get every tenant's events.
  tenantId = hookTenant(tenantId, publish && publish.scope);
  const url = webhookUrl(tenantId);
  if (!url) return false;
  try {
    const cfg = await tenantConfig.getAll(tenantId).catch(() => ({}));
    if (cfg.pfm_webhook_url === url && cfg.pfm_webhook_secret) return true;
    const hook = await publish.createWebhook({ url, eventTypes: [HOOK_EVENT] });
    if (!hook || !hook.secret) throw new Error('Post for Me returned no webhook secret');
    await tenantConfig.set(tenantId, 'pfm_webhook_secret', hook.secret);
    await tenantConfig.set(tenantId, 'pfm_webhook_id', hook.id || '');
    await tenantConfig.set(tenantId, 'pfm_webhook_url', url);
    log.info({ tenantId, url }, 'Post for Me webhook registered');
    return true;
  } catch (err) {
    log.warn({ err: err.message, tenantId }, 'Post for Me webhook registration failed (the timer still comments)');
    return false;
  }
}

/** Is this call really from Post for Me? (the Post-For-Me-Webhook-Secret header). */
export async function verifyWebhook(tenantId, header) {
  const secret = (await tenantConfig.get(tenantId, 'pfm_webhook_secret').catch(() => '')) || '';
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(String(secret));
  return !!secret && a.length === b.length && timingSafeEqual(a, b);
}

/** A channel just went live: put the link in its first comment now. */
export async function onWebhook({ tenantId = 'default', event }) {
  if (!event || event.event_type !== HOOK_EVENT) return false;
  const r = event.data || {};
  if (!r.post_id || !r.success) return false;
  const row = await repo.getByPost(r.post_id);
  if (!row || row.status !== 'pending') return false;
  // Act as the job's own tenant, with its own scope (its accounts, its tokens).
  const providers = await buildProviders(row.tenant_id || 'default');
  if (!webhookMayAct({ hookTenantId: tenantId, rowTenantId: row.tenant_id, rowScope: providers.resolved.postformeScope })) {
    log.warn({ hook: tenantId, row: row.tenant_id, post: r.post_id }, 'webhook for another tenant ignored');
    return false;
  }
  const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey || '', scope: providers.resolved.postformeScope }, log);
  const state = await commentOn(publish, row, r, 1);
  // The timer closes the job (and retries a retryable failure) on its next pass.
  await repo.finish(row.id, { status: 'pending', attempts: row.attempts || 0, nextAt: later(1) });
  return state === 'ok';
}

export default { queue, runDue, commentText, webhookUrl, ensureWebhook, verifyWebhook, onWebhook, hookTenant, webhookMayAct };
