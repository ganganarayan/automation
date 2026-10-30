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
 *         GET  /api/v1/admin/instances/:id        read-only detail + previews
 *         GET  /api/v1/admin/instances/:id/data   JSON (instance + cost)
 *         POST /api/v1/admin/instances/sample      seed a sample (dev)
 *         POST /api/v1/admin/instances/:id/delete  delete (if not locked)
 *         GET  /api/v1/admin/instances/ready-ai    ready video + AI copy picker
 *         POST /api/v1/admin/instances/ready-ai/generate  transcribe + write one video's copy
 *         POST /api/v1/admin/instances/ready-ai/durations video lengths for the listed videos
 *         POST /api/v1/admin/instances/ready/post  post the ticked videos
 *         GET  /api/v1/admin/instances/ready       old link → ready-ai
 */
import * as instances from '../services/instanceService.js';
import * as review from '../services/instanceReviewService.js';
import * as readyPost from '../services/readyPostService.js';
import * as stageRunner from '../services/stageRunnerService.js';
import * as jobRunner from '../core/jobRunner.js';
import * as funnelsRepo from '../repositories/funnelsRepository.js';
import { INSTANCE_STEPS, sumInstanceCost, costBreakdown, shortId, formatDuration } from '../utils/instanceSpec.js';
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

  // The plain "Post ready videos" lane was merged into the AI lane; old links
  // still land there. Registered before '/admin/instances/:id' so "ready"
  // isn't read as an id.
  router.get('/admin/instances/ready', (req, res) => {
    const q = new URLSearchParams(Object.entries(req.query || {}).map(([k, v]) => [k, String(v)])).toString();
    res.redirect(302, `/api/v1/admin/instances/ready-ai${q ? `?${q}` : ''}`);
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

  // Ready video + AI copy: same as above, but each ticked video is transcribed
  // and gets its own title / description / IG caption / short post to review.
  router.get('/admin/instances/ready-ai', async (req, res, next) => {
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

  router.post('/admin/instances/ready-ai/generate', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { funnelId, driveId, name, transcript, accessToken, accounts } = req.body || {};
      if (!funnelId || !driveId) return res.status(400).json({ ok: false, error: 'funnelId and driveId required' });
      const out = await readyPost.generateCopy({ tenantId: req.tenantId, funnelId, driveId: String(driveId), name: String(name || ''), transcript: String(transcript || ''), accessToken: String(accessToken || ''), accounts });
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
      const { funnelId, driveId, transcript, copy, thumbs, sizes, costs } = req.body || {};
      if (!funnelId || !driveId) return res.status(400).json({ ok: false, error: 'funnelId and driveId required' });
      res.json({ ok: true, ...(await readyPost.saveDraftEdit({ funnelId, driveId, transcript, copy, thumbs, sizes, costs })) });
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

  // Manual-run funnel chooser: pick a funnel to start a hand-stepped run.
  // Registered before '/:id' so "manual" isn't read as an instance id.
  router.get('/admin/instances/manual', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const list = await funnelsRepo.listByTenant(req.tenantId);
      res.type('html').send(manualChooserPage(list));
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
        tenantId: req.tenantId, funnel, title: `${funnel.name} — manual ${formatIst(new Date(), { withTime: false })}`, status: 'manual',
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
  manual: 'Manual',
  draft: 'AI draft',
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
  const tabs = [['', 'All'], ['final_review', 'In review'], ['posted', 'Posted']]
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
        <td>${statusPill(r.status)}</td>
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

const READY_AI = { base: '/api/v1/admin/instances/ready-ai', title: 'Ready video + AI copy', nav: 'ready-ai' };

// Ready-video: funnel chooser when none is in the query.
function readyChooserPage(funnels, lane = READY_AI) {
  const items = (funnels || [])
    .map((f) => `<a class="act" href="${lane.base}?funnel=${encodeURIComponent(f.id)}">${esc(f.name)}</a>`)
    .join(' ');
  return shell(lane.title, `
    <div class="top">
      <h1>${esc(lane.title)}</h1>
      <div class="toprow"><a class="act" href="/api/v1/admin/instances">← All instances</a></div>
    </div>
    <p class="ro">Pick a funnel whose Drive folder holds the uploaded videos to post.</p>
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

// Ready video + AI copy: tick a video and the app transcribes it and writes its
// per-platform copy into the fields below; edit, schedule, then post in tick order.
function readyAiPickerPage({ funnel, videos, prefills, drafts = {}, ...src }) {
  const cards = (videos || [])
    .map((v, i) => `<div class="card">
      <div class="tile" onclick="openVideo('${esc(v.id)}')"><img src="${esc(driveThumbUrl(v.id, 'w400'))}" loading="lazy"><span class="playov">▶</span><span class="dur" id="du-${esc(v.id)}"></span></div>
      <label class="pick"><input type="checkbox" id="cb-${esc(v.id)}" onchange="toggle('${esc(v.id)}')"> <span class="ord" id="ord-${esc(v.id)}" data-id="${esc(v.id)}"></span> ${esc(v.name)}</label>
      <input type="hidden" id="nm-${esc(v.id)}" value="${esc(v.name)}">
      <div class="det ailay" id="det-${esc(v.id)}">
        <div class="aicol">
        <label class="fl">Transcript / text (optional — paste to skip transcription; blank = the app transcribes the video)<textarea id="tx-${esc(v.id)}" rows="6"></textarea></label>
        <div class="nowrow"><button class="act" id="gb-${esc(v.id)}" onclick="gen('${esc(v.id)}')">✨ Generate transcript + Thumbnail</button> <button class="act" id="sv-${esc(v.id)}" onclick="saveDraft('${esc(v.id)}')">💾 Save draft</button> <span class="hint" id="gs-${esc(v.id)}"></span></div>
        <div class="thumbs" id="th-${esc(v.id)}"></div>
        </div>
        <div class="aicol">
        <label class="fl">YouTube title<input id="ti-${esc(v.id)}" maxlength="100"></label>
        <label class="fl">Description — YouTube · LinkedIn · Facebook (link appended)<textarea id="de-${esc(v.id)}" rows="7"></textarea></label>
        <label class="fl">Instagram caption<textarea id="ig-${esc(v.id)}" rows="6"></textarea></label>
        <label class="fl">Short — Threads · X (link appended) <span class="hint" id="sc-${esc(v.id)}"></span><textarea id="sh-${esc(v.id)}" rows="2" oninput="cnt('${esc(v.id)}')"></textarea></label>
        <div class="nowrow"><b>When:</b>
          <label class="nowrow"><input type="radio" name="when-${esc(v.id)}" checked onchange="toggleNow('${esc(v.id)}')"> 📅 Schedule</label>
          <label class="nowrow"><input type="radio" name="when-${esc(v.id)}" id="now-${esc(v.id)}" onchange="toggleNow('${esc(v.id)}')"> ⚡ Post now</label>
        </div>
        <label class="fl">Schedule (IST DD-MM-YYYY HH:MM)<input id="sch-${esc(v.id)}" value="${esc(prefills[i] || '')}"></label>
        </div>
      </div>
    </div>`)
    .join('');

  return shell(`Ready video + AI copy — ${shortId(String(funnel.id))}`, `
    <div class="top">
      <div>
        <h1>Ready video + AI copy — ${esc(funnel.name)}</h1>
        <div class="sub">Tick a video, optionally paste its transcript, then ✨ Generate transcript + Thumbnail: the app transcribes it (unless you pasted text), writes its YouTube title, description (also LinkedIn &amp; Facebook), Instagram caption and a short Threads / X post, and designs a thumbnail for each platform (no thumbnail = the video's first frame). Edit, then post — in the order you ticked.</div>
      </div>
      <div class="toprow">
        <a class="act" href="/api/v1/admin/instances/ready-ai">↺ Change funnel</a>
        <a class="act" href="/api/v1/admin/instances">← All instances</a>
      </div>
    </div>
    ${folderBar(funnel, src)}
    ${acctBar(src.resolved)}
    <div class="grid">${cards}</div>
    <div class="bar">
      <button class="approve" onclick="postSel(false)">📅 Schedule selected</button>
      <button class="approve" onclick="postSel(true)">⚡ Post selected now</button>
      <span id="rmsg" class="hint"></span>
    </div>
    <p class="hint">📅 Schedule selected uses each video's own choice (a video set to ⚡ Post now still goes immediately). ⚡ Post selected now publishes every ticked video immediately, ignoring the schedules.</p>
    ${previewModal()}
  `, `
    const FUNNEL_ID = ${JSON.stringify(String(funnel.id))};
    const order = [], costs = {}, busy = {}, done = {}, thumbs = {};
    (function(){
      const ids=Array.from(document.querySelectorAll('[id^="du-"]')).map(e=>e.id.slice(3));
      if(!ids.length) return;
      fetch('/api/v1/admin/instances/ready-ai/durations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ ids })})
        .then(r=>r.json()).then(j=>{ if(!j.ok) return; Object.keys(j.durations||{}).forEach(id=>{ const n=Number(j.durations[id])||0, e=document.getElementById('du-'+id); if(e&&n) e.textContent=Math.floor(n/60)+':'+String(n%60).padStart(2,'0'); }); })
        .catch(()=>{});
    })();
    const $ = (p,id)=>document.getElementById(p+'-'+id);
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
    // Show one generation (fresh, or a saved draft restored after a reload).
    function applyGen(id, j){
      $('ti',id).value=j.copy.title||''; $('de',id).value=j.copy.description||''; $('ig',id).value=j.copy.igCaption||''; $('sh',id).value=j.copy.short||''; cnt(id);
      if(j.transcript) $('tx',id).value=j.transcript; $('gb',id).textContent='✨ Regenerate transcript + Thumbnail';
      thumbs[id]=j.thumbs||{};
      $('th',id).innerHTML=(j.sizes||[]).map(z=>'<a class="'+(z.size==='landscape'?'wide':'tall')+'" href="'+z.url+'" target="_blank" rel="noopener" title="Open full size"><img src="'+z.url+'"><span>'+z.label+' · '+z.platforms.join(', ')+'</span></a>').join('')
        +(j.thumbError?'<div class="hint">⚠ '+String(j.thumbError).replace(/</g,'&lt;')+(Object.keys(thumbs[id]).length?'':' — the first frame will be used')+'</div>':'');
      done[id]=true;
    }
    const SAVED = ${JSON.stringify(drafts).replace(/</g, '\\u003c')};
    Object.keys(SAVED).forEach(id=>{ if(!$('cb',id)) return; applyGen(id, SAVED[id]); $('gs',id).textContent='💾 Saved draft from '+SAVED[id].atIst+' · $'+Number(SAVED[id].costUsd||0).toFixed(4); });
    // Keep this video's current fields (your edits too) without regenerating.
    async function saveDraft(id){
      if(busy[id]) return;
      if(!$('ti',id).value.trim() && !$('de',id).value.trim()){ $('gs',id).textContent='Nothing to save yet — generate or write the copy first.'; return; }
      $('sv',id).disabled=true;
      try{
        const r=await fetch('/api/v1/admin/instances/ready-ai/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ funnelId:FUNNEL_ID, driveId:id, transcript:$('tx',id).value,
          copy:{ title:$('ti',id).value, description:$('de',id).value, igCaption:$('ig',id).value, short:$('sh',id).value }, thumbs:thumbs[id]||{}, costs:costs[id]||[] })});
        const j=await r.json();
        if(!j.ok) throw new Error(j.error||'failed');
        done[id]=true; $('gs',id).textContent='💾 Saved to instances';
      }catch(e){ $('gs',id).textContent='⚠ Save failed: '+e.message; }
      $('sv',id).disabled=false;
    }
    async function gen(id){
      if(busy[id]) return;
      const pasted=$('tx',id).value.trim();
      busy[id]=true; $('gb',id).disabled=true; $('gs',id).textContent=(pasted?'Writing copy from your text':'Transcribing + writing copy')+' + designing thumbnails… (about 1–2 min)';
      try{
        const r=await fetch('/api/v1/admin/instances/ready-ai/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ funnelId:FUNNEL_ID, driveId:id, name:$('nm',id).value, transcript:pasted, accounts: pickedAccounts(), accessToken: await driveToken() })});
        const j=await r.json();
        if(!j.ok) throw new Error(j.error||'failed');
        applyGen(id, j);
        costs[id]=(costs[id]||[]).concat(j.costs||[]);
        const usd=(costs[id]||[]).reduce((t,c)=>t+(Number(c.costUsd)||0),0);
        $('gs',id).textContent=(j.transcribed?'✓ Transcribed + copy written':(j.transcript?'✓ Copy written from your text':'✓ No speech found — copy written from the file name'))+' · $'+usd.toFixed(4);
      }catch(e){ $('gs',id).textContent='⚠ '+e.message; }
      busy[id]=false; $('gb',id).disabled=false;
    }
    function toggleNow(id){ const n=$('now',id), s=$('sch',id); if(n&&s){ s.disabled=n.checked; s.style.opacity=n.checked?0.45:1; } }
    async function postSel(allNow){
      if(!order.length){ msg('Tick at least one video.'); return; }
      if(!pickedAccounts().length){ msg('Tick at least one account under "Post to".'); return; }
      if(order.some(id=>busy[id])){ msg('Wait for the copy to finish generating.'); return; }
      const nogen=order.filter(id=>!done[id]);
      if(nogen.length){ msg('Press ✨ Generate transcript + Thumbnail first for '+nogen.map(id=>$('ord',id).textContent).join(', ')+'.'); return; }
      const missing=order.filter(id=>!$('ti',id).value.trim()||!$('de',id).value.trim()||!$('ig',id).value.trim()||!$('sh',id).value.trim());
      if(missing.length){ msg('Fill every copy field for '+missing.map(id=>$('ord',id).textContent).join(', ')+'.'); return; }
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
  `, 'ready-ai');
}

// ---- manual stepper UI -----------------------------------------------------

function manualChooserPage(funnels) {
  const items = (funnels || [])
    .map((f) => `<button class="act" onclick="startManual('${esc(String(f.id))}')">${esc(f.name)}</button>`)
    .join(' ');
  return shell('Manual run', `
    <div class="top">
      <h1>Manual run</h1>
      <div class="toprow"><a class="act" href="/api/v1/admin/instances">← All instances</a></div>
    </div>
    <p class="ro">Pick a funnel to start a hand-stepped run — generate/preview/approve each stage, then post. Set <b>Manual stepper = On</b> in a funnel to also pause its scheduled daily runs for manual stepping; turn it off to go back to automatic.</p>
    <div class="row">${items || '<span class="hint">No funnels yet.</span>'}</div>
  `, `
    async function startManual(fid){
      const r=await fetch('/api/v1/admin/instances/manual/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({funnelId:fid})});
      const j=await r.json();
      if(j.ok) location.href='/api/v1/admin/instances/'+j.id; else alert(j.error||'failed');
    }
  `, 'manual');
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
      <div><h1>${esc(row.title || 'Manual run')}</h1><div class="sub">${esc(row.funnel_name || '—')} · ${esc(shortId(row.id))} · 🎛 manual stepper</div></div>
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
  `, 'manual');
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
