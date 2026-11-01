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
 *         POST /api/v1/webhook/postforme/:tenant
 */
import * as firstComment from '../services/firstCommentService.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.post('/webhook/postforme/:tenant', async (req, res) => {
    const tenantId = String(req.params.tenant || 'default');
    if (!(await firstComment.verifyWebhook(tenantId, req.get('Post-For-Me-Webhook-Secret')))) {
      return res.status(401).json({ ok: false });
    }
    res.json({ ok: true });
    firstComment.onWebhook({ tenantId, event: req.body }).catch((err) => log.warn({ err: err.message }, 'first comment webhook failed (the timer retries)'));
  });

  log.info('first comment webhook registered at /api/v1/webhook/postforme/:tenant');
}

export default { register };
