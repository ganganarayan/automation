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
import { navHtml, NAV_CSS, NAV_SHELL_CSS } from '../utils/adminNav.js';
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

/**
 * The Comments screen: the rules that are armed, the leads they captured, and
 * every other comment that arrived. An unmatched comment is NOT a lead — nothing
 * is sent for it — but it is still shown so it can be answered by hand.
 */
function capturePage(ruleRows, leadRows) {
  const leadsOnly = leadRows.filter((l) => l.dm_status !== 'no_rule');
  const others = leadRows.filter((l) => l.dm_status === 'no_rule');

  const rulesHtml = ruleRows.length
    ? ruleRows.map(ruleRow).join('')
    : `<tr><td colspan="7" class="empty">No keyword rules yet — one is armed each time the app publishes a post.</td></tr>`;
  const leadsHtml = leadsOnly.length
    ? leadsOnly.map(leadRow).join('')
    : `<tr><td colspan="8" class="empty">No leads captured yet.</td></tr>`;
  const othersHtml = others.length
    ? others.map(otherRow).join('')
    : `<tr><td colspan="6" class="empty">No other comments yet.</td></tr>`;

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comments — automation</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 ${NAV_SHELL_CSS}
 ${NAV_CSS}
 .wrap{max-width:1180px;margin:1.4rem auto;padding:0 1rem}
 h1{font-size:1.3rem;margin:0}
 h2{font-size:.9rem;margin:1.6rem 0 .5rem;color:#9a9ab0;text-transform:uppercase;letter-spacing:.05em}
 .sub{color:#8a8aa2;font-size:.82rem;margin:.25rem 0 0}
 .card{background:#12121b;border:1px solid #24243a;border-radius:12px;overflow:hidden}
 table{width:100%;border-collapse:collapse;font-size:.86rem}
 th,td{text-align:left;padding:.6rem .7rem;border-bottom:1px solid #1e1e2c;vertical-align:top}
 th{color:#9a9ab0;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;background:#15151f}
 tr:hover td{background:#15151f}
 td.empty{text-align:center;color:#6f6f88;padding:1.4rem}
 .kw{font-weight:600;color:#e8e8ef}
 .txt{max-width:340px;white-space:pre-wrap;word-break:break-word;color:#c7c7d9}
 .muted{color:#6f6f88;font-size:.78rem}
 .pill{display:inline-block;padding:.1rem .55rem;border-radius:999px;font-size:.72rem;border:1px solid #24243a;background:#1c1c2a;color:#9a9ab0}
 .pill.on{background:#123b1f;border-color:#1f6b38;color:#8ff0b0}
 .pill.off{background:#1c1c2a;color:#9a9ab0}
 .pill.bad{background:#3b1212;border-color:#6b1f1f;color:#ff9a9a}
 button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:.35rem .75rem;font-size:.8rem}
 .btn-toggle{background:#2a2a44;color:#fff}
 .btn-del{background:#5a1d1d;color:#ffd7d7}
 form.inline{display:inline;margin:0}
</style>
<div class="layout">
  <aside>${navHtml({ current: 'capture' })}</aside>
  <main><div class="wrap">
    <h1>🎯 Comments</h1>
    <p class="sub">Instagram &amp; Facebook. A comment matching an armed keyword becomes a lead and gets a DM; everything else is just listed here for you to answer yourself.</p>

    <h2>Keyword rules</h2>
    <div class="card"><table>
      <thead><tr><th>Platform</th><th>Lane</th><th>Keyword</th><th>Match</th><th>DM</th><th>Status</th><th></th></tr></thead>
      <tbody>${rulesHtml}</tbody>
    </table></div>

    <h2>Leads</h2>
    <div class="card"><table>
      <thead><tr><th>Platform</th><th>Keyword</th><th>Lane</th><th>Username</th><th>Comment time</th><th>DM status</th><th>Follow-up</th><th></th></tr></thead>
      <tbody>${leadsHtml}</tbody>
    </table></div>

    <h2>Other comments — no rule matched</h2>
    <div class="card"><table>
      <thead><tr><th>Platform</th><th>Username</th><th>Comment</th><th>Post</th><th>Comment time</th><th></th></tr></thead>
      <tbody>${othersHtml}</tbody>
    </table></div>
  </div></main>
</div>`;
}

/** An unmatched comment: seen and shown, never acted on. */
function otherRow(l) {
  return `<tr>
    <td>${esc(PLATFORM_LABEL[l.platform] || l.platform)}</td>
    <td class="kw">${esc(l.commenter_username || l.commenter_id || '—')}</td>
    <td class="txt">${esc(truncate(l.comment_text, 200))}${l.abuse ? `<br><span class="pill bad">abusive</span>` : ''}</td>
    <td class="muted">${esc(l.post_id || '—')}</td>
    <td>${esc(formatIst(l.comment_created_at))}</td>
    <td><form class="inline" method="post" action="/api/v1/admin/capture/leads/${l.id}/delete"
          onsubmit="return confirm('Delete this comment on the platform and remove this row?')">
      <button class="btn-del" type="submit">Delete</button>
    </form></td>
  </tr>`;
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
