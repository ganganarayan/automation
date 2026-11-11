/**
 * Comparison pages (public, no sign-in).
 *
 * Purpose:      /compare lists every comparison; /compare/content-engine-vs-<slug>
 *               is one competitor in full: where the revenue comes from, every
 *               row with their own wording and a source link, what they do
 *               better, and when to pick them.
 * Responsibility: Pure HTML rendering (no settings / DB / I/O).
 * Dependencies: utils/compareData (facts), utils/publicPages (shell, matrix).
 *
 * Routes (app.js): GET /compare  ·  GET /compare/:page
 */

import { CHECKED_ON, VERDICT, ROWS, US, COMPETITORS, REVENUE_PATH, bySlug } from './compareData.js';
import {
  landingHead, landingNav, landingFooter, contactHrefFor, compareMatrix, compareCards, comparePath, LOGIN_PATH, escGst,
} from './publicPages.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PREFIX = 'content-engine-vs-';

/** The competitor a /compare/:page segment names, or null. */
export function competitorForPage(page) {
  const p = String(page || '');
  return p.startsWith(PREFIX) ? bySlug(p.slice(PREFIX.length)) : null;
}

const word = (v) => (VERDICT[v] || VERDICT.u);
const cell = (v, note, src) => {
  const m = word(v);
  return `<span class="${m.cls}">${m.sym} ${esc(m.word)}</span><small>${escGst(note)}${src ? ` <a href="${esc(src)}" rel="nofollow noopener" target="_blank">source</a>` : ''}</small>`;
};

function finalCta(email, heading) {
  const trial = contactHrefFor(email)('7-day trial');
  return `<section class="final"><div class="wrap">
  <h2>${esc(heading)}</h2>
  <p class="kicker" style="margin:0 auto 1.6rem">Seven days free, then ₹3,099 + GST a funnel ($36 outside India). Or buy now and your workspace is ready the moment you pay.</p>
  <div class="cta"><a class="btn" href="${trial}">Start the 7-day trial</a><a class="btn ghost" href="/#pricing">See pricing</a></div>
</div></section>`;
}

/** GET /compare */
export function compareIndexPage({ email = '' } = {}) {
  const names = COMPETITORS.map((c) => c.name).join(', ');
  return `${landingHead('Content Engine vs other social media tools: feature comparison',
    `Content Engine compared feature by feature with ${names}: who makes the post, who posts every day, and who turns comments into leads.`)}
${landingNav('/')}
<header class="hero"><div class="wrap">
  <span class="pill">Feature comparison, checked ${esc(CHECKED_ON)}</span>
  <h1>Content Engine vs <em>the tools you know</em></h1>
  <p class="lead">Schedulers queue the post you made. Content Engine makes the post, publishes it every day and turns the comments into leads. Every claim below comes from each company's own website.</p>
</div></header>
<section><div class="wrap">
  <h2>Every feature, side by side</h2>
  <p class="kicker">Rows run in the order a post turns into money: made, posted, converted, paid for.</p>
  ${compareMatrix()}
</div></section>
<section><div class="wrap">
  <h2>One page per tool</h2>
  <p class="kicker">Each page shows their own words with a source link, what they do better than us, and when you should pick them instead.</p>
  ${compareCards()}
</div></section>
${finalCta(email, 'Stop making posts. Start revenue from posts.')}
${landingFooter(email)}`;
}

/** GET /compare/content-engine-vs-<slug>. Returns '' for an unknown competitor. */
export function comparisonPage(c, { email = '' } = {}) {
  if (!c) return '';
  const them = (key) => c.rows[key] || ['u', 'Not listed.', ''];
  // Rows where we answer yes and they do not: the gaps a buyer pays for.
  const gaps = ROWS.filter((r) => r.key && !['freePlan', 'entryPrice', 'inr'].includes(r.key)
    && US[r.key][0] === 'y' && them(r.key)[0] !== 'y');

  const revenue = REVENUE_PATH.map(([step, text, key], i) => {
    const [v, note] = them(key);
    return `<div class="card money"><span class="num">${i + 1}</span><h3>${esc(step)}</h3><p>${esc(text)}</p><p style="margin-top:.6rem"><b>${esc(c.name)}:</b> <span class="${word(v).cls}">${word(v).sym}</span> ${esc(note)}</p></div>`;
  }).join('');

  const table = ROWS.map((r) => (r.group
    ? `<tr class="grp"><td colspan="3">${esc(r.group)}</td></tr>`
    : `<tr><td>${esc(r.label)}</td><td class="us">${cell(...US[r.key])}</td><td>${cell(...them(r.key))}</td></tr>`)).join('');

  const others = COMPETITORS.filter((o) => o.slug !== c.slug);

  return `${landingHead(`Content Engine vs ${c.name}: feature comparison`,
    `Content Engine against ${c.name}, feature by feature, from ${c.name}'s own website on ${CHECKED_ON}: what each does, what ${c.name} does better, and which one turns posts into revenue.`)}
${landingNav('/')}
<header class="hero" style="text-align:left"><div class="wrap">
  <p class="crumb"><a href="/">Home</a> / <a href="/compare">Compare</a> / ${esc(c.name)}</p>
  <span class="pill">${esc(c.name)} · ${esc(c.category)} · checked ${esc(CHECKED_ON)}</span>
  <h1 style="margin-left:0">Content Engine vs <em>${esc(c.name)}</em></h1>
  <p class="lead" style="margin-left:0">${esc(c.lede)}</p>
  <div class="cta" style="justify-content:flex-start"><a class="btn" href="${contactHrefFor(email)('7-day trial')}">Start the 7-day trial</a><a class="btn ghost" href="#table">See every feature</a></div>
</div></header>

<section><div class="wrap">
  <h2>What Content Engine adds</h2>
  <p class="kicker">${gaps.length} things Content Engine does that ${esc(c.name)} does not list, or only does in part.</p>
  <div class="grid g3">${gaps.map((r) => `<div class="card"><h3>${esc(r.label)}</h3><p>${escGst(US[r.key][1])}</p><p style="margin-top:.6rem"><b>${esc(c.name)}:</b> ${esc(them(r.key)[1])}</p></div>`).join('')}</div>
</div></section>

<section><div class="wrap">
  <h2>From a post to revenue</h2>
  <p class="kicker">A post earns when it is seen, clicked, turned into a lead, followed up and paid for at a cost you know. Here is each step, and where ${esc(c.name)} stands.</p>
  <div class="grid g5">${revenue}</div>
</div></section>

<section id="table"><div class="wrap">
  <h2>Every feature, with sources</h2>
  <p class="kicker">${esc(c.name)}'s column is in their own terms, read from their website on ${esc(CHECKED_ON)}. "Not listed" means we could not find it, not that it can never exist.${c.sourceNote ? ` ${esc(c.sourceNote)}` : ''}</p>
  <div class="tbl"><table><thead><tr><th>Feature</th><th class="us">Content Engine</th><th>${esc(c.name)}</th></tr></thead><tbody>${table}</tbody></table></div>
</div></section>

<section><div class="wrap">
  <h2>What ${esc(c.name)} does better</h2>
  <p class="kicker">Things ${esc(c.name)} has that Content Engine does not. If one of these is what you need, it is a good reason to choose them.</p>
  <div class="grid g3">${c.theyWin.map((w) => `<div class="card win"><p style="color:var(--text)">${esc(w)}</p></div>`).join('')}</div>
  <div class="card" style="margin-top:1.4rem"><h3>When ${esc(c.name)} is the better buy</h3><p>${esc(c.betterWhen)}</p></div>
</div></section>

<section><div class="wrap">
  <h2>Price</h2>
  <div class="grid g3">
    <div class="card"><h3>Content Engine</h3><p>Always-On Brand: ₹3,099 + GST a month per funnel (brand) with 10 channels and 30 finished posts ($36 outside India, no GST). Agency ₹3,899 + GST per client ($45). AI included. 7-day trial. <a href="/#pricing">See plans</a></p></div>
    <div class="card"><h3>${esc(c.name)}</h3><p>${esc(c.price)}</p></div>
  </div>
</div></section>

<section><div class="wrap">
  <h2>Other comparisons</h2>
  <p class="kicker"><a href="/compare">See all tools side by side</a></p>
  ${compareCards(others)}
</div></section>

${finalCta(email, `Keep ${c.name} for what it does best. Let Content Engine make the revenue.`)}
${landingFooter(email)}`;
}

export { comparePath, LOGIN_PATH };
export default { compareIndexPage, comparisonPage, competitorForPage };
