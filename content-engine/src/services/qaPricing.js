/**
 * QA phase 7: pricing and online payment (Always-On Brand, 11-11-2026).
 *
 * Purpose:      Prove on the live server that the one-plan pricing holds:
 *               every plan on sale keeps at least 50% margin, quotes add up in
 *               both currencies, the database has the new columns, limits scale
 *               with the funnels or clients bought, an Agency bought per client
 *               runs on the owner's AI keys while a flat one does not, a plan
 *               change (Solo) lands on the workspace, and the public pages and
 *               payment doors show and refuse the right things.
 * Responsibility: pricingChecks(port) -> check rows; the fixtures it needs.
 * Dependencies: planSpec, billingSpec, billingService (applyPlanKey, ready),
 *               planService, tenantSettings, tenantRepository, core/db, planPage.
 *
 * Fixtures (no sign-in, made once, never posting): qa-pricing-brand (2 funnels,
 * 1 extra user), qa-pricing-agency (2 clients) with clients -c1 and -c2.
 * Nothing is paid and no Razorpay subscription is opened: /buy/start is only
 * called while online payment is closed (it refuses before Razorpay).
 */
import { query } from '../core/db.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as tenantSettings from '../core/tenantSettings.js';
import * as planService from './planService.js';
import * as billing from './billingService.js';
import { PLANS, EXTRAS, limitsForTenant } from '../utils/planSpec.js';
import { lowestMargin, FEE_KEEP } from '../utils/marginSpec.js';
import { quote, planKey, readPlanKey, describe, BUYABLE, CHARGEABLE } from '../utils/billingSpec.js';
import { planBody, soloOffer } from '../utils/planPage.js';

const G = 'Phase 7 pricing';
const check = (name, status, detail = '') => ({ group: G, name, status, detail: String(detail || '') });
const errText = (err) => String((err && err.message) || err || 'failed').slice(0, 240);

export const BRAND_ID = 'qa-pricing-brand';
export const AGENCY_ID = 'qa-pricing-agency';

async function fixture(id, { plan, units = null, extraUsers = 0, parentId = null }) {
  let row = await tenantRepo.findById(id);
  if (!row) row = await tenantRepo.createNew({ id, name: `QA ${id.replace(/^qa-/, '')}`, ownerEmail: '', plan, expiresAt: null, parentId, units, extraUsers });
  if (!parentId && (row.plan !== plan || (row.units ?? null) !== units || (Number(row.extra_users) || 0) !== extraUsers)) {
    await tenantRepo.setPlanUnits(id, plan, units, extraUsers);
  }
  return row;
}

function marginChecks() {
  const out = [];
  for (const plan of CHARGEABLE) {
    for (const cur of ['INR', 'USD']) {
      const m = lowestMargin(plan, cur);
      out.push(check(`Margin: ${PLANS[plan].label} in ${cur}`, m >= 0.5 ? 'ok' : 'fail', `lowest ${(m * 100).toFixed(1)}% (yearly is 10 months for 12)`));
    }
  }
  const user = (EXTRAS.user.inr * 10) / 12 * FEE_KEEP.INR / ((EXTRAS.user.inr * 10) / 12);
  out.push(check('Margin: extra user', user >= 0.5 ? 'ok' : 'fail', `about ${(user * 100).toFixed(0)}%: a login costs nothing to run`));
  return out;
}

function quoteChecks() {
  const out = [];
  const cases = [
    ['1 funnel, India, monthly', { plan: 'brand', country: 'IN' }, 365700, '₹3,657'],
    ['3 funnels + 2 users, India, yearly', { plan: 'brand', bill: 'yr', country: 'IN', units: 3, users: 2 }, Math.round((3099 * 3 + 200) * 10 * 1.18) * 100, ''],
    ['4 clients + 1 user, outside India, monthly', { plan: 'agency', country: 'XX', units: 4, users: 1 }, 18150, '$181.50'],
    ['Solo, India, monthly', { plan: 'solo', country: 'IN' }, Math.round(1699 * 1.18) * 100, ''],
  ];
  for (const [name, input, amount, text] of cases) {
    try {
      const q = quote(input);
      const back = readPlanKey(planKey(q));
      const good = q.amount === amount && back.plan === q.plan && back.units === q.units && back.users === q.users && (!text || describe(q).includes(text));
      out.push(check(`Quote: ${name}`, good ? 'ok' : 'fail', `${describe(q)}; charge ${q.amount} in the smallest unit`));
    } catch (err) { out.push(check(`Quote: ${name}`, 'fail', errText(err))); }
  }
  const refused = [['custom', {}], ['lite', {}], ['brand', { units: 0 }], ['agency', { units: 51 }], ['brand', { users: 99 }]]
    .filter(([plan, extra]) => { try { quote({ plan, ...extra }); return true; } catch { return false; } });
  out.push(check('Quote: refuses what is not on sale', refused.length ? 'fail' : 'ok', refused.length ? `allowed: ${refused.map((r) => r[0]).join(', ')}` : 'Custom, old plans, 0 or 51 units, 99 users all refused'));
  out.push(check('On sale', BUYABLE.join() === 'brand,agency' && !BUYABLE.includes('solo') ? 'ok' : 'fail', `buy page: ${BUYABLE.join(', ')}; Solo only from the cancel page`));
  return out;
}

async function schemaChecks() {
  const want = [['tenants', 'units'], ['tenants', 'extra_users'], ['checkouts', 'units'], ['checkouts', 'extra_users']];
  const { rows } = await query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND ((table_name = 'tenants' AND column_name IN ('units', 'extra_users')) OR (table_name = 'checkouts' AND column_name IN ('units', 'extra_users')))`,
  );
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = want.map(([t, c]) => `${t}.${c}`).filter((k) => !have.has(k));
  return [check('Database: units columns (migration 030)', missing.length ? 'fail' : 'ok', missing.length ? `missing ${missing.join(', ')}` : 'tenants and checkouts have units and extra_users')];
}

async function limitChecks() {
  const out = [];
  await fixture(BRAND_ID, { plan: 'brand', units: 2, extraUsers: 1 });
  planService.invalidate();
  const info = await planService.tenantInfo(BRAND_ID);
  const lim = limitsForTenant(info.plan, { units: info.units, extraUsers: info.extraUsers });
  out.push(check('Limits: 2 funnels + 1 user read back', lim.funnels === 2 && lim.posts === 60 && lim.users === 2 && lim.channels === 10 ? 'ok' : 'fail',
    `funnels ${lim.funnels}, posts ${lim.posts}, users ${lim.users}, channels ${lim.channels} per funnel`));
  const rows = [['funnels', 1, 2], ['posts', 59, 60], ['users', 1, 2]];
  for (const [what, under, full] of rows) {
    const okUnder = await planService.limitReason(BRAND_ID, what, { used: under, adding: 1 });
    const okFull = await planService.limitReason(BRAND_ID, what, { used: full, adding: 1 });
    out.push(check(`Limits: ${what}`, !okUnder && okFull ? 'ok' : 'fail', `${under + 1} ${okUnder ? 'refused' : 'allowed'}, ${full + 1} ${okFull ? `refused ("${okFull.slice(0, 80)}")` : 'allowed'}`));
  }

  await fixture(AGENCY_ID, { plan: 'agency', units: 2 });
  await fixture(`${AGENCY_ID}-c1`, { plan: 'agency', parentId: AGENCY_ID });
  await fixture(`${AGENCY_ID}-c2`, { plan: 'agency', parentId: AGENCY_ID });
  planService.invalidate();
  const third = await planService.clientReason(AGENCY_ID);
  out.push(check('Agency per client: a 3rd client on 2 bought', third ? 'ok' : 'fail', third ? `refused ("${third.slice(0, 80)}")` : 'allowed'));
  const ainfo = await planService.tenantInfo(`${AGENCY_ID}-c1`);
  const alim = limitsForTenant(ainfo.plan, { units: ainfo.units, extraUsers: ainfo.extraUsers });
  out.push(check('Agency per client: pooled limits', alim.posts === 60 && alim.clients === 2 && alim.users === 3 && ainfo.pool.length === 3 ? 'ok' : 'fail',
    `posts ${alim.posts} across ${ainfo.pool.length} workspaces, clients ${alim.clients}, users ${alim.users}`));
  return out;
}

async function keyChecks() {
  const out = [];
  tenantSettings.invalidate();
  const owner = await tenantSettings.forTenant('default');
  const paidOwner = Object.entries(owner.keyOwners || {}).filter(([p, w]) => w === 'platform' && ['openai', 'anthropic', 'elevenlabs'].includes(p)).map(([p]) => p);
  if (!paidOwner.length) return [check('AI keys: per-client agency', 'skip', 'the owner has no OpenAI, Claude or ElevenLabs key to share')];
  const kid = await tenantSettings.forTenant(`${AGENCY_ID}-c1`);
  const head = await tenantSettings.forTenant(AGENCY_ID);
  const onOwner = (s) => paidOwner.filter((p) => (s.keyOwners || {})[p] === 'platform');
  out.push(check('AI keys: agency bought per client', onOwner(head).length === paidOwner.length ? 'ok' : 'fail', `on the owner's keys: ${onOwner(head).join(', ') || 'none'} (AI is in its price)`));
  out.push(check('AI keys: its client', onOwner(kid).length === paidOwner.length ? 'ok' : 'fail', `on the owner's keys: ${onOwner(kid).join(', ') || 'none'}`));
  const flat = await tenantRepo.findById('qa-agency');
  if (flat && !flat.units) {
    const flatKid = (await tenantRepo.childrenOf('qa-agency').catch(() => []))[0];
    const fs = await tenantSettings.forTenant(flatKid ? String(flatKid.id) : 'qa-agency');
    const leak = onOwner(fs);
    out.push(check('AI keys: flat agency still brings its own', leak.length ? 'fail' : 'ok', leak.length ? `uses the owner's ${leak.join(', ')}` : 'never on the owner\'s keys'));
  } else {
    out.push(check('AI keys: flat agency still brings its own', 'skip', 'no flat qa-agency fixture yet (run the QA check on qa-agency once)'));
  }
  return out;
}

async function soloChecks() {
  const out = [];
  try {
    const q = quote({ plan: 'solo', country: 'IN' });
    const moved = await billing.applyPlanKey(BRAND_ID, planKey(q));
    let t = await tenantRepo.findById(BRAND_ID);
    out.push(check('Solo: a charge on the Solo plan moves the workspace', moved && t.plan === 'solo' && t.units === null && Number(t.extra_users) === 0 ? 'ok' : 'fail', `now ${t.plan}, units ${t.units}`));
    planService.invalidate();
    const funnels = await planService.limitReason(BRAND_ID, 'funnels', { used: 1, adding: 1 });
    out.push(check('Solo: 1 funnel, 5 channels', funnels && limitsForTenant('solo').channels === 5 ? 'ok' : 'fail', funnels ? 'a 2nd funnel is refused' : 'a 2nd funnel is allowed'));
    const back = await billing.applyPlanKey(BRAND_ID, planKey(quote({ plan: 'brand', country: 'IN', units: 2, users: 1 })));
    t = await tenantRepo.findById(BRAND_ID);
    out.push(check('Solo: and back to 2 funnels', back && t.plan === 'brand' && t.units === 2 ? 'ok' : 'fail', `now ${t.plan}, units ${t.units}, extra users ${t.extra_users}`));
    const noop = await billing.applyPlanKey(BRAND_ID, 'junk:key');
    out.push(check('Solo: an unknown plan key changes nothing', noop ? 'fail' : 'ok', noop ? 'changed' : 'ignored'));
  } catch (err) { out.push(check('Solo: plan change', 'fail', errText(err))); }
  const t = { id: 'x', name: 'x', plan: 'brand', units: 1, billing_sub_id: 'sub_qa', billing_currency: 'INR', expires_at: new Date() };
  const page = planBody({ tenant: t, role: 'admin' });
  const offerFirst = page.includes('Before you go: Solo') && page.indexOf('Before you go') < page.indexOf('Cancel my plan');
  out.push(check('Solo: offered just before Cancel', offerFirst && !soloOffer({ ...t, plan: 'solo' }) && !soloOffer({ ...t, parent_id: 'a' }) ? 'ok' : 'fail', 'shown before Cancel; never to a Solo workspace or an agency client'));
  return out;
}

async function httpChecks(port) {
  const base = `http://127.0.0.1:${port}`;
  const out = [];
  const get = async (path) => { const r = await fetch(base + path, { signal: AbortSignal.timeout(15_000) }); return { status: r.status, text: await r.text() }; };
  const post = async (path, body, headers = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return { status: r.status, text: await r.text().catch(() => '') };
  };
  const page = async (name, path, must, mustNot = []) => {
    try {
      const r = await get(path);
      const miss = must.filter((m) => !r.text.includes(m));
      const bad = mustNot.filter((m) => r.text.includes(m));
      out.push(check(`Page: ${name}`, r.status === 200 && !miss.length && !bad.length ? 'ok' : 'fail',
        r.status !== 200 ? `answered ${r.status}` : miss.length ? `missing: ${miss.join(' | ')}` : bad.length ? `should not show: ${bad.join(' | ')}` : 'shows the offer'));
    } catch (err) { out.push(check(`Page: ${name}`, 'fail', errText(err))); }
  };
  await page('home pricing', '/', ['Always-On Brand', '₹3,099<small> + GST / month per funnel', '₹3,899<small> + GST / month per client', '$36<small> / month per funnel', '₹21,780+', '$257+', 'Founding price', 'data-buy="brand"', 'data-buy="agency"'],
    ['Starter Lite', 'data-buy="growth"', 'data-buy="solo"', String.fromCharCode(0x2014)]);
  await page('buy page', '/buy?plan=agency&units=3', ['<option value="agency" selected>', 'value="3"', '"brand":{"inr":3099,"usd":36', 'Extra users'], ['<option value="solo"']);
  await page('buy page ignores Solo', '/buy?plan=solo', ['<option value="brand" selected>'], ['<option value="solo"']);
  await page('compare', '/compare', ['₹3,099 + GST'], ['Starter Lite ₹999']);

  const open = await billing.ready().catch(() => false);
  if (open) {
    out.push(check('Door: buy start', 'skip', 'online payment is open: not starting a real Razorpay subscription from QA'));
  } else {
    try {
      const r = await post('/buy/start', { plan: 'brand', units: 1, bill: 'mo', country: 'IN', name: 'QA', email: 'qa@example.invalid', phone: '+919999999999' });
      out.push(check('Door: buy start while closed', r.status === 400 && /not open yet/.test(r.text) ? 'ok' : 'fail', `answered ${r.status}: ${r.text.slice(0, 100)}`));
    } catch (err) { out.push(check('Door: buy start while closed', 'fail', errText(err))); }
  }
  try {
    const r = await post('/buy/webhook', { event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_qa' } } } }, { 'X-Razorpay-Signature': 'qa-wrong' });
    out.push(check('Door: webhook with a wrong signature', r.status === 400 ? 'ok' : 'fail', `answered ${r.status}`));
  } catch (err) { out.push(check('Door: webhook with a wrong signature', 'fail', errText(err))); }
  try {
    const r = await post('/api/v1/admin/plan/solo', {});
    const away = r.status === 401 || r.status === 403 || r.status === 302 || r.status === 303;
    out.push(check('Door: Solo switch as a stranger', away ? 'ok' : 'fail', `answered ${r.status}`));
  } catch (err) { out.push(check('Door: Solo switch as a stranger', 'fail', errText(err))); }
  return out;
}

/** Every pricing check. Never throws: a broken step is a failed row. */
export async function pricingChecks(port) {
  const out = [...marginChecks(), ...quoteChecks()];
  for (const step of [schemaChecks, limitChecks, keyChecks, soloChecks]) {
    try { out.push(...(await step())); } catch (err) { out.push(check(`Step ${step.name}`, 'fail', errText(err))); }
  }
  try { out.push(...(await httpChecks(port))); } catch (err) { out.push(check('HTTP', 'fail', errText(err))); }
  planService.invalidate();
  tenantSettings.invalidate();
  return out;
}

export default { pricingChecks, BRAND_ID, AGENCY_ID };
