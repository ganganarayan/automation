/**
 * The buy page (pure HTML).
 *
 * Purpose:      Pick a plan and billing, say where the business is billed, pay
 *               with Razorpay Checkout, and get the new workspace's sign-in.
 *               India: rupees with 18% GST added. Outside India: US dollars, no GST.
 * Responsibility: HTML and the page script; modules/billing does the I/O.
 * Dependencies: utils/billingSpec, utils/planSpec, utils/publicPages (shell).
 */
import { shell, LOGIN_PATH } from './publicPages.js';
import { PLANS } from './planSpec.js';
import { BUYABLE, PERIODS, COUNTRIES, quoteTable, money, BUY_PATH } from './billingSpec.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Price lines the page shows, keyed plan:bill:country (from billingSpec, never summed in the browser). */
function priceLines() {
  const out = {};
  for (const [k, q] of Object.entries(quoteTable())) {
    const per = PERIODS[q.bill].unit;
    out[k] = q.currency === 'INR'
      ? { pay: `${money(q.total, 'INR')}`, lines: [`${money(q.base, 'INR')} a ${per}`, `18% GST: ${money(q.gst, 'INR')}`, `Total: ${money(q.total, 'INR')} a ${per}, renews ${PERIODS[q.bill].word}`] }
      : { pay: `${money(q.total, 'USD')}`, lines: [`${money(q.base, 'USD')} a ${per}`, 'No GST outside India', `Total: ${money(q.total, 'USD')} a ${per}, renews ${PERIODS[q.bill].word}`] };
  }
  return out;
}

export function buyPage({ plan = 'starter', bill = 'mo', cur = '', ready = false, email = '' } = {}) {
  const p = BUYABLE.includes(plan) ? plan : 'starter';
  const b = PERIODS[bill] ? bill : 'mo';
  const country = cur === 'usd' ? 'XX' : cur === 'inr' ? 'IN' : '';
  const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  const closed = ready ? '' : `<p class="warn">🟡 Online payment opens soon. ${email ? `Write to <a href="mailto:${esc(email)}">${esc(email)}</a> and we will set up your workspace.` : 'Write to us and we will set up your workspace.'}</p>`;
  return shell('Buy a plan: Content Engine', `
<style>
 form.buy{display:grid;gap:.9rem;margin-top:1rem}
 form.buy label{display:grid;gap:.3rem;font-size:.92rem;color:#c7c7d9}
 form.buy input,form.buy select{background:#13131f;border:1px solid #2a2a44;color:#e8e8ef;border-radius:8px;padding:.6rem .7rem;font:inherit}
 .two{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.9rem}
 .sum{background:#13131f;border:1px solid #24243a;border-radius:10px;padding:.8rem 1rem}
 .sum p{margin:.15rem 0}.sum .tot{font-weight:700;font-size:1.05rem}
 .pay{background:#2d6cdf;color:#fff;border:0;border-radius:8px;padding:.75rem 1.2rem;font-weight:700;font-size:1rem;cursor:pointer}
 .pay[disabled]{opacity:.5;cursor:not-allowed}
 .hint{color:#9a9ab0;font-size:.86rem;margin:0}.warn{color:#ffd479}.err{color:#ff9a9a}
 .done{background:#10241a;border:1px solid #1f5a3a;border-radius:10px;padding:1rem}
 code{background:#0b0b12;border:1px solid #2a2a44;border-radius:6px;padding:.15rem .4rem;font-size:1rem}
</style>
<h1>Buy a plan</h1>
<p class="sub">Pay once a month or once a year; it renews until you cancel (one click, in the app, under Plan). Your workspace is ready as soon as you pay.</p>
${closed}
<div id="buy">
<form class="buy" id="f" onsubmit="return go(event)">
  <div class="two">
    <label>Plan<select name="plan" id="plan" onchange="sum()">${BUYABLE.map((id) => opt(id, PLANS[id].label, id === p)).join('')}</select></label>
    <label>Billing<select name="bill" id="bill" onchange="sum()">${opt('mo', 'Monthly', b === 'mo')}${opt('yr', 'Yearly: 12 months for the price of 10', b === 'yr')}</select></label>
  </div>
  <label>Where is your business billed?<select name="country" id="country" onchange="sum()">${Object.entries(COUNTRIES).map(([v, l]) => opt(v, v === 'IN' ? 'India: rupees, 18% GST added' : 'Outside India: US dollars, no GST', v === country)).join('')}</select></label>
  <div class="two">
    <label>Your name<input name="name" required maxlength="80" autocomplete="name"></label>
    <label>Business name<input name="business" maxlength="80" autocomplete="organization"></label>
  </div>
  <div class="two">
    <label>Email (your sign-in)<input name="email" type="email" required maxlength="120" autocomplete="email"></label>
    <label>Phone with country code<input name="phone" required maxlength="20" placeholder="+91 98765 43210" autocomplete="tel"></label>
  </div>
  <label id="gstrow">GSTIN (optional, for a GST invoice you can claim)<input name="gstin" maxlength="15" placeholder="22AAAAA0000A1Z5"></label>
  <div class="sum" id="sum"></div>
  <p class="hint">By paying you agree to the <a href="/terms">terms</a> and the <a href="/refund">refund policy</a> (no refunds; cancel any time and it stops at the end of the period you paid for).</p>
  <p id="msg" class="err" role="alert"></p>
  <div><button class="pay" id="paybtn" type="submit"${ready ? '' : ' disabled'}>Pay</button></div>
</form>
</div>
<script>
var PRICES=${JSON.stringify(priceLines()).replace(/</g, '\\u003c')};
var READY=${ready ? 'true' : 'false'};
function el(id){return document.getElementById(id);}
(function(){var c=el('country');if(!${country ? 'true' : 'false'}){var s='';try{s=localStorage.getItem('ce_cur')||'';}catch(e){}if(s==='inr')c.value='IN';else if(s==='usd')c.value='XX';else{var tz='';try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'';}catch(e){}c.value=/^Asia\\/(Kolkata|Calcutta)$/.test(tz)?'IN':'XX';}}sum();})();
function sum(){var k=el('plan').value+':'+el('bill').value+':'+el('country').value;var q=PRICES[k];if(!q)return;el('sum').innerHTML=q.lines.map(function(l,i){return '<p'+(i===q.lines.length-1?' class="tot"':'')+'>'+l+'</p>';}).join('');el('paybtn').textContent='Pay '+q.pay;el('gstrow').style.display=el('country').value==='IN'?'':'none';}
function loadRzp(){return new Promise(function(ok,bad){if(window.Razorpay)return ok();var s=document.createElement('script');s.src='https://checkout.razorpay.com/v1/checkout.js';s.onload=ok;s.onerror=function(){bad(new Error('The payment window did not load. Check your connection and try again.'));};document.body.appendChild(s);});}
async function post(u,b){var r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});var j=await r.json().catch(function(){return {ok:false,error:'Something went wrong'};});if(!j.ok)throw new Error(j.error||'Something went wrong');return j;}
async function go(e){e.preventDefault();var m=el('msg');m.textContent='';if(!READY)return false;var btn=el('paybtn');btn.disabled=true;
 try{var f=el('f');var body={};new FormData(f).forEach(function(v,k){body[k]=v;});if(body.country!=='IN')body.gstin='';
  var s=await post('${BUY_PATH}/start',body);await loadRzp();
  var rz=new window.Razorpay({key:s.keyId,subscription_id:s.subscriptionId,name:'Content Engine',description:s.description,prefill:s.prefill,theme:{color:'#2d6cdf'},
   handler:function(r){done({paymentId:r.razorpay_payment_id,subscriptionId:r.razorpay_subscription_id,signature:r.razorpay_signature},0);},
   modal:{ondismiss:function(){btn.disabled=false;}}});
  rz.on('payment.failed',function(r){m.textContent=(r&&r.error&&r.error.description)||'The payment did not go through. Try again.';btn.disabled=false;});
  rz.open();
 }catch(err){m.textContent=err.message;btn.disabled=false;}
 return false;}
async function done(p,tries){var box=el('buy');
 try{var j=await post('${BUY_PATH}/confirm',p);
  if(!j.tenant){if(tries<6){box.innerHTML='<div class="done"><p>🟢 Paid. Making your workspace...</p></div>';return setTimeout(function(){done(p,tries+1);},3000);}throw new Error('Paid, but the workspace is still being made. Write to us with payment id '+p.paymentId+'.');}
  var pw=j.tempPassword?'<p>One-time password: <code>'+j.tempPassword.replace(/[<>&]/g,'')+'</code></p><p class="hint">Copy it now: it is shown once. You choose your own password at your first sign-in.</p>':'<p class="hint">Sign in with this email. If you do not have the password, write to us with payment id '+p.paymentId+'.</p>';
  box.innerHTML='<div class="done"><h2>🟢 Paid. Your workspace is ready.</h2><p>Sign-in email: <b>'+String(j.email).replace(/[<>&]/g,'')+'</b></p>'+pw+'<p><a class="btn" href="${LOGIN_PATH}">Sign in</a></p></div>';
 }catch(err){box.insertAdjacentHTML('afterbegin','<p class="err">'+String(err.message).replace(/[<>&]/g,'')+'</p>');}}
</script>`);
}

export default { buyPage };
