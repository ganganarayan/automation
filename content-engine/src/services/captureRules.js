/**
 * Publish-time keyword-rule creation.
 *
 * Purpose:      After a successful publish, turn the content's keyword / dm_text
 *               / dm_link into keyword_rule(s) — one per DM-capable platform
 *               (Instagram, Facebook) among the post's accounts. Threads, X,
 *               YouTube and LinkedIn have no DM API, so they get no rule.
 * Responsibility: Thin orchestration over the repository; safe to call on every
 *               publish path. No keyword -> nothing created.
 * Dependencies: keywordRulesRepository (lazy-loaded so this module unit-tests
 *               without a database; callers may inject deps.rules).
 */
const DM_PLATFORMS = new Set(['instagram', 'facebook']);

let _rules = null;
async function defaultRules() {
  if (!_rules) _rules = await import('../repositories/keywordRulesRepository.js');
  return _rules;
}

/** Distinct DM-capable platforms among a set of Post-for-Me account ids. */
export function dmPlatforms(accountIds = [], accountMap = {}) {
  const out = new Set();
  for (const id of accountIds) {
    const p = String((accountMap[id] || {}).platform || '').toLowerCase();
    if (DM_PLATFORMS.has(p)) out.add(p);
  }
  return [...out];
}

/**
 * Create the keyword rule(s) for a just-published post.
 * @returns {Promise<Array>} the created/updated rule rows (possibly empty).
 */
export async function createForPublish({
  tenantId = 'default',
  funnelId = null,
  lane = null,
  platforms = [],
  postformePostId,
  keyword,
  dmText = '',
  dmLink = null,
  publicReplyVariants = [],
  matchMode = 'word',
  log,
}, deps = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return []; // no keyword on the content row -> publish normally, no rule
  if (!postformePostId) return [];
  const rules = deps.rules || (await defaultRules());
  const made = [];
  for (const platform of platforms) {
    try {
      const r = await rules.upsert({
        tenantId, funnelId, platform, postformePostId, lane,
        keyword: kw, matchMode, dmText, dmLink, publicReplyVariants, active: true,
      });
      made.push(r);
    } catch (err) {
      log?.warn?.({ err: err.message, platform, postformePostId }, 'capture: rule create failed');
    }
  }
  if (made.length) log?.info?.({ postformePostId, keyword: kw, platforms: made.length }, 'capture: keyword rule(s) created at publish');
  return made;
}

export default { dmPlatforms, createForPublish };
