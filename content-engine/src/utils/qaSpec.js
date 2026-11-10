/**
 * QA check rules (pure).
 *
 * Purpose:      Decide, from what the running app resolved for a QA tenant, whether
 *               tenancy holds: no owner setting leaks in, the keys come from the
 *               right owner for its plan, it only sees its own Post for Me accounts.
 * Responsibility: isQaTenant, qaTenantId, leakedSettings, keyFindings,
 *               accountFindings, verdict.
 * Dependencies: pfmScope (external_id owner).
 *
 * A check is { group, name, status: 'ok' | 'warn' | 'fail' | 'skip', detail }.
 */
import { tenantOfExternalId } from './pfmScope.js';

export const QA_PREFIX = 'qa-';

/** QA tenants are named qa-<something>: made without a sign-in, used only for tests. */
export function isQaTenant(id) {
  return String(id || '').startsWith(QA_PREFIX) && String(id).length > QA_PREFIX.length;
}

/** "starter" or "qa-starter" -> "qa-starter"; '' when it cannot be a tenant id. */
export function qaTenantId(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const id = s.startsWith(QA_PREFIX) ? s : QA_PREFIX + s;
  return /^qa-[a-z0-9][a-z0-9-]{0,27}$/.test(id) ? id : '';
}

// Owner-only settings: another tenant must never resolve the owner's value for these.
// (Model names, the SMTP port and the Google service account are shared on purpose.)
export const OWNER_ONLY = [
  'sheets.gita', 'sheets.vidapulse', 'sheets.video', 'sheets.factory',
  'drive.gitaFolder', 'drive.stripFile', 'drive.voiceoverFolder', 'drive.reelsFolder',
  'drive.factoryGptFolder', 'drive.factoryGeminiFolder',
  'postforme.gitaAccounts', 'postforme.vidapulseAccounts', 'postforme.gitaVideoAccounts', 'postforme.accountMap',
  'emails.notify', 'emails.approvalGita', 'emails.approvalVidapulse', 'emails.report',
  'links.gitaAssessment', 'links.gitaSimpleAssessment',
  'instagram.automationUrl', 'instagram.contactEmail', 'instagram.commentWebhookUrl',
  'smtp.host', 'smtp.user', 'smtp.pass', 'smtp.from',
  'mail.apiKey', 'mail.from', 'mail.gmailEmail',
  'prompts.global', 'prompts.copy', 'prompts.claudeContext', 'lessons.image', 'lessons.video',
  'comparison.list', 'comparison.brand', 'shortMusic.url',
];

const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const filled = (v) => {
  if (v == null || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return String(v).trim() !== '';
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The owner-only fields where the QA tenant resolved the owner's own non-empty
 * value although the QA tenant never set one itself. [] = no leak.
 */
export function leakedSettings(qa, owner, qaOverridden = () => false) {
  const out = [];
  for (const path of OWNER_ONLY) {
    const mine = at(qa, path);
    const theirs = at(owner, path);
    if (filled(theirs) && same(mine, theirs) && !qaOverridden(path)) out.push(path);
  }
  if (qa && qa.comparison && qa.comparison.builtIn) out.push('comparison.builtIn');
  if (qa && qa.mail && qa.mail.gmailReady && !(qaOverridden('mail.gmailReady'))) out.push('mail.gmailReady');
  return out;
}

const PAID = ['openai', 'anthropic', 'gemini', 'kling', 'runway', 'hailuo', 'elevenlabs', 'heygen', 'transcript', 'json2video'];

/**
 * Who pays per provider. An Agency tenant brings its own keys: a 'platform' key there
 * is a fail (it would land on the owner's bill). Other plans may use the platform's.
 */
export function keyFindings(keyOwners = {}, plan = 'custom') {
  const byo = String(plan) === 'agency';
  return PAID.map((p) => {
    const who = keyOwners[p] || 'none';
    if (byo && who === 'platform') return { group: 'Keys', name: p, status: 'fail', detail: 'Agency plan but uses the owner\'s key (owner pays)' };
    if (who === 'none') return { group: 'Keys', name: p, status: 'skip', detail: byo ? 'no key of its own (Agency brings its own)' : 'no key anywhere' };
    return { group: 'Keys', name: p, status: 'ok', detail: who === 'tenant' ? 'its own key' : 'owner\'s platform key (on your bill)' };
  });
}

/** Every Post for Me account the tenant sees must carry its own external_id. */
export function accountFindings(accounts = [], tenantId, { ownerCount = null } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const foreign = list.filter((a) => tenantOfExternalId(a && a.external_id) !== String(tenantId));
  const out = [];
  if (foreign.length) {
    out.push({ group: 'Isolation', name: 'Post for Me accounts', status: 'fail', detail: `sees ${foreign.length} account(s) that are not its own: ${foreign.slice(0, 3).map((a) => a.platform || a.id).join(', ')}` });
  } else {
    out.push({ group: 'Isolation', name: 'Post for Me accounts', status: 'ok', detail: list.length ? `sees only its own ${list.length} account(s): ${list.map((a) => a.platform).filter(Boolean).join(', ')}` : 'sees no accounts (none connected yet), so it cannot post to yours' });
  }
  if (ownerCount !== null) {
    out.push({ group: 'Isolation', name: 'Owner accounts hidden', status: ownerCount > 0 && !foreign.length ? 'ok' : (ownerCount > 0 ? 'fail' : 'warn'), detail: ownerCount > 0 ? `the owner has ${ownerCount} account(s) on the shared key; none show here` : 'the owner has no accounts on the shared key, so hiding them was not tested' });
  }
  return out;
}

/** 'fail' if any failed, 'warn' if any warned, else 'ok'. */
export function verdict(checks = []) {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

export default { QA_PREFIX, isQaTenant, qaTenantId, OWNER_ONLY, leakedSettings, keyFindings, accountFindings, verdict };
