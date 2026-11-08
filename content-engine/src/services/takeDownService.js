/**
 * Take down: remove a live post from the channels you tick.
 *
 * Purpose:      One 🗑 button on a posted instance removes it from each picked
 *               channel, on the platform itself. Post for Me cannot do it (its
 *               delete only drops its own record), so each channel's post id
 *               comes from Post for Me's results and the delete goes to the
 *               platform with the account's own token, in the same token order
 *               as the first comment (your Meta token first for Facebook and
 *               Instagram, then Post for Me's).
 * Responsibility:
 *               - takeDown({ instanceId, accountIds }): one try per picked
 *                 channel; each gets removedAt on success or removeError on
 *                 failure. The channel keeps state 'ok' (it did post), so the
 *                 posted / partial / retry logic never reads it as failed.
 *               - Never throws for one channel: the result lists each one.
 * Dependencies: instanceRepository, instanceService, providerFactory,
 *               publishProvider, firstCommentService (tokensFor),
 *               takeDownSenders, logger.
 */
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as instanceService from './instanceService.js';
import { buildProviders } from './providerFactory.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { tokensFor } from './firstCommentService.js';
import { createTakeDownSenders } from './takeDownSenders.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'takeDown' });
const senders = createTakeDownSenders({ log });

const refsOf = (row, pub) => {
  const own = Array.isArray(row.post_refs) ? row.post_refs : JSON.parse(row.post_refs || '[]');
  return [...new Set([...(own || []), ...(Array.isArray(pub.posts) ? pub.posts : [])].filter(Boolean))];
};

/** Channels that are live now and can be ticked: posted and not taken down yet. */
export function liveChannels(channels = []) {
  return (Array.isArray(channels) ? channels : []).filter((c) => c && c.state === 'ok' && !c.removedAt);
}

export async function takeDown({ instanceId, accountIds = [] }) {
  const row = await instanceRepo.get(instanceId);
  if (!row) throw new Error('instance not found');
  if (!['posted', 'partial'].includes(row.status)) throw new Error('only a posted instance can be taken down');
  const steps = instanceService.parseSteps(row);
  const pub = ((steps.find((s) => s.key === 'publish') || {}).artifacts) || {};
  const live = liveChannels(pub.channels);
  const picked = new Set((accountIds || []).map(String));
  const targets = live.filter((c) => picked.has(String(c.id)));
  if (!targets.length) throw new Error('tick at least one live channel');

  const providers = await buildProviders(row.tenant_id);
  if (!providers.resolved.postformeKey) throw new Error('Post for Me key is not set');
  const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey }, log);

  // Each channel's platform post id, from the post that put it live.
  const postIds = {};
  for (const ref of refsOf(row, pub)) {
    const results = await publish.postResults(ref).catch((err) => { log.warn({ err: err.message, ref }, 'post results lookup failed'); return []; });
    for (const r of results) {
      const id = r && r.success && r.platform_data && r.platform_data.id;
      if (id) postIds[r.social_account_id] = String(id);
    }
  }

  const outcome = {};
  for (const c of targets) {
    try {
      const account = await publish.getAccount(c.id);
      const platform = (account && account.platform) || c.platform || '';
      const postId = postIds[c.id] || '';
      const out = await senders.takeDown({ platform, postId, tokens: await tokensFor(row.tenant_id, platform, postId, account || {}) });
      outcome[c.id] = out.state === 'ok'
        ? { removedAt: new Date().toISOString(), via: out.via }
        : { error: out.error };
      log.info({ instance: row.id, platform, state: out.state, via: out.via, gone: out.gone }, 'take down');
    } catch (err) {
      outcome[c.id] = { error: String(err.message || 'delete failed').slice(0, 200) };
      log.warn({ instance: row.id, account: c.id, err: err.message }, 'take down failed');
    }
  }

  // Read again just before saving, so a link filled meanwhile is not lost.
  const fresh = (await instanceRepo.get(row.id)) || row;
  const freshSteps = instanceService.parseSteps(fresh);
  const next = freshSteps.map((s) => {
    if (s.key !== 'publish') return s;
    const a = s.artifacts || {};
    const channels = (a.channels || []).map((c) => {
      const o = outcome[c.id];
      if (!o) return c;
      if (o.removedAt) {
        const { removeError, ...rest } = c;
        return { ...rest, removedAt: o.removedAt };
      }
      return { ...c, removeError: o.error };
    });
    return { ...s, artifacts: { ...a, channels } };
  });
  await instanceRepo.saveLinks(row.id, next);

  const list = targets.map((c) => ({
    id: c.id, platform: c.platform || '', name: c.name || '',
    removed: !!(outcome[c.id] && outcome[c.id].removedAt),
    error: (outcome[c.id] && outcome[c.id].error) || '',
  }));
  return { instanceId: row.id, removed: list.filter((x) => x.removed).length, failed: list.filter((x) => !x.removed).length, channels: list };
}

export default { takeDown, liveChannels };
