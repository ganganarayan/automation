/**
 * Module: instances UI (runtime execution records).
 *
 * Purpose:      The posted-log / instances table and the read-only instance
 *               detail page with in-app Drive-embed previews (image / video /
 *               audio / text) and the real per-step cost breakdown. Approve /
 *               reject and the cron land in later slices; this is review only.
 * Responsibility: HTTP + auth + HTML rendering; logic in instanceService.
 * Dependencies: instanceService, instanceSpec, utils/time, accessService.
 *
 * Routes: GET  /api/v1/admin/instances           the table (?status= filters)
 *         GET  /api/v1/admin/instances/new        start: Prepare (ready videos) or a generated run
 *         GET  /api/v1/admin/instances/prepare    a funnel's sources + ready videos, per-video stage panels
 *         GET  /api/v1/admin/instances/:id        the instance view: stage panels for a ready video or a
 *                                                 generated run, read-only detail once posted
 *         GET  /api/v1/admin/instances/:id/data   JSON (instance + cost)
 *         POST /api/v1/admin/instances/sample      seed a sample (dev)
 *         POST /api/v1/admin/instances/:id/delete  delete (if not locked)
 *         GET  /api/v1/admin/instances/ready-ai    old link → prepare (so are /ready and /manual → /new)
 *         POST /api/v1/admin/instances/ready-ai/transcribe  Whisper one video → transcript review
 *         POST /api/v1/admin/instances/ready-ai/transcript  save / approve a transcript (text or SRT)
 *         POST /api/v1/admin/instances/ready-ai/generate  copy + thumbnails from the approved transcript
 *         POST /api/v1/admin/instances/ready-ai/durations video lengths for the listed videos
 *         POST /api/v1/admin/instances/ready/post  post the ticked videos
 */
import * as instances from '../services/instanceService.js';
import * as review from '../services/instanceReviewService.js';
import * as readyPost from '../services/readyPostService.js';
import * as stageRunner from '../services/stageRunnerService.js';
import * as jobRunner from '../core/jobRunner.js';
import * as funnelsRepo from '../repositories/funnelsRepository.js';
import { INSTANCE_STEPS, sumInstanceCost, costBreakdown, shortId, formatDuration } from '../utils/instanceSpec.js';
import { READY_STAGES, SOURCE_TYPES, laneOf, readyStage, stageLabel } from '../utils/laneSpec.js';
import { MANUAL_STAGES, STAGE_LABEL, inputKind, canExecute } from '../utils/manualStepSpec.js';
import { navHtml, NAV_CSS, NAV_SHELL_CSS } from '../utils/adminNav.js';
import { formatIst } from '../utils/time.js';
import { defaultSlotsIso, parseDriveFolderId, parsePickedFiles } from '../utils/readyPostSpec.js';
import { driveThumbUrl } from '../utils/reviewSpec.js';
import { keyOk } from '../services/accessService.js';

const MANUAL_JOB = 'manual_stage';

export function register(ctx) {
  const { router, log } = ctx;
  const guardHtml = async (req, res) => {
    if (await keyOk(req)) return true;
    res.redirect('/api/v1/admin/settings');
    return false;
  };

  router.get('/admin/instances', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const status = req.query.status ? String(req.query.status) : null;
      const rows = await instances.list({ tenantId: req.tenantId, status });
      res.type('html').send(listPage(rows, status));
    } catch (err) {
      next(err);
    }
  });

  // Old menu pages are now stage panels: "Post ready videos" and "Ready video +
  // AI copy" land on Prepare, "Manual run" on New. Registered before
  // '/admin/instances/:id' so these words aren't read as ids.
  const keepQuery = (req) => {
    const q = new URLSearchParams(Object.entries(req.query || {}).map(([k, v]) => [k, String(v)])).toString();
    return q ? `?${q}` : '';
  };
  router.get('/admin/instances/ready', (req, res) => res.redirect(302, `${PREPARE.base}${keepQuery(req)}`));
  router.get('/admin/instances/ready-ai', (req, res) => res.redirect(302, `${PREPARE.base}${keepQuery(req)}`));
  router.get('/admin/instances/manual', (req, res) => res.redirect(302, '/api/v1/admin/instances/new'));

  router.get('/admin/instances/new', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      res.type('html').send(newPage(await funnelsRepo.listByTenant(req.tenantId)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/instances/ready/post', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const funnelId = req.body?.funnelId;
      const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
      if (!funnelId) return res.status(400).json({ ok: false, error: 'funnelId required' });
      const accessToken = String(req.body?.accessToken || '');
      const out = await readyPost.postSelections({ tenantId: req.tenantId, funnelId, selections, accessToken, accounts: req.body?.accounts });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Prepare: a funnel's sources and their ready videos, each with its stage
  // panels (clean → transcript gate → copy + thumbnails → schedule).
  router.get('/admin/instances/prepare', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const funnelId = req.query.funnel ? String(req.query.funnel) : '';
      const list = await funnelsRepo.listByTenant(req.tenantId);
      if (!funnelId) return res.type('html').send(readyChooserPage(list));
      const folder = parseDriveFolderId(req.query.folder);
      const picked = parsePickedFiles(req.query.picked);
      const out = await readyPost.listReadyVideos({ tenantId: req.tenantId, funnelId, folder, picked });
      const prefills = defaultSlotsIso(out.resolved.publishTime, out.videos.length).map((iso) => formatIst(iso));
      res.type('html').send(readyAiPickerPage({ ...out, prefills }));
    } catch (err) {
      next(err);
    }
  });

  // Stage 2: transcribe one video, then stop for the operator's review.
  router.post('/admin/instances/ready-ai/transcribe', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { funnelId, driveId, name, accessToken, source } = req.body || {};
      if (!funnelId || !driveId) return res.status(400).json({ ok: false, error: 'funnelId and driveId required' });
      res.json({ ok: true, ...(await readyPost.transcribeVideo({ tenantId: req.tenantId, funnelId, driveId: String(driveId), name: String(name || ''), accessToken: String(accessToken || ''), source })) });
    } catch (err) {
      log.error({ err: err.message }, 'ready-ai transcribe failed');
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Stage 2: save an edited / pasted (SRT) transcript; approve = pass the gate.
  router.post('/admin/instances/ready-ai/transcript', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { funnelId, driveId, name, text, headline, subhead, imagePrompt, approve, source } = req.body || {};
      if (!funnelId || !driveId) return res.status(400).json({ ok: false, error: 'funnelId and driveId required' });
      res.json({ ok: true, ...(await readyPost.saveTranscript({
        funnelId, driveId: String(driveId), name: String(name || ''), text: String(text || ''),
        headline: String(headline || ''), subhead: String(subhead || ''), imagePrompt: String(imagePrompt || ''), approve: approve === true, source,
      })) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/instances/ready-ai/source/delete', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { funnelId, sourceId } = req.body || {};
      if (!funnelId || !sourceId) return res.status(400).json({ ok: false, error: 'funnelId and sourceId required' });
      res.json({ ok: await readyPost.removeSource({ funnelId, sourceId }) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Stage 3: copy + thumbnails, only from the approved transcript.
  router.post('/admin/instances/ready-ai/generate', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { funnelId, driveId, name, accessToken, accounts } = req.body || {};
      if (!funnelId || !driveId) return res.status(400).json({ ok: false, error: 'funnelId and driveId required' });
      const out = await readyPost.generateCopy({ tenantId: req.tenantId, funnelId, driveId: String(driveId), name: String(name || ''), accessToken: String(accessToken || ''), accounts });
      res.json({ ok: true, ...out });
    } catch (err) {
      log.error({ err: err.message }, 'ready-ai generate failed');
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // 💾 Save draft: keep the page's current copy / thumbnails for one video.
  router.post('/admin/instances/ready-ai/save', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { funnelId, driveId, copy, thumbs, sizes, costs } = req.body || {};
      if (!funnelId || !driveId) return res.status(400).json({ ok: false, error: 'funnelId and driveId required' });
      res.json({ ok: true, ...(await readyPost.saveDraftEdit({ funnelId, driveId, copy, thumbs, sizes, costs })) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ✂ Clean: zoom out a corner watermark + cut the outro, in the background.
  router.post('/admin/instances/ready-ai/clean', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { funnelId, driveId, zoomPct, trimEndSec, endText, endLink, endSec, name, source } = req.body || {};
      if (!funnelId || !driveId) return res.status(400).json({ ok: false, error: 'funnelId and driveId required' });
      res.json({ ok: true, ...(await readyPost.startClean({ funnelId, driveId, zoomPct, trimEndSec, endText, endLink, endSec, name: String(name || ''), source })) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/instances/ready-ai/clean-status', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { funnelId, driveId } = req.body || {};
      if (!funnelId || !driveId) return res.status(400).json({ ok: false, error: 'funnelId and driveId required' });
      res.json({ ok: true, ...(await readyPost.cleanStatus({ funnelId, driveId })) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Video lengths for the listed Drive videos (ffprobe on the public link).
  router.post('/admin/instances/ready-ai/durations', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      res.json({ ok: true, durations: await readyPost.videoDurations(req.body?.ids) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/admin/instances/:id/data', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const row = await instances.get(req.params.id);
      if (!row) return res.status(404).json({ error: 'not found' });
      const steps = instances.parseSteps(row);
      res.json({ instance: { ...row, steps }, cost: { total: sumInstanceCost(steps), byStep: costBreakdown(steps) } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/instances/manual/new', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const funnel = await funnelsRepo.get(Number(req.body?.funnelId));
      if (!funnel) return res.status(404).json({ ok: false, error: 'funnel not found' });
      const inst = await instances.createForFunnel({
        tenantId: req.tenantId, funnel, title: `${funnel.name} — manual ${formatIst(new Date(), { withTime: false })}`, status: 'manual', sourceType: 'generated',
      });
      res.json({ ok: true, id: inst.id });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/admin/instances/:id', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const row = await instances.get(req.params.id);
      if (!row) return res.redirect('/api/v1/admin/instances');
      const steps = instances.parseSteps(row);
      const lane = laneOf(row);
      // A ready video in progress opens on its stage panels.
      if (lane === 'ready' && !row.locked && row.funnel_id) {
        try {
          return res.type('html').send(readyAiPickerPage(await readyPost.instanceView(row)));
        } catch (err) {
          log.warn({ err: err.message, instance: row.id }, 'ready instance view failed (showing detail)');
        }
      }
      const manual = row.status === 'manual' && !row.locked;
      res.type('html').send(manual ? manualPage(row, steps) : detailPage(row, steps));
    } catch (err) {
      next(err);
    }
  });

  // Manual stepper: execute ONE stage. Script "save edited text" is instant and
  // runs inline; every other stage is queued on the job runner (image/animation/
  // voiceover can take minutes) and the page auto-refreshes while it runs.
  router.post('/admin/instances/:id/stage/:key/execute', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { id, key } = req.params;
      if (!MANUAL_STAGES.includes(key)) return res.status(400).json({ ok: false, error: 'unknown stage' });
      const row = await instances.get(id);
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
      if (row.locked) return res.status(400).json({ ok: false, error: 'locked' });
      const input = (req.body && req.body.input) || {};
      await instances.updateStep(id, key, { status: 'running', startedAt: new Date().toISOString(), error: null });
      if (key === 'script' && input.text && input.text.trim()) {
        const r = await stageRunner.executeManualStage({ instanceId: id, stepKey: key, input });
        return res.json(r);
      }
      await jobRunner.enqueueJob({ tenantId: req.tenantId, type: MANUAL_JOB, payload: { instanceId: id, stepKey: key, input } });
      res.json({ ok: true, queued: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  jobRunner.registerHandler(
    MANUAL_JOB,
    async (job) => {
      const { instanceId, stepKey, input } = job.payload || {};
      if (!instanceId || !stepKey) return;
      await stageRunner.executeManualStage({ instanceId, stepKey, input });
    },
    { maxAttempts: 1, backoffSeconds: 30 }, // manual: the operator retries, no auto-retry
  );

  router.post('/admin/instances/sample', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = await instances.createSample({ tenantId: req.tenantId });
      res.json({ ok: true, id });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/instances/:id/delete', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const ok = await instances.remove(req.params.id);
      res.json({ ok, error: ok ? null : 'locked or not found' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Send a checkpoint review email (script | final) for this instance. Same
  // keyOk guard as the other UI actions; the service also exposes the
  // admin-key /jobs/instance-review trigger for programmatic callers (slice 5).
  router.post('/admin/instances/:id/send-review', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const checkpoint = String(req.query.checkpoint || req.body?.checkpoint || 'script');
      const r = await review.requestReview({ tenantId: req.tenantId, instanceId: req.params.id, checkpoint });
      res.json({ ok: true, reviewUrl: r.reviewUrl, emailedTo: r.approvalEmail || null });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  log.info('instances UI routes registered');
}

// ---- rendering -------------------------------------------------------------

const STATUS_LABEL = {
  script_review: 'Script review',
  running: 'Running',
  final_review: 'Final review',
  approved: 'Approved',
  posted: 'Posted',
  failed: 'Failed',
  superseded: 'Superseded',
  manual: 'Generated (manual)',
  draft: 'Ready video',
  transcript_review: 'Transcript review',
};

function statusPill(status) {
  const cls = status === 'posted' ? 'ok' : status === 'failed' ? 'bad' : status === 'superseded' ? 'mut' : 'warn';
  return `<span class="pill ${cls}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

function usd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function finalVideoId(steps) {
  const stitch = (steps || []).find((s) => s.key === 'stitch');
  return stitch && stitch.artifacts && stitch.artifacts.video ? stitch.artifacts.video.driveId : '';
}

function listPage(rows, status) {
  const tabs = [['', 'All'], ['transcript_review', 'Transcripts to verify'], ['draft', 'Ready videos'], ['final_review', 'In review'], ['posted', 'Posted']]
    .map(([v, l]) => `<a class="tab${(status || '') === v ? ' on' : ''}" href="/api/v1/admin/instances${v ? `?status=${v}` : ''}">${esc(l)}</a>`)
    .join('');

  const body = (rows || [])
    .map((r) => {
      const steps = instances.parseSteps(r);
      const vid = finalVideoId(steps);
      const preview = vid
        ? `<button class="act" onclick="openVideo('${esc(vid)}')">▶ Preview</button>`
        : '<span class="hint">—</span>';
      const del = r.locked ? '' : `<button class="act danger" onclick="del('${esc(r.id)}')">Delete</button>`;
      return `<tr>
        <td><a href="/api/v1/admin/instances/${esc(r.id)}">${esc(shortId(r.id))}</a></td>
        <td>${esc(r.title || '—')}</td>
        <td>${esc(r.funnel_name || '—')}</td>
        <td>${r.duration_seconds != null ? esc(formatDuration(r.duration_seconds)) : '—'}</td>
        <td>${esc(usd(r.cost_usd))}</td>
        <td>${statusPill(r.status)}${laneOf(r) === 'ready' && !r.locked ? ` <span class="hint">${esc(stageLabel(readyStage(r, steps)))}</span>` : ''}</td>
        <td>${esc(formatIst(r.posted_at))}</td>
        <td class="actions">${preview} <a class="act" href="/api/v1/admin/instances/${esc(r.id)}">Open</a> ${del}</td>
      </tr>`;
    })
    .join('');

  return shell('Instances', `
    <div class="top">
      <h1>Instances</h1>
      <div class="toprow">
        <div class="tabs">${tabs}</div>
        <a class="act primary" href="/api/v1/admin/instances/new">+ New</a>
        <button class="act" onclick="sample()">+ Sample</button>
      </div>
    </div>
    <table>
      <thead><tr><th>Instance</th><th>Title</th><th>Funnel</th><th>Length</th><th>Cost</th><th>Status</th><th>Posted</th><th></th></tr></thead>
      <tbody>${body || '<tr><td colspan="8" class="hint">No instances yet. A run creates one; use + Sample to preview the UI.</td></tr>'}</tbody>
    </table>
    ${previewModal()}
  `, `
    async function sample(){ const r=await fetch('/api/v1/admin/instances/sample',{method:'POST'}); const j=await r.json(); if(j.ok) location.reload(); else alert(j.error||'failed'); }
    async function del(id){ if(!confirm('Delete this instance?')) return; const r=await fetch('/api/v1/admin/instances/'+id+'/delete',{method:'POST'}); const j=await r.json(); if(j.ok) location.reload(); else alert(j.error||'failed'); }
  `, 'instances');
}

function detailPage(row, steps) {
  const bd = costBreakdown(steps);
  const total = sumInstanceCost(steps);

  const stepRows = INSTANCE_STEPS.map((def) => {
    const s = steps.find((x) => x.key === def.key) || { status: 'pending', artifacts: {} };
    const a = s.artifacts || {};
    let summary = '—';
    let preview = '';
    if (def.key === 'script' && a.text) { summary = `${a.text.length} chars`; preview = btn(`openText('Script', S.script)`); }
    else if (def.key === 'images' && Array.isArray(a.images)) { summary = `${a.images.length} stills`; preview = btn(`openGrid('Images', S.images, 'image')`); }
    else if (def.key === 'animate' && Array.isArray(a.clips)) { summary = `${a.clips.length} clips`; preview = btn(`openGrid('Clips', S.clips, 'video')`); }
    else if (def.key === 'voiceover' && a.audio) { summary = a.audio.durationSec ? `${formatDuration(a.audio.durationSec)} audio` : 'audio'; preview = btn(`openAudio(S.voiceover)`); }
    else if (def.key === 'transcript' && a.text) { summary = 'timestamps'; preview = btn(`openText('Transcript', S.transcript)`); }
    else if (def.key === 'stitch' && a.video) { summary = a.video.durationSec ? `${formatDuration(a.video.durationSec)} reel` : 'reel'; preview = btn(`openVideo(S.stitch)`, 'primary'); }
    else if (def.key === 'publish' && Array.isArray(a.posts) && a.posts.length) { summary = `${a.posts.length} posts`; }
    const cost = bd[def.key] ? usd(bd[def.key]) : '—';
    return `<tr>
      <td class="stepname"><span class="dot ${s.status}"></span>${esc(def.label)}</td>
      <td>${esc(statusWord(s.status))}</td>
      <td>${esc(summary)}</td>
      <td>${esc(cost)}</td>
      <td>${preview || '<span class="hint">—</span>'}</td>
    </tr>`;
  }).join('');

  const data = {
    script: (steps.find((s) => s.key === 'script')?.artifacts?.text) || '',
    transcript: (steps.find((s) => s.key === 'transcript')?.artifacts?.text) || '',
    images: ((steps.find((s) => s.key === 'images')?.artifacts?.images) || []).map((i) => i.driveId),
    clips: ((steps.find((s) => s.key === 'animate')?.artifacts?.clips) || []).map((c) => c.driveId),
    voiceover: (steps.find((s) => s.key === 'voiceover')?.artifacts?.audio?.driveId) || '',
    stitch: finalVideoId(steps),
  };

  return shell(`Instance ${shortId(row.id)}`, `
    <div class="top">
      <div>
        <h1>${esc(row.title || 'Untitled')}</h1>
        <div class="sub">${esc(row.funnel_name || '—')} · instance ${esc(shortId(row.id))} · round ${esc(String(row.round || 1))}</div>
      </div>
      <div class="toprow">
        ${statusPill(row.status)}
        ${row.locked ? '<span class="pill ok">🔒 locked</span>' : ''}
        <a class="act" href="/api/v1/admin/instances">← All instances</a>
      </div>
    </div>
    <p class="ro">Read-only here. ${row.locked ? 'Posted and locked.' : 'Approve or request a change from the emailed review link.'}</p>
    ${row.locked ? '' : `<div class="row">
      <button class="act" onclick="sendReview('script')">✉ Send script review</button>
      <button class="act primary" onclick="sendReview('final')">✉ Send final review</button>
      <span id="rvmsg" class="hint"></span>
    </div>`}

    <table class="steps">
      <thead><tr><th>Step</th><th>Status</th><th>Output</th><th>Cost</th><th>Preview</th></tr></thead>
      <tbody>${stepRows}</tbody>
      <tfoot><tr><td colspan="3" class="tot">Total AI cost</td><td class="tot">${esc(usd(total))}</td><td></td></tr></tfoot>
    </table>

    <p class="meta">Created ${esc(formatIst(row.created_at))}${row.posted_at ? ` · posted ${esc(formatIst(row.posted_at))}` : ''}</p>
    ${previewModal()}
  `, `
    const S = ${JSON.stringify(data)};
    async function sendReview(cp){
      const m=document.getElementById('rvmsg'); if(m) m.textContent='Sending…';
      try{
        const r=await fetch('/api/v1/admin/instances/${row.id}/send-review?checkpoint='+cp,{method:'POST'});
        const j=await r.json();
        if(m) m.textContent = j.ok ? ('Sent'+(j.emailedTo?(' to '+j.emailedTo):' — no approval email set, link only')) : ('Failed: '+(j.error||''));
      }catch(e){ if(m) m.textContent='Failed: '+e.message; }
    }
  `, 'instances');
}

function btn(call, kind = '') {
  return `<button class="act ${kind}" onclick="${call}">▶ Preview</button>`;
}

const PREPARE = { base: '/api/v1/admin/instances/prepare', title: 'Prepare — ready videos', nav: 'prepare' };

// Ready-video: funnel chooser when none is in the query.
function readyChooserPage(funnels, lane = PREPARE) {
  const items = (funnels || [])
    .map((f) => `<a class="act" href="${lane.base}?funnel=${encodeURIComponent(f.id)}">${esc(f.name)}</a>`)
    .join(' ');
  return shell(lane.title, `
    <div class="top">
      <h1>${esc(lane.title)}</h1>
      <div class="toprow"><a class="act" href="/api/v1/admin/instances">← All instances</a></div>
    </div>
    <p class="ro">Pick a funnel. Its saved sources (Drive folders of finished videos) open with their videos; each video becomes one instance and moves through ✂ Clean → transcript → copy + thumbnails → schedule.</p>
    <div class="row">${items || '<span class="hint">No funnels yet.</span>'}</div>
  `, '', lane.nav);
}

// Ready-video: which connected Post for Me accounts to post to. Loaded with the
// global API key; the funnel's last choice is pre-ticked, and the ticks are
// saved back on the funnel when you generate / post.
function acctBar(resolved = {}) {
  const saved = (resolved.accounts || []).map((id) => ({ id, platform: ((resolved.accountMap || {})[id] || {}).platform || '', name: ((resolved.accountMap || {})[id] || {}).account_name || id }));
  return `<div class="acctbar"><b>Post to:</b> <span id="acctlist" class="hint">Loading your Post for Me accounts…</span></div>
    <script>
      const SAVED_ACCTS = ${JSON.stringify(saved).replace(/</g, '\\u003c')};
      let ACCTS = SAVED_ACCTS.slice();
      function renderAccts(){
        const el=document.getElementById('acctlist'); if(!el) return;
        const on=new Set(SAVED_ACCTS.map(a=>a.id));
        el.className='';
        el.innerHTML = ACCTS.length ? ACCTS.map(a=>'<label class="nowrow acct"><input type="checkbox" class="acctcb" value="'+a.id+'" data-plat="'+String(a.platform).replace(/"/g,'')+'" data-name="'+String(a.name).replace(/"/g,'')+'"'+(on.has(a.id)?' checked':'')+'> <b>'+String(a.platform).replace(/</g,'&lt;')+'</b> '+String(a.name).replace(/</g,'&lt;')+'</label>').join(' ')
          : '<span class="hint">No connected accounts found in Post for Me.</span>';
      }
      function pickedAccounts(){ return Array.from(document.querySelectorAll('.acctcb:checked')).map(c=>({ id:c.value, platform:c.dataset.plat, name:c.dataset.name })); }
      fetch('/api/v1/admin/funnels/fetch-accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
        .then(r=>r.json()).then(j=>{ if(j.ok){ const ids=new Set(ACCTS.map(a=>a.id)); (j.accounts||[]).forEach(a=>{ if(!ids.has(a.id)) ACCTS.push(a); }); renderAccts(); } else { renderAccts(); const el=document.getElementById('acctlist'); if(el) el.insertAdjacentHTML('beforeend',' <span class="hint">⚠ '+String(j.error||'').replace(/</g,'&lt;')+'</span>'); } })
        .catch(()=>renderAccts());
    </script>`;
}

// Ready-video: where the videos come from.
//  1. 📂 Pick from Drive — "Sign in with Google" + Google's own picker; the app
//     then acts only on the picked files with the operator's short-lived token
//     (drive.file scope). Nothing to share, no service account, any account.
//  2. Or paste a folder link — read with no key at all when the folder is shared
//     "Anyone with the link" (or via the service account when one is set). The
//     last folder per funnel is remembered in this browser.
function folderBar(funnel, { folder = '', saEmail = '', listError = '', totalFiles = 0, videos = [], picked = false, picker = {} } = {}) {
  const fid = esc(String(funnel.id));
  const pk = { clientId: picker.clientId || '', apiKey: picker.apiKey || '', appId: picker.appId || '' };
  const pickerReady = !!(pk.clientId && pk.apiKey && pk.appId);
  const link = folder ? `https://drive.google.com/drive/folders/${folder}` : '';
  const share = saEmail ? `Share the folder with <b>${esc(saEmail)}</b> as <b>Editor</b> (Editor lets the app tag posted files "POSTED").` : 'In Drive, set the folder sharing to <b>Anyone with the link</b>.';
  let status = '';
  if (picked) status = `<p class="hint">🟢 ${esc(String(videos.length))} video(s) picked from Google Drive. Tick the one(s) to post. <a href="#" onclick="clearPicked();return false">✕ Clear</a></p>`;
  else if (!folder) status = '<p class="ro">Paste the Google Drive folder link (or ID) that holds your videos, then press ↻ Load / refresh. The folder must be shared “Anyone with the link”.</p>';
  else if (listError) status = `<p class="ro">⚠ Couldn't open that folder: ${esc(listError)}. ${share}</p>`;
  else if (!videos.length) status = `<p class="ro">No unposted videos in this folder (${esc(String(totalFiles))} file(s) seen). Videos already posted are hidden. ${totalFiles ? '' : share}</p>`;
  else status = `<p class="hint">${esc(String(videos.length))} unposted video(s) in this folder. Tick the one(s) to post.</p>`;
  return `<div class="row" style="gap:.5rem;align-items:center;margin:.6rem 0">
      <input id="folderin" style="flex:1;min-width:260px" placeholder="Paste Drive folder link or ID (folder shared “Anyone with the link”)" value="${esc(link)}" onkeydown="if(event.key==='Enter')loadFolder()">
      <button class="act primary" onclick="loadFolder()">↻ Load / refresh</button>
      ${link ? `<a class="act" href="${esc(link)}" target="_blank" rel="noopener">Open in Drive ↗</a>` : ''}
    </div>
    ${pickerReady ? `<div class="row" style="gap:.5rem;align-items:center;margin:.3rem 0">
      <button class="act" onclick="pickDrive(false)">📂 …or pick from Drive</button>
      <a class="act" href="#" onclick="pickDrive(true);return false" title="Sign in with a different Google account">⇄ Switch Google account</a>
    </div>` : ''}
    ${status}
    ${pickerReady ? '<script src="https://accounts.google.com/gsi/client" async defer></script><script src="https://apis.google.com/js/api.js" async defer></script>' : ''}
    <script>
      const PK = ${JSON.stringify(pk).replace(/</g, '\\u003c')};
      const PICKED = ${picked ? 'true' : 'false'};
      const TOK = 'gdriveTok';
      function savedToken(){ try{ const t=JSON.parse(sessionStorage.getItem(TOK)||'null'); return t && t.exp>Date.now() ? t.t : ''; }catch(e){ return ''; } }
      function saveToken(t, secs){ try{ sessionStorage.setItem(TOK, JSON.stringify({ t, exp: Date.now()+(Math.max(60,Number(secs)||3600)-60)*1000 })); }catch(e){} }
      // Sign in with Google (drive.file) and hand the token to cb.
      function withToken(switchAccount, cb){
        const t = switchAccount ? '' : savedToken();
        if(t) return cb(t);
        if(!PK.clientId){ alert('Set the Google sign-in client ID, Picker API key and project number under Settings → Workspace → Google first.'); return; }
        if(!(window.google && google.accounts && google.accounts.oauth2)){ alert('Google sign-in is still loading — try again in a second.'); return; }
        const tc = google.accounts.oauth2.initTokenClient({ client_id: PK.clientId, scope: 'https://www.googleapis.com/auth/drive.file',
          callback: (r)=>{ if(r.error){ alert('Google sign-in failed: '+r.error); return; } saveToken(r.access_token, r.expires_in); cb(r.access_token); } });
        tc.requestAccessToken(switchAccount ? { prompt: 'select_account' } : {});
      }
      // The token for generate / post — only when the videos were picked with sign-in.
      function driveToken(){ if(!PICKED) return Promise.resolve(''); const t=savedToken(); return t ? Promise.resolve(t) : new Promise((res)=>withToken(false,res)); }
      function goPicked(files){
        const u=new URL(location.href); u.searchParams.set('funnel','${fid}'); u.searchParams.delete('folder');
        u.searchParams.set('picked', JSON.stringify(files)); location.href=u.toString();
      }
      function clearPicked(){ const u=new URL(location.href); u.searchParams.delete('picked'); location.href=u.toString(); }
      function pickDrive(switchAccount){
        if(!(PK.clientId && PK.apiKey && PK.appId)){ alert('Set the Google sign-in client ID, Picker API key and project number under Settings → Workspace → Google first.'); return; }
        withToken(switchAccount, (tok)=>{
          if(!window.gapi){ alert('Google Picker is still loading — try again in a second.'); return; }
          gapi.load('picker', ()=>{
            const view = new google.picker.DocsView(google.picker.ViewId.DOCS_VIDEOS).setIncludeFolders(true).setMode(google.picker.DocsViewMode.LIST);
            const p = new google.picker.PickerBuilder()
              .addView(view)
              .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
              .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
              .setOAuthToken(tok).setDeveloperKey(PK.apiKey).setAppId(PK.appId)
              .setTitle('Pick the video(s) to post')
              .setCallback((d)=>{ if(d.action===google.picker.Action.PICKED){ goPicked((d.docs||[]).map(x=>({ id:x.id, name:x.name }))); } })
              .build();
            p.setVisible(true);
          });
        });
      }
      function loadFolder(){
        const v=document.getElementById('folderin').value.trim();
        const u=new URL(location.href); u.searchParams.set('funnel','${fid}'); u.searchParams.delete('picked');
        if(v) u.searchParams.set('folder', v); else u.searchParams.delete('folder');
        try{ if(v) localStorage.setItem('readyFolder-${fid}', v); else localStorage.removeItem('readyFolder-${fid}'); }catch(e){}
        location.href=u.toString();
      }
      (function(){ try{
        const u=new URL(location.href), saved=localStorage.getItem('readyFolder-${fid}');
        if(!u.searchParams.get('folder') && !u.searchParams.get('picked') && saved){ u.searchParams.set('folder', saved); location.replace(u.toString()); }
      }catch(e){} })();
    </script>`;
}

// Ready-video stage panels, per video: 1 Prepare (✂ Clean) → 2 Transcript
// (transcribe / edit / paste SRT, then approve — the gate) → 3 AI copy +
// thumbnails (only after approval) → 4 Review & schedule → posted. The Prepare
// list shows them for every ticked video; an instance's own view shows them
// for its one video (`single`).
function stageChips(id, stage) {
  return READY_STAGES.map((s, i) => `<span class="chip${s.key === stage ? ' on' : ''}" data-k="${esc(s.key)}">${i + 1} · ${esc(s.label)}</span>`).join('');
}

function sourcesBar(funnel, sources = [], folder = '') {
  const items = (sources || []).filter((x) => x.type === 'drive_folder').map((x) => `<span class="srcchip${x.ref === folder ? ' on' : ''}">
      <a href="${PREPARE.base}?funnel=${encodeURIComponent(funnel.id)}&folder=${encodeURIComponent(x.ref)}">📁 ${esc(x.label || x.ref)}</a>
      <button title="Forget this source" onclick="dropSource(${Number(x.id)})">✕</button></span>`).join('');
  if (!items) return '';
  return `<div class="row srcbar"><b>Sources:</b> ${items}</div>`;
}

function readyAiPickerPage({ funnel, videos, prefills = [], drafts = {}, single = null, source = {}, ...src }) {
  const cta = String((src.resolved || {}).ctaLink || '').trim();
  const cards = (videos || [])
    .map((v, i) => {
      const d = drafts[v.id] || {};
      const id = esc(v.id);
      return `<div class="card">
      <div class="tile" onclick="openVideo('${id}')"><img src="${esc(driveThumbUrl(v.id, 'w400'))}" loading="lazy"><span class="playov">▶</span><span class="dur" id="du-${id}"></span></div>
      <label class="pick"><input type="checkbox" id="cb-${id}" onchange="toggle('${id}')"> <span class="ord" id="ord-${id}" data-id="${id}"></span> ${esc(v.name)}</label>
      <div class="stgrow"><span class="pill warn stg" id="sp-${id}">${esc(stageLabel(d.stage || 'prepare'))}</span> <span id="ol-${id}">${d.instanceId && !single ? `<a class="hint" href="/api/v1/admin/instances/${esc(d.instanceId)}">Open instance ›</a>` : ''}</span></div>
      <input type="hidden" id="nm-${id}" value="${esc(v.name)}">
      <div class="det ailay" id="det-${id}">
        <div class="chips" id="st-${id}">${stageChips(v.id, d.stage || 'prepare')}</div>
        <div class="aicol">
          <div class="panel"><h4>1 · Prepare <span class="hint">optional — only videos with a watermark / outro</span></h4>
            <div class="nowrow cleanrow"><span>Remove watermark + outro —</span>
              <label class="nowrow">zoom % <input id="zm-${id}" class="cleanzm" type="number" min="0" max="30" step="0.5" style="width:4.5rem"></label>
              <label class="nowrow">cut last s <input id="tr-${id}" class="cleantr" type="number" min="0" max="60" step="0.5" style="width:4.5rem"></label>
              <button class="act" id="cl-${id}" onclick="cleanVid('${id}')">✂ Clean video</button>
            </div>
            <div class="endcard">
              <label class="fl">End card text — black screen, white text, centred (blank = no end card)<textarea id="ec-${id}" class="endtx" rows="2" placeholder="e.g. Take the free assessment"></textarea></label>
              <div class="nowrow">
                <label class="nowrow" style="flex:1">link <input id="el-${id}" class="endln" style="flex:1" placeholder="https://…"></label>
                <label class="nowrow">seconds <input id="es-${id}" class="endsec" type="number" min="0" max="15" step="0.5" style="width:4.5rem"></label>
              </div>
            </div>
            <div class="pbar" id="pb-${id}"><i></i></div>
            <div class="hint" id="cs-${id}">Zooms in keeping the top fixed so the bottom-right watermark leaves the frame, and cuts the outro. The end card plays after the video. Posting then uses the cleaned video.</div>
          </div>
          <div class="panel"><h4>2 · Transcript <span class="hint">check the names, then approve</span></h4>
            <label class="fl">Edit the transcript, or paste an SRT — cue numbers and timestamps are removed before the AI reads it (the SRT itself is kept)<textarea id="tx-${id}" rows="7" oninput="txEdited('${id}')"></textarea></label>
            <label class="fl">Thumbnail headline — big text on the image (you write it)<input id="hl-${id}" maxlength="80" placeholder="e.g. Why STHIRA works"></label>
            <label class="fl">Thumbnail sub-head — smaller line under it (optional)<input id="su-${id}" maxlength="120"></label>
            <label class="fl">Image prompt — drafted from the transcript; edit it to change the artwork<textarea id="ip-${id}" rows="4"></textarea></label>
            <div class="nowrow">
              <button class="act" id="tb-${id}" onclick="transcribe('${id}')">🎙 Transcribe</button>
              <button class="act" id="ts-${id}" onclick="saveTx('${id}', false)">💾 Save</button>
              <button class="act primary" id="gb-${id}" onclick="approveGen('${id}')">✅ Approve + generate copy &amp; thumbnails</button>
            </div>
            <div class="hint" id="tg-${id}">Not transcribed yet — 🎙 Transcribe, or paste the text / SRT. Then type the headline, check the image prompt and approve.</div>
          </div>
          <div class="panel"><h4>3 · AI copy + thumbnails <span class="hint">written from the approved transcript, with your headline</span></h4>
            <div class="nowrow"><button class="act" id="sv-${id}" onclick="saveDraft('${id}')">💾 Save draft</button> <span class="hint" id="gs-${id}"></span></div>
            <div class="thumbs" id="th-${id}"></div>
          </div>
        </div>
        <div class="aicol">
          <div class="panel"><h4>4 · Review &amp; schedule</h4>
            <label class="fl">YouTube title<input id="ti-${id}" maxlength="100"></label>
            <label class="fl">Description — YouTube · LinkedIn · Facebook ${cta ? `(ends with the funnel's CTA link)` : `<span class="warnt">🟡 this funnel has no CTA link — set it in Funnels → setup</span>`}<textarea id="de-${id}" rows="7"></textarea></label>
            <label class="fl">Instagram caption<textarea id="ig-${id}" rows="6"></textarea></label>
            <label class="fl">Short — Threads · X (link appended) <span class="hint" id="sc-${id}"></span><textarea id="sh-${id}" rows="2" oninput="cnt('${id}')"></textarea></label>
            <div class="nowrow"><b>When:</b>
              <label class="nowrow"><input type="radio" name="when-${id}" checked onchange="toggleNow('${id}')"> 📅 Schedule</label>
              <label class="nowrow"><input type="radio" name="when-${id}" id="now-${id}" onchange="toggleNow('${id}')"> ⚡ Post now</label>
            </div>
            <label class="fl">Schedule (IST DD-MM-YYYY HH:MM)<input id="sch-${id}" value="${esc(prefills[i] || '')}"></label>
          </div>
        </div>
      </div>
    </div>`;
    })
    .join('');

  const head = single
    ? `<div class="top">
      <div>
        <h1>${esc(single.title || 'Ready video')}</h1>
        <div class="sub">${esc(funnel.name)} · instance ${esc(shortId(single.id))} · ${esc(SOURCE_TYPES[source.type] || 'Ready video')} · ready-video lane</div>
      </div>
      <div class="toprow">${statusPill(single.status)}
        <a class="act" href="${PREPARE.base}?funnel=${encodeURIComponent(funnel.id)}">← Prepare list</a>
        <a class="act" href="/api/v1/admin/instances">All instances</a>
      </div>
    </div>
    <script>const PICKED=false; function driveToken(){ return Promise.resolve(''); }</script>`
    : `<div class="top">
      <div>
        <h1>Prepare — ${esc(funnel.name)}</h1>
        <div class="sub">Tick a video and take it through its stages: ✂ Clean (optional) → 🎙 Transcript (fix the names, or paste an SRT) → ✅ Approve → ✨ Generate copy + thumbnails → schedule. Nothing paid runs on a transcript you haven't approved. Each video is one instance. Posts go out in the order you ticked.</div>
      </div>
      <div class="toprow">
        <a class="act" href="${PREPARE.base}">↺ Change funnel</a>
        <a class="act" href="/api/v1/admin/instances">← All instances</a>
      </div>
    </div>
    ${sourcesBar(funnel, src.sources, src.folder)}
    ${folderBar(funnel, src)}`;

  return shell(single ? `Instance ${shortId(single.id)}` : `Prepare — ${funnel.name}`, `
    ${head}
    ${acctBar(src.resolved)}
    <div class="grid">${cards}</div>
    <div class="bar">
      <button class="approve" onclick="postSel(false)">📅 Schedule ${single ? 'this video' : 'selected'}</button>
      <button class="approve" onclick="postSel(true)">⚡ Post ${single ? 'it' : 'selected'} now</button>
      <span id="rmsg" class="hint"></span>
    </div>
    <p class="hint">📅 Schedule uses each video's own choice (a video set to ⚡ Post now still goes immediately). ⚡ Post now publishes immediately, ignoring the schedules.</p>
    ${previewModal()}
  `, `
    const FUNNEL_ID = ${JSON.stringify(String(funnel.id))};
    const SOURCE = ${JSON.stringify({ type: source.type || 'drive_folder', id: source.id || null })};
    const SINGLE = ${single ? 'true' : 'false'};
    const CTA = ${JSON.stringify(cta).replace(/</g, '\\u003c')};
    // What the box shows is what posts: the CTA link ends the description (the post adds it only when missing).
    const withCta = t=>{ t=String(t||'').trim(); return !CTA || t.indexOf(CTA)>=0 ? t : (t ? t+'\\n\\n'+CTA : CTA); };
    const STAGE_LABEL = ${JSON.stringify(Object.fromEntries(READY_STAGES.map((s) => [s.key, s.label])))};
    const order = [], costs = {}, busy = {}, done = {}, thumbs = {}, approved = {};
    (function(){
      const ids=Array.from(document.querySelectorAll('[id^="du-"]')).map(e=>e.id.slice(3));
      if(!ids.length) return;
      fetch('/api/v1/admin/instances/ready-ai/durations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ ids })})
        .then(r=>r.json()).then(j=>{ if(!j.ok) return; Object.keys(j.durations||{}).forEach(id=>{ const n=Number(j.durations[id])||0, e=document.getElementById('du-'+id); if(e&&n) e.textContent=Math.floor(n/60)+':'+String(n%60).padStart(2,'0'); }); })
        .catch(()=>{});
    })();
    const $ = (p,id)=>document.getElementById(p+'-'+id);
    const post = (path, body)=>fetch('/api/v1/admin/instances/ready-ai/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({ funnelId:FUNNEL_ID }, body))}).then(r=>r.json());
    function msg(t){ const m=document.getElementById('rmsg'); if(m) m.textContent=t; }
    function renumber(){ order.forEach((id,i)=>{ const b=$('ord',id); if(b) b.textContent='#'+(i+1); }); document.querySelectorAll('.ord').forEach(b=>{ if(order.indexOf(b.dataset.id)<0) b.textContent=''; }); }
    function cnt(id){ $('sc',id).textContent='('+$('sh',id).value.length+'/220)'; }
    function toggle(id){
      const cb=$('cb',id), det=$('det',id);
      if(cb.checked){ if(order.indexOf(id)<0) order.push(id); det.classList.add('on'); }
      else { const k=order.indexOf(id); if(k>=0) order.splice(k,1); det.classList.remove('on'); }
      det.parentElement.classList.toggle('wide', cb.checked);
      renumber();
    }
    function setStage(id, k){
      const st=$('st',id); if(st) st.querySelectorAll('.chip').forEach(c=>c.classList.toggle('on', c.dataset.k===k));
      const sp=$('sp',id); if(sp) sp.textContent=STAGE_LABEL[k]||k;
    }
    function setInst(id, instanceId){ const o=$('ol',id); if(!SINGLE && o && instanceId) o.innerHTML='<a class="hint" href="/api/v1/admin/instances/'+instanceId+'">Open instance ›</a>'; }
    // The gate: ✨ Generate is live only for an approved transcript.
    function gateUi(id){ $('gb',id).disabled = !!busy[id]; }
    function txEdited(id){
      if(!approved[id]) return;
      approved[id]=false; gateUi(id); setStage(id, 'transcript');
      $('tg',id).textContent='🟡 Edited — ✅ Approve again to use it.';
    }
    async function transcribe(id){
      if(busy[id]) return;
      if($('tx',id).value.trim() && !confirm('Replace the text in the box with a fresh transcription? (Whisper costs a little.)')) return;
      busy[id]=true; gateUi(id); $('tb',id).disabled=true; $('tg',id).textContent='🎙 Transcribing… (about a minute for a long video)';
      try{
        const j=await post('transcribe', { driveId:id, name:$('nm',id).value, source:SOURCE, accessToken: await driveToken() });
        if(!j.ok) throw new Error(j.error||'failed');
        $('tx',id).value=j.transcript||''; approved[id]=false; setStage(id, 'transcript'); setInst(id, j.instanceId);
        if(j.imagePrompt) $('ip',id).value=j.imagePrompt;
        costs[id]=(costs[id]||[]).concat(j.costs||[]);
        const usd=(j.costs||[]).reduce((t,c)=>t+(Number(c.costUsd)||0),0);
        $('tg',id).textContent=(j.transcribed?'🟡 Transcribed':'🟡 No speech found — type a description, or approve empty to write from the file name')+' · $'+usd.toFixed(4)+' — check the names, type the headline, check the image prompt, then ✅ Approve + generate.'+(j.promptError?' (Image prompt draft failed: '+j.promptError+' — write one.)':'');
      }catch(e){ $('tg',id).textContent='⚠ '+e.message; }
      busy[id]=false; $('tb',id).disabled=false; gateUi(id);
    }
    async function saveTx(id, approve){
      if(busy[id] && !approve) return false;
      const text=$('tx',id).value;
      if(approve && !$('hl',id).value.trim()){ $('tg',id).textContent='🟡 Type the thumbnail headline first.'; $('hl',id).focus(); return false; }
      if(approve && !text.trim() && !confirm('The transcript is empty — the copy will be written from the file name and the brand brief. Approve anyway?')) return false;
      $('ts',id).disabled=true;
      let ok=false;
      try{
        const j=await post('transcript', { driveId:id, name:$('nm',id).value, source:SOURCE, text, approve, headline:$('hl',id).value, subhead:$('su',id).value, imagePrompt:$('ip',id).value });
        if(!j.ok) throw new Error(j.error||'failed');
        $('tx',id).value=j.transcript||''; approved[id]=!!j.approved; setStage(id, j.stage); setInst(id, j.instanceId);
        $('tg',id).textContent=(j.approved?'🟢 Approved '+j.approvedIst+'.':'💾 Saved — not approved yet.')+(j.srt?' SRT timestamps removed for the AI; the SRT is kept.':'');
        ok=true;
      }catch(e){ $('tg',id).textContent='⚠ '+e.message; }
      $('ts',id).disabled=false;
      return ok;
    }
    // One step: save the transcript + your headline / sub-head / image prompt, approve, then write the copy and thumbnails.
    async function approveGen(id){
      if(busy[id]) return;
      busy[id]=true; gateUi(id);
      const ok=await saveTx(id, true);
      busy[id]=false;
      if(ok) await gen(id); else gateUi(id);
    }
    // Show one generation (fresh, or a saved draft restored after a reload).
    function applyGen(id, j){
      $('ti',id).value=j.copy.title||''; $('de',id).value=withCta(j.copy.description); $('ig',id).value=j.copy.igCaption||''; $('sh',id).value=j.copy.short||''; cnt(id);
      $('gb',id).textContent='✅ Approve + regenerate copy & thumbnails';
      thumbs[id]=j.thumbs||{};
      $('th',id).innerHTML=(j.sizes||[]).map(z=>'<a class="'+(z.size==='landscape'?'wide':'tall')+'" href="'+z.url+'" target="_blank" rel="noopener" title="Open full size"><img src="'+z.url+'"><span>'+z.label+' · '+z.platforms.join(', ')+'</span></a>').join('')
        +(j.thumbError?'<div class="hint">⚠ '+String(j.thumbError).replace(/</g,'&lt;')+(Object.keys(thumbs[id]).length?'':' — the first frame will be used')+'</div>':'');
      done[id]=true;
    }
    const SAVED = ${JSON.stringify(drafts).replace(/</g, '\\u003c')};
    // ✂ Clean: the last zoom / cut used in this browser is the default for the next video.
    const cleaning = {};
    let CO = { zoomPct: 10, trimEndSec: 0, endText: '', endLink: '', endSec: 4 };
    try{ CO = Object.assign(CO, JSON.parse(localStorage.getItem('cleanOpts')||'{}')); }catch(e){}
    document.querySelectorAll('.cleanzm').forEach(e=>{ e.value=CO.zoomPct; }); document.querySelectorAll('.cleantr').forEach(e=>{ e.value=CO.trimEndSec; });
    document.querySelectorAll('.endtx').forEach(e=>{ e.value=CO.endText||''; }); document.querySelectorAll('.endln').forEach(e=>{ e.value=CO.endLink||CTA; }); document.querySelectorAll('.endsec').forEach(e=>{ e.value=CO.endSec; });
    const mmss = n=>Math.floor(n/60)+':'+String(Math.round(n)%60).padStart(2,'0');
    function bar(id, pct, on){ const b=$('pb',id); if(!b) return; b.classList.toggle('on', !!on); b.firstElementChild.style.width=Math.max(0,Math.min(100,pct||0))+'%'; b.classList.toggle('busy', on && !(pct>0)); }
    function showClean(id, c){
      bar(id, 0, false);
      $('cs',id).innerHTML='🟢 Cleaned (zoom '+c.zoomPct+'%, cut last '+c.trimEndSec+' s'+(c.endSec?', end card '+c.endSec+' s':'')+' → '+mmss(c.durationSec||0)+') · <a href="'+c.url+'" target="_blank" rel="noopener">▶ Preview cleaned video</a> · posting uses this copy';
      if($('zm',id)) $('zm',id).value=c.zoomPct; if($('tr',id)) $('tr',id).value=c.trimEndSec;
    }
    async function pollClean(id){
      try{
        const j=await post('clean-status', { driveId:id });
        if(j.ok && j.state==='running'){
          const secs=Math.round((Date.now()-j.startedAt)/1000);
          const what = j.phase==='uploading' ? '⬆ Uploading the cleaned video to Post for Me…'
            : j.phase==='encoding' ? '✂ Downloading + re-encoding… '+(j.pct||0)+'%'+(j.totalSec?(' ('+mmss(j.doneSec||0)+' of '+mmss(j.totalSec)+')'):'')
            : '✂ Starting… reading the video length';
          bar(id, j.phase==='uploading'?100:(j.pct||0), true);
          $('cs',id).textContent=what+' · '+secs+' s — you can work on other videos meanwhile';
          return setTimeout(()=>pollClean(id), 3000);
        }
        cleaning[id]=false; $('cl',id).disabled=false; bar(id, 0, false);
        if(j.ok && j.state==='done') showClean(id, j.clean);
        else $('cs',id).textContent='⚠ Clean failed: '+(j.error||j.state||'unknown');
      }catch(e){ setTimeout(()=>pollClean(id), 8000); }
    }
    async function cleanVid(id){
      if(cleaning[id]) return;
      const zoomPct=Number($('zm',id).value)||0, trimEndSec=Number($('tr',id).value)||0;
      const endText=$('ec',id).value, endLink=$('el',id).value.trim(), endSec=(endText.trim()||endLink)?(Number($('es',id).value)||0):0;
      try{ localStorage.setItem('cleanOpts', JSON.stringify({ zoomPct, trimEndSec, endText, endLink, endSec:Number($('es',id).value)||0 })); }catch(e){}
      cleaning[id]=true; $('cl',id).disabled=true; bar(id, 0, true); $('cs',id).textContent='✂ Starting…';
      try{
        const j=await post('clean', { driveId:id, zoomPct, trimEndSec, endText, endLink, endSec, name:$('nm',id).value, source:SOURCE });
        if(!j.ok) throw new Error(j.error||'failed');
        pollClean(id);
      }catch(e){ cleaning[id]=false; $('cl',id).disabled=false; bar(id, 0, false); $('cs',id).textContent='⚠ '+e.message; }
    }
    Object.keys(SAVED).forEach(id=>{
      if(!$('cb',id)) return;
      const d=SAVED[id];
      if(d.clean) showClean(id, d.clean);
      if(d.hasTranscript || d.transcript) $('tx',id).value=d.transcript||'';
      $('hl',id).value=d.headline||''; $('su',id).value=d.subhead||''; $('ip',id).value=d.imagePrompt||'';
      approved[id]=!!d.approved; gateUi(id);
      if(d.hasTranscript) $('tg',id).textContent=d.approved?('🟢 Approved '+d.approvedIst+(d.srt?' · SRT kept':'')):'🟡 Waiting for you — check the names, type the headline, check the image prompt, then ✅ Approve + generate.';
      if(d.copy){ applyGen(id, d); $('gs',id).textContent='💾 Saved draft from '+d.atIst+' · $'+Number(d.costUsd||0).toFixed(4); }
    });
    // Keep this video's current copy (your edits too) without regenerating.
    async function saveDraft(id){
      if(busy[id]) return;
      if(!$('ti',id).value.trim() && !$('de',id).value.trim()){ $('gs',id).textContent='Nothing to save yet — generate or write the copy first.'; return; }
      $('sv',id).disabled=true;
      try{
        const j=await post('save', { driveId:id,
          copy:{ title:$('ti',id).value, description:$('de',id).value, igCaption:$('ig',id).value, short:$('sh',id).value }, thumbs:thumbs[id]||{}, costs:costs[id]||[] });
        if(!j.ok) throw new Error(j.error||'failed');
        done[id]=true; setInst(id, j.instanceId); $('gs',id).textContent='💾 Saved to the instance';
      }catch(e){ $('gs',id).textContent='⚠ Save failed: '+e.message; }
      $('sv',id).disabled=false;
    }
    async function gen(id){
      if(busy[id]) return;
      if(!approved[id]){ $('gs',id).textContent='✅ Approve the transcript first.'; gateUi(id); return; }
      busy[id]=true; gateUi(id); $('gs',id).textContent='Writing copy + designing thumbnails… (about a minute)';
      try{
        const j=await post('generate', { driveId:id, name:$('nm',id).value, accounts: pickedAccounts(), accessToken: await driveToken() });
        if(!j.ok) throw new Error(j.error||'failed');
        applyGen(id, j); setStage(id, 'review'); setInst(id, j.instanceId);
        costs[id]=(costs[id]||[]).concat(j.costs||[]);
        const usd=(j.costs||[]).reduce((t,c)=>t+(Number(c.costUsd)||0),0);
        $('gs',id).textContent='✓ Copy written from the approved transcript · $'+usd.toFixed(4);
      }catch(e){ $('gs',id).textContent='⚠ '+e.message; }
      busy[id]=false; gateUi(id);
    }
    function toggleNow(id){ const n=$('now',id), s=$('sch',id); if(n&&s){ s.disabled=n.checked; s.style.opacity=n.checked?0.45:1; } }
    async function postSel(allNow){
      if(!order.length){ msg('Tick at least one video.'); return; }
      if(!pickedAccounts().length){ msg('Tick at least one account under "Post to".'); return; }
      if(order.some(id=>busy[id])){ msg('Wait for the transcript / copy to finish.'); return; }
      if(order.some(id=>cleaning[id])){ msg('Wait for ✂ Clean to finish.'); return; }
      const nogen=order.filter(id=>!done[id]);
      if(nogen.length){ msg('✅ Approve + generate first for '+nogen.map(id=>$('ord',id).textContent||'this video').join(', ')+'.'); return; }
      const missing=order.filter(id=>!$('ti',id).value.trim()||!$('de',id).value.trim()||!$('ig',id).value.trim()||!$('sh',id).value.trim());
      if(missing.length){ msg('Fill every copy field for '+missing.map(id=>$('ord',id).textContent||'this video').join(', ')+'.'); return; }
      const selections = order.map(id=>({ driveId:id, name:$('nm',id).value, caption:'', scheduledAt:$('sch',id).value, now:allNow||$('now',id).checked,
        copy:{ title:$('ti',id).value, description:$('de',id).value, igCaption:$('ig',id).value, short:$('sh',id).value }, costs:costs[id]||[], thumbs:thumbs[id]||{} }));
      const nowCount=selections.filter(s=>s.now).length;
      if(nowCount && !confirm(nowCount+' video(s) will go live on every channel right now. Continue?')) return;
      msg((nowCount===selections.length?'Posting now ':'Scheduling ')+selections.length+'…');
      try{
        const r=await fetch('/api/v1/admin/instances/ready/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ funnelId:FUNNEL_ID, selections, accounts: pickedAccounts(), accessToken: await driveToken() })});
        const j=await r.json();
        if(j.ok){
          const bad=(j.results||[]).filter(x=>!x.ok);
          msg('Posted '+j.posted+(bad.length?(', '+bad.length+' failed: '+bad.map(x=>x.name+' — '+x.error).join('; ')):'. Opening the log…'));
          if(!bad.length) setTimeout(()=>location.href='/api/v1/admin/instances',1300);
        }
        else msg('Failed: '+(j.error||''));
      }catch(e){ msg('Failed: '+e.message); }
    }
    async function dropSource(sid){
      if(!confirm('Forget this source? Its videos and instances stay.')) return;
      const j=await post('source/delete', { sourceId:sid });
      if(j.ok) location.href='${PREPARE.base}?funnel='+encodeURIComponent(FUNNEL_ID); else alert(j.error||'failed');
    }
    if(SINGLE){ const cb=document.querySelector('[id^="cb-"]'); if(cb){ cb.checked=true; toggle(cb.id.slice(3)); } }
  `, 'prepare');
}

// ---- manual stepper UI -----------------------------------------------------

// Start something: ready videos go through Prepare (per funnel source); a
// generated run is a hand-stepped instance whose stage panels open at once.
function newPage(funnels) {
  const ready = (funnels || [])
    .map((f) => `<a class="act" href="${PREPARE.base}?funnel=${encodeURIComponent(f.id)}">${esc(f.name)}</a>`)
    .join(' ');
  const items = (funnels || [])
    .map((f) => `<button class="act" onclick="startManual('${esc(String(f.id))}')">${esc(f.name)}</button>`)
    .join(' ');
  return shell('New instance', `
    <div class="top">
      <h1>New instance</h1>
      <div class="toprow"><a class="act" href="/api/v1/admin/instances">← All instances</a></div>
    </div>
    <h3>📥 Ready videos <span class="hint">the everyday lane</span></h3>
    <p class="ro">Finished videos from a funnel's Drive folder: ✂ Clean → transcript (you approve it) → AI copy + thumbnails → schedule.</p>
    <div class="row">${ready || '<span class="hint">No funnels yet.</span>'}</div>
    <h3>🎛 Generated run <span class="hint">script → images → animate → voice → stitch</span></h3>
    <p class="ro">A hand-stepped run: generate, preview and approve each stage, then post. Set <b>Manual stepper = On</b> in a funnel to also pause its scheduled daily runs for manual stepping; turn it off to go back to automatic.</p>
    <div class="row">${items || '<span class="hint">No funnels yet.</span>'}</div>
  `, `
    async function startManual(fid){
      const r=await fetch('/api/v1/admin/instances/manual/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({funnelId:fid})});
      const j=await r.json();
      if(j.ok) location.href='/api/v1/admin/instances/'+j.id; else alert(j.error||'failed');
    }
  `, 'instances');
}

function manualCard(key, steps) {
  const s = steps.find((x) => x.key === key) || { status: 'pending', artifacts: {} };
  const a = s.artifacts || {};
  const can = canExecute(steps, key);
  const kind = inputKind(key);
  const label = STAGE_LABEL[key] || key;

  let preview = '';
  if (key === 'script' && a.text) preview = btn(`openText('Script', S.script)`);
  else if (key === 'images' && (a.images || []).length) preview = btn(`openGrid('Images', S.images, 'image')`);
  else if (key === 'animate' && (a.clips || []).length) preview = btn(`openGrid('Clips', S.clips, 'video')`);
  else if (key === 'voiceover' && a.audio) preview = btn(`openAudio(S.voiceover)`);
  else if (key === 'transcript' && a.text) preview = btn(`openText('Transcript', S.transcript)`);
  else if (key === 'stitch' && a.video) preview = btn(`openVideo(S.stitch)`, 'primary');
  else if (key === 'publish' && (a.posts || []).length) preview = '<span class="hint">posted ✓</span>';

  let inputHtml = '';
  if (kind === 'script') inputHtml = `<textarea id="in-script" rows="6" placeholder="Click Generate to draft with AI, or paste/edit your own script, then Save.">${esc(a.text || '')}</textarea>`;
  else if (kind === 'prompts') inputHtml = `<textarea id="in-images" rows="5" placeholder="One image prompt per line. Leave blank to auto-build from the script.">${esc((a.images || []).map((i) => i.prompt || '').join('\n'))}</textarea>`;
  else if (kind === 'prompt') inputHtml = `<input id="in-animate" placeholder="Animation prompt (optional) — applied to every clip">`;
  else if (kind === 'caption') inputHtml = `<textarea id="in-publish" rows="3" placeholder="Caption (blank = the funnel's caption + link). Executing this posts the reel."></textarea>`;

  let actions;
  if (key === 'script') {
    actions = `<button class="act" onclick="genScript()" ${can ? '' : 'disabled'}>✨ Generate with AI</button>
      <button class="act primary" onclick="exec('script')" ${can ? '' : 'disabled'}>Save script</button>`;
  } else {
    actions = `<button class="act primary" onclick="exec('${key}')" ${can ? '' : 'disabled'}>${key === 'publish' ? 'Post now' : 'Execute'}</button>`;
  }

  return `<div class="mcard">
    <h3><span class="dot ${esc(s.status)}"></span>${esc(label)} <span class="hint">${esc(statusWord(s.status))}</span></h3>
    ${s.error ? `<p class="ro">⚠ ${esc(s.error)}</p>` : ''}
    ${inputHtml}
    <div class="mrow">${actions} ${preview} <span id="msg-${esc(key)}" class="hint"></span></div>
  </div>`;
}

function manualPage(row, steps) {
  const total = sumInstanceCost(steps);
  const data = {
    script: (steps.find((s) => s.key === 'script')?.artifacts?.text) || '',
    transcript: (steps.find((s) => s.key === 'transcript')?.artifacts?.text) || '',
    images: ((steps.find((s) => s.key === 'images')?.artifacts?.images) || []).map((i) => i.driveId),
    clips: ((steps.find((s) => s.key === 'animate')?.artifacts?.clips) || []).map((c) => c.driveId),
    voiceover: (steps.find((s) => s.key === 'voiceover')?.artifacts?.audio?.driveId) || '',
    stitch: finalVideoId(steps),
  };
  const running = (steps || []).some((s) => s.status === 'running');
  const cards = MANUAL_STAGES.map((key) => manualCard(key, steps)).join('');

  return shell(`Manual — ${shortId(row.id)}`, `
    <div class="top">
      <div><h1>${esc(row.title || 'Generated run')}</h1><div class="sub">${esc(row.funnel_name || '—')} · ${esc(shortId(row.id))} · 🎛 generated lane, stepped by hand</div></div>
      <div class="toprow">${statusPill(row.status)}<a class="act" href="/api/v1/admin/instances">← All instances</a></div>
    </div>
    <p class="ro">Run each stage in order: edit the input where shown, <b>Execute</b>, <b>Preview</b>, then do the next. The final stage posts.${running ? ' <b>Running…</b> this page refreshes itself.' : ''}</p>
    <div class="mcards">${cards}</div>
    <p class="meta">Total AI cost ${esc(usd(total))} · created ${esc(formatIst(row.created_at))}</p>
    <style>
      .mcards{display:flex;flex-direction:column;gap:.7rem;margin:1rem 0}
      .mcard{border:1px solid #24243a;border-radius:10px;padding:.7rem 1rem;background:#17172a}
      .mcard h3{margin:0 0 .3rem;font-size:.95rem;display:flex;align-items:center;gap:.5rem}
      .mcard textarea,.mcard input{width:100%;background:#0f0f1c;color:#e8e8f0;border:1px solid #2a2a44;border-radius:7px;padding:.5rem;font:inherit;margin:.3rem 0}
      .mrow{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.3rem}
      .mcard button[disabled]{opacity:.4;cursor:not-allowed}
    </style>
    ${previewModal()}
  `, `
    const S=${JSON.stringify(data)};
    ${running ? 'setTimeout(function(){location.reload();},5000);' : ''}
    function val(id){ const e=document.getElementById(id); return e?e.value:''; }
    async function exec(key){
      const m=document.getElementById('msg-'+key); if(m) m.textContent='Working…';
      const input={};
      if(key==='script') input.text=val('in-script');
      else if(key==='images') input.prompts=val('in-images').split('\\n').map(function(s){return s.trim();}).filter(Boolean);
      else if(key==='animate') input.prompt=val('in-animate');
      else if(key==='publish') input.caption=val('in-publish');
      try{
        const r=await fetch('/api/v1/admin/instances/${row.id}/stage/'+key+'/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:input})});
        const j=await r.json();
        if(j.ok) setTimeout(function(){location.reload();},1200);
        else if(m) m.textContent='Failed: '+(j.error||'');
      }catch(e){ if(m) m.textContent='Failed: '+e.message; }
    }
    function genScript(){ const t=document.getElementById('in-script'); if(t) t.value=''; exec('script'); }
  `, 'instances');
}

function statusWord(s) {
  return { pending: 'pending', running: 'running', done: 'done', failed: 'failed', skipped: 'skipped' }[s] || s;
}

// A Drive-embedded preview modal + its player helpers (video/audio via Drive's
// /preview iframe; images via Drive thumbnails; text inline). In-app, no nav.
function previewModal() {
  return `<div id="pv" class="pv" onclick="if(event.target===this)closePv()">
    <div class="pvbox">
      <div class="pvhead"><span id="pvtitle"></span><button class="pvx" onclick="closePv()">✕</button></div>
      <div id="pvbody" class="pvbody"></div>
    </div>
  </div>
  <script>
   const DRV=id=>'https://drive.google.com/file/d/'+encodeURIComponent(id)+'/preview';
   const THB=id=>'https://drive.google.com/thumbnail?id='+encodeURIComponent(id)+'&sz=w600';
   function showPv(title, html){ document.getElementById('pvtitle').textContent=title; document.getElementById('pvbody').innerHTML=html; document.getElementById('pv').classList.add('on'); }
   function closePv(){ document.getElementById('pv').classList.remove('on'); document.getElementById('pvbody').innerHTML=''; }
   function openVideo(id){ showPv('Video', '<iframe class="pviframe" allow="autoplay" src="'+DRV(id)+'"></iframe>'); }
   function openAudio(id){ showPv('Voiceover', '<iframe class="pviframe aud" allow="autoplay" src="'+DRV(id)+'"></iframe>'); }
   function openText(title, text){ showPv(title, '<pre class="pvtext">'+(text||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</pre>'); }
   function openImageFull(id){ showPv('Image', '<img class="pvimg" src="'+THB(id).replace('w600','w1200')+'">'); }
   function openGrid(title, ids, kind){
     if(!ids||!ids.length){ showPv(title, '<p class="hint">Nothing here.</p>'); return; }
     const tiles=ids.map(function(id){
       const click = kind==='video' ? "openVideo('"+id+"')" : "openImageFull('"+id+"')";
       const play = kind==='video' ? '<span class=\\'playov\\'>▶</span>' : '';
       return '<div class="tile" onclick="'+click+'"><img src="'+THB(id)+'" loading="lazy">'+play+'</div>';
     }).join('');
     showPv(title, '<div class="grid">'+tiles+'</div>');
   }
   document.addEventListener('keydown',e=>{ if(e.key==='Escape') closePv(); });
  </script>`;
}

function shell(title, inner, script, current) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — automation</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .wrap{max-width:1040px;margin:1.4rem auto;padding:0 1rem}
${NAV_SHELL_CSS}
${NAV_CSS}
 .top{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
 h1{font-size:1.3rem;margin:0}.sub{color:#8a8aa2;font-size:.82rem;margin-top:.2rem}
 .toprow{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
 .tabs{display:flex;gap:.3rem}.tab{color:#c7c7d9;text-decoration:none;font-size:.85rem;padding:.4rem .8rem;border:1px solid #24243a;border-radius:8px}
 .tab.on{background:#2a2a44;color:#fff}
 .act{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.4rem .8rem;cursor:pointer;font-size:.82rem;text-decoration:none;display:inline-flex;align-items:center;gap:.25rem}
 .act.primary{background:#2d6cdf}.act.danger{background:#5a1d1d}
 table{width:100%;border-collapse:collapse;font-size:.88rem;background:#12121b;border:1px solid #24243a;border-radius:12px;overflow:hidden}
 th,td{text-align:left;padding:.6rem .7rem;border-bottom:1px solid #1e1e2c;vertical-align:middle}
 th{color:#9a9ab0;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}
 td a{color:#7aa2ff}.actions{display:flex;gap:.35rem;flex-wrap:wrap}
 .hint{color:#6f6f88;font-size:.8rem}
 .pill{font-size:.72rem;padding:.12rem .55rem;border-radius:999px;border:1px solid #24243a}
 .pill.ok{background:#123b1f;border-color:#1f6b38;color:#8ff0b0}
 .pill.warn{background:#3a2f12;border-color:#7a5a1f;color:#f0d68f}
 .pill.bad{background:#3b1212;border-color:#6b1f1f;color:#ff9a9a}
 .pill.mut{background:#1c1c2a;color:#9a9ab0}
 .ro{color:#8a8aa2;font-size:.85rem;margin:.2rem 0 1rem}
 .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.4rem 0 1rem}
 .steps .stepname{display:flex;align-items:center;gap:.5rem}
 .dot{width:9px;height:9px;border-radius:50%;background:#444;display:inline-block}
 .dot.done{background:#2ea043}.dot.running{background:#2d6cdf}.dot.failed{background:#d14}.dot.pending{background:#3a3a52}
 .tot{font-weight:600;color:#c7c7d9}
 .meta{color:#6f6f88;font-size:.78rem;margin-top:.8rem}
 .pv{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;padding:1.2rem;z-index:50}
 .pv.on{display:flex}
 .pvbox{background:#12121b;border:1px solid #2a2a44;border-radius:12px;max-width:760px;width:100%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column}
 .pvhead{display:flex;justify-content:space-between;align-items:center;padding:.7rem 1rem;border-bottom:1px solid #24243a;font-size:.9rem}
 .pvx{background:none;border:0;color:#c7c7d9;font-size:1.1rem;cursor:pointer}
 .pvbody{padding:1rem;overflow:auto}
 .pviframe{width:100%;height:68vh;border:0;border-radius:8px;background:#000}
 .pviframe.aud{height:120px}
 .pvimg{max-width:100%;border-radius:8px;display:block;margin:0 auto}
 .pvtext{white-space:pre-wrap;font-size:.85rem;color:#d7d7e6;background:#0b0b12;border:1px solid #24243a;border-radius:8px;padding:.8rem;margin:0}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.6rem}
 .tile{position:relative;border:1px solid #24243a;border-radius:8px;overflow:hidden;cursor:pointer;aspect-ratio:2/3;background:#0b0b12}
 .tile img{width:100%;height:100%;object-fit:cover;display:block}
 .playov{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1.6rem;color:#fff;background:rgba(0,0,0,.25)}
 .dur{position:absolute;right:6px;bottom:6px;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.8);color:#fff;font-size:.78rem;font-weight:600}
 .dur:empty{display:none}
 button.act:disabled{opacity:.5;cursor:wait}
 .card{border:1px solid #24243a;border-radius:10px;padding:.6rem;background:#12121b}
 .card .tile{max-height:260px;margin:0 auto .5rem}
 .pick{display:flex;align-items:center;gap:.4rem;font-size:.84rem;color:#e8e8ef;cursor:pointer}
 .ord{color:#7aa2ff;font-weight:700;min-width:1.6em;display:inline-block}
 .det{display:none;margin-top:.5rem}
 .det.on{display:block}
 .card.wide{grid-column:1/-1}
 .card.wide>.tile{max-height:320px;max-width:220px}
 .det.ailay.on{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.2rem;align-items:start}
 @media (max-width:900px){.det.ailay.on{grid-template-columns:1fr}}
 .acctbar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.5rem 0 .8rem;padding:.5rem .7rem;border:1px solid #24243a;border-radius:8px}
 .acct{margin-right:.8rem}
 .thumbs{display:flex;flex-wrap:wrap;gap:.8rem;margin:.6rem 0;align-items:flex-end}
 .thumbs a{display:flex;flex-direction:column;align-items:center;gap:.25rem;font-size:.8rem;color:inherit;text-decoration:none}
 .thumbs a.wide img{width:300px;max-width:100%}
 .thumbs a.tall img{width:190px}
 .thumbs img{border-radius:6px;border:1px solid #444;display:block}
 .fl{display:flex;flex-direction:column;gap:.2rem;font-size:.74rem;color:#9a9ab0;margin-top:.45rem}
 .nowrow{display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:#c7c7d9;margin-top:.45rem;cursor:pointer}
 .nowrow input{width:auto;margin:0}
 .fl textarea,.fl input{font:inherit;font-size:.82rem;background:#0b0b12;color:#e8e8ef;border:1px solid #24243a;border-radius:6px;padding:.4rem}
 .bar{position:sticky;bottom:0;background:#0b0b12;border-top:1px solid #24243a;padding:.9rem 0;margin-top:1rem;display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
 .pbar{display:none;height:6px;border-radius:3px;background:#24243a;overflow:hidden;margin:.4rem 0 .2rem}
 .pbar.on{display:block}.pbar i{display:block;height:100%;width:0;background:#2ea043;transition:width .6s}
 .pbar.busy i{width:30%!important;background:#2d6cdf;animation:pb 1.2s ease-in-out infinite}
 @keyframes pb{0%{margin-left:-30%}100%{margin-left:100%}}
 .warnt{color:#f0d68f}
 .endcard{border-top:1px dashed #24243a;margin-top:.5rem;padding-top:.2rem}
 .panel{border:1px solid #24243a;border-radius:8px;padding:.5rem .7rem;margin-bottom:.6rem;background:#15151f}
 .panel h4{margin:0 0 .3rem;font-size:.86rem;color:#e8e8ef}
 .chips{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.35rem}
 .chip{font-size:.74rem;padding:.15rem .55rem;border-radius:999px;border:1px solid #2a2a44;color:#8a8aa2}
 .chip.on{background:#2d6cdf;border-color:#2d6cdf;color:#fff}
 .stgrow{display:flex;gap:.5rem;align-items:center;margin-top:.3rem}
 .srcbar{gap:.4rem}.srcchip{display:inline-flex;align-items:center;gap:.2rem;border:1px solid #24243a;border-radius:8px;padding:.2rem .5rem;font-size:.8rem}
 .srcchip.on{border-color:#2d6cdf}.srcchip a{color:#c7c7d9;text-decoration:none}.srcchip button{background:none;border:0;color:#6f6f88;cursor:pointer}
 h3{font-size:1rem;margin:1.2rem 0 .3rem}
 .approve{background:#0a7d32;color:#fff;border:0;border-radius:8px;padding:.7rem 1.3rem;font-size:1rem;cursor:pointer}
</style>
<div class="layout">
  <aside>${navHtml({ current })}</aside>
  <main><div class="wrap">${inner}</div></main>
</div>
<script>${script || ''}</script>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { register };
