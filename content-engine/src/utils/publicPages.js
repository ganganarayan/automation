/**
 * Public pages (no sign-in): home, privacy policy, terms of service.
 *
 * Purpose:      What the bare domain shows before sign-in, and the two policy
 *               pages Google's OAuth consent screen (Branding) links to, so the
 *               Google sign-in for "Connect Google Drive" can be published.
 *               The Sign in button opens the app on the same domain.
 * Responsibility: Pure HTML rendering (no settings / DB / I/O).
 * Dependencies: utils/planSpec (plan limits and prices, pure).
 *
 * Routes (app.js): GET /  ·  GET /privacy  ·  GET /terms
 */

import { PLANS } from './planSpec.js';

export const UPDATED = '11-11-2026';
export const LOGIN_PATH = '/api/v1/admin/today';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui,sans-serif;margin:0;background:#0b0b12;color:#e8e8ef;line-height:1.6}
 .wrap{max-width:760px;margin:0 auto;padding:2.5rem 16px 3rem}
 header{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:2rem}
 .brand{font-weight:700;font-size:1.15rem;color:#fff;text-decoration:none}
 a{color:#7aa2ff}
 .btn{background:#2d6cdf;color:#fff;border-radius:8px;padding:.6rem 1.1rem;text-decoration:none;font-weight:600;display:inline-block}
 h1{font-size:1.8rem;line-height:1.25;margin:.2rem 0 .8rem}
 h2{font-size:1.05rem;margin:1.6rem 0 .4rem;color:#c7c7d9}
 .sub{color:#9a9ab0}
 ul{padding-left:1.2rem}
 footer{margin-top:3rem;padding-top:1rem;border-top:1px solid #24243a;color:#6f6f88;font-size:.85rem;display:flex;gap:1rem;flex-wrap:wrap}
</style></head><body><div class="wrap">
<header><a class="brand" href="/">Content Engine</a><a class="btn" href="${LOGIN_PATH}">Sign in</a></header>
${inner}
<footer><span>Content Engine</span><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a></footer>
</div></body></html>`;
}

const contactLine = (email) => (email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : 'the site owner');

/** Indian digit grouping for rupee prices (14999 -> "14,999", 149999 -> "1,49,999"). */
export function inr(n) {
  const s = String(Math.round(Number(n) || 0));
  if (s.length <= 3) return s;
  const head = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${head},${s.slice(-3)}`;
}

/** Channels the app publishes to (through Post for Me, plus the platforms' own APIs for take-downs). */
export const CHANNELS = ['Instagram', 'Facebook', 'YouTube', 'TikTok', 'LinkedIn', 'Threads', 'X', 'Pinterest'];

/** What each paid plan adds, in the words of docs/pricing-plan.md. Limits come from utils/planSpec. */
export const PLAN_FEATURES = {
  starter: {
    tag: 'Post every day, hands off',
    lines: [
      'Ready video lane: AI copy, headline thumbnail in every size, end card, Clean check',
      'Image posts as voiced videos with music',
      'YouTube Shorts from image posts',
      'Daily router that never skips a day',
      'Your link as the first comment',
      'Approve from the app, one daily digest email',
      'Take down a post from every channel at once',
      'Connect your accounts from the app',
    ],
  },
  growth: {
    tag: 'Grow and capture leads',
    lead: 'Everything in Starter, plus',
    lines: [
      'AI video lane: script, pictures, animation, voice',
      'An image post when an animation fails',
      'Comment-to-DM lead capture on Instagram and Facebook',
      'Lead visit tracking on your landing pages',
      'Disapprove and Remake, with learned lessons',
      'Festival posts, comparison videos, placed text on pictures',
      'A call to action per funnel, with a per-post override',
    ],
  },
  agency: {
    tag: 'Many brands, your own keys',
    lead: 'Everything in Growth, plus',
    lines: [
      'Your own OpenAI, Claude, Kling, MiniMax and ElevenLabs keys (you pay the providers)',
      'Optionally your own Post for Me key',
      'Cost log per funnel, to bill your own clients',
      'Priority support',
    ],
  },
};

const FEATURE_GROUPS = [
  {
    id: 'make',
    title: 'Make the post',
    items: [
      ['Claude writes the copy', 'Caption, hook and picture prompt from Claude, written against a background you paste once per funnel. OpenAI draws the pictures.'],
      ['Placed picture text', 'The picture is drawn with no text, then Claude places the audience eyebrow, headline and sub-head in its empty space, so words never sit on a face.'],
      ['Thumbnails in every size', '16:9, 9:16 and 4:5 for every platform you post to, with the tall ones drawn as their own picture instead of cropped. An audience tag sits above the headline and still reads at 160 px.'],
      ['Your own thumbnail headline', 'Type a headline for a ready video and it is used as is; leave it blank and the AI writes one.'],
      ['End card', 'A closing card with your call to action on every ready video.'],
      ['Comparison videos', 'Thumbnail and copy built from a facts list you keep in Settings, with no AI picture to get the numbers wrong.'],
      ['Festival posts', 'Posts for the festivals that matter to your audience, made in your own style.'],
      ['Music with credits', 'One Music box: a Drive folder of tracks, each with a same-name .txt credit that goes on the last line of the caption.'],
    ],
  },
  {
    id: 'check',
    title: 'Check it before it goes out',
    items: [
      ['Clean check', 'One switch. Off posts your video as is; on has the AI check each video, including its ending in the window you choose (15 s by default).'],
      ['Transcript gate and glossary', 'Each ready video is transcribed and checked against your glossary, so names and terms are spelled your way.'],
      ['Approve from the app', 'Review and Approve buttons in the Library. Approving runs the Clean check once, then schedules.'],
      ['Disapprove and Remake', 'Give a reason, get a one-minute hold to change your mind, then Remake or send Video corrections. The lane reruns and learns the lesson for next time.'],
      ['Empty reviews refused', 'A script review with nothing in it is refused, so a blank click never approves a bad post.'],
      ['One daily digest', 'One email per address after 20:00 IST with everything that went live, failed or waits for you, instead of an email per post.'],
    ],
  },
  {
    id: 'publish',
    title: 'Publish everywhere',
    items: [
      ['Per-channel results', 'Every channel gets its own ✅ or ❌, its post link and its first-comment status on the Log.'],
      ['Scheduled is not posted', 'A post only counts as live when the platform says so, and you get told when it is.'],
      ['Retry failed only', 'One button re-sends just the channels that failed; the ones that worked are left alone.'],
      ['Link as the first comment', 'Your link is posted as the first comment on every channel that allows it.'],
      ['Smart step-down', 'Threads and X get the video, then image and text, then text, and skip a video longer than they take (5 min on Threads, 20 min on X).'],
      ['Take down a post', 'Tick the channels and press Delete once: the post comes off each platform through its own API.'],
    ],
  },
  {
    id: 'leads',
    title: 'Turn comments into leads',
    items: [
      ['Comment-to-DM capture', 'Someone comments your keyword on Instagram or Facebook and gets a DM with their own personal link.'],
      ['Lead visits', 'A small script on your landing page marks each DM\'d lead who opens their link, right on the Leads page.'],
      ['Call to action per funnel', 'Each funnel has its own call to action, and any single post can override it.'],
      ['Several landing pages', 'Point different funnels and posts at different pages.'],
    ],
  },
  {
    id: 'run',
    title: 'Run it like a business',
    items: [
      ['Funnels', 'One funnel per brand or audience, each with its own name, channels, background, call to action and Daily time. Rename one any time.'],
      ['Stock counts', 'The Funnels page shows ready videos, ready thumbnails and image posts left per funnel, counted the way the router picks them.'],
      ['Real cost per post', 'Every AI step records what it really cost. Log and cost shows it per post, and keeps the cost of posts you delete.'],
      ['Balance strip', 'Live balances for Kling, Runway and ElevenLabs, and typed balance minus recorded spend for OpenAI, Claude and MiniMax, on one line.'],
      ['Key history', 'Every change to a paid key is recorded, so you can see when each key was set or replaced.'],
      ['Workspaces and users', 'Each client is its own workspace with its own accounts, keys and posts, kept apart. Users have roles and plan end dates.'],
      ['Connect from the app', 'Google Drive, Gmail and your social accounts connect from Settings. No setup files, no developer needed.'],
      ['Indian dates and IST', 'Every date reads DD-MM-YYYY and every time is IST, in the app, emails and exports.'],
    ],
  },
];

const LANES = [
  {
    n: 'Lane 1',
    name: 'Ready video',
    text: 'Drop your own videos in a Drive folder. They go out in serial-number order from the file name, then A to Z, never by upload date. Each gets AI copy, thumbnails in every size, an end card and the Clean check, and is renamed POSTED when it is live.',
  },
  {
    n: 'Lane 2',
    name: 'AI video',
    text: 'No video? The lane writes a script, draws the pictures, animates them (Kling, Runway or MiniMax Hailuo) and voices them with ElevenLabs. If an animation fails, the same post steps down to an image post from its own still.',
  },
  {
    n: 'Lane 3',
    name: 'Image post',
    text: 'A picture in three sizes, turned into a voiced video with your music, so it plays as a Reel, a Short and a feed post. On YouTube it goes out as a 10-second Short.',
  },
];

const STEPS = [
  ['Connect', 'Sign in, connect Google Drive and your social accounts from Settings.'],
  ['Set up a funnel', 'Name it, paste your background, pick channels, a call to action and a Daily time (19:00 by default).'],
  ['Stock it', 'Drop ready videos in Drive, or let the AI lanes make posts for you.'],
  ['Approve', 'Review in the app or from the email. Approve, or Disapprove with a reason and Remake.'],
  ['It posts', 'The router wakes once a day, picks the best lane, publishes to every channel and sends your digest.'],
];

const FAQ = [
  ['Will it really post every day?', 'Yes. The router wakes each workspace once a day at its Daily time and always posts: a ready video first, then an AI video, then an image post if nothing else is in stock.'],
  ['Does anything go out without me?', 'Only what you approve. Every post waits in the Library for Approve, and the daily digest tells you what is waiting.'],
  ['How many channels can I connect?', `As many as your plan allows: any number of accounts across ${CHANNELS.join(', ')}. Each funnel posts to all of its channels from one approval.`],
  ['Do I need my own AI keys?', 'Not on Starter or Growth: the AI is included. On Agency you bring your own OpenAI, Claude, Kling, MiniMax and ElevenLabs keys and pay those providers directly.'],
  ['What happens when a channel fails?', 'That channel shows ❌ on the Log with the reason. Press Retry failed only and just that channel is sent again.'],
  ['Can I remove a post after it is live?', 'Yes. Tick the channels and press Delete once; the post is taken down from each platform.'],
  ['What can the app see in my Google Drive?', 'Only the files it creates itself (the drive.file permission). Your other files stay private. See the privacy policy.'],
  ['What if I go over my plan?', 'The app tells you before you go over. Add 30 more posts for ₹999, or an extra AI video for ₹349.'],
];

const HOME_CSS = `
 :root{color-scheme:dark;--bg:#0b0b12;--card:#13131f;--line:#24243a;--text:#e8e8ef;--mute:#9a9ab0;--blue:#2d6cdf;--link:#7aa2ff;--green:#3ecf8e}
 *{box-sizing:border-box}html{scroll-behavior:smooth}
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--text);line-height:1.6}
 a{color:var(--link)}
 .wrap{max-width:1120px;margin:0 auto;padding:0 20px}
 nav.top{position:sticky;top:0;z-index:5;background:rgba(11,11,18,.88);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
 nav.top .wrap{display:flex;align-items:center;gap:1.4rem;height:60px}
 .brand{font-weight:800;font-size:1.15rem;color:#fff;text-decoration:none;margin-right:auto}
 .links a{color:var(--mute);text-decoration:none;font-size:.92rem;margin-left:1.1rem}
 .links a:hover{color:#fff}
 .btn{background:var(--blue);color:#fff;border-radius:10px;padding:.7rem 1.25rem;text-decoration:none;font-weight:650;display:inline-block;border:1px solid var(--blue)}
 .btn.ghost{background:transparent;border-color:var(--line);color:var(--text)}
 .btn.sm{padding:.45rem .9rem;font-size:.9rem}
 .hero{padding:5rem 0 3.5rem;text-align:center}
 .pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:.25rem .8rem;font-size:.82rem;color:var(--mute);margin-bottom:1.2rem}
 .hero h1{font-size:clamp(2rem,5vw,3.4rem);line-height:1.12;margin:0 auto 1rem;max-width:820px;letter-spacing:-.02em}
 .hero h1 em{font-style:normal;color:var(--link)}
 .hero p.lead{font-size:1.15rem;color:var(--mute);max-width:680px;margin:0 auto 2rem}
 .cta{display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap}
 .chips{display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap;margin-top:2.4rem}
 .chip{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.3rem .75rem;font-size:.88rem}
 section{padding:4rem 0;border-top:1px solid var(--line)}
 h2{font-size:clamp(1.5rem,3vw,2.1rem);margin:0 0 .5rem;letter-spacing:-.01em}
 .kicker{color:var(--mute);margin:0 0 2.2rem;max-width:720px}
 .grid{display:grid;gap:1rem}
 .g3{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
 .g5{grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}
 .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.3rem}
 .card h3{margin:.1rem 0 .4rem;font-size:1.05rem}
 .card p{margin:0;color:var(--mute);font-size:.95rem}
 .num{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:var(--blue);color:#fff;font-weight:700;font-size:.9rem;margin-bottom:.6rem}
 .lane .tag{color:var(--link);font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
 .group{margin-top:2.6rem}
 .group h3.gt{font-size:1.2rem;margin:0 0 1rem}
 .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1rem;margin-top:2rem}
 .stat{border-left:3px solid var(--blue);padding-left:.9rem}
 .stat b{display:block;font-size:1.6rem}
 .stat span{color:var(--mute);font-size:.9rem}
 .plans{grid-template-columns:repeat(auto-fit,minmax(290px,1fr));align-items:stretch}
 .plan{display:flex;flex-direction:column}
 .plan.best{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}
 .plan .badge{align-self:flex-start;background:var(--blue);color:#fff;font-size:.75rem;font-weight:700;border-radius:999px;padding:.15rem .6rem;margin-bottom:.6rem}
 .plan .price{font-size:2.1rem;font-weight:800;margin:.4rem 0 0}
 .plan .price small{font-size:.95rem;color:var(--mute);font-weight:500}
 .plan .ptag{color:var(--mute);margin:0 0 1rem}
 .plan ul{list-style:none;padding:0;margin:0 0 1.4rem;flex:1}
 .plan li{padding:.32rem 0 .32rem 1.5rem;position:relative;font-size:.93rem}
 .plan li:before{content:"✓";position:absolute;left:0;color:var(--green);font-weight:700}
 .plan li.lim{color:#fff}
 .plan li.head{padding-left:0;color:var(--mute);font-weight:600}
 .plan li.head:before{content:""}
 .plan .btn{text-align:center}
 .fine{color:var(--mute);font-size:.9rem;margin-top:1.4rem}
 details{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem 1.2rem;margin-bottom:.7rem}
 summary{cursor:pointer;font-weight:650}
 details p{margin:.7rem 0 0;color:var(--mute)}
 .final{text-align:center}
 footer{border-top:1px solid var(--line);padding:2rem 0;color:#6f6f88;font-size:.88rem}
 footer .wrap{display:flex;gap:1.2rem;flex-wrap:wrap;align-items:center}
 footer .wrap span{margin-right:auto}
 .tbl{overflow-x:auto;border:1px solid var(--line);border-radius:14px}
 table{border-collapse:collapse;width:100%;font-size:.92rem}
 th,td{padding:.7rem .85rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
 thead th{background:var(--card);position:sticky;top:0;font-weight:700;white-space:nowrap}
 thead th a{color:#fff;text-decoration:none}thead th a:hover{color:var(--link)}
 th.us,td.us{background:rgba(45,108,223,.10)}
 tbody tr:last-child td{border-bottom:0}
 td.c{text-align:center;white-space:nowrap}
 .y{color:var(--green);font-weight:800}.p{color:#e0b23a;font-weight:800}.n{color:#ef6b6b;font-weight:800}.u{color:var(--mute)}
 tr.grp td{background:#0f0f19;color:var(--mute);font-weight:700;text-transform:uppercase;font-size:.75rem;letter-spacing:.06em}
 td small{display:block;color:var(--mute);font-size:.82rem;margin-top:.15rem}
 .legend{color:var(--mute);font-size:.85rem;margin-top:.8rem}
 .vs h3{display:flex;justify-content:space-between;align-items:center;gap:.5rem}
 .vs .cat{color:var(--mute);font-size:.8rem;font-weight:500}
 .crumb{color:var(--mute);font-size:.9rem;margin-bottom:1rem}.crumb a{color:var(--mute)}
 .win{border-left:3px solid #e0b23a}
 .money{border-left:3px solid var(--green)}
 @media (max-width:760px){.links{display:none}.hero{padding:3.5rem 0 2.5rem}section{padding:3rem 0}}
`;

/** Plan-button target: a prefilled email to the contact, or sign-in without one. */
export function contactHrefFor(email = '') {
  return (plan) => (email
    ? `mailto:${esc(email)}?subject=${encodeURIComponent(`Content Engine: ${plan} plan`)}`
    : LOGIN_PATH);
}

/** <head> and the opening <body> shared by the landing and comparison pages. */
export function landingHead(title, description) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<style>${HOME_CSS}</style></head><body>`;
}

/** Top bar. `base` is '' on the home page (same-page anchors) and '/' elsewhere. */
export function landingNav(base = '') {
  return `<nav class="top"><div class="wrap">
  <a class="brand" href="/">Content Engine</a>
  <span class="links"><a href="${base}#how">How it works</a><a href="${base}#features">Features</a><a href="${base}#pricing">Pricing</a><a href="${base}#faq">FAQ</a></span>
  <a class="btn sm" href="${LOGIN_PATH}">Sign in</a>
</div></nav>`;
}

/** Footer and the closing tags. */
export function landingFooter(email = '') {
  return `<footer><div class="wrap"><span>Content Engine</span><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a>${email ? `<a href="mailto:${esc(email)}">Contact</a>` : ''}</div></footer>
</body></html>`;
}

function planCard(id, contactHref) {
  const lim = PLANS[id];
  const f = PLAN_FEATURES[id];
  const many = (n, one, other) => (n === null ? `Unlimited ${other}` : `${n} ${n === 1 ? one : other}`);
  const limits = [
    many(lim.funnels, 'funnel (brand)', 'funnels (brands)'),
    lim.channels === null ? 'Unlimited channels' : `${lim.channels} channels per funnel`,
    `${lim.posts === null ? 'Unlimited' : lim.posts} posts a month`,
    lim.aiVideos === null ? 'AI videos as your keys allow' : lim.aiVideos === 0 ? 'No AI videos' : `${lim.aiVideos} AI videos a month`,
    many(lim.users, 'user', 'users'),
  ];
  const best = id === 'growth';
  return `<div class="card plan${best ? ' best' : ''}">
  ${best ? '<span class="badge">Most popular</span>' : ''}
  <h3>${esc(lim.label)}</h3>
  <p class="price">₹${inr(lim.priceInr)}<small> / month${id === 'agency' ? ' + your own AI keys' : ''}</small></p>
  <p class="ptag">${esc(f.tag)}</p>
  <ul>
    ${limits.map((l) => `<li class="lim">${esc(l)}</li>`).join('')}
    ${f.lead ? `<li class="head">${esc(f.lead)}</li>` : ''}
    ${f.lines.map((l) => `<li>${esc(l)}</li>`).join('')}
  </ul>
  <a class="btn${best ? '' : ' ghost'}" href="${contactHref(lim.label)}">${id === 'starter' ? 'Start the 7-day trial' : `Choose ${esc(lim.label)}`}</a>
</div>`;
}

/**
 * The public home (landing) page. `email` is the contact address for the plan
 * buttons ('' = they open sign-in instead, since there is no self sign-up).
 */
export function homePage({ email = '' } = {}) {
  const contactHref = contactHrefFor(email);
  const trialHref = contactHref('Starter trial');
  const cards = (items) => items.map(([t, p]) => `<div class="card"><h3>${esc(t)}</h3><p>${esc(p)}</p></div>`).join('');

  return `${landingHead('Content Engine: a post every day on every channel, made and published for you',
    `Content Engine makes, checks and publishes one post a day per brand to ${CHANNELS.join(', ')}. Ready videos, AI videos and image posts, approved by you, with comment-to-DM lead capture.`)}
${landingNav('')}

<header class="hero"><div class="wrap">
  <span class="pill">One post a day, per brand, on every channel</span>
  <h1>Your social media, <em>made, checked and posted</em> every single day.</h1>
  <p class="lead">Content Engine turns your videos, or nothing at all, into finished posts with copy, thumbnails, voice and music. You approve. It publishes to every channel, reports what went live and turns comments into leads.</p>
  <div class="cta"><a class="btn" href="${trialHref}">Start the 7-day trial</a><a class="btn ghost" href="#pricing">See pricing</a></div>
  <div class="chips">${CHANNELS.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
</div></header>

<section id="how"><div class="wrap">
  <h2>How it works</h2>
  <p class="kicker">Set it up once. After that, the only daily job left is pressing Approve.</p>
  <div class="grid g5">${STEPS.map(([t, p], i) => `<div class="card"><span class="num">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(p)}</p></div>`).join('')}</div>
  <div class="stats">
    <div class="stat"><b>3 lanes</b><span>so a day is never skipped</span></div>
    <div class="stat"><b>Any number</b><span>of channels your plan allows, from one approval</span></div>
    <div class="stat"><b>3 sizes</b><span>16:9, 9:16 and 4:5, for every platform</span></div>
    <div class="stat"><b>1 email</b><span>a day, after 20:00 IST</span></div>
  </div>
</div></section>

<section id="lanes"><div class="wrap">
  <h2>Three lanes, one post a day</h2>
  <p class="kicker">The daily router tries each lane in turn and always posts: your ready video first, then an AI video, then an image post.</p>
  <div class="grid g3">${LANES.map((l) => `<div class="card lane"><span class="tag">${esc(l.n)}</span><h3>${esc(l.name)}</h3><p>${esc(l.text)}</p></div>`).join('')}</div>
</div></section>

<section id="features"><div class="wrap">
  <h2>Everything it does</h2>
  <p class="kicker">Every feature below is built and in the app today.</p>
  ${FEATURE_GROUPS.map((g) => `<div class="group" id="f-${g.id}"><h3 class="gt">${esc(g.title)}</h3><div class="grid g3">${cards(g.items)}</div></div>`).join('')}
</div></section>

<section id="pricing"><div class="wrap">
  <h2>Pricing</h2>
  <p class="kicker">One post means one post on all its channels. AI is included on Starter and Growth.</p>
  <div class="grid plans">${['starter', 'growth', 'agency'].map((id) => planCard(id, contactHref)).join('')}</div>
  <p class="fine">All plans: over the limit, ₹999 for 30 more posts and ₹349 per extra AI video. Pay yearly: 10 months, get 12. Start with a 7-day trial of Starter. Prices in Indian rupees, per workspace.</p>
</div></section>

<section id="faq"><div class="wrap">
  <h2>Questions</h2>
  <p class="kicker">The short answers.</p>
  ${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}
</div></section>

<section class="final"><div class="wrap">
  <h2>Stop making posts. Start revenue from posts.</h2>
  <p class="kicker" style="margin:0 auto 1.6rem">Seven days free on Starter. Access is by invitation: ask, and your workspace is set up for you.</p>
  <div class="cta"><a class="btn" href="${trialHref}">Start the 7-day trial</a><a class="btn ghost" href="${LOGIN_PATH}">Sign in</a></div>
</div></section>

${landingFooter(email)}`;
}

/** The privacy policy. `email` is the contact address ('' = "the site owner"). */
export function privacyPage({ email = '' } = {}) {
  return shell('Privacy policy: Content Engine', `
<h1>Privacy policy</h1>
<p class="sub">Last updated ${UPDATED}</p>
<p>Content Engine is an invite-only tool used to create and schedule social media posts for the brands of the people it invites. This page explains what it stores and why.</p>
<h2>What we collect</h2>
<ul>
  <li><b>Account details:</b> the email address and a hashed password of each invited user.</li>
  <li><b>Content:</b> the scripts, captions, images, videos and schedules made in the app.</li>
  <li><b>Connected services:</b> keys and tokens for services the owner connects (for example Google Drive, Post for Me and AI providers), stored to do the work the owner asks for.</li>
  <li><b>Basic logs:</b> request logs used to run and debug the service.</li>
</ul>
<h2>Google user data</h2>
<p>When you press "Connect Google Drive", the app asks for the <b>drive.file</b> permission only. It can see and change only the files the app itself creates in your Drive (finished and cleaned videos in a "content-engine clean" folder), not your other files. It uses them to store videos until they are posted, then deletes them.</p>
<p>Content Engine's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Google user data is not sold, not used for advertising, not used to train AI models, and not shared with anyone except to provide the features described here.</p>
<h2>How it is used and shared</h2>
<p>Data is used only to make, approve and publish your posts. It is sent to the services that do that work (AI generation providers, Post for Me for publishing, the email provider for approval emails), and nowhere else. We do not sell personal data.</p>
<h2>Keeping and deleting data</h2>
<p>Data is kept while the account is active. You can disconnect Google Drive at any time in the app's Settings, or revoke access in your Google Account. To have your data deleted, write to ${contactLine(email)}.</p>
<h2>Contact</h2>
<p>Questions about this policy: ${contactLine(email)}.</p>`);
}

/** The terms of service. */
export function termsPage({ email = '' } = {}) {
  return shell('Terms of service: Content Engine', `
<h1>Terms of service</h1>
<p class="sub">Last updated ${UPDATED}</p>
<p>Content Engine is available only to people the owner invites and sets up a workspace for. By signing in you agree to these terms.</p>
<h2>Use</h2>
<ul>
  <li>Use it only for content you have the right to publish.</li>
  <li>You are responsible for the posts you approve and for following the rules of each social platform.</li>
  <li>Keep your sign-in details private.</li>
</ul>
<h2>Service</h2>
<p>The service is provided as is, without warranties. It depends on third-party services (AI providers, Google, Post for Me, social networks) and may change, pause or stop at any time. We are not liable for lost posts, data or revenue to the extent the law allows.</p>
<h2>Access</h2>
<p>The owner may remove access at any time. You may stop using it at any time and ask for your data to be deleted (see the <a href="/privacy">privacy policy</a>).</p>
<h2>Contact</h2>
<p>${contactLine(email)}</p>`);
}

export default { UPDATED, LOGIN_PATH, CHANNELS, PLAN_FEATURES, inr, homePage, privacyPage, termsPage };
