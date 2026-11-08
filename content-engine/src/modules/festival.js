/**
 * Module: Festival post page (the festival lane).
 *
 * Purpose:      Upload one picture, write one copy, tick the funnels, pick now or
 *               a time: every funnel posts it as a voiced video to all its
 *               channels, on top of its normal daily post (services/festivalService).
 * Responsibility: HTTP + auth + HTML; the work is in festivalService.
 * Routes: GET  /api/v1/admin/festival                 the page (form + past festival posts)
 *         GET  /api/v1/admin/festival/status          JSON: the batches (the page polls it)
 *         POST /api/v1/admin/festival/upload          the picture as the raw body (image/png|jpeg|webp)
 *         POST /api/v1/admin/festival/compose         { picture, cutout, position, size }: your photo on the picture
 *         POST /api/v1/admin/festival                 { title, copy, imageUrl, driveId, funnelIds, postAt, autoPost }
 *         POST /api/v1/admin/festival/:id/approve     approve one waiting post
 *         POST /api/v1/admin/festival/approve-all     { batchId }
 *         POST /api/v1/admin/festival/:id/retry       make a failed one again
 * Dependencies: festivalService, accessService, adminNav, utils/{time,retrySpec}, express.
 */
import express from 'express';
import * as festival from '../services/festivalService.js';
import { keyOk, currentSession } from '../services/accessService.js';
import { navHtml, NAV_CSS, NAV_SHELL_CSS } from '../utils/adminNav.js';
import { formatIst, nowIst } from '../utils/time.js';
import { parseRetryDate } from '../utils/retrySpec.js';
import { stateOf, CUTOUT_SIZES } from '../utils/festivalSpec.js';

const BASE = '/api/v1/admin/festival';

export function register(ctx) {
  const { router, log } = ctx;
  const guardHtml = async (req, res) => {
    if (await keyOk(req)) return true;
    res.redirect(`/api/v1/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    return false;
  };
  const guardJson = async (req, res) => {
    if (await keyOk(req)) return true;
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  };
  const tenant = (req) => req.tenantId || 'default';

  router.get('/admin/festival', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const [session, funnels, batches] = await Promise.all([
        currentSession(req),
        festival.funnelReadiness(tenant(req)).catch(() => []),
        festival.batches(tenant(req)).catch(() => []),
      ]);
      res.set('Cache-Control', 'no-store').type('html').send(page({ session, funnels, batches }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/festival/status', async (req, res) => {
    if (!(await guardJson(req, res))) return;
    try {
      const batches = await festival.batches(tenant(req));
      res.set('Cache-Control', 'no-store').json({ ok: true, html: batchesHtml(batches), busy: batches.some((b) => b.rows.some((r) => ['running', 'approved'].includes(r.status))) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post(
    '/admin/festival/upload',
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: festival.MAX_BYTES }),
    async (req, res) => {
      if (!(await guardJson(req, res))) return;
      try {
        const buffer = Buffer.isBuffer(req.body) ? req.body : null;
        res.json({ ok: true, ...(await festival.upload({ tenantId: tenant(req), buffer, mime: String(req.headers['content-type'] || '').split(';')[0].trim() })) });
      } catch (err) {
        log.warn({ err: err.message }, 'festival picture upload failed');
        res.status(400).json({ ok: false, error: err.message });
      }
    },
  );

  router.post('/admin/festival/compose', async (req, res) => {
    if (!(await guardJson(req, res))) return;
    try {
      const b = req.body || {};
      res.json({ ok: true, ...(await festival.compose({ tenantId: tenant(req), picture: b.picture, cutout: b.cutout, position: b.position, size: b.size })) });
    } catch (err) {
      log.warn({ err: err.message }, 'festival photo could not be placed');
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/festival', async (req, res) => {
    if (!(await guardJson(req, res))) return;
    try {
      const b = req.body || {};
      let postAt = null;
      if (b.postAt) {
        const at = parseRetryDate(b.postAt);
        if (!at) return res.status(400).json({ ok: false, error: 'Pick a date and time still to come, or choose Post now.' });
        postAt = at.at;
      }
      const out = await festival.start({
        tenantId: tenant(req), title: b.title, copy: b.copy, imageUrl: b.imageUrl, driveId: b.driveId,
        funnelIds: b.funnelIds, postAt, autoPost: b.autoPost !== false,
      });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/festival/approve-all', async (req, res) => {
    if (!(await guardJson(req, res))) return;
    try {
      res.json({ ok: true, ...(await festival.approveAll({ tenantId: tenant(req), batchId: String((req.body || {}).batchId || '') })) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/festival/:id/approve', async (req, res) => {
    if (!(await guardJson(req, res))) return;
    try {
      res.json(await festival.approve({ tenantId: tenant(req), id: req.params.id }));
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/festival/:id/retry', async (req, res) => {
    if (!(await guardJson(req, res))) return;
    try {
      res.json(await festival.retry({ tenantId: tenant(req), id: req.params.id }));
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  log.info('festival lane registered');
}

// ---- rendering -------------------------------------------------------------


function rowHtml(r) {
  const s = stateOf(r);
  const acts = [
    r.videoUrl ? `<a class="act" href="${esc(r.videoUrl)}" target="_blank" rel="noopener">▶ Video</a>` : '',
    r.status === 'image_review' && r.approvalId ? `<button class="act primary" onclick="act('${esc(r.id)}','approve')">✅ Approve</button>` : '',
    r.status === 'failed' ? `<button class="act" onclick="act('${esc(r.id)}','retry')">↻ Retry</button>` : '',
    `<a class="act" href="/api/v1/admin/instances/${esc(r.id)}">Open</a>`,
  ].filter(Boolean).join('');
  return `<tr><td>${esc(r.funnelName)}</td><td>${s.dot} ${esc(s.text)}${r.musicCredit ? `<div class="hint">🎵 ${esc(r.musicCredit)}</div>` : ''}</td><td class="acts">${acts}</td></tr>`;
}

export function batchesHtml(batches = []) {
  if (!batches.length) return '<p class="hint">No festival posts yet.</p>';
  return batches.map((b) => {
    const waiting = b.rows.filter((r) => r.status === 'image_review' && r.approvalId && !r.autoPost).length;
    return `<div class="batch">
      <div class="bhead">
        ${b.thumbUrl ? `<img class="bthumb" src="${esc(b.thumbUrl)}" alt="">` : ''}
        <div class="bmeta"><b>${esc(b.title || 'Festival post')}</b><div class="hint">Started ${esc(formatIst(b.createdAt))}, ${b.rows.length} funnel(s)</div>
        <div class="bcopy">${esc(b.copy).replace(/\n/g, '<br>')}</div>
        ${waiting ? `<button class="act primary" onclick="approveAll('${esc(b.batchId)}')">✅ Approve all ${waiting} waiting</button>` : ''}</div>
      </div>
      <table><tr><th>Funnel</th><th>State</th><th></th></tr>${b.rows.map(rowHtml).join('')}</table>
    </div>`;
  }).join('');
}

function funnelsHtml(funnels = []) {
  if (!funnels.length) return '<p class="hint">No funnels yet. Add one in Setup, Funnels.</p>';
  return funnels.map((f) => {
    const ok = !f.problem;
    const on = ok && f.active;
    return `<label class="fn${ok ? '' : ' off'}"><input type="checkbox" name="fn" value="${esc(f.id)}" ${on ? 'checked' : ''} ${ok ? '' : 'disabled'}>
      ${ok ? '🟢' : '🔴'} ${esc(f.name)}${f.active ? '' : ' <span class="hint">(paused)</span>'}${ok ? '' : `<span class="hint"> : ${esc(f.problem)}</span>`}</label>`;
  }).join('');
}

function page({ session, funnels, batches }) {
  const minAt = nowIst().plus({ minutes: 15 }).toFormat("yyyy-MM-dd'T'HH:mm");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Festival post, automation</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .wrap{max-width:1040px;margin:1.4rem auto;padding:0 1rem}
${NAV_SHELL_CSS}
${NAV_CSS}
 h1{font-size:1.3rem;margin:0}.sub{color:#8a8aa2;font-size:.85rem;margin:.3rem 0 1rem}
 h2{font-size:.95rem;color:#c7c7d9;margin:1.6rem 0 .6rem}
 .card{background:#12121b;border:1px solid #24243a;border-radius:12px;padding:1rem 1.1rem}
 label.blk{display:block;font-size:.82rem;color:#c7c7d9;margin:.9rem 0 .3rem}
 input[type=text],input[type=datetime-local],textarea{width:100%;background:#0b0b12;color:#e8e8ef;border:1px solid #2a2a44;border-radius:8px;padding:.55rem .65rem;font:inherit}
 textarea{min-height:9rem;resize:vertical}
 .act{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.4rem .8rem;cursor:pointer;font-size:.82rem;text-decoration:none;display:inline-flex;align-items:center;gap:.25rem}
 .act.primary{background:#2d6cdf}.act.big{padding:.6rem 1.1rem;font-size:.92rem}
 .act:disabled{opacity:.5;cursor:default}
 .hint{color:#6f6f88;font-size:.8rem}
 .fn{display:block;padding:.3rem 0;font-size:.9rem}.fn.off{opacity:.6}
 .row{display:flex;gap:1.2rem;flex-wrap:wrap;align-items:center}
 #preview{max-width:320px;max-height:320px;border-radius:8px;margin-top:.5rem;display:none;background:#000}
 .me{display:flex;gap:.8rem;align-items:center;flex-wrap:wrap;margin-top:.3rem}
 #methumb{width:64px;height:64px;object-fit:contain;border-radius:8px;background:repeating-conic-gradient(#2a2a44 0 25%,#1a1a2a 0 50%) 0 0/16px 16px;display:none}
 #msg{margin-top:.8rem;font-size:.88rem;white-space:pre-line}
 .batch{background:#12121b;border:1px solid #24243a;border-radius:12px;padding:.9rem;margin-bottom:1rem}
 .bhead{display:flex;gap:.9rem;margin-bottom:.7rem}.bthumb{width:90px;height:90px;object-fit:cover;border-radius:8px}
 .bcopy{font-size:.82rem;color:#b9b9cc;margin:.4rem 0;max-height:4.5em;overflow:hidden}
 table{width:100%;border-collapse:collapse;font-size:.88rem}
 th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #1e1e2c;vertical-align:middle}
 th{color:#9a9ab0;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
 td.acts{white-space:nowrap;text-align:right}td.acts .act{margin-left:.3rem}
</style>
<div class="layout">
  <aside>${navHtml({ current: 'festival', session })}</aside>
  <main><div class="wrap">
  <h1>🪔 Festival post</h1>
  <p class="sub">One picture and one copy to every ticked funnel, outside the daily lanes. Each funnel gets a video of your picture with the copy read aloud in its own voice, subtitles and music, sized for each channel (9:16, 4:5, 16:9), on all its channels including YouTube Shorts. The funnel's normal post for that day still goes out.</p>
  <div class="card">
    <label class="blk">1. Picture (PNG, JPG or WebP, up to 15 MB). Used whole: it sits on a blurred copy of itself where a size needs more room.</label>
    <input type="file" id="pic" accept="image/png,image/jpeg,image/webp" onchange="showPic()">
    <label class="blk">Your photo on it (optional): your background-removed PNG, standing on the bottom edge. It is remembered for next time.</label>
    <div class="me">
      <img id="methumb" alt="">
      <input type="file" id="me" accept="image/png,image/webp" onchange="pickMe()">
      <button class="act" type="button" id="meclear" onclick="clearMe()" style="display:none">✕ No photo</button>
    </div>
    <div class="row" id="meopts" style="display:none;margin-top:.4rem">
      <span class="hint">Where:</span>
      <label class="fn"><input type="radio" name="mepos" value="left" onchange="draw()"> Left</label>
      <label class="fn"><input type="radio" name="mepos" value="center" onchange="draw()"> Centre</label>
      <label class="fn"><input type="radio" name="mepos" value="right" checked onchange="draw()"> Right</label>
      <span class="hint">Size:</span>
      <label class="fn"><input type="radio" name="mesize" value="small" onchange="draw()"> Small</label>
      <label class="fn"><input type="radio" name="mesize" value="medium" checked onchange="draw()"> Medium</label>
      <label class="fn"><input type="radio" name="mesize" value="large" onchange="draw()"> Large</label>
    </div>
    <canvas id="preview"></canvas>
    <label class="blk">2. Title (the YouTube title and the name in the Library)</label>
    <input type="text" id="title" maxlength="90" placeholder="Happy Diwali">
    <label class="blk">3. Copy: the caption on every channel, and what the voice reads aloud</label>
    <textarea id="copy" maxlength="${festival.MAX_COPY}" placeholder="Wishing you and your family a bright and joyful Diwali..." oninput="count()"></textarea>
    <div class="hint" id="cnt">0 characters. X gets the first 280, cut at a word.</div>
    <label class="blk">4. Funnels</label>
    <div class="row"><button class="act" type="button" onclick="tick(true)">Tick all</button><button class="act" type="button" onclick="tick(false)">Untick all</button></div>
    ${funnelsHtml(funnels)}
    <label class="blk">5. When</label>
    <div class="row">
      <label class="fn"><input type="radio" name="when" value="now" checked onchange="when()"> ⚡ Post as soon as the video is made</label>
      <label class="fn"><input type="radio" name="when" value="at" onchange="when()"> 📅 Schedule (IST)</label>
      <input type="datetime-local" id="at" min="${esc(minAt)}" style="max-width:240px" disabled>
    </div>
    <label class="fn" style="margin-top:.6rem"><input type="checkbox" id="auto" checked> Post without asking me (untick to approve each video first, here or from the daily email)</label>
    <div style="margin-top:1rem"><button class="act primary big" id="go" onclick="go()">🪔 Make and post to all ticked funnels</button></div>
    <div id="msg"></div>
  </div>
  <h2>Festival posts</h2>
  <div id="batches">${batchesHtml(batches)}</div>
  </div></main>
</div>
<script>
const $=(id)=>document.getElementById(id);
function msg(t){ $('msg').textContent=t; }
// Same placement as the server (utils/festivalSpec overlayBox), for the preview.
const SIZES=${JSON.stringify(CUTOUT_SIZES)};
function box(W,H,w,h,pos,size){ const sc=Math.min(H*(SIZES[size]||SIZES.medium)/h, W*0.9/w); const bw=Math.max(1,Math.round(w*sc)), bh=Math.max(1,Math.round(h*sc)); const m=Math.round(W*0.03); const l=pos==='left'?m:pos==='center'?Math.round((W-bw)/2):W-bw-m; return {w:bw,h:bh,l:Math.max(0,l),t:Math.max(0,H-bh)}; }
const KEY='festivalMe';
let picImg=null, meImg=null, meFile=null, meSaved=null;
try{ meSaved=JSON.parse(localStorage.getItem(KEY)||'null'); }catch(e){ meSaved=null; }
function load(src){ return new Promise((ok,no)=>{ const i=new Image(); i.onload=()=>ok(i); i.onerror=no; i.src=src; }); }
// Empty edges of the photo are cut off, as the server does, so it stands on the bottom.
function trimmed(img){ const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight; const x=c.getContext('2d'); x.drawImage(img,0,0);
  let d; try{ d=x.getImageData(0,0,c.width,c.height).data; }catch(e){ return {img, sx:0, sy:0, w:c.width, h:c.height}; }
  let t=c.height,b=-1,l=c.width,r=-1; for(let y=0;y<c.height;y++) for(let q=0;q<c.width;q++){ if(d[(y*c.width+q)*4+3]>8){ if(y<t)t=y; if(y>b)b=y; if(q<l)l=q; if(q>r)r=q; } }
  return b<0 ? {img, sx:0, sy:0, w:c.width, h:c.height} : {img, sx:l, sy:t, w:r-l+1, h:b-t+1}; }
let meTrim=null;
function draw(){
  const c=$('preview'); if(!picImg){ c.style.display='none'; return; }
  c.width=picImg.naturalWidth; c.height=picImg.naturalHeight; const x=c.getContext('2d'); x.drawImage(picImg,0,0);
  if(meTrim){ const pos=document.querySelector('input[name=mepos]:checked').value, size=document.querySelector('input[name=mesize]:checked').value;
    const b=box(c.width,c.height,meTrim.w,meTrim.h,pos,size); x.drawImage(meTrim.img,meTrim.sx,meTrim.sy,meTrim.w,meTrim.h,b.l,b.t,b.w,b.h); }
  c.style.display='block';
}
async function showPic(){ const f=$('pic').files[0]; picImg=f ? await load(URL.createObjectURL(f)) : null; draw(); }
async function setMe(src){ $('methumb').src=src; $('methumb').style.display='block'; $('meclear').style.display='inline-flex'; $('meopts').style.display='flex';
  try{ meImg=await load(src); meTrim=trimmed(meImg); }catch(e){ meImg=null; meTrim=null; } draw(); }
async function pickMe(){ const f=$('me').files[0]; if(!f) return; meFile=f; await setMe(URL.createObjectURL(f)); }
function clearMe(){ meFile=null; meSaved=null; meImg=null; meTrim=null; localStorage.removeItem(KEY); $('me').value=''; $('methumb').style.display='none'; $('meclear').style.display='none'; $('meopts').style.display='none'; draw(); }
if(meSaved && meSaved.url){ setMe(meSaved.thumbnailUrl||meSaved.url); if(meSaved.position){ const p=document.querySelector('input[name=mepos][value='+meSaved.position+']'); if(p) p.checked=true; } if(meSaved.size){ const z=document.querySelector('input[name=mesize][value='+meSaved.size+']'); if(z) z.checked=true; } }
function count(){ const n=$('copy').value.trim().length; $('cnt').textContent=n+' characters. X gets the first 280, cut at a word.'; }
function tick(on){ document.querySelectorAll('input[name=fn]:not(:disabled)').forEach(c=>c.checked=on); }
function when(){ $('at').disabled=document.querySelector('input[name=when]:checked').value!=='at'; }
async function post(url, body){ const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); return r.json().catch(()=>({ok:false,error:'no answer'})); }
async function go(){
  const f=$('pic').files[0];
  const copy=$('copy').value.trim();
  const funnelIds=[...document.querySelectorAll('input[name=fn]:checked')].map(c=>c.value);
  const at=document.querySelector('input[name=when]:checked').value==='at' ? $('at').value : '';
  if(!f) return msg('🔴 Choose the picture.');
  if(!copy) return msg('🔴 Write the copy.');
  if(!funnelIds.length) return msg('🔴 Tick at least one funnel.');
  if(document.querySelector('input[name=when]:checked').value==='at' && !at) return msg('🔴 Pick the date and time, or choose Post now.');
  if(!confirm('Post this to '+funnelIds.length+' funnel(s)'+(at?' at '+at.replace('T',' ')+' IST':' as soon as the videos are made')+'?')) return;
  $('go').disabled=true; msg('🟡 Uploading the picture...');
  try{
    const up=await (await fetch('${BASE}/upload',{method:'POST',headers:{'Content-Type':f.type},body:f})).json().catch(()=>({ok:false,error:'upload failed'}));
    if(!up.ok) throw new Error(up.error||'upload failed');
    let pic=up;
    if(meFile || (meSaved && meSaved.url)){
      const position=document.querySelector('input[name=mepos]:checked').value, size=document.querySelector('input[name=mesize]:checked').value;
      let me=meSaved;
      if(meFile){
        msg('🟡 Uploading your photo...');
        me=await (await fetch('${BASE}/upload',{method:'POST',headers:{'Content-Type':meFile.type},body:meFile})).json().catch(()=>({ok:false,error:'upload failed'}));
        if(!me.ok) throw new Error(me.error||'your photo did not upload');
      }
      msg('🟡 Placing your photo on the picture...');
      pic=await post('${BASE}/compose',{picture:{driveId:up.driveId,url:up.url},cutout:{driveId:me.driveId,url:me.url},position,size});
      if(!pic.ok) throw new Error(pic.error||'your photo could not be placed');
      meSaved={url:me.url,driveId:me.driveId,thumbnailUrl:me.thumbnailUrl,position,size}; meFile=null;
      localStorage.setItem(KEY, JSON.stringify(meSaved));
    }
    msg('🟡 Starting the videos...');
    const r=await post('${BASE}',{title:$('title').value.trim(),copy,imageUrl:pic.url,driveId:pic.driveId,funnelIds,postAt:at,autoPost:$('auto').checked});
    if(!r.ok) throw new Error(r.error||'could not start');
    let t='🟢 Making the video for: '+(r.started.join(', ')||'none')+'. Each takes a few minutes; this list updates by itself.';
    if(r.skipped.length) t+='\\n🔴 Skipped: '+r.skipped.map(s=>s.name+' ('+s.reason+')').join('; ');
    msg(t); waitFor=8; refresh();
  }catch(e){ msg('🔴 '+e.message); }
  $('go').disabled=false;
}
async function act(id, what){
  const r=await post('${BASE}/'+encodeURIComponent(id)+'/'+what);
  if(!r.ok) alert(r.error||'failed'); refresh();
}
async function approveAll(batchId){
  if(!confirm('Approve every waiting video in this festival post?')) return;
  const r=await post('${BASE}/approve-all',{batchId});
  if(!r.ok) alert(r.error||'failed'); else msg('🟢 Approved '+r.approved+'.'); refresh();
}
let timer=null, waitFor=0;
async function refresh(){
  clearTimeout(timer);
  const r=await fetch('${BASE}/status',{cache:'no-store'}).then(x=>x.json()).catch(()=>null);
  if(r&&r.ok) $('batches').innerHTML=r.html;
  // Just started: the posts appear within a few seconds, so keep looking a little while.
  if(waitFor>0) waitFor--;
  if((r&&r.busy)||waitFor>0) timer=setTimeout(refresh, waitFor>0?5000:15000);
}
${batches.some((b) => b.rows.some((r) => ['running', 'approved'].includes(r.status))) ? 'timer=setTimeout(refresh,15000);' : ''}
</script>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { register, batchesHtml };
