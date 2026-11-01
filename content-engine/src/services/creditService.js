/**
 * Daily router — Lane 2 credit check.
 *
 * Purpose:      Before the router spends anything on an AI video, find out
 *               whether Lane 2 can deliver: a video provider with credit (in
 *               the funnel's order: Kling / Runway / Hailuo), plus the
 *               ElevenLabs narrator voice, an image API, the LLM and the GitHub
 *               assembly (docs/daily-router-plan.md, Lane 2 step 1).
 * Responsibility:
 *               - check: read what can be read, decide with routerSpec.
 *                 Balance APIs used (checked against each provider's docs,
 *                 01-11-2026):
 *                   Runway     GET /v1/organization → creditBalance
 *                   Kling      GET /account/costs → resource packs' remaining
 *                              quantity (its response fields are not public;
 *                              parsed leniently, unreadable = unknown)
 *                   ElevenLabs GET /v1/user/subscription → character_limit − character_count
 *                 Hailuo/MiniMax, OpenAI and Gemini have no balance API: they
 *                 count as OK until one refuses with an "out of credit" error,
 *                 which markExhausted records for the rest of the IST day.
 *               - noteVerdict: the once-per-dry-spell email (resets when Lane 2
 *                 can run again).
 *               - status: the last check, for the Keys and credit page.
 *               State lives in tenant_config key router_credit (JSON).
 * Dependencies: tenantConfigRepository, driveConnectService, providerFactory,
 *               core/httpClient, utils/{routerSpec,animationSpec,time}, logger.
 */
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as driveConnect from './driveConnectService.js';
import { buildProviders } from './providerFactory.js';
import { request } from '../core/httpClient.js';
import { signKlingToken } from '../utils/animationSpec.js';
import { providerOrder, creditState, laneTwoVerdict, dryTransition, VIDEO_PROVIDERS } from '../utils/routerSpec.js';
import { todayKeyIst, formatIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'credit' });
const STORE = 'router_credit';

async function load(tenantId) {
  try {
    return JSON.parse((await tenantConfig.get(tenantId, STORE)) || '{}') || {};
  } catch {
    return {};
  }
}

async function save(tenantId, state) {
  await tenantConfig.set(tenantId, STORE, JSON.stringify(state));
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Runway's credit balance, or null when unreadable. */
async function runwayBalance(apiKey) {
  const res = await request('https://api.dev.runwayml.com/v1/organization', {
    headers: { Authorization: `Bearer ${apiKey}`, 'X-Runway-Version': '2024-11-06' }, label: 'runway.balance', log, retries: 0, timeoutMs: 10000,
  });
  return res.ok ? num(res.data && res.data.creditBalance) : null;
}

/** Kling's remaining resource-pack quantity (live packs), or null when unreadable. */
async function klingBalance(accessKey, secretKey) {
  const end = Date.now();
  const q = new URLSearchParams({ start_time: String(end - 90 * 86400000), end_time: String(end) });
  const res = await request(`https://api.klingai.com/account/costs?${q}`, {
    headers: { Authorization: `Bearer ${signKlingToken(accessKey, secretKey)}` }, label: 'kling.balance', log, retries: 0, timeoutMs: 10000,
  });
  const packs = res.ok && res.data && res.data.data && res.data.data.resource_pack_subscribe_infos;
  if (!Array.isArray(packs)) return null;
  return packs
    .filter((p) => !/expired|runout|run_out|used/i.test(String(p.status || '')))
    .reduce((t, p) => t + (num(p.remaining_quantity) || 0), 0);
}

/** ElevenLabs characters left this billing period, or null when unreadable. */
async function elevenlabsLeft(apiKey) {
  const res = await request('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': apiKey }, label: 'elevenlabs.balance', log, retries: 0, timeoutMs: 10000,
  });
  if (!res.ok || !res.data) return null;
  const limit = num(res.data.character_limit);
  const used = num(res.data.character_count);
  return limit === null || used === null ? null : Math.max(0, limit - used);
}

const safe = (p) => p.catch((err) => {
  log.warn({ err: err.message }, 'balance read failed (counted as unknown)');
  return null;
});

/**
 * Can Lane 2 run for this funnel now? funnelCfg is the raw funnel_config map
 * (video_provider_order, animation_provider, voice_id, tts_provider).
 * Returns { ok, provider, missing, order, video: {p: state}, deps: {k: state}, at }.
 */
export async function check({ tenantId = 'default', funnelCfg = {} } = {}) {
  const providers = await buildProviders(tenantId);
  const r = providers.resolved || {};
  const a = r.animation || {};
  const state = await load(tenantId);
  const ex = state.exhausted || {};
  const today = todayKeyIst();
  const order = providerOrder(funnelCfg.video_provider_order, funnelCfg.animation_provider);

  const keys = {
    kling: !!(a.klingAccessKey && a.klingSecretKey),
    runway: !!a.runwayApiKey,
    hailuo: !!(a.hailuoApiKey && a.hailuoGroupId),
  };
  const [kling, runway, voiceLeft, drive] = await Promise.all([
    keys.kling && ex.kling !== today ? safe(klingBalance(a.klingAccessKey, a.klingSecretKey)) : null,
    keys.runway && ex.runway !== today ? safe(runwayBalance(a.runwayApiKey)) : null,
    r.tts?.elevenlabsApiKey ? safe(elevenlabsLeft(r.tts.elevenlabsApiKey)) : null,
    driveConnect.status(tenantId).catch(() => ({ connected: false })),
  ]);
  const balances = { kling, runway, hailuo: null };
  const video = Object.fromEntries(VIDEO_PROVIDERS.map((p) => [p, creditState({ configured: keys[p], balance: balances[p], exhaustedOn: ex[p], today })]));

  const voice = creditState({ configured: !!(r.tts?.elevenlabsApiKey && funnelCfg.voice_id), balance: voiceLeft, exhaustedOn: ex.voice, today });
  if (r.tts?.elevenlabsApiKey && !funnelCfg.voice_id) voice.note = 'no voice picked on this funnel';
  const deps = {
    voice,
    image: creditState({ configured: !!(r.openai?.apiKey || r.gemini?.apiKey), exhaustedOn: ex.image, today }),
    llm: creditState({ configured: !!(r.openai?.apiKey || r.gemini?.apiKey), exhaustedOn: ex.llm, today }),
    assembly: (drive && drive.connected && r.clean?.githubToken)
      ? { ok: true, state: 'ok', note: 'Drive connected, GitHub token set' }
      : { ok: false, state: 'missing', note: !(drive && drive.connected) ? 'Google Drive not connected' : 'no GitHub token' },
  };
  const verdict = laneTwoVerdict({ order, video, deps });
  const out = { ...verdict, order, video, deps, at: new Date().toISOString() };
  await save(tenantId, { ...(await load(tenantId)), last: out }).catch(() => {});
  return out;
}

/** A provider said "out of credit": skip it for the rest of the IST day. */
export async function markExhausted(tenantId = 'default', key) {
  if (!key) return;
  const state = await load(tenantId);
  state.exhausted = { ...(state.exhausted || {}), [key]: todayKeyIst() };
  await save(tenantId, state);
  log.warn({ tenantId, key }, 'marked out of credit for today');
}

/**
 * Record whether Lane 2 could run. Sends ONE email when it just went dry
 * (naming what is out); nothing more until it has run again.
 */
export async function noteVerdict(tenantId = 'default', verdict = {}) {
  const state = await load(tenantId);
  const { send, next } = dryTransition(state.dry, !!verdict.ok);
  await save(tenantId, { ...state, dry: next });
  if (!send) return false;
  try {
    const providers = await buildProviders(tenantId);
    const to = providers.resolved?.emails?.notify || providers.resolved?.emails?.approvalGita || '';
    if (!to) return false;
    const list = (verdict.missing || []).map((m) => `<li>${String(m).replace(/[&<>]/g, '')}</li>`).join('');
    await providers.mail.send({
      to,
      subject: '🟡 AI video lane is out of credit',
      html: `<p>The daily router could not make an AI video (${formatIst(new Date())} IST). Out or not set up:</p><ul>${list}</ul>
        <p>Image posts fill in until it's topped up. You get this email once; it resets when an AI video can run again.</p>
        <p>Status: Setup → Keys and credit.</p>`,
    });
    return true;
  } catch (err) {
    log.warn({ err: err.message }, 'dry-spell email failed');
    return false;
  }
}

/** The last check (for the Keys and credit page), or null. */
export async function status(tenantId = 'default') {
  const state = await load(tenantId);
  return state.last ? { ...state.last, dry: state.dry || null } : null;
}

export default { check, markExhausted, noteVerdict, status };
