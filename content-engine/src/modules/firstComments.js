/**
 * Module: first comment (Post for Me webhook receiver).
 *
 * Purpose:      Post for Me calls this the moment a channel of a post goes
 *               live; that channel then gets the post's link as its first
 *               comment, before anyone else comments.
 * Responsibility: HTTP only — verify the secret header, answer 200 at once,
 *               hand the event to firstCommentService.
 * Dependencies: firstCommentService.
 *
 * Routes (no sign-in — the Post-For-Me-Webhook-Secret header is checked):
 *         POST /api/v1/webhook/postforme/:tenant  (also runs the post check)
 *         POST /api/v1/jobs/check-posts  (admin key; the GitHub wake-up backup)
 */
import * as firstComment from '../services/firstCommentService.js';
import * as readyPost from '../services/readyPostService.js';
import { requireAdminKey } from '../middleware/auth.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.post('/webhook/postforme/:tenant', async (req, res) => {
    const tenantId = String(req.params.tenant || 'default');
    if (!(await firstComment.verifyWebhook(tenantId, req.get('Post-For-Me-Webhook-Secret')))) {
      return res.status(401).json({ ok: false });
    }
    res.json({ ok: true });
    firstComment.onWebhook({ tenantId, event: req.body }).catch((err) => log.warn({ err: err.message }, 'first comment webhook failed (the timer retries)'));
    // A channel went live: mark it ✅/❌ and send the go-live email now, so the
    // app need not be awake on a timer to notice.
    readyPost.refreshAllTenants().catch((err) => log.warn({ err: err.message }, 'post check after webhook failed'));
  });

  // Wake-up ping (GitHub cron backup for a missed webhook): check posts, then sleep.
  router.post('/jobs/check-posts', requireAdminKey, (req, res) => {
    res.status(202).json({ accepted: true });
    readyPost.refreshAllTenants().catch((err) => log.warn({ err: err.message }, 'check-posts failed'));
  });

  // Every boot is a wake-up: catch anything that went live while asleep.
  setTimeout(() => {
    readyPost.refreshAllTenants().catch((err) => log.warn({ err: err.message }, 'boot post check failed'));
  }, 15 * 1000).unref?.();

  log.info('first comment webhook registered at /api/v1/webhook/postforme/:tenant');
}

export default { register };
