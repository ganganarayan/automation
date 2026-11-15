/**
 * Gemini quota errors, read in plain words (pure).
 *
 * Purpose:      A Gemini 429 says three different things: the key's project has
 *               no quota at all for the model (Free Tier, limit 0, so waiting
 *               never helps), the day's quota is used up, or a per-minute limit
 *               was hit (wait the given seconds and try again).
 * Responsibility: geminiQuotaOf(err) reads the error, geminiQuotaReason(q) says
 *               it for the instance page, quotaRetryWait(q) says how long a
 *               single bounded retry should wait (null = do not retry). No I/O.
 * Dependencies: none.
 */

/** Seconds from "47788s", "13h16m28.4s", "12.5s". null when absent. */
export function delaySeconds(text = '') {
  const s = String(text || '');
  const tagged = s.match(/retryDelay\\?"\s*:\s*\\?"(\d+(?:\.\d+)?)s/);
  if (tagged) return Math.ceil(Number(tagged[1]));
  const said = s.match(/retry in\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i);
  if (!said || !said[1]) return null;
  const part = (re) => { const m = said[1].match(re); return m ? Number(m[1]) : 0; };
  const total = part(/(\d+)h/) * 3600 + part(/(\d+)m(?!s)/) * 60 + part(/(\d+(?:\.\d+)?)s/);
  return total > 0 ? Math.ceil(total) : null;
}

/** null unless err is a Gemini 429 / quota error. */
export function geminiQuotaOf(err) {
  const msg = String((err && (err.message || err)) || '');
  const status = err && (err.status || err.statusCode);
  if (status !== 429 && !/\b429\b|Too Many Requests|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(msg)) return null;
  const model = (msg.match(/model:\s*([\w.\-/]+)/) || msg.match(/models\/([\w.\-]+):/) || [])[1] || '';
  return {
    freeTier: /free[_ ]tier/i.test(msg),
    zeroLimit: /limit:\s*0\b/.test(msg),
    perDay: /per day|PerDay/i.test(msg),
    retrySec: delaySeconds(msg),
    model,
  };
}

function hours(sec) {
  if (!sec) return '';
  if (sec < 90) return `${sec} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

/** The plain line the instance page and the Log show. */
export function geminiQuotaReason(q) {
  if (!q) return '';
  const model = q.model || 'the image model';
  if (q.zeroLimit) {
    return `Gemini key has no quota for ${model} (limit 0${q.freeTier ? ', Free Tier' : ''}), so waiting will not help. `
      + 'Turn on billing for its Google project in AI Studio, or set Image model to OpenAI. (Google 429)';
  }
  if (q.perDay) return `Gemini's daily quota for ${model} is used up${q.retrySec ? `, it resets in about ${hours(q.retrySec)}` : ''}. (Google 429)`;
  return `Gemini's per-minute limit for ${model} was hit${q.retrySec ? `, retry in ${hours(q.retrySec)}` : ''}. (Google 429)`;
}

/**
 * Seconds to wait before the one retry, or null. Only a per-minute limit with a
 * short wait is worth it: limit 0 and a spent daily quota fail again.
 */
export function quotaRetryWait(q, maxSec = 60) {
  if (!q || q.zeroLimit || q.perDay) return null;
  const wait = q.retrySec == null ? 20 : q.retrySec;
  return wait <= maxSec ? wait : null;
}

export default { delaySeconds, geminiQuotaOf, geminiQuotaReason, quotaRetryWait };
