/**
 * Module: comment-to-DM capture (admin view).
 *
 * Purpose:      One operator page for the capture layer — the keyword rules
 *               (one on/off switch each) and the captured-leads table with a
 *               per-row delete. The webhook receiver, senders, and publish-time
 *               rule creation land in later steps; this is the surface they fill.
 * Responsibility: HTTP + auth + HTML rendering; data lives in the repositories.
 * Dependencies: keywordRulesRepository, capturedLeadsRepository, accessService,
 *               utils/time.
 *
 * Routes: GET  /api/v1/admin/capture                 rules + leads page
 *         POST /api/v1/admin/capture/rules/:id/toggle flip a rule active/off
 *         POST /api/v1/admin/capture/leads/:id/delete delete a lead row
 */
import * as rules from '../repositories/keywordRulesRepository.js';
import * as leads from '../repositories/capturedLeadsRepository.js';
import * as jobRunner from '../core/jobRunner.js';
import * as captureService from '../services/captureService.js';
import * as captureConfig from '../services/captureConfig.js';
import { captureSenders } from '../services/captureSenders.js';
import { verifyMetaSignature, parseCommentEvents, parseMessageEvents } from '../utils/captureSpec.js';
import { keyOk } from '../services/accessService.js';
import { formatIst } from '../utils/time.js';

const JOB_TYPE = 'capture_comment';
const REPLY_JOB = 'capture_reply';

export function register(ctx) {
  const { router, log } = ctx;

  const guardHtml = async (req, res) => {
    if (await keyOk(req)) return true;
    res.redirect('/api/v1/admin/settings');
    return false;
  };

  router.get('/admin/capture', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const [ruleRows, leadRows] = await Promise.all([
        rules.listByTenant({ tenantId: req.tenantId }),
        leads.listByTenant({ tenantId: req.tenantId }),
      ]);
      res.type('html').send(capturePage(ruleRows, leadRows));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/capture/rules/:id/toggle', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      const rule = await rules.get(id);
      if (!rule) return res.status(404).json({ ok: false, error: 'not found' });
      await rules.setActive(id, !rule.active);
      res.redirect('/api/v1/admin/capture');
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/capture/leads/:id/delete', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      const row = await leads.get(id);
      if (row) {
        // Delete the live comment on Instagram/Facebook too (best-effort), then
        // remove the log row regardless of whether the platform delete succeeds.
        const cfg = await captureConfig.forTenant(req.tenantId);
        const token = captureConfig.tokenFor(cfg, row.account_id);
        if (token) {
          try {
            await captureSenders.deleteComment({ platform: row.platform, pageToken: token, commentId: row.comment_id });
            log.info({ commentId: row.comment_id }, 'capture: live comment deleted');
          } catch (err) {
            log.warn({ err: err.message, commentId: row.comment_id }, 'capture: live comment delete failed (removing row anyway)');
          }
        }
        await leads.remove(id);
        log.info({ commentId: row.comment_id }, 'capture lead deleted');
      }
      res.redirect('/api/v1/admin/capture');
    } catch (err) {
      next(err);
    }
  });

  // --- Meta webhook (Instagram + Facebook comments) -----------------------

  // Verification handshake: Meta calls this once with the verify token we set in
  // the app config and expects the challenge echoed back as plain text.
  router.get('/webhook/meta-comments', async (req, res) => {
    try {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      const cfg = await captureConfig.forTenant(req.tenantId);
      if (mode === 'subscribe' && cfg.verifyToken && token === cfg.verifyToken) {
        return res.status(200).type('text/plain').send(String(challenge ?? ''));
      }
      return res.sendStatus(403);
    } catch {
      return res.sendStatus(403);
    }
  });

  // Event delivery: verify the signature over the RAW body, then 200 fast and
  // hand each comment to the durable job queue (never block Meta's request).
  router.post('/webhook/meta-comments', async (req, res) => {
    let cfg;
    try {
      cfg = await captureConfig.forTenant(req.tenantId);
    } catch {
      return res.sendStatus(200); // acknowledge; nothing we can do without config
    }
    const ok = verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'], cfg.appSecret);
    if (!ok) {
      req.log?.warn?.('capture: bad or missing webhook signature');
      return res.sendStatus(403);
    }
    res.sendStatus(200); // ack immediately

    try {
      const events = parseCommentEvents(req.body);
      for (const event of events) {
        await jobRunner.enqueueJob({ tenantId: req.tenantId, type: JOB_TYPE, payload: { event } });
      }
      // Replies to our DMs drive the follow gate (and open the 24h window).
      const replies = parseMessageEvents(req.body);
      for (const event of replies) {
        await jobRunner.enqueueJob({ tenantId: req.tenantId, type: REPLY_JOB, payload: { event } });
      }
      if (events.length || replies.length) {
        req.log?.info?.({ comments: events.length, replies: replies.length }, 'capture: events queued');
      }
    } catch (err) {
      req.log?.error?.({ err: err.message }, 'capture: failed to queue comment events');
    }
  });

  // Durable handler: one comment at a time, with retry/backoff from the runner.
  // The real DM + public-reply senders run here; a 5xx bubbles up and the runner
  // retries with backoff, while a 4xx (e.g. 7-day window closed) is recorded and
  // not retried (see captureSenders.isRetryableStatus).
  jobRunner.registerHandler(
    JOB_TYPE,
    async (job) => {
      const tenantId = job.tenant_id;
      const event = job.payload?.event;
      if (!event) return;
      const cfg = await captureConfig.forTenant(tenantId);
      await captureService.processCommentEvent(
        { tenantId, event, selfIds: cfg.selfIds, abuseWords: cfg.abuseWords },
        { rules, leads, senders: captureSenders, tokenFor: captureConfig.tokenFor, captureCfg: cfg, log },
      );
    },
    { maxAttempts: 5, backoffSeconds: 60 },
  );

  // Follow gate: someone replied to our DM, so we may now read follower status.
  jobRunner.registerHandler(
    REPLY_JOB,
    async (job) => {
      const tenantId = job.tenant_id;
      const event = job.payload?.event;
      if (!event) return;
      const cfg = await captureConfig.forTenant(tenantId);
      await captureService.processMessageEvent(
        { tenantId, event, selfIds: cfg.selfIds },
        { rules, leads, senders: captureSenders, tokenFor: captureConfig.tokenFor, captureCfg: cfg, log },
      );
    },
    { maxAttempts: 5, backoffSeconds: 60 },
  );

  log.info('capture admin registered at /api/v1/admin/capture (+ /webhook/meta-comments)');
}

// ---- rendering -------------------------------------------------------------

const PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook' };

const FOLLOWUP_LABEL = {
  pending: '⏳ awaiting reply',
  running: '⏳ sending',
  delivered: '🟢 link delivered',
  nudged: '🟡 asked to follow',
  skipped: '⚪ skipped',
  failed: '🔴 failed',
};

/** Follow-up state + what we learned about following (only known after a reply). */
function followupCell(l) {
  const base = FOLLOWUP_LABEL[l.followup_status] || esc(l.followup_status || '—');
  const f = l.follows === true ? ' · follows' : l.follows === false ? ' · not following' : '';
  return `${base}${f ? `<br><span class="muted">${esc(f.replace(' · ', ''))}</span>` : ''}`;
}

function dmStatusDot(status) {
  const map = {
    sent: '🟢 sent',
    pending: '⏳ pending',
    failed: '🔴 failed',
    blocked_abuse: '🟡 blocked (abuse)',
    skipped_old: '⚪ skipped (>7d)',
    skipped_window: '⚪ skipped (window)',
    no_rule: '⚪ no rule',
    self: '⚪ own comment',
  };
  return map[status] || esc(status || '—');
}

function capturePage(ruleRows, leadRows) {
  const rulesHtml = ruleRows.length
    ? ruleRows.map(ruleRow).join('')
    : `<tr><td colspan="7" class="empty">No rules yet — they are created automatically when a post with a keyword is published.</td></tr>`;

  const leadsHtml = leadRows.length
    ? leadRows.map(leadRow).join('')
    : `<tr><td colspan="8" class="empty">No leads captured yet.</td></tr>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comment capture</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #f6f7f9; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background:#15171a; color:#e8e8e8; } .card{background:#1e2126!important;} th{background:#23272e!important;} tr:hover td{background:#23272e!important;} }
  header { padding: 16px 20px; border-bottom: 1px solid #0001; display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size: 1.1rem; margin: 0; }
  header a { color:#0a7d32; text-decoration:none; font-size:.9rem; }
  main { padding: 16px 20px; max-width: 1200px; }
  h2 { font-size: .95rem; margin: 22px 0 8px; color:#555; }
  .card { background:#fff; border-radius:10px; box-shadow:0 1px 3px #0002; overflow:hidden; }
  table { width:100%; border-collapse: collapse; font-size:.86rem; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid #0001; vertical-align:top; }
  th { background:#f0f2f5; font-weight:600; position:sticky; top:0; }
  tr:hover td { background:#f8f9fb; }
  td.empty { text-align:center; color:#888; padding:22px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:.78rem; background:#eef; }
  .on { background:#0a7d32; color:#fff; } .off { background:#bbb; color:#fff; }
  .kw { font-weight:600; }
  .txt { max-width:320px; white-space:pre-wrap; word-break:break-word; color:#444; }
  button { font:inherit; cursor:pointer; border:0; border-radius:6px; padding:5px 11px; }
  .btn-toggle { background:#eef; color:#334; }
  .btn-del { background:#fdecec; color:#b02020; }
  form.inline { display:inline; margin:0; }
  .muted { color:#999; font-size:.8rem; }
</style></head><body>
<header>
  <h1>🎯 Comment capture</h1>
  <a href="/api/v1/admin/instances">← Instances</a>
  <a href="/api/v1/dashboard">Dashboard</a>
  <span class="muted">Instagram &amp; Facebook — auto-DM on keyword, with log</span>
</header>
<main>
  <h2>Keyword rules</h2>
  <div class="card"><table>
    <thead><tr><th>Platform</th><th>Lane</th><th>Keyword</th><th>Match</th><th>DM</th><th>Status</th><th></th></tr></thead>
    <tbody>${rulesHtml}</tbody>
  </table></div>

  <h2>Captured leads</h2>
  <div class="card"><table>
    <thead><tr><th>Platform</th><th>Keyword</th><th>Lane</th><th>Username</th><th>Comment time</th><th>DM status</th><th>Follow-up</th><th></th></tr></thead>
    <tbody>${leadsHtml}</tbody>
  </table></div>
</main>
</body></html>`;
}

function ruleRow(r) {
  const variants = Array.isArray(r.public_reply_variants) ? r.public_reply_variants.length : 0;
  return `<tr>
    <td>${esc(PLATFORM_LABEL[r.platform] || r.platform)}</td>
    <td>${esc(r.lane || '—')}</td>
    <td class="kw">${esc(r.keyword)}</td>
    <td><span class="pill">${esc(r.match_mode)}</span></td>
    <td class="txt">${esc(truncate(r.dm_text, 140))}${r.dm_link ? `<br><span class="muted">${esc(r.dm_link)}</span>` : ''}<br><span class="muted">${variants} reply variant${variants === 1 ? '' : 's'}${r.require_follow ? ' · 🔒 follow required' : ''}</span></td>
    <td><span class="pill ${r.active ? 'on' : 'off'}">${r.active ? 'ON' : 'OFF'}</span></td>
    <td><form class="inline" method="post" action="/api/v1/admin/capture/rules/${r.id}/toggle">
      <button class="btn-toggle" type="submit">${r.active ? 'Turn off' : 'Turn on'}</button>
    </form></td>
  </tr>`;
}

function leadRow(l) {
  return `<tr>
    <td>${esc(PLATFORM_LABEL[l.platform] || l.platform)}</td>
    <td class="kw">${esc(l.keyword || '—')}</td>
    <td>${esc(l.lane || '—')}</td>
    <td>${esc(l.commenter_username || l.commenter_id || '—')}</td>
    <td>${esc(formatIst(l.comment_created_at))}</td>
    <td>${dmStatusDot(l.dm_status)}${l.error ? `<br><span class="muted">${esc(truncate(l.error, 80))}</span>` : ''}</td>
    <td>${followupCell(l)}</td>
    <td><form class="inline" method="post" action="/api/v1/admin/capture/leads/${l.id}/delete"
          onsubmit="return confirm('Delete this lead${''}? (removes the log row)')">
      <button class="btn-del" type="submit">Delete</button>
    </form></td>
  </tr>`;
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { register };
