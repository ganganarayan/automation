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
 */
import * as instances from '../services/instanceService.js';
import * as review from '../services/instanceReviewService.js';
import * as readyPost from '../services/readyPostService.js';
import * as funnelsRepo from '../repositories/funnelsRepository.js';
import { INSTANCE_STEPS, sumInstanceCost, costBreakdown, shortId, formatDuration } from '../utils/instanceSpec.js';
import { formatIst } from '../utils/time.js';
import { defaultSlotsIso, defaultCaption } from '../utils/readyPostSpec.js';
import { driveThumbUrl } from '../utils/reviewSpec.js';
import { keyOk } from '../services/accessService.js';

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

  // Ready-video direct post: pick uploaded, unposted videos from the funnel's
  // Drive folder and post them via Post-for-Me, bypassing the whole pipeline.
  // Registered before '/admin/instances/:id' so "ready" isn't read as an id.
  router.get('/admin/instances/ready', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const funnelId = req.query.funnel ? String(req.query.funnel) : '';
      const list = await funnelsRepo.listByTenant(req.tenantId);
      if (!funnelId) return res.type('html').send(readyChooserPage(list));
      const { funnel, resolved, videos } = await readyPost.listReadyVideos({ tenantId: req.tenantId, funnelId });
      const prefills = defaultSlotsIso(resolved.publishTime, videos.length).map((iso) => formatIst(iso));
      res.type('html').send(readyPickerPage({ funnel, resolved, videos, prefills }));
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
      const out = await readyPost.postSelections({ tenantId: req.tenantId, funnelId, selections });
      res.json({ ok: true, ...out });
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

  router.get('/admin/instances/:id', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const row = await instances.get(req.params.id);
      if (!row) return res.redirect('/api/v1/admin/instances');
      res.type('html').send(detailPage(row, instances.parseSteps(row)));
    } catch (err) {
      next(err);
    }
  });

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
        <a class="act primary" href="/api/v1/admin/instances/ready">📤 Post ready videos</a>
        <button class="act" onclick="sample()">+ Sample</button>
        <a class="act" href="/api/v1/admin/settings#funnels">← Settings</a>
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
  `);
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
  `);
}

function btn(call, kind = '') {
  return `<button class="act ${kind}" onclick="${call}">▶ Preview</button>`;
}

// Ready-video: funnel chooser when none is in the query.
function readyChooserPage(funnels) {
  const items = (funnels || [])
    .map((f) => `<a class="act" href="/api/v1/admin/instances/ready?funnel=${encodeURIComponent(f.id)}">${esc(f.name)}</a>`)
    .join(' ');
  return shell('Post ready videos', `
    <div class="top">
      <h1>Post ready videos</h1>
      <div class="toprow"><a class="act" href="/api/v1/admin/instances">← All instances</a></div>
    </div>
    <p class="ro">Pick a funnel whose Drive folder holds the uploaded videos to post.</p>
    <div class="row">${items || '<span class="hint">No funnels yet.</span>'}</div>
  `, '');
}

// Ready-video: tick-select unposted Drive videos, caption + schedule each, post
// in selection order via Post-for-Me (no generation, no review email).
function readyPickerPage({ funnel, resolved, videos, prefills }) {
  const defCap = defaultCaption(resolved);
  const cards = (videos || [])
    .map((v, i) => `<div class="card">
      <div class="tile" onclick="openVideo('${esc(v.id)}')"><img src="${esc(driveThumbUrl(v.id, 'w400'))}" loading="lazy"><span class="playov">▶</span></div>
      <label class="pick"><input type="checkbox" id="cb-${esc(v.id)}" onchange="toggle('${esc(v.id)}')"> <span class="ord" id="ord-${esc(v.id)}" data-id="${esc(v.id)}"></span> ${esc(v.name)}</label>
      <input type="hidden" id="nm-${esc(v.id)}" value="${esc(v.name)}">
      <div class="det" id="det-${esc(v.id)}">
        <label class="fl">Caption<textarea id="cap-${esc(v.id)}" rows="3">${esc(defCap)}</textarea></label>
        <label class="fl">Schedule (IST DD-MM-YYYY HH:MM)<input id="sch-${esc(v.id)}" value="${esc(prefills[i] || '')}"></label>
      </div>
    </div>`)
    .join('');

  return shell(`Post ready videos — ${shortId(String(funnel.id))}`, `
    <div class="top">
      <div>
        <h1>Post ready videos — ${esc(funnel.name)}</h1>
        <div class="sub">Uploaded, not-yet-posted videos in this funnel's Drive folder. Tick to select — they post in the order you tick, directly via Post for Me.</div>
      </div>
      <div class="toprow">
        <a class="act" href="/api/v1/admin/instances/ready">↺ Change funnel</a>
        <a class="act" href="/api/v1/admin/instances">← All instances</a>
      </div>
    </div>
    ${!resolved.driveFolder ? '<p class="ro">⚠ This funnel has no Drive folder set.</p>' : ''}
    <div class="grid">${cards || '<p class="hint">No unposted videos found in the Drive folder.</p>'}</div>
    <div class="bar">
      <button class="approve" onclick="postSel()">Post selected</button>
      <span id="rmsg" class="hint"></span>
    </div>
    ${previewModal()}
  `, `
    const FUNNEL_ID = ${JSON.stringify(String(funnel.id))};
    const order = [];
    function msg(t){ const m=document.getElementById('rmsg'); if(m) m.textContent=t; }
    function renumber(){ order.forEach((id,i)=>{ const b=document.getElementById('ord-'+id); if(b) b.textContent='#'+(i+1); }); document.querySelectorAll('.ord').forEach(b=>{ if(order.indexOf(b.dataset.id)<0) b.textContent=''; }); }
    function toggle(id){
      const cb=document.getElementById('cb-'+id), det=document.getElementById('det-'+id);
      if(cb.checked){ if(order.indexOf(id)<0) order.push(id); det.classList.add('on'); }
      else { const k=order.indexOf(id); if(k>=0) order.splice(k,1); det.classList.remove('on'); }
      renumber();
    }
    async function postSel(){
      if(!order.length){ msg('Tick at least one video.'); return; }
      const selections = order.map(id=>({ driveId:id, name:document.getElementById('nm-'+id).value, caption:document.getElementById('cap-'+id).value, scheduledAt:document.getElementById('sch-'+id).value }));
      msg('Posting '+selections.length+'…');
      try{
        const r=await fetch('/api/v1/admin/instances/ready/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ funnelId:FUNNEL_ID, selections })});
        const j=await r.json();
        if(j.ok){ msg('Posted '+j.posted+(j.failed?(', '+j.failed+' failed'):'')+'. Opening the log…'); setTimeout(()=>location.href='/api/v1/admin/instances',1300); }
        else msg('Failed: '+(j.error||''));
      }catch(e){ msg('Failed: '+e.message); }
    }
  `);
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

function shell(title, inner, script) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — automation</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .wrap{max-width:1040px;margin:1.4rem auto;padding:0 1rem}
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
 .card{border:1px solid #24243a;border-radius:10px;padding:.6rem;background:#12121b}
 .card .tile{max-height:260px;margin:0 auto .5rem}
 .pick{display:flex;align-items:center;gap:.4rem;font-size:.84rem;color:#e8e8ef;cursor:pointer}
 .ord{color:#7aa2ff;font-weight:700;min-width:1.6em;display:inline-block}
 .det{display:none;margin-top:.5rem}
 .det.on{display:block}
 .fl{display:flex;flex-direction:column;gap:.2rem;font-size:.74rem;color:#9a9ab0;margin-top:.45rem}
 .fl textarea,.fl input{font:inherit;font-size:.82rem;background:#0b0b12;color:#e8e8ef;border:1px solid #24243a;border-radius:6px;padding:.4rem}
 .bar{position:sticky;bottom:0;background:#0b0b12;border-top:1px solid #24243a;padding:.9rem 0;margin-top:1rem;display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
 .approve{background:#0a7d32;color:#fff;border:0;border-radius:8px;padding:.7rem 1.3rem;font-size:1rem;cursor:pointer}
</style>
<div class="wrap">${inner}</div>
<script>${script || ''}</script>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { register };
