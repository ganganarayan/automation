/**
 * Module: lead visits (personal DM links + the landing-page script).
 *
 * Purpose:      A DM'd lead's link opens /go/{code}: marked clicked, sent on to
 *               the landing page. The landing pages load /t/lead.js, which
 *               reports the page view and form submits against that code.
 * Responsibility: HTTP only; logic in leadVisitService.
 * Dependencies: leadVisitService, settings.
 *
 * Routes (no sign-in: the code is random and only marks that one lead):
 *         GET  /api/v1/go/:code     count the click, 302 to the landing page
 *         GET  /api/v1/t/lead.js    the script every landing page includes
 *         POST /api/v1/t/event      { lc, type: view|form, fields } from the script
 */
import express from 'express';
import * as leadVisits from '../services/leadVisitService.js';
import { settings } from '../settings/index.js';

/** Reads ?lc= (kept for later pages of the same site), reports the view and every form submit. */
export function leadScript(base) {
  const endpoint = `${String(base || '').replace(/\/+$/, '')}/api/v1/t/event`;
  return `(function(){try{
var E=${JSON.stringify(endpoint)},K='ce_lc',q=new URLSearchParams(location.search),c=q.get('lc');
try{if(c){localStorage.setItem(K,c)}else{c=localStorage.getItem(K)}}catch(e){}
if(!c)return;
function send(o){o.lc=c;var b=JSON.stringify(o);if(navigator.sendBeacon&&navigator.sendBeacon(E,new Blob([b],{type:'text/plain'})))return;fetch(E,{method:'POST',body:b,keepalive:true,headers:{'content-type':'text/plain'}}).catch(function(){})}
send({type:'view',page:location.pathname});
document.addEventListener('submit',function(ev){var f=ev.target,o={};if(!f||!f.elements)return;
for(var i=0;i<f.elements.length;i++){var el=f.elements[i],n=el.name||el.id;if(!n||el.type==='password'||el.type==='hidden'||el.type==='file')continue;if((el.type==='checkbox'||el.type==='radio')&&!el.checked)continue;o[n]=el.value}
send({type:'form',page:location.pathname,fields:o})},true);
window.ceLeadForm=function(fields){send({type:'form',page:location.pathname,fields:fields||{}})};
}catch(e){}})();`;
}

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/go/:code', async (req, res) => {
    const to = await leadVisits.onClick(String(req.params.code || '').toLowerCase()).catch(() => '');
    if (!to) return res.status(404).type('text').send('This link has expired.');
    res.set('Cache-Control', 'no-store').redirect(302, to);
  });

  router.get('/t/lead.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').type('application/javascript').send(leadScript(settings.app.publicBaseUrl));
  });

  const cors = (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
  router.options('/t/event', cors);
  router.post('/t/event', cors, express.text({ type: '*/*', limit: '16kb' }), async (req, res) => {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    res.status(204).end();
    leadVisits.onPageEvent(body || {}).catch((err) => log.warn({ err: err.message }, 'lead page event failed'));
  });

  log.info('lead visits registered at /api/v1/go/:code (+ /t/lead.js, /t/event)');
}

export default { register, leadScript };
