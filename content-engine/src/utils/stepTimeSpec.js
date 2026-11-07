/**
 * Step status and time per step (pure).
 *
 * Purpose:      Say which step an instance is on, in plain words, and how long each
 *               step really took. Time waiting on a person's approval is a wait: it
 *               is shown as one and never counts as working time.
 * Responsibility: Step labels per lane, step log → timeline, totals, duration text,
 *               the Library's current step, and the Library's live script. No I/O.
 * Dependencies: utils/{laneSpec,libraryStatus,retrySpec}.
 *
 * The real steps per lane (read from the services, nothing more):
 *   AI video (lane 2): research, script, script approval, images, animate,
 *     voiceover, transcript, stitch, final approval, publish.
 *   Ready video (lane 1): clean, transcript, transcript check (operator's Prepare page
 *     only), copy + thumbnails, approval, publish.
 *   Image post (lane 3): sheet refill, image, approval, publish.
 * Research, refill and a first clean or transcribe run before the instance exists, so
 * they appear once finished, not live.
 *
 * A step log event is { k: step key, s: 'start' | 'end' | 'fail' | 'mark', at: ISO, email?, by?, note? }.
 * A 'mark' is one plain line on the Log (note), with no time of its own.
 * email ('sent' | 'failed' | 'none') is on a review's start; by ('approved' | 'rework' |
 * 'router') on its end. Rows from before the log use the steps column's times; whatever
 * was never recorded reads "-".
 */
import { laneOf } from './laneSpec.js';
import { rowStatus } from './libraryStatus.js';
import { RETRY_STUCK_MS, isStuck } from './retrySpec.js';

const WORK = {
  research: 'Researching the topic',
  refill: 'Topping up the content sheet',
  clean: 'Cleaning the video',
  script: 'Preparing script',
  copy: 'Writing copy and thumbnails',
  images: 'Generating images',
  animate: 'Animating images',
  voiceover: 'Recording voiceover',
  transcript: 'Transcribing voiceover',
  stitch: 'FFmpeg stitching',
  draw_image: 'Drawing the headline on the image',
  publish: 'Sending to Post for Me',
};

const REVIEWS = {
  review_script: { noun: 'Script', status: 'script_review' },
  review_final: { noun: 'Final video', status: 'final_review' },
  review_copy: { noun: 'Copy', status: 'video_review' },
  review_image: { noun: 'Image', status: 'image_review' },
  review_transcript: { noun: 'Transcript', status: 'transcript_review', noEmail: true },
};

const STATUS_REVIEW = Object.fromEntries(Object.entries(REVIEWS).map(([k, v]) => [v.status, k]));

/** The steps each lane really has, in order. */
export const LANE_STEPS = {
  ai: ['research', 'script', 'review_script', 'images', 'animate', 'voiceover', 'transcript', 'stitch', 'review_final', 'publish'],
  ready: ['clean', 'transcript', 'review_transcript', 'copy', 'review_copy', 'publish'],
  image: ['refill', 'images', 'review_image', 'publish'],
};

// The steps column's stages that mean something on each lane, as [stage, step key].
const STEP_COLUMN = {
  ai: [['script', 'script'], ['images', 'images'], ['animate', 'animate'], ['voiceover', 'voiceover'], ['transcript', 'transcript'], ['stitch', 'stitch'], ['publish', 'publish']],
  ready: [['transcript', 'transcript'], ['script', 'copy'], ['publish', 'publish']],
  image: [['images', 'images'], ['publish', 'publish']],
};

const RENDER = ['images', 'animate', 'voiceover', 'transcript', 'stitch'];
const OVER = ['failed', 'superseded', 'posted', 'partial', 'scheduled', 'done'];

const ms = (v) => (v ? new Date(v).getTime() || 0 : 0);
const stepOf = (steps, key) => (Array.isArray(steps) ? steps : []).find((s) => s && s.key === key) || {};

/** Which step list a row follows. */
export function timeLane(row) {
  const lane = laneOf(row || {});
  return lane === 'ready' || lane === 'image' ? lane : 'ai';
}

/** Plain words for a working step on a lane. */
export function workLabel(key, lane = 'ai') {
  if (key === 'transcript' && lane === 'ready') return 'Transcribing video';
  if (key === 'images' && lane === 'image') return 'Generating image';
  return WORK[key] || key;
}

/** Plain words for a wait on a person. email unknown (older rows) makes no claim about it. */
export function reviewLabel(key, email) {
  const r = REVIEWS[key];
  if (!r) return key;
  if (r.noEmail) return 'Transcript waiting for your check';
  if (email === 'digest') return `${r.noun} ready, link in the daily email`;
  if (email === 'sent') return `${r.noun} email sent for approval`;
  if (email === 'failed') return `${r.noun} email failed, approve it here`;
  if (email === 'none') return `${r.noun} ready, no approval email set`;
  return `${r.noun} ready, waiting for approval`;
}

function outcomeLabel(key, by) {
  const noun = (REVIEWS[key] || {}).noun || 'Step';
  return by === 'rework' ? `${noun} sent back for changes` : `${noun} approved`;
}

/** The step_log column as an array, whatever the driver hands back. */
export function parseStepLog(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const v = JSON.parse(value);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** One step log event. */
export function stepEvent(key, state, { at = null, email = null, by = null, note = null } = {}) {
  return { k: key, s: state, at: at || new Date().toISOString(), ...(email ? { email } : {}), ...(by ? { by } : {}), ...(note ? { note } : {}) };
}

/** Duration text: 45s, 1m 20s, 2h 05m, 3d 4h. Unknown reads "-". */
export function formatSpan(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const s = Math.max(0, Math.round(Number(value) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const spanMs = (a, b) => (ms(a) && ms(b) && ms(b) >= ms(a) ? ms(b) - ms(a) : null);

/**
 * The instance's story in time order. Each entry: { key, kind: 'work' | 'wait' | 'mark',
 * label, startedAt, endedAt, at, ms, state }. state is done, failed, running or lost
 * (work), waiting, done or ended (wait), done (mark). Lost work was started but nobody
 * finished it (a restart): its time is unknown, so it is "-", not the hours since.
 */
export function buildTimeline(row, steps, log, now = Date.now()) {
  const r = row || {};
  const lane = timeLane(r);
  const out = [];
  const open = new Map();
  const seen = new Set();
  const finished = OVER.includes(r.status) || !!r.locked;
  const quiet = (from) => now - Math.max(ms(from), ms(r.updated_at)) > RETRY_STUCK_MS;
  const mark = (key, label, at) => out.push({ key, kind: 'mark', label, startedAt: at, endedAt: at, at, ms: null, state: 'done' });

  const events = parseStepLog(log === undefined ? r.step_log : log).filter((e) => e && e.k && e.s).sort((a, b) => ms(a.at) - ms(b.at));
  for (const ev of events) {
    if (ev.s === 'mark') {
      mark(ev.k, ev.note || ev.k, ev.at);
      continue;
    }
    const wait = !!REVIEWS[ev.k];
    const span = open.get(ev.k);
    if (ev.s === 'start') {
      if (span) {
        span.state = wait ? 'ended' : 'lost';
        span.endedAt = wait ? ev.at : null;
      }
      const entry = {
        key: ev.k, kind: wait ? 'wait' : 'work', label: wait ? reviewLabel(ev.k, ev.email) : workLabel(ev.k, lane),
        startedAt: ev.at, endedAt: null, state: 'open',
      };
      out.push(entry);
      open.set(ev.k, entry);
      seen.add(ev.k);
    } else if (span) {
      open.delete(ev.k);
      span.endedAt = ev.at;
      span.state = ev.s === 'fail' ? 'failed' : 'done';
      if (ev.by === 'router') span.drop = true; // the router passed it on at once: nobody waited
      if (wait && ev.by && ev.by !== 'router') mark(ev.k, outcomeLabel(ev.k, ev.by), ev.at);
      if (ev.k === 'stitch' && ev.s === 'end') mark('final_ready', 'Final video ready', ev.at);
    } else if (wait) {
      if (ev.by && ev.by !== 'router') mark(ev.k, outcomeLabel(ev.k, ev.by), ev.at); // the wait began before the log
    } else if (!seen.has(ev.k)) {
      // An end with no start: it began before the log. A repeat end is ignored.
      seen.add(ev.k);
      const from = stepOf(steps, ev.k).startedAt || null;
      out.push({ key: ev.k, kind: 'work', label: workLabel(ev.k, lane), startedAt: from, endedAt: ev.at, state: ev.s === 'fail' ? 'failed' : 'done' });
      if (ev.k === 'stitch' && ev.s === 'end') mark('final_ready', 'Final video ready', ev.at);
    }
  }
  for (const entry of open.values()) {
    if (entry.kind === 'wait') entry.state = r.status === REVIEWS[entry.key].status ? 'waiting' : 'ended';
    else entry.state = finished || quiet(entry.startedAt) ? 'lost' : 'running';
  }

  // Whatever the log has nothing on: the steps column's times, as far as they go.
  for (const [stage, key] of STEP_COLUMN[lane]) {
    const s = stepOf(steps, stage);
    if (seen.has(key) || !['done', 'failed', 'running'].includes(s.status)) continue;
    const running = s.status === 'running';
    out.push({
      key, kind: 'work', label: workLabel(key, lane), startedAt: s.startedAt || null, endedAt: running ? null : s.finishedAt || null,
      state: running ? (finished || quiet(s.startedAt) ? 'lost' : 'running') : s.status,
    });
    if (key === 'stitch' && s.status === 'done' && s.finishedAt) mark('final_ready', 'Final video ready', s.finishedAt);
  }

  return out
    .filter((e) => !e.drop)
    .map((e) => {
      const live = e.state === 'running' || e.state === 'waiting';
      const span = e.kind === 'mark' || e.state === 'lost' ? null : spanMs(e.startedAt, live ? new Date(now).toISOString() : e.endedAt);
      return { ...e, at: e.startedAt || e.endedAt || null, ms: span };
    })
    .sort((a, b) => ms(a.at) - ms(b.at));
}

/**
 * Working time and waiting time, never mixed. unknown counts the working steps with
 * no recorded time, so a total can say it is only part of the story.
 */
export function stepTotals(entries) {
  const out = { workMs: 0, waitMs: 0, unknown: 0 };
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e.kind === 'work') {
      if (e.ms === null || e.ms === undefined) out.unknown += 1;
      else out.workMs += e.ms;
    } else if (e.kind === 'wait' && e.ms) {
      out.waitMs += e.ms;
    }
  }
  return out;
}

function nextWork(row, steps) {
  const lane = timeLane(row);
  if (lane === 'image') return workLabel('images', lane);
  if (lane === 'ready') return 'Preparing';
  if (!stepOf(steps, 'script').artifacts?.text) return workLabel('script', lane);
  const next = RENDER.find((k) => !['done', 'skipped'].includes(stepOf(steps, k).status));
  return next ? workLabel(next, lane) : 'Final video ready';
}

/**
 * What the Library's pill says for a row: { key, label, dot, note, since, active, open }.
 * active: work is happening now, so the page keeps polling. open: not settled yet (work
 * or a wait), so the page re-checks once when the tab comes back.
 */
export function currentStep(row, steps, log, now = Date.now()) {
  const r = row || {};
  const st = rowStatus(r, now);
  const base = { key: st.key, label: st.label, dot: st.dot, note: st.note || '', since: null, active: false, open: false };
  if (st.posting) return { ...base, active: true, open: true };
  const timeline = buildTimeline(r, steps, log, now);
  if (st.key === 'failed') {
    const bad = [...timeline].reverse().find((e) => e.state === 'failed');
    return bad && r.post_status !== 'post_failed' ? { ...base, label: `Failed at ${bad.label}` } : base;
  }
  if (OVER.includes(r.status) || r.locked) return base;

  const running = [...timeline].reverse().find((e) => e.state === 'running');
  if (running) return { ...base, label: running.label, dot: '🔵', since: running.startedAt, active: true, open: true };

  const review = STATUS_REVIEW[r.status];
  if (review) {
    if (review === 'review_script' && !stepOf(steps, 'script').artifacts?.text) return { ...base, label: 'No script yet', dot: '🟡', open: true };
    const wait = [...timeline].reverse().find((e) => e.key === review && e.state === 'waiting');
    return { ...base, label: wait ? wait.label : reviewLabel(review), dot: '🟡', since: wait ? wait.startedAt : null, open: true };
  }
  if (r.status === 'running') {
    const next = nextWork(r, steps);
    if (isStuck(r, now)) return { ...base, label: `Stopped at ${next}`, dot: '🟡' };
    const approved = timeLane(r) === 'ai' && next === workLabel('images') && stepOf(steps, 'images').status !== 'failed';
    return { ...base, label: approved ? 'Script approved' : next, dot: '🔵', active: true, open: true };
  }
  if (r.status === 'approved') {
    const fresh = now - ms(r.updated_at) <= RETRY_STUCK_MS;
    return { ...base, label: 'Approved, sending to Post for Me', dot: '🔵', active: fresh, open: fresh };
  }
  return base;
}

/**
 * The Library's live updates: a second's tick for the running clocks, a small poll of
 * the rows with work happening. Nothing is fetched when no row is working or the tab is
 * hidden, so an open Library never keeps a sleeping app awake. Coming back to the tab
 * checks the unsettled rows once. A row whose status moved reloads the page, for its
 * buttons, unless the preview is open.
 */
export const LIVE_STEPS_SCRIPT = `
(function(){
  const POLL_TICKS=6, KEY='libOpenSteps';
  const fmt=${formatSpan.toString()};
  const cells=()=>Array.from(document.querySelectorAll('.stepcell'));
  const idsWhere=(attr)=>cells().filter((c)=>c.dataset[attr]==='1').map((c)=>c.dataset.id).slice(0,100);
  let timer=null, n=0, busy=false;
  function tick(){
    document.querySelectorAll('[data-since]').forEach((el)=>{ const t=new Date(el.dataset.since).getTime(); if(t) el.textContent=fmt(Date.now()-t); });
  }
  function stop(){ if(timer){ clearInterval(timer); timer=null; } }
  function start(){
    if(timer||document.hidden||!idsWhere('active').length) return;
    n=0; timer=setInterval(()=>{ tick(); n+=1; if(n%POLL_TICKS===0) poll(idsWhere('active')); },1000);
  }
  async function poll(ids){
    if(busy||!ids.length) return;
    busy=true;
    try{
      const r=await fetch('/api/v1/admin/instances/live?ids='+ids.join(','));
      if(r.status===401){ stop(); return; }
      if(!r.ok) return;
      const j=await r.json();
      let moved=false;
      (j.items||[]).forEach((it)=>{
        const c=cells().find((x)=>x.dataset.id===it.id);
        if(!c) return;
        if(c.dataset.key!==it.key) moved=true;
        c.dataset.active=it.active?'1':'0'; c.dataset.open=it.open?'1':'0';
        c.querySelector('.stepnow').innerHTML=it.now;
        const tot=c.querySelector('.steptot'); if(tot) tot.textContent=it.total;
        const list=c.querySelector('.stepl'); if(list) list.innerHTML=it.list;
      });
      const pv=document.getElementById('pv');
      if(moved&&!(pv&&pv.classList.contains('on'))){ location.reload(); return; }
      if(!idsWhere('active').length) stop(); else start();
    }catch(e){ /* the next tick tries again */ }
    finally{ busy=false; }
  }
  function remember(){
    try{ sessionStorage.setItem(KEY, JSON.stringify(cells().filter((c)=>{ const d=c.querySelector('details'); return d&&d.open; }).map((c)=>c.dataset.id))); }catch(e){ /* only a convenience */ }
  }
  try{
    const kept=JSON.parse(sessionStorage.getItem(KEY)||'[]');
    cells().forEach((c)=>{ const d=c.querySelector('details'); if(d&&kept.includes(c.dataset.id)) d.open=true; });
  }catch(e){ /* only a convenience */ }
  document.addEventListener('toggle',remember,true);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden) stop();
    else { poll(idsWhere('open')); start(); }
  });
  start();
})();
`;

export default { LANE_STEPS, timeLane, workLabel, reviewLabel, parseStepLog, stepEvent, formatSpan, buildTimeline, stepTotals, currentStep, LIVE_STEPS_SCRIPT };
