/**
 * The balance strip on top of Keys and credit (pure: no I/O).
 *
 * Purpose:      One or two lines that say how much is left on every key, so you
 *               know which one to top up. Runway, Kling and ElevenLabs are read
 *               live from their own balance APIs. OpenAI, Claude and MiniMax
 *               have no balance API: you type the balance once after a top-up,
 *               and the app takes off what it has spent there since (the real
 *               cost it records on every run). Gemini's spend is not priced, so
 *               it only says the key is set.
 * Responsibility:
 *               - ESTIMATED: the providers you type a balance for, with their cost-log name
 *               - parseBalance(raw): { usd, at } or null
 *               - balanceItem(...): { key, name, text, tone, set } for one provider
 * Dependencies: none.
 */

/** key -> what the page calls it and the provider name in the cost log. */
export const ESTIMATED = {
  openai: { name: 'OpenAI', provider: 'openai' },
  anthropic: { name: 'Claude', provider: 'anthropic' },
  hailuo: { name: 'MiniMax', provider: 'hailuo' },
};

// Below these, the dot turns yellow: time to top up.
const LOW = { usd: 3, kling: 50, runway: 200, elevenlabs: 5000 };

/** A stored balance ({"usd":20,"at":"…"}), or null. */
export function parseBalance(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const usd = Number(o && o.usd);
    if (!Number.isFinite(usd) || !o.at || Number.isNaN(Date.parse(o.at))) return null;
    return { usd, at: o.at };
  } catch {
    return null;
  }
}

const money = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const count = (n) => Math.round(n).toLocaleString('en-IN');

/**
 * One provider for the strip. kind 'estimated': balance = { usd, at } typed by
 * you, spent = USD the app recorded there since. kind 'live': value from the
 * provider's API (null = could not read). Returns { key, name, text, tone, set }
 * where tone is ok | low | out | unknown and set says the name can be clicked
 * to type a new balance.
 */
export function balanceItem({ key, kind, name, balance = null, spent = 0, value = null, unit = '' }) {
  if (kind === 'estimated') {
    if (!balance) return { key, name, text: 'type balance', tone: 'unknown', set: true };
    const left = balance.usd - (Number(spent) || 0);
    const tone = left <= 0 ? 'out' : left < LOW.usd ? 'low' : 'ok';
    return { key, name, text: `≈ ${money(Math.max(0, left))}`, tone, set: true };
  }
  if (kind === 'none') return { key, name, text: 'no balance API', tone: 'unknown', set: false };
  if (value === null || value === undefined) return { key, name, text: 'not readable', tone: 'unknown', set: false };
  const low = LOW[key] ?? 0;
  const tone = value <= 0 ? 'out' : value < low ? 'low' : 'ok';
  return { key, name, text: `${count(value)}${unit ? ` ${unit}` : ''}`, tone, set: false };
}

export default { ESTIMATED, parseBalance, balanceItem };
