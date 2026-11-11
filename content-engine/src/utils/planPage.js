/**
 * Plan page body (pure).
 *
 * Purpose:      What the Plan page shows: plan, renew or end date, the one-click
 *               Cancel or Keep my plan button, and for the owner the exit
 *               assessment link box.
 * Responsibility: HTML only; the route (modules/planCancel) does the I/O.
 * Dependencies: utils/cancelSpec, utils/planSpec (both pure).
 */
import { cancelProblem } from './cancelSpec.js';
import { planLabel, PLANS, limitsForTenant } from './planSpec.js';

export const PLAN_PATH = '/api/v1/admin/plan';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The page body. `day` formats a date for people; the route passes the
 * project's IST formatter (utils/time formatIst without the time).
 */
export function planBody({ tenant = null, role = 'admin', superAdmin = false, base = '', flash = '', day = (v) => String(v || ''), pay = null, origin = '' } = {}) {
  const why = cancelProblem({ tenant, role, superAdmin });
  const ends = tenant && tenant.expires_at ? day(tenant.expires_at) : '';
  const out = [`<div class="top"><div><h1>Plan</h1><div class="sub">${esc(tenant ? tenant.name : '')}</div></div></div>`];

  if (flash === 'cancelled') out.push('<p class="ok">🟢 Your plan is cancelled. You will not be charged again.</p>');
  if (flash === 'kept') out.push('<p class="ok">🟢 Your plan will renew as usual.</p>');
  if (flash === 'solo') out.push('<p class="ok">🟢 You move to Solo from your next renewal. Until then nothing changes.</p>');

  if (tenant) {
    const lim = limitsForTenant(tenant.plan, { units: tenant.units, extraUsers: tenant.extra_users });
    const bought = lim.units ? `${lim.units} ${lim.perUnit === 'client' ? (lim.units === 1 ? 'client' : 'clients') : (lim.units === 1 ? 'funnel' : 'funnels')}` : '';
    out.push(`<div class="card"><div class="row"><span>Plan</span><b>${esc(planLabel(tenant.plan))}${bought ? `, ${esc(bought)}` : ''}</b></div>
      ${lim.users !== null && lim.users !== undefined ? `<div class="row"><span>Users</span><b>${esc(lim.users)}</b></div>` : ''}
      <div class="row"><span>${tenant.cancelled_at ? 'Works until' : 'Renews on'}</span><b>${esc(ends || 'no end date set')}</b></div>
      ${tenant.cancelled_at ? `<div class="row"><span>Cancelled on</span><b>${esc(day(tenant.cancelled_at))}</b></div>` : ''}</div>`);
  }

  if (!why && tenant) {
    if (tenant.cancelled_at && tenant.billing_sub_id) {
      out.push(`<p class="hint">🟡 Cancelled. Your card or UPI will not be charged again, and everything keeps working${ends ? ` until ${esc(ends)}` : ''}. To carry on after that, buy the plan again from <a href="/#pricing">pricing</a>.</p>`);
    } else if (tenant.cancelled_at) {
      out.push(`<p class="hint">🟡 Cancelled. Everything keeps working${ends ? ` until ${esc(ends)}` : ''}; after that the workspace stops posting. Changed your mind?</p>
        <form method="post" action="${PLAN_PATH}/resume"><button class="act primary" type="submit">Keep my plan</button></form>`);
    } else {
      if (soloOffer(tenant)) out.push(soloOffer(tenant));
      out.push(`<h2>Cancel</h2>
        <p class="hint">One click. You will not be charged again, and everything keeps working${ends ? ` until ${esc(ends)}` : ' until the end of the period you paid for'}. Payments are not refunded (<a href="/refund">refund policy</a>).</p>
        <form method="post" action="${PLAN_PATH}/cancel"><button class="act danger" type="submit">🔴 Cancel my plan</button></form>`);
    }
  } else if (why) {
    out.push(`<p class="hint">${esc(why)}</p>`);
  }

  if (superAdmin && pay) {
    const hook = `${origin}/buy/webhook`;
    out.push(`<h2 id="payments">Payments (owner only)</h2>
      <p class="hint">Razorpay takes payments on the <a href="/buy">buy page</a>: India in rupees with 18% GST, everyone else in US dollars with no GST. US dollars need International payments switched on in your Razorpay account. From the Razorpay dashboard, Account and Settings, API keys. A blank box keeps what is saved.</p>
      <div class="card"><div class="row"><span>Status</span><b>${pay.keyId && pay.secretSet ? (pay.keyId.startsWith('rzp_live_') ? '🟢 Live: people can pay' : '🟡 Test keys: payments are not real') : '🟡 Not set: the buy page asks people to write to you'}</b></div>
      <div class="row"><span>Webhook</span><b>${pay.webhookSet ? '🟢 Secret saved' : '🟡 Not set: renewals will not extend workspaces'}</b></div></div>
      <div class="grid2">
        <label>Key Id<input id="rzp-id" placeholder="rzp_live_..." value="${esc(pay.keyId)}"></label>
        <label>Key Secret<input id="rzp-secret" type="password" placeholder="${pay.secretSet ? 'saved' : ''}" autocomplete="off"></label>
        <label>Webhook secret<input id="rzp-hook" type="password" placeholder="${pay.webhookSet ? 'saved' : ''}" autocomplete="off"></label>
      </div>
      <div class="inl"><button class="act" type="button" onclick="genHook()">Generate webhook secret</button><button class="act primary" type="button" onclick="savePay()">Save</button><span id="pay-flag" class="hint"></span></div>
      <p class="hint">In Razorpay, Webhooks, add: URL <b>${esc(hook)}</b>, the same webhook secret, events <b>subscription.charged, subscription.cancelled, subscription.halted, subscription.completed</b>.</p>
      <script>function genHook(){var a=new Uint8Array(24);crypto.getRandomValues(a);var s=Array.from(a,function(x){return x.toString(16).padStart(2,'0');}).join('');var i=document.getElementById('rzp-hook');i.type='text';i.value=s;}
      async function savePay(){const f=document.getElementById('pay-flag');f.textContent='';try{const j=await (await fetch('${PLAN_PATH}/billing-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyId:document.getElementById('rzp-id').value,keySecret:document.getElementById('rzp-secret').value,webhookSecret:document.getElementById('rzp-hook').value})})).json();f.textContent=j.ok?'🟢 saved, reload to see the status':'🟡 '+(j.error||'not saved');}catch(e){f.textContent='🟡 '+e.message;}}</script>`);
  }

  if (superAdmin) {
    out.push(`<h2>Exit assessment (owner only)</h2>
      <p class="hint">After someone cancels, they are sent here. The workspace id and plan are added to the link (?tenant=…&amp;plan=…) so each answer is tied to its tenant. Leave empty to send them back to this page.</p>
      <div class="inl"><input id="exit-url" type="url" placeholder="https://" value="${esc(base)}"><button class="act primary" type="button" onclick="saveExit()">Save</button><span id="exit-flag" class="hint"></span></div>
      <script>async function saveExit(){const f=document.getElementById('exit-flag');f.textContent='';try{const j=await (await fetch('${PLAN_PATH}/exit-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:document.getElementById('exit-url').value})})).json();f.textContent=j.ok?'🟢 saved':'🟡 '+(j.error||'not saved');}catch(e){f.textContent='🟡 '+e.message;}}</script>`);
  }
  return out.join('\n');
}

/**
 * The offer to someone about to cancel: keep posting on Solo (1 funnel, 5
 * channels, the lean build) for less. Never on the pricing page. '' when it
 * does not apply (already on Solo, or a client of an agency).
 */
export function soloOffer(tenant) {
  if (!tenant || tenant.plan === 'solo' || tenant.parent_id) return '';
  const s = PLANS.solo;
  const price = tenant.billing_currency === 'USD' ? `$${s.priceUsd} a month` : `₹${s.priceInr.toLocaleString('en-IN')} + GST a month`;
  return `<h2>Before you go: Solo</h2>
    <div class="card"><p>Keep a post going out every day for <b>${esc(price)}</b>: 1 funnel, ${s.channels} channels, ${s.posts} posts a month, with a lighter build (one picture cut to each size, a lower-cost voice).</p>
    ${tenant.billing_sub_id
    ? `<p class="hint">You move to Solo from your next renewal, on the same card.</p>
    <form method="post" action="${PLAN_PATH}/solo"><button class="act primary" type="submit">Switch to Solo instead</button></form>`
    : '<p class="hint">Write to us before your renewal date and we move you to Solo.</p>'}</div>`;
}

export default { PLAN_PATH, planBody, soloOffer };
