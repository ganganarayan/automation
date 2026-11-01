/**
 * Wake schedule (pure).
 *
 * Purpose:      The daily job times each tenant sets in Setup → Settings →
 *               Daily schedule (IST), turned into the one wake schedule the
 *               GitHub Actions workflow (.github/workflows/wake.yml) reads from
 *               the repository variable WAKE_SCHEDULE, and the "is it due" test
 *               both the workflow and the app use.
 * Responsibility:
 *               - parseTime / parseTimeList: HH:MM (24h) checks (configOps uses
 *                 them to validate on save).
 *               - tenantTimes: one tenant's times, defaults for blanks.
 *               - buildWakeSchedule: the union across tenants,
 *                 {"router":["16:00"],"nudge":["10:00"],"posts":["08:20","20:20"]}.
 *               - isDue / anyDue: a time within the last windowMin minutes (IST),
 *                 across midnight too.
 *               - variableRequests / syncOutcome: the GitHub REST calls that
 *                 write WAKE_SCHEDULE, and how their answer reads in the UI.
 * Dependencies: utils/cleanHookSpec (normalizeRepo).
 */
import { normalizeRepo } from './cleanHookSpec.js';

export const WAKE_VARIABLE = 'WAKE_SCHEDULE';
export const WAKE_WINDOW_MIN = 30;
// The app's own due test allows 10 minutes more: the workflow decides at its
// start, and the cold-start retries can land the ping a few minutes later.
export const SERVER_WINDOW_MIN = WAKE_WINDOW_MIN + 10;

/** tenant_config key → default (blank = the default). */
export const WAKE_DEFAULTS = {
  router_check_time: '16:00',
  nudge_time: '10:00',
  post_check_times: '08:20, 20:20',
};
export const WAKE_KEYS = Object.keys(WAKE_DEFAULTS);
export const SYNC_KEY = 'wake_schedule_synced';

/** 'HH:MM' (24h, zero-padded) or null. Accepts '8:20' as 08:20. */
export function parseTime(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** A comma (or space / new line) list of times → { times (sorted, unique), bad }. */
export function parseTimeList(s) {
  const parts = String(s ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const times = [];
  const bad = [];
  for (const p of parts) {
    const t = parseTime(p);
    if (t) times.push(t);
    else bad.push(p);
  }
  return { times: [...new Set(times)].sort(), bad };
}

/** One tenant's job times from its config map. Blank or unreadable → the default. */
export function tenantTimes(cfg = {}) {
  const one = (key) => parseTime(cfg[key]) || WAKE_DEFAULTS[key];
  const list = parseTimeList(cfg.post_check_times).times;
  return {
    router: [one('router_check_time')],
    nudge: [one('nudge_time')],
    posts: list.length ? list : parseTimeList(WAKE_DEFAULTS.post_check_times).times,
  };
}

/** The union across tenants. No tenants → the defaults. */
export function buildWakeSchedule(configs = []) {
  const list = configs.length ? configs : [{}];
  const out = { router: new Set(), nudge: new Set(), posts: new Set() };
  for (const cfg of list) {
    const t = tenantTimes(cfg);
    for (const job of Object.keys(out)) t[job].forEach((x) => out[job].add(x));
  }
  return Object.fromEntries(Object.entries(out).map(([job, set]) => [job, [...set].sort()]));
}

const minutesOf = (hhmm) => {
  const t = parseTime(hhmm);
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/**
 * True when `timeHHMM` fell within the last `windowMin` minutes of `nowIst`
 * (a Luxon DateTime in IST, or anything with hour/minute), including `now`
 * itself and across midnight (23:50 is due at 00:10).
 */
export function isDue(timeHHMM, nowIst, windowMin = WAKE_WINDOW_MIN) {
  const t = minutesOf(timeHHMM);
  if (t === null || !nowIst) return false;
  const now = Number(nowIst.hour) * 60 + Number(nowIst.minute);
  const ago = (now - t + 1440) % 1440;
  return ago < windowMin;
}

/** Any of the times due (see isDue). */
export function anyDue(times, nowIst, windowMin = WAKE_WINDOW_MIN) {
  return (times || []).some((t) => isDue(t, nowIst, windowMin));
}

/**
 * The two GitHub REST calls that write the repository variable: PATCH it,
 * and on a 404 create it with POST.
 */
export function variableRequests({ repo, token, value, name = WAKE_VARIABLE }) {
  const r = normalizeRepo(repo);
  if (!r) throw new Error('GitHub repo must look like owner/name (Setup → Keys and credit → Video clean)');
  if (!token) throw new Error('No GitHub token: set it under Setup → Keys and credit → Video clean');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  return {
    patch: {
      url: `https://api.github.com/repos/${r}/actions/variables/${name}`,
      init: { method: 'PATCH', headers, body: JSON.stringify({ name, value }) },
    },
    post: {
      url: `https://api.github.com/repos/${r}/actions/variables`,
      init: { method: 'POST', headers, body: JSON.stringify({ name, value }) },
    },
  };
}

/** How a sync answer reads: { ok, message } (the UI adds the time). */
export function syncOutcome(status, reason = '') {
  if (status === 204 || status === 201 || status === 200) return { ok: true, message: 'synced' };
  if (status === 403) return { ok: false, message: "GitHub token needs 'Variables: Read and write' permission on the repo" };
  return { ok: false, message: `GitHub said ${status}: ${String(reason || 'no reason given').slice(0, 200)}` };
}

export default {
  WAKE_VARIABLE, WAKE_WINDOW_MIN, SERVER_WINDOW_MIN, WAKE_DEFAULTS, WAKE_KEYS, SYNC_KEY,
  parseTime, parseTimeList, tenantTimes, buildWakeSchedule, isDue, anyDue, variableRequests, syncOutcome,
};
