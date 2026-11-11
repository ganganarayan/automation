/**
 * QA check: the app tests itself where it really runs (Railway), as a QA tenant.
 *
 * Purpose:      One button that proves, on the live machine, what unit tests cannot:
 *               ffmpeg and the fonts are there, the database answers, a tenant only
 *               sees its own things, its keys come from the right owner, plan limits
 *               hold, and (optionally, a few cents) the real paid providers answer.
 * Responsibility:
 *               - createQaTenant({ id, plan }): a qa-* workspace with no sign-in
 *                 (the super admin works in it through /t/<id>/...)
 *               - run(tenantId, { paid }): { tenant, plan, verdict, checks, spentUsd }
 * Dependencies: tenantSettings, providerFactory, planService, qaPhases (one group per phase), utils/qaSpec,
 *               utils/pricing, middleware/tenantGuard (the real record decision).
 *
 * Nothing here posts, emails or changes a funnel. Paid calls go to the usage ledger
 * as source "qa check", so the AI cost box shows them on the QA tenant.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tenantSettings from '../core/tenantSettings.js';
import { settings } from '../settings/index.js';
import { ping } from '../core/db.js';
import { buildProviders } from './providerFactory.js';
import * as planService from './planService.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as usage from '../repositories/usageRepository.js';
import * as phases from './qaPhases.js';
import * as qaAgency from './qaAgency.js';
import { PLAN_IDS } from '../utils/planSpec.js';
import { costClaude, costText, costImages } from '../utils/pricing.js';
import { probeMp4DurationSeconds } from '../utils/videoSpec.js';
import { isQaTenant, qaTenantId, verdict } from '../utils/qaSpec.js';

const exec = promisify(execFile);
const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg';
const TIMEOUT = 20_000;

/** A qa-* workspace with no owner sign-in. Fails if the id is taken. */
export async function createQaTenant({ id, plan = 'starter' } = {}) {
  const tid = qaTenantId(id);
  if (!tid) throw new Error('QA workspace id: qa- then letters, digits or dashes');
  const p = PLAN_IDS.includes(String(plan)) ? String(plan) : 'starter';
  const row = await tenantRepo.createNew({ id: tid, name: `QA ${p}`, ownerEmail: '', plan: p, expiresAt: null });
  tenantSettings.invalidate();
  planService.invalidate();
  return row;
}

const check = (group, name, status, detail = '') => ({ group, name, status, detail: String(detail || '') });
const errText = (err) => String((err && err.message) || err || 'failed').slice(0, 240);

async function timed(fn) {
  return Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), TIMEOUT * 3))]);
}

// ---- the machine itself -------------------------------------------------------

async function machineChecks() {
  const out = [];
  try { await ping(); out.push(check('Machine', 'Database', 'ok', 'answers')); } catch (err) { out.push(check('Machine', 'Database', 'fail', errText(err))); }
  try {
    const { stdout } = await exec(ffmpegBin(), ['-hide_banner', '-version'], { timeout: TIMEOUT });
    out.push(check('Machine', 'ffmpeg', 'ok', String(stdout).split('\n')[0].slice(0, 80)));
  } catch (err) { out.push(check('Machine', 'ffmpeg', 'fail', `not found or broken: ${errText(err)}`)); }
  try {
    const { stdout } = await exec('fc-list', [':', 'family'], { timeout: TIMEOUT });
    const fams = String(stdout);
    const latin = /Noto Sans/i.test(fams);
    const deva = /Devanagari/i.test(fams);
    out.push(check('Machine', 'Fonts', latin && deva ? 'ok' : 'fail', `Noto Sans ${latin ? 'yes' : 'missing'}, Devanagari ${deva ? 'yes' : 'missing'}`));
  } catch (err) { out.push(check('Machine', 'Fonts', 'warn', `could not list fonts: ${errText(err)}`)); }
  try {
    const sharp = (await import('sharp')).default;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160"><rect width="100%" height="100%" fill="#fff"/><text x="20" y="100" font-family="Noto Sans, Noto Sans Devanagari" font-size="64" fill="#000">QA test नमस्ते</text></svg>';
    const { data, info } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true });
    let dark = 0;
    for (let i = 0; i < data.length; i += 1) if (data[i] < 128) dark += 1;
    const share = dark / (info.width * info.height);
    out.push(check('Machine', 'Text on pictures', share > 0.01 ? 'ok' : 'fail', `${(share * 100).toFixed(1)}% of the test card is ink`));
  } catch (err) { out.push(check('Machine', 'Text on pictures', 'fail', errText(err))); }
  return out;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text().catch(() => '');
  return { status: res.status, text };
}

/** A short reason from a provider's error body (never the key). */
function reasonOf(text) {
  try {
    const j = JSON.parse(text);
    const d = j.detail || j.error || j;
    const s = typeof d === 'string' ? d : (d.status || d.message || d.type || JSON.stringify(d));
    return String(s).slice(0, 140);
  } catch {
    return String(text || '').slice(0, 140);
  }
}

/** Free calls that prove a key is accepted (list models / read the account). */
async function keyPings(r) {
  const out = [];
  const tries = [
    ['openai', r.openai.apiKey, () => getJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${r.openai.apiKey}` })],
    ['anthropic', r.claude.apiKey, () => getJson('https://api.anthropic.com/v1/models', { 'x-api-key': r.claude.apiKey, 'anthropic-version': '2023-06-01' })],
    ['elevenlabs', r.tts.elevenlabsApiKey, () => getJson('https://api.elevenlabs.io/v1/user/subscription', { 'xi-api-key': r.tts.elevenlabsApiKey })],
    ['gemini', r.gemini.apiKey, () => getJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(r.gemini.apiKey)}`, {})],
  ];
  for (const [name, key, call] of tries) {
    if (!key) continue;
    try {
      const { status, text } = await call();
      const why = reasonOf(text);
      // ElevenLabs keys can be scoped: one without the account permission may still speak.
      if (name === 'elevenlabs' && (status === 401 || status === 403)) {
        const v = await getJson('https://api.elevenlabs.io/v1/voices', { 'xi-api-key': key });
        out.push(check('Keys live', name, v.status === 200 ? 'warn' : 'fail', v.status === 200 ? `key works (reads voices) but not the account, so its balance shows unknown: ${why}` : `account ${status}: ${why}; voices ${v.status}: ${reasonOf(v.text)}`));
        continue;
      }
      out.push(check('Keys live', name, status === 200 ? 'ok' : (status === 401 || status === 403 ? 'fail' : 'warn'), status === 200 ? 'key accepted' : `answered ${status}: ${why}`));
    } catch (err) { out.push(check('Keys live', name, 'warn', errText(err))); }
  }
  return out;
}

// ---- a few cents of real work -------------------------------------------------

async function paidChecks(tenantId, p) {
  const out = [];
  const r = p.resolved;
  const owners = r.keyOwners || {};
  const spent = [];
  const keep = async (c, provider) => {
    spent.push(c.costUsd || 0);
    await usage.record({ tenantId, provider: c.provider, model: c.model, unit: c.unit, quantity: c.quantity, costUsd: c.costUsd, source: 'qa check', keyOwner: owners[provider] === 'tenant' ? 'tenant' : 'platform' });
  };

  if (p.claude) {
    try {
      const res = await timed(() => p.claude.generateJsonDetailed({
        system: 'You are a test. Answer only with the JSON asked for.',
        user: 'Return {"ok": true, "word": "<any one English word>"}.',
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, word: { type: 'string' } }, required: ['ok', 'word'], additionalProperties: false },
        maxTokens: 4000,
      }));
      const c = costClaude({ ...res.usage, model: res.model });
      await keep(c, 'anthropic');
      out.push(check('Paid smoke', 'Claude copy writer', res.data && res.data.ok === true ? 'ok' : 'fail', `${res.model}, said "${String(res.data && res.data.word).slice(0, 20)}", $${c.costUsd}`));
    } catch (err) { out.push(check('Paid smoke', 'Claude copy writer', 'fail', errText(err))); }
  } else {
    out.push(check('Paid smoke', 'Claude copy writer', 'skip', 'no Claude key for this tenant'));
  }

  if (!r.openai.apiKey) {
    out.push(check('Paid smoke', 'OpenAI', 'skip', 'no OpenAI key for this tenant'));
    return { out, spent };
  }
  try {
    const res = await timed(() => p.llm.generateTextDetailed({ system: 'Answer with one word.', user: 'Say ready.' }));
    const c = costText({ ...res.usage, model: res.model });
    await keep(c, 'openai');
    out.push(check('Paid smoke', 'OpenAI text', res.text ? 'ok' : 'fail', `${res.model} said "${res.text.slice(0, 20)}", $${c.costUsd}`));
  } catch (err) { out.push(check('Paid smoke', 'OpenAI text', 'fail', errText(err))); }

  let png = null;
  const size = '1024x1024';
  try {
    png = await timed(() => p.llm.generateImage({ prompt: 'A plain flat test card: a soft blue circle on a white background. No text, no people.', size }));
    const c = costImages({ count: 1, size, model: r.openai.imageModel || 'gpt-image-1' });
    await keep(c, 'openai');
    out.push(check('Paid smoke', 'OpenAI picture', png && png.length > 1000 ? 'ok' : 'fail', `${Math.round((png ? png.length : 0) / 1024)} KB, $${c.costUsd}`));
  } catch (err) { out.push(check('Paid smoke', 'OpenAI picture', 'fail', errText(err))); }

  // The picture into a short vertical video, the way image posts become videos.
  if (png) {
    const dir = await mkdtemp(join(tmpdir(), 'qa-'));
    try {
      await writeFile(join(dir, 'in.png'), png);
      await exec(ffmpegBin(), ['-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', join(dir, 'in.png'), '-t', '2', '-r', '25',
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-c:v', 'libx264', '-movflags', '+faststart', join(dir, 'out.mp4')], { timeout: TIMEOUT * 3 });
      const mp4 = await readFile(join(dir, 'out.mp4'));
      const sec = probeMp4DurationSeconds(mp4, 0);
      out.push(check('Paid smoke', 'Picture to video (ffmpeg)', mp4.length > 1000 && sec > 1 ? 'ok' : 'fail', `${Math.round(mp4.length / 1024)} KB, ${sec ? sec.toFixed(1) : '?'} s, 1080x1920`));
    } catch (err) {
      out.push(check('Paid smoke', 'Picture to video (ffmpeg)', 'fail', errText(err)));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { out, spent };
}

/**
 * Every check for one QA tenant. paid = also spend a few cents on the real providers.
 * @returns {{ tenant, plan, verdict, checks, spentUsd, at }}
 */
export async function run(tenantId, { paid = false } = {}) {
  const id = String(tenantId || '');
  if (!isQaTenant(id) || id === phases.EXPIRED_ID) throw new Error('the QA check runs on a qa-* workspace (not qa-expired, the fixture)');
  if (!(await tenantRepo.findById(id))) throw new Error('no such QA workspace');
  tenantSettings.invalidate();

  const checks = [];
  checks.push(...(await machineChecks()));
  const [mine, owner] = await Promise.all([tenantSettings.forTenant(id), tenantSettings.forTenant('default')]);
  const p = await buildProviders(id);
  checks.push(...(await phases.doorChecks(id, p)));
  checks.push(...(await phases.leakChecks(id, mine, owner)));
  const { out: lifeOut, plan } = await phases.lifecycleChecks(id);
  checks.push(...lifeOut);
  checks.push(...(await phases.billingChecks(id, mine, plan)));
  checks.push(...(await phases.sharedChecks(id, mine, owner)));
  checks.push(...(await phases.httpChecks(id, settings.port)));
  checks.push(...(await qaAgency.agencyChecks(id).catch((err) => [{ group: 'Phase 6 agency', name: 'Agency clients', status: 'fail', detail: String(err.message || err).slice(0, 240) }])));
  checks.push(...(await keyPings(mine)));
  let spent = [];
  if (paid) {
    const res = await paidChecks(id, p);
    checks.push(...res.out);
    spent = res.spent;
    checks.push(await phases.ledgerCheck(id, spent));
  }
  const spentUsd = Math.round(spent.reduce((t, n) => t + (Number(n) || 0), 0) * 1e4) / 1e4;
  return { tenant: id, plan, verdict: verdict(checks), checks, spentUsd, at: new Date().toISOString() };
}

export default { createQaTenant, run };
