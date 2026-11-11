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
import { PLANS, MAX_UNITS, MAX_EXTRA_USERS } from './planSpec.js';
import { BUYABLE, PERIODS, COUNTRIES, unitPrices, BUY_PATH } from './billingSpec.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buyPage({ plan = 'brand', bill = 'mo', cur = '', units = '', ready = false, email = '' } = {}) {
  const p = BUYABLE.includes(plan) ? plan : 'brand';
  const n = Math.min(MAX_UNITS, Math.max(1, Math.floor(Number(units)) || 1));
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
    <label>Plan<select name="plan" id="plan" onchange="sum()">${BUYABLE.map((id) => opt(id, PLANS[id].perUnit === 'client' ? 'Agency: priced per client' : `${PLANS[id].label}: priced per funnel (brand)`, id === p)).join('')}</select></label>
    <label>Billing<select name="bill" id="bill" onchange="sum()">${opt('mo', 'Monthly', b === 'mo')}${opt('yr', 'Yearly: 12 months for the price of 10', b === 'yr')}</select></label>
  </div>
  <div class="two">
    <label><span id="unitlab">Funnels (brands), 10 channels each</span><input name="units" id="units" type="number" min="1" max="${MAX_UNITS}" value="${n}" required oninput="sum()"></label>
    <label>Extra users (1 user is included${p === 'agency' ? ', plus one per client' : ''})<input name="users" id="users" type="number" min="0" max="${MAX_EXTRA_USERS}" value="0" oninput="sum()"></label>
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
var P=${JSON.stringify(unitPrices()).replace(/</g, '\\u003c')};
var READY=${ready ? 'true' : 'false'};
function el(id){return document.getElementById(id);}
(function(){var c=el('country');if(!${country ? 'true' : 'false'}){var s='';try{s=localStorage.getItem('ce_cur')||'';}catch(e){}if(s==='inr')c.value='IN';else if(s==='usd')c.value='XX';else{var tz='';try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'';}catch(e){}c.value=/^Asia\\/(Kolkata|Calcutta)$/.test(tz)?'IN':'XX';}}sum();})();
function grp(n){var s=String(Math.round(n));if(s.length<=3)return s;return s.slice(0,-3).replace(/\\B(?=(\\d{2})+(?!\\d))/g,',')+','+s.slice(-3);}
function cash(n,inr){if(inr)return '\u20b9'+grp(n);var c=Math.round(n*100);return '$'+String(Math.floor(c/100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',')+(c%100?'.'+String(c%100).padStart(2,'0'):'');}
function whole(id,lo,hi){var v=Math.floor(Number(el(id).value));return v>=lo&&v<=hi?v:lo;}
function sum(){var pl=P.plans[el('plan').value];if(!pl)return;var inr=el('country').value==='IN';var yr=el('bill').value==='yr';
 el('unitlab').textContent=pl.per==='client'?'Clients, each its own workspace, 10 channels':'Funnels (brands), 10 channels each';
 var n=whole('units',1,P.maxUnits),u=whole('users',0,P.maxUsers);var unit=inr?pl.inr:pl.usd,user=inr?P.user.inr:P.user.usd;
 var month=unit*n+user*u;var times=yr?10:1;var base=inr?Math.round(month*times):Math.round(month*times*100)/100;var gst=inr?Math.round(base*1.18)-base:0;var total=base+gst;var per=yr?'year':'month';
 var lines=[n+' '+(pl.per==='client'?(n===1?'client':'clients'):(n===1?'funnel':'funnels'))+' x '+cash(unit*times,inr)];
 if(u)lines.push(u+' extra user'+(u===1?'':'s')+' x '+cash(user*times,inr));
 lines.push(inr?'18% GST: '+cash(gst,true):'No GST outside India');
 lines.push('Total: '+cash(total,inr)+' a '+per+', renews '+(yr?'yearly':'monthly'));
 el('sum').innerHTML=lines.map(function(l,i){return '<p'+(i===lines.length-1?' class="tot"':'')+'>'+l+'</p>';}).join('');el('paybtn').textContent='Pay '+cash(total,inr);el('gstrow').style.display=inr?'':'none';}
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
