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
import { TEST_PLANS, TEST_CURRENCIES, defaultTestAmount, testPrice, upgradePrice, stepsFrom, subscribeState } from './billingTestSpec.js';

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
        <label>Key Secret<span class="inl"><input id="rzp-secret" type="password" placeholder="${pay.secretSet ? 'saved' : ''}" autocomplete="off"><button class="act" type="button" onclick="copyPay('rzp-secret',this)">Copy</button></span></label>
        <label>Webhook secret<span class="inl"><input id="rzp-hook" type="password" placeholder="${pay.webhookSet ? 'saved' : ''}" autocomplete="off"><button class="act" type="button" onclick="copyPay('rzp-hook',this)">Copy</button></span></label>
      </div>
      <div class="inl"><button class="act" type="button" onclick="genHook()">Generate webhook secret</button><button class="act primary" type="button" onclick="savePay()">Save</button><span id="pay-flag" class="hint"></span></div>
      <p class="hint">In Razorpay, Account and Settings, Webhooks, Add new webhook:</p>
      <div class="inl"><label>Webhook URL<input id="rzp-url" readonly value="${esc(hook)}" style="min-width:22rem"></label><button class="act" type="button" onclick="copyPay('rzp-url',this)">Copy</button></div>
      <p class="hint">Secret: the webhook secret above (Generate, Copy, paste it in Razorpay, then Save here). Events: <b>subscription.charged, subscription.cancelled, subscription.halted, subscription.completed</b>. A saved secret is never shown again: to change it, generate a new one and update Razorpay too.</p>
      <script>function genHook(){var a=new Uint8Array(24);crypto.getRandomValues(a);var s=Array.from(a,function(x){return x.toString(16).padStart(2,'0');}).join('');var i=document.getElementById('rzp-hook');i.value=s;document.getElementById('pay-flag').textContent='🟢 New secret made (hidden). Press Copy, paste it in Razorpay, then Save.';}
      function copyPay(id,b){var v=document.getElementById(id).value;var f=document.getElementById('pay-flag');if(!v){f.textContent='🟡 Nothing to copy: a saved secret is not kept in the page. Generate or type it first.';return;}navigator.clipboard.writeText(v).then(function(){var t=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=t;},1200);},function(e){f.textContent='🟡 Copy failed: '+e.message;});}
      async function savePay(){const f=document.getElementById('pay-flag');f.textContent='';try{const j=await (await fetch('${PLAN_PATH}/billing-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyId:document.getElementById('rzp-id').value,keySecret:document.getElementById('rzp-secret').value,webhookSecret:document.getElementById('rzp-hook').value})})).json();f.textContent=j.ok?'🟢 saved, reload to see the status':'🟡 '+(j.error||'not saved');}catch(e){f.textContent='🟡 '+e.message;}}</script>`);
    out.push(testPayments(pay.tests || []));
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

/** A row's Subscribe cell: Subscribe, off while paid, or Pay again after a failed renewal. */
function subCell(p, tests) {
  const s = subscribeState(p, tests);
  if (s.kind === 'paid') return `<button class="act" type="button" disabled title="A test workspace on this plan is paid up">Paid till ${s.until}</button>`;
  if (s.kind === 'lapsed') return `<button class="act" type="button" data-do="renew" data-ws="${s.tenantId}" data-word="Pay again" title="The renewal did not go through: pay with any method, autopay continues on it">Pay again ${testPrice(p)}</button>`;
  return `<button class="act" type="button" data-do="subscribe" data-word="Subscribe">Subscribe ${testPrice(p)}</button>`;
}

/** Owner only: test payments on every plan, one row each, with the live keys. */
export function testPayments(tests = []) {
  const esc2 = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const opts = tests.length
    ? tests.map((t) => `<option value="${esc2(t.tenantId)}">${esc2(t.name)}: ${esc2(planLabel(t.plan))}, ${esc2(t.email)}, ${t.ended ? 'cancelled' : `paid until ${esc2(t.until)}`}</option>`).join('')
    : '<option value="">No test workspace yet: Subscribe on a row first</option>';
  const curOpts = Object.keys(TEST_CURRENCIES).map((c) => `<option>${c}</option>`).join('');
  const rows = TEST_PLANS.map((p) => `<tr data-plan="${p}"><td><b>${esc2(PLANS[p].label)}</b></td>
      <td><span class="inl"><select class="tp-cur" aria-label="Currency">${curOpts}</select><input class="tp-amt" inputmode="decimal" aria-label="Amount" value="${defaultTestAmount(p).toFixed(2)}" data-def="${defaultTestAmount(p).toFixed(2)}"></span><small class="tp-range">a month (1.00 to 100.00)</small></td>
      <td>${subCell(p, tests)}</td>
      <td>${stepsFrom(p).up ? `<button class="act" type="button" data-do="upgrade" data-to="${stepsFrom(p).up}" data-word="Upgrade to ${esc2(PLANS[stepsFrom(p).up].label)}">Upgrade to ${esc2(PLANS[stepsFrom(p).up].label)} ${upgradePrice(stepsFrom(p).up)}</button>` : ''}</td>
      <td>${stepsFrom(p).down ? `<button class="act" type="button" data-do="downgrade" data-to="${stepsFrom(p).down}">Downgrade to ${esc2(PLANS[stepsFrom(p).down].label)}</button>` : ''}</td>
      <td><button class="act" type="button" data-do="cancel">Cancel</button></td></tr>`).join('');
  const data = JSON.stringify({ order: TEST_PLANS, tests, cur: TEST_CURRENCIES }).replace(/</g, '\\u003c');
  return `<h2 id="test-payments">Test payments (owner only)</h2>
    <p class="hint">Real money with the keys above. Pick INR or USD and type the amount on each plan (INR 1.00 to 100.00, USD 0.50 to 100.00); by default each plan has its own small monthly price (1.10 for the cheapest, 1.20 the next, and so on) so you can tell every charge apart in Razorpay. Upgrade charges the amount on the plan it moves to; Downgrade bills the amount on the plan it moves to from the next renewal. USD needs international payments switched on in Razorpay. Each row is the plan the picked workspace is on now: only that row's Upgrade, Downgrade and Cancel are live. Subscribe makes a new workspace on that plan and emails its sign-in to the buyer email. Upgrade moves it one plan up and charges that plan's price once (Starter Lite to Solo: ₹1.20), opens its features now, and the renewals then charge the new plan's price. Downgrade moves it one plan down and charges nothing: the features outside the new plan switch off now, and the renewals charge the new plan's price from the next month. Cancel ends the subscription and locks the workspace. Once a plan is paid its Subscribe turns off; if a monthly renewal fails it turns into Pay again, which takes any payment method and carries the autopay on it. Each step emails the buyer. Renewals go on every month until you cancel.</p>
    <div class="grid2">
      <label>Test buyer email (new for each Subscribe)<input id="tp-email" type="email" placeholder="you+lite@gmail.com" autocomplete="off"></label>
      <label>Test buyer name and phone<span class="inl"><input id="tp-name" placeholder="Name"><input id="tp-phone" placeholder="Phone"></span></label>
    </div>
    <label>Test workspace for Upgrade, Downgrade and Cancel<select id="tp-ws">${opts}</select></label>
    <style>table.tp button[disabled]{opacity:.35;cursor:not-allowed}table.tp .tp-cur{width:5.5em}table.tp .tp-amt{width:6em}table.tp small{display:block;opacity:.7}</style>
    <table class="tp"><thead><tr><th>Plan</th><th>Price</th><th></th><th></th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p id="tp-msg" class="hint"></p>
    <script>(function(){var D=${data};var M=document.getElementById('tp-msg');var W=document.getElementById('tp-ws');
    function picked(){for(var i=0;i<D.tests.length;i++){if(D.tests[i].tenantId===W.value)return D.tests[i];}return null;}
    function rank(p){return D.order.indexOf(p);}
    function row(p){return document.querySelector('table.tp tr[data-plan="'+p+'"]');}
    function price(p){var r=row(p);if(!r)return {};var c=r.querySelector('.tp-cur').value,a=r.querySelector('.tp-amt').value.trim(),n=Number(a),L=D.cur[c];
      if(!a||!isFinite(n)||n<L.min||n>L.max)throw new Error('Type an amount from '+L.min.toFixed(2)+' to '+L.max.toFixed(2)+' '+c+' on '+p);return {currency:c,price:n.toFixed(2)};}
    function shown(p){try{var x=price(p);return x.currency+' '+x.price;}catch(e){return '';}}
    function relabel(){document.querySelectorAll('table.tp tr[data-plan]').forEach(function(r){var p=r.getAttribute('data-plan'),c=r.querySelector('.tp-cur').value,L=D.cur[c];
      r.querySelector('.tp-range').textContent='a month ('+L.min.toFixed(2)+' to '+L.max.toFixed(2)+')';
      r.querySelectorAll('button[data-word]').forEach(function(b){var to=b.getAttribute('data-to')||p;b.textContent=b.getAttribute('data-word')+' '+shown(to);});});}
    document.querySelectorAll('table.tp .tp-cur, table.tp .tp-amt').forEach(function(el){el.addEventListener('input',relabel);el.addEventListener('change',relabel);});
    function paint(){var t=picked();var on=t&&!t.ended?rank(t.plan):-2;document.querySelectorAll('table.tp tr[data-plan]').forEach(function(r){var x=rank(r.getAttribute('data-plan'));
      var live=on>=0&&x===on;var u=r.querySelector('[data-do=upgrade]'),d=r.querySelector('[data-do=downgrade]');if(u)u.disabled=!live;if(d)d.disabled=!live;r.querySelector('[data-do=cancel]').disabled=!live;r.style.fontWeight=(on===x)?'700':'';});}
    async function post(u,b){var r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});var j=await r.json().catch(function(){return {ok:false,error:'The app answered '+r.status};});if(!j.ok)throw new Error(j.error||'failed');return j;}
    function rzp(){return new Promise(function(ok,bad){if(window.Razorpay)return ok();var s=document.createElement('script');s.src='https://checkout.razorpay.com/v1/checkout.js';s.onload=ok;s.onerror=function(){bad(new Error('The payment window did not load'));};document.body.appendChild(s);});}
    function mailed(e){return e&&e.sent?' Email sent.':' 🟡 Email not sent'+(e&&e.error?': '+e.error:'')+'.';}
    function later(){setTimeout(function(){location.reload();},3500);}
    async function run(step,plan,ws){M.textContent='Working…';try{
      var pr=step==='cancel'?{}:price(plan);
      if(step==='subscribe'){var s=await post('/api/v1/admin/plan/test/subscribe',{currency:pr.currency,price:pr.price,plan:plan,email:document.getElementById('tp-email').value,name:document.getElementById('tp-name').value,phone:document.getElementById('tp-phone').value});await rzp();
        new window.Razorpay({key:s.keyId,subscription_id:s.subscriptionId,name:'Content Engine',description:s.description,prefill:s.prefill,
          handler:async function(r){try{var j=await post('/buy/confirm',{paymentId:r.razorpay_payment_id,subscriptionId:r.razorpay_subscription_id,signature:r.razorpay_signature});M.textContent='🟢 Paid. Workspace '+j.tenant+' made for '+j.email+(j.tempPassword?', one-time password '+j.tempPassword:'')+'. The sign-in was emailed. Reloading…';setTimeout(function(){location.reload();},8000);}catch(e){M.textContent='🔴 '+e.message;}},
          modal:{ondismiss:function(){M.textContent='🟡 Payment window closed.';}}}).open();return;}
      if(step==='renew'){var rn=await post('/api/v1/admin/plan/test/renew',{tenantId:ws,currency:pr.currency,price:pr.price});await rzp();
        new window.Razorpay({key:rn.keyId,subscription_id:rn.subscriptionId,name:'Content Engine',description:rn.description,prefill:rn.prefill,
          handler:async function(r){try{var j=await post('/api/v1/admin/plan/test/renew-paid',{paymentId:r.razorpay_payment_id,subscriptionId:r.razorpay_subscription_id,signature:r.razorpay_signature});M.textContent='🟢 Paid again, '+j.tenant+' is open.'+mailed(j.email)+' Reloading…';later();}catch(e){M.textContent='🔴 '+e.message;}},
          modal:{ondismiss:function(){M.textContent='🟡 Payment window closed.';}}}).open();return;}
      var t=picked();if(!t)throw new Error('Pick a test workspace first');
      if(step==='upgrade'){var o=await post('/api/v1/admin/plan/test/upgrade',{tenantId:t.tenantId,plan:plan,currency:pr.currency,price:pr.price});await rzp();
        new window.Razorpay({key:o.keyId,order_id:o.orderId,amount:o.amount,currency:o.currency||'INR',name:'Content Engine',description:o.description,prefill:o.prefill,
          handler:async function(r){try{var j=await post('/api/v1/admin/plan/test/upgrade-paid',{orderId:r.razorpay_order_id,paymentId:r.razorpay_payment_id,signature:r.razorpay_signature});M.textContent='🟢 Upgraded to '+j.plan+'.'+mailed(j.email)+' Reloading…';later();}catch(e){M.textContent='🔴 '+e.message;}},
          modal:{ondismiss:function(){M.textContent='🟡 Payment window closed.';}}}).open();return;}
      if(step==='downgrade'){if(!confirm('Move '+t.name+' down to '+plan+' now?')){M.textContent='';return;}var d=await post('/api/v1/admin/plan/test/downgrade',{tenantId:t.tenantId,plan:plan,currency:pr.currency,price:pr.price});M.textContent='🟢 Downgraded to '+d.plan+'.'+mailed(d.email)+' Reloading…';later();return;}
      if(step==='cancel'){if(!confirm('Cancel the subscription of '+t.name+' and lock it now?')){M.textContent='';return;}var c=await post('/api/v1/admin/plan/test/cancel',{tenantId:t.tenantId});M.textContent=(c.razorpay==='cancelled'?'🟢 Cancelled on Razorpay and locked.':'🟡 Locked here, Razorpay said: '+c.razorpay)+mailed(c.email)+' Reloading…';later();}
    }catch(e){M.textContent='🔴 '+e.message;}}
    document.querySelectorAll('table.tp button[data-do]').forEach(function(b){b.addEventListener('click',function(){run(b.getAttribute('data-do'),b.getAttribute('data-to')||b.closest('tr').getAttribute('data-plan'),b.getAttribute('data-ws'));});});
    W.addEventListener('change',paint);paint();relabel();})();</script>`;
}
