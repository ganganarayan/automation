/**
 * Knowledge base pages and the AI search files (public, no sign-in).
 *
 * Purpose:      /kb is a searchable help centre; /kb/<slug> is one question
 *               answered in full. Both are written for answer engines as well
 *               as people: the answer comes first, headings are questions,
 *               and each page carries schema.org JSON-LD (Article, FAQPage,
 *               BreadcrumbList; the index adds WebSite with a SearchAction).
 *               /llms.txt and /llms-full.txt give AI crawlers the whole KB in
 *               plain markdown; /sitemap.xml and /robots.txt list every page.
 * Responsibility: Pure rendering (no settings / DB / I/O). `origin` is the
 *               public address (https://host) used for canonical and absolute
 *               links; '' leaves links relative.
 * Dependencies: utils/kbData (articles), utils/publicPages (layout), utils/compareData.
 *
 * Routes (app.js): GET /kb · /kb/:slug · /llms.txt · /llms-full.txt · /sitemap.xml · /robots.txt
 */

import { KB_TOPICS, kbArticles, kbDate } from './kbData.js';
import { COMPETITORS } from './compareData.js';
import { landingHead, landingNav, landingFooter, comparePath } from './publicPages.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** JSON for a <script> block: no "</script>" can close it early. */
const ld = (obj) => `\n<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

const clean = (o) => String(o || '').replace(/\/+$/, '');
export const kbPath = (a) => `/kb/${a.slug}`;

const KB_CSS = `<style>
 .kb-search{display:flex;gap:.5rem;max-width:640px;margin:0 auto}
 .kb-search input{flex:1;font:inherit;font-size:1.05rem;padding:.8rem 1rem;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text)}
 .kb-hits{max-width:760px;margin:1.4rem auto 0;text-align:left}
 .kb-hits a,.kb-list a{display:block;padding:.85rem 1rem;border:1px solid var(--line);border-radius:12px;background:var(--card);text-decoration:none;color:var(--text);margin-bottom:.6rem}
 .kb-hits a b,.kb-list a b{display:block;color:var(--link)}
 .kb-hits a span,.kb-list a span{color:var(--mute);font-size:.93rem}
 .kb-none{color:var(--mute)}
 .kb-topic{margin-bottom:2.4rem}
 .kb-topic h3{margin:0 0 .2rem;font-size:1.25rem}
 .kb-topic p.blurb{color:var(--mute);margin:0 0 .9rem}
 .kb-art{max-width:760px}
 .kb-art h1{font-size:clamp(1.8rem,4vw,2.6rem);font-weight:900;line-height:1.12;letter-spacing:-.02em;margin:.4rem 0 1rem}
 .kb-answer{border-left:4px solid var(--blue);background:var(--card);border-radius:0 12px 12px 0;padding:1rem 1.2rem;font-size:1.12rem;margin:0 0 2rem}
 .kb-art h2{font-size:1.35rem;margin:2rem 0 .5rem;letter-spacing:-.01em}
 .kb-art p.lead-a{font-weight:600}
 .kb-crumbs{font-size:.88rem;color:var(--mute)}
 .kb-crumbs a{color:var(--mute)}
 .kb-meta{color:var(--mute);font-size:.88rem}
 .kb-rel{margin-top:2.6rem}
</style>`;

/** The search script: scores each article against the typed words, live, and reads ?q=. */
const SEARCH_JS = `<script>
(function(){
var D=JSON.parse(document.getElementById('kb-data').textContent);
var box=document.getElementById('kb-q'),out=document.getElementById('kb-hits'),all=document.getElementById('kb-all');
function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9\\u0900-\\u097f ]+/g,' ');}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function run(){
  var q=norm(box.value).split(' ').filter(function(w){return w.length>1;});
  if(!q.length){out.innerHTML='';all.style.display='';return;}
  var hits=D.map(function(a){var t=norm(a.q),k=norm(a.k),b=norm(a.a+' '+a.b),s=0;
    q.forEach(function(w){if(t.indexOf(w)>=0)s+=4;if(k.indexOf(w)>=0)s+=3;if(b.indexOf(w)>=0)s+=1;});
    return {a:a,s:s};}).filter(function(h){return h.s>0;}).sort(function(x,y){return y.s-x.s;}).slice(0,10);
  all.style.display='none';
  out.innerHTML=hits.length?hits.map(function(h){return '<a href="'+h.a.u+'"><b>'+esc(h.a.q)+'</b><span>'+esc(h.a.a)+'</span></a>';}).join(''):'<p class="kb-none">No answer matches yet. Try other words, or browse the topics below.</p>';
}
box.addEventListener('input',run);
var m=/[?&]q=([^&]*)/.exec(location.search);if(m){box.value=decodeURIComponent(m[1].replace(/\\+/g,' '));run();}
})();
</script>`;

function card(a) {
  return `<a href="${kbPath(a)}"><b>${esc(a.question)}</b><span>${esc(a.short)}</span></a>`;
}

/** Search form: submits to /kb?q= so it also works with scripts off and from article pages. */
function searchForm(autofocus = false) {
  return `<form class="kb-search" action="/kb" method="get" role="search"><input id="kb-q" name="q" type="search" placeholder="Search: post every day, cancel, Instagram DM..." aria-label="Search the help centre"${autofocus ? ' autofocus' : ''}><button class="btn" type="submit">Search</button></form>`;
}

const head = (title, description, origin, path, extra = '') => landingHead(title, description,
  `${origin ? `\n<link rel="canonical" href="${esc(clean(origin) + path)}">` : ''}
<meta property="og:type" content="${path === '/kb' ? 'website' : 'article'}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">${origin ? `<meta property="og:url" content="${esc(clean(origin) + path)}">` : ''}
<meta name="robots" content="index,follow,max-snippet:-1">${extra}${KB_CSS}`);

/** GET /kb (and /kb?q=...). */
export function kbIndexPage({ email = '', cur = 'inr', origin = '' } = {}) {
  const arts = kbArticles(cur);
  const o = clean(origin);
  const data = arts.map((a) => ({
    u: kbPath(a), q: a.question, a: a.short, k: a.keywords.join(' '),
    b: a.sections.map((s) => `${s.q} ${s.a} ${s.p.join(' ')} ${s.bullets.join(' ')}`).join(' '),
  }));
  const jsonLd = [
    {
      '@context': 'https://schema.org', '@type': 'WebSite', name: 'Content Engine help centre', url: `${o}/kb`,
      potentialAction: { '@type': 'SearchAction', target: `${o}/kb?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
    },
    {
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: arts.map((a) => ({ '@type': 'Question', name: a.question, url: `${o}${kbPath(a)}`, acceptedAnswer: { '@type': 'Answer', text: a.short } })),
    },
  ];
  const desc = 'Answers about Content Engine: posting every day, approving posts, channels, comment-to-DM leads, AI cost, pricing and privacy.';
  return `${head('Content Engine help centre: answers and how-tos', desc, origin, '/kb', jsonLd.map(ld).join(''))}
${landingNav('/')}
<header class="hero"><div class="wrap">
  <span class="pill">Help centre · ${arts.length} answers</span>
  <h1>How can we <em>help?</em></h1>
  <p class="lead">Short, straight answers about making, approving and publishing posts with Content Engine.</p>
  ${searchForm(true)}
  <div class="kb-hits" id="kb-hits" aria-live="polite"></div>
</div></header>
<section id="kb-all"><div class="wrap">
  ${KB_TOPICS.map((t) => {
    const list = arts.filter((a) => a.topic === t.id);
    return list.length ? `<div class="kb-topic" id="t-${t.id}"><h3>${esc(t.title)}</h3><p class="blurb">${esc(t.blurb)}</p><div class="kb-list">${list.map(card).join('')}</div></div>` : '';
  }).join('')}
</div></section>
<script type="application/json" id="kb-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
${SEARCH_JS}
${landingFooter(email)}`;
}

/** GET /kb/<slug>. Returns '' for an unknown slug. */
export function kbArticlePage(slug, { email = '', cur = 'inr', origin = '' } = {}) {
  const arts = kbArticles(cur);
  const a = arts.find((x) => x.slug === String(slug || ''));
  if (!a) return '';
  const o = clean(origin);
  const topic = KB_TOPICS.find((t) => t.id === a.topic) || { title: 'Help', id: '' };
  const related = a.related.map((s) => arts.find((x) => x.slug === s)).filter(Boolean);
  const jsonLd = [
    {
      '@context': 'https://schema.org', '@type': 'Article', headline: a.question, description: a.short,
      datePublished: a.updated, dateModified: a.updated, url: `${o}${kbPath(a)}`, mainEntityOfPage: `${o}${kbPath(a)}`,
      author: { '@type': 'Organization', name: 'Content Engine' }, publisher: { '@type': 'Organization', name: 'Content Engine' },
      keywords: a.keywords.join(', '),
    },
    {
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: [{ q: a.question, a: a.short }, ...a.sections.map((s) => ({ q: s.q, a: [s.a, ...s.p].join(' ') }))]
        .map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })),
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Help centre', item: `${o}/kb` },
        { '@type': 'ListItem', position: 2, name: topic.title, item: `${o}/kb#t-${topic.id}` },
        { '@type': 'ListItem', position: 3, name: a.question, item: `${o}${kbPath(a)}` },
      ],
    },
  ];
  return `${head(`${a.question} | Content Engine help`, a.short, origin, kbPath(a), jsonLd.map(ld).join(''))}
${landingNav('/')}
<section style="border-top:0"><div class="wrap kb-art">
  <nav class="kb-crumbs" aria-label="Breadcrumb"><a href="/kb">Help centre</a> › <a href="/kb#t-${esc(topic.id)}">${esc(topic.title)}</a></nav>
  <article>
    <h1>${esc(a.question)}</h1>
    <p class="kb-answer">${esc(a.short)}</p>
    ${a.sections.map((s) => `<h2>${esc(s.q)}</h2>
    <p class="lead-a">${esc(s.a)}</p>
    ${s.p.map((x) => `<p>${esc(x)}</p>`).join('')}
    ${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}`).join('')}
    <p class="kb-meta">Updated ${esc(kbDate(a.updated))}</p>
  </article>
  ${related.length ? `<div class="kb-rel"><h2>Related answers</h2><div class="kb-list">${related.map(card).join('')}</div></div>` : ''}
  <div class="kb-rel"><h2>Did not find it?</h2>${searchForm(false)}</div>
</div></section>
<section class="final"><div class="wrap">
  <h2>Stop making posts. Start revenue from posts.</h2>
  <div class="cta"><a class="btn" href="/#pricing">See pricing</a><a class="btn ghost" href="/kb">All answers</a></div>
</div></section>
${landingFooter(email)}`;
}

/** Every public path with its last change date, for the sitemap. */
export function publicPaths(cur = 'inr') {
  const base = ['/', '/kb', '/compare', '/privacy', '/terms', '/refund', '/shipping'].map((p) => ({ path: p, updated: '' }));
  const compare = COMPETITORS.map((c) => ({ path: comparePath(c), updated: '' }));
  const kb = kbArticles(cur).map((a) => ({ path: kbPath(a), updated: a.updated }));
  return [...base, ...compare, ...kb];
}

/** GET /sitemap.xml */
export function sitemapXml({ origin = '' } = {}) {
  const o = clean(origin);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${publicPaths().map((p) => `  <url><loc>${esc(o + p.path)}</loc>${p.updated ? `<lastmod>${p.updated}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
}

/** GET /robots.txt: every crawler, AI assistants included, may read the public pages. */
export function robotsTxt({ origin = '' } = {}) {
  const o = clean(origin);
  return `User-agent: *
Allow: /
Disallow: /api/

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

${o ? `Sitemap: ${o}/sitemap.xml\n` : ''}`;
}

/** GET /llms.txt: the llmstxt.org index, one line per answer. */
export function llmsTxt({ cur = 'usd', origin = '' } = {}) {
  const o = clean(origin);
  const arts = kbArticles(cur);
  const topics = KB_TOPICS.map((t) => {
    const list = arts.filter((a) => a.topic === t.id);
    return list.length ? `## ${t.title}\n\n${list.map((a) => `- [${a.question}](${o}${kbPath(a)}): ${a.short}`).join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
  return `# Content Engine

> Content Engine is a social media app that makes a finished post every day (copy, pictures in every size and a voiced video), publishes it to up to 10 channels (Instagram, Facebook, YouTube, TikTok, LinkedIn, Threads, X, Pinterest) from one approval, and turns comments into leads with comment-to-DM.

Prices in this file are in US dollars; visitors in India see rupees plus GST on the site. The full text of every answer is in ${o}/llms-full.txt.

${topics}

## Pages

- [Home and pricing](${o}/): what it does, plans and prices
- [Comparisons](${o}/compare): Content Engine against ${COMPETITORS.map((c) => c.name).join(', ')}
- [Privacy policy](${o}/privacy)
- [Refund and cancellation policy](${o}/refund)
`;
}

/** GET /llms-full.txt: every answer in full, as markdown. */
export function llmsFullTxt({ cur = 'usd', origin = '' } = {}) {
  const o = clean(origin);
  const body = kbArticles(cur).map((a) => [
    `## ${a.question}`,
    '',
    `Source: ${o}${kbPath(a)} (updated ${kbDate(a.updated)})`,
    '',
    a.short,
    ...a.sections.flatMap((s) => ['', `### ${s.q}`, '', s.a, ...s.p.map((x) => `\n${x}`), ...(s.bullets.length ? ['', ...s.bullets.map((b) => `- ${b}`)] : [])]),
  ].join('\n')).join('\n\n');
  return `# Content Engine: every help answer in full

Prices are in US dollars; visitors in India see rupees plus GST on the site.

${body}
`;
}

export default { kbPath, kbIndexPage, kbArticlePage, publicPaths, sitemapXml, robotsTxt, llmsTxt, llmsFullTxt };
