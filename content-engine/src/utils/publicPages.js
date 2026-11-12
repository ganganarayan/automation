/**
 * Public pages (no sign-in): home, privacy policy, terms of service,
 * refund and cancellation policy, shipping and delivery policy.
 *
 * Purpose:      What the bare domain shows before sign-in, and the two policy
 *               pages Google's OAuth consent screen (Branding) links to, so the
 *               Google sign-in for "Connect Google Drive" can be published.
 *               The Sign in button opens the app on the same domain.
 * Responsibility: Pure HTML rendering (no settings / DB / I/O).
 * Dependencies: utils/planSpec (plan limits and prices), utils/compareData (competitors), both pure.
 *
 * Routes (app.js): GET /  ·  GET /privacy  ·  GET /terms  ·  GET /refund  ·  GET /shipping
 */

import { PLANS, GST_NOTE, EXTRAS, withGst } from './planSpec.js';
import { CHECKED_ON, VERDICT, COMPETITORS, usFor, rowsFor, competitorsFor } from './compareData.js';

export const UPDATED = '11-11-2026';
export const LOGIN_PATH = '/api/v1/admin/today';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "+ GST" beside a price, in the same text as the price. */
export const GST_HTML = GST_NOTE;

/** Escape text ("+ GST" reads as normal text). */
export const escGst = (s) => esc(s);

/** A dollar price. */
export const usd = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;

/** A dollar price that may carry cents ($1.50). */
export const usdc = (n) => (Number(n) % 1 ? `$${Number(n).toFixed(2)}` : usd(n));

/** 'inr' or 'usd' (anything else is usd). */
export const curOf = (c) => (c === 'inr' ? 'inr' : 'usd');

export function shell(title, inner) {
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
<footer><span>Content Engine</span><a href="/compare">Compare</a><a href="/kb">Help</a><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="/refund">Refund policy</a><a href="/shipping">Shipping policy</a></footer>
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

/**
 * The offer, sold as what it solves: what a business wants, what the app does
 * about it, and what it would pay for that without us (inr, usd a month; null =
 * included, nothing to compare). Anchors: a content freelancer at the low end,
 * Buffer for 10 channels, ManyChat Essential (compareData).
 */
export const VALUE_STACK = [
  { want: 'Content every day, without hiring', does: '30 finished posts a month per funnel: copy, a picture in every size, a voiced video with music, made from your videos or from nothing', costs: 'A content freelancer', inr: 15000, usd: 180 },
  { want: 'Be everywhere your buyers scroll', does: '10 channels per funnel, all from one approval', costs: 'Buffer for 10 channels', inr: 5280, usd: 60 },
  { want: 'Comments that turn into sales', does: 'Comment-to-DM on Instagram and Facebook, a personal link for each lead, your link as the first comment', costs: 'ManyChat', inr: 1500, usd: 17 },
  { want: 'Never go silent', does: 'The router triggers once a day and always posts; festival posts arrive on time', costs: '', inr: null, usd: null },
  { want: 'Stay in control in 10 seconds a day', does: 'Approve from your phone or the daily email; Disapprove and Remake learns your voice', costs: '', inr: null, usd: null },
  { want: 'Fix a mistake fast', does: 'Delete a post from every channel in one click', costs: '', inr: null, usd: null },
  { want: 'Stand out', does: 'Comparison videos, placed text on pictures, YouTube Shorts from every image post', costs: '', inr: null, usd: null },
];

/** What the stack would cost a month without us. */
export const STACK_TOTAL = {
  inr: VALUE_STACK.reduce((t, r) => t + (r.inr || 0), 0),
  usd: VALUE_STACK.reduce((t, r) => t + (r.usd || 0), 0),
};

/** Why saying yes is easy (no promise here that the app does not keep). */
export const BONUSES = [
  ['7 days free', 'Try every feature for a week before the first charge.'],
  ['Done-with-you setup', 'A 30-minute call: we connect your channels and set up your first funnel with you.'],
  ['Founding price', 'The first 50 businesses keep this price for as long as they stay.'],
  ['Cancel in one click', 'In the app, under Plan. No notice period, no fee.'],
];

/** The two plan cards. */
export const PLAN_FEATURES = {
  brand: {
    tag: 'One brand, posting every day, everywhere',
    lines: [
      'Everything in the list above',
      'Ready video lane: AI copy, headline thumbnail in every size, end card, Clean check',
      'Image posts as voiced videos with music',
      'A call to action per funnel, with a per-post override',
      'Connect your accounts from the app',
    ],
  },
  agency: {
    tag: 'Every client on the same promise',
    lead: 'Everything in Always-On Brand, per client, plus',
    lines: [
      'Client logins: an owner who acts, or a viewer who only looks',
      'Your team on one sign-in across clients',
      'Cost per client, to bill your own clients',
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
      ['One daily digest', 'One email per address each evening with everything that went live, failed or waits for you, instead of an email per post.'],
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
      ['Dates that read right', 'Every date reads day first (DD-MM-YYYY) and every time is 24-hour, in the app, emails and exports.'],
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
  ['It posts', 'The router triggers once a day, picks the best lane, publishes to every channel and sends your digest.'],
];

const FAQ = [
  ['Will it really post every day?', 'Yes. The router triggers once a day for each workspace, at its Daily time, and always posts: a ready video first, then an AI video, then an image post if nothing else is in stock.'],
  ['Does anything go out without me?', 'Only what you approve. Every post waits in the Library for Approve, and the daily digest tells you what is waiting.'],
  ['How many channels can I connect?', `10 channels per funnel, across ${CHANNELS.join(', ')}. Each funnel posts to all of its channels from one approval.`],
  ['Do I need my own AI keys?', 'No. The AI is included in every plan, Agency too. An agency may still add its own keys to pay those providers directly.'],
  ['Why one plan?', 'Because every business needs the same thing: a post every day on every channel, and comments that turn into customers. You pay per funnel (brand), with 10 channels each, so one brand pays for one and five brands pay for five.'],
  ['What happens when a channel fails?', 'That channel shows ❌ on the Log with the reason. Press Retry failed only and just that channel is sent again.'],
  ['Can I remove a post after it is live?', 'Yes. Tick the channels and press Delete once; the post is taken down from each platform.'],
  ['What can the app see in my Google Drive?', 'Only the files it creates itself (the drive.file permission). Your other files stay private. See the privacy policy.'],
];

/** The questions that carry a price, in the visitor's currency. */
function faqFor(cur) {
  if (cur === 'usd') {
    return [...FAQ,
      ['What if I go over my plan?', `The app tells you before you go over. Add 30 more posts for ${usd(EXTRAS.posts30.usd)}, an AI video for ${usd(EXTRAS.aiVideo.usd)}, or another user for ${usdc(EXTRAS.user.usd)} a month.`],
      ['What currency do I pay in?', 'US dollars, by card, renewing monthly or yearly until you cancel.'],
    ];
  }
  return [...FAQ,
    ['What if I go over my plan?', `The app tells you before you go over. Add 30 more posts for ₹${inr(EXTRAS.posts30.inr)} + GST, an AI video for ₹${inr(EXTRAS.aiVideo.inr)} + GST, or another user for ₹${inr(EXTRAS.user.inr)} + GST a month.`],
    ['Are prices with GST?', 'Prices are shown before GST, with the total beside each one: 18% GST is added and shown on your GST invoice, so a GST-registered business can claim it back.'],
  ];
}

/** Before and after: our own words for what changes on day one. */
const BEFORE = [
  'Hunting for tonight\'s post idea at 11 pm',
  'Resizing one picture three times',
  'Pasting the same link under every post',
  'Price questions in the comments, answered days late',
];
const AFTER = [
  'Tomorrow\'s post made and waiting for Approve',
  'Every size made for every platform',
  'Your link in the first comment, everywhere',
  'Every keyword comment gets a DM with a link',
];

/** "See it in action": each scene is a phone chat and a note beside it. */
const SCENES = [
  {
    tab: 'A comment becomes a lead',
    who: 'Your Instagram post',
    chat: [['in', 'priya_k: PRICE'], ['sys', 'Comment matched your keyword'], ['out', 'Hi Priya! Here is your link with today\'s offer:'], ['out', 'yourbrand.in/p/priya-7f3'], ['sys', 'Priya opened the link. The Leads page marks her.']],
    note: ['Comments turn into contacts', 'Someone comments your keyword and gets a DM with their own link. When they open it, the Leads page shows who it was, so you follow up the warm ones first.'],
  },
  {
    tab: 'A raw video becomes a post',
    who: 'Your Drive folder',
    chat: [['in', '07 Morning routine.mp4 added'], ['sys', 'Transcribed and checked against your glossary'], ['out', 'Caption, hook and hashtags written'], ['out', 'Thumbnails drawn: 16:9, 9:16 and 4:5'], ['sys', 'Waiting for your Approve']],
    note: ['Drop a video, get a post', 'Put your videos in a Drive folder. Each one gets copy, a thumbnail in every size, an end card and a Clean check, then waits for your Approve.'],
  },
  {
    tab: 'Nothing in stock today',
    who: 'The daily router, 19:00',
    chat: [['sys', 'No ready video left in this funnel'], ['out', 'Script written from your background'], ['out', 'Pictures drawn, animated and voiced'], ['sys', 'Animation failed? The same post goes out as an image post.'], ['out', 'Posted on all your channels ✓']],
    note: ['A day is never skipped', 'When you have nothing new, the router makes an AI video or an image post instead, so every funnel posts every day.'],
  },
  {
    tab: 'A post went out wrong',
    who: 'The Log',
    chat: [['in', 'Instagram ✓  Facebook ✓  X ✗'], ['out', 'Retry failed only'], ['sys', 'X ✓, the others left alone'], ['in', 'Wrong price in the caption?'], ['out', 'Tick the channels, press Delete once'], ['sys', 'Taken down everywhere']],
    note: ['Fix it in one click', 'Each channel shows its own result. Re-send only what failed, or take a post down from every channel at once.'],
  },
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
 .hero h1{font-size:clamp(2rem,5vw,3.4rem);font-weight:900;line-height:1.08;margin:0 auto 1rem;max-width:900px;letter-spacing:-.03em}
 .hero p.subhead{font-size:clamp(1.15rem,2.6vw,1.45rem);font-weight:700;max-width:720px;margin:0 auto 1rem}
 .hero h1 em{font-style:normal;color:var(--link)}
 .hero p.lead{font-size:1.15rem;color:var(--mute);max-width:680px;margin:0 auto 2rem}
 .cta{display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap}
 .chips{display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap;margin-top:2.4rem}
 .chip{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.3rem .75rem;font-size:.88rem}
 section{padding:4rem 0;border-top:1px solid var(--line)}
 h2{font-size:clamp(1.7rem,4vw,2.7rem);font-weight:900;line-height:1.1;margin:0 0 .6rem;letter-spacing:-.025em}
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
 .plans{grid-template-columns:repeat(auto-fit,minmax(250px,1fr));align-items:stretch}
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
 .tbl{position:relative;overflow-x:auto;border:1px solid var(--line);border-radius:14px}
 table{border-collapse:collapse;width:100%;font-size:.92rem}
 th,td{padding:.7rem .85rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
 thead th{background:var(--card);position:sticky;top:0;font-weight:700;white-space:nowrap}
 thead th a{color:#fff;text-decoration:none}thead th a:hover{color:var(--link)}
 th.us,td.us{background:rgba(45,108,223,.10)}
 tbody tr:last-child td{border-bottom:0}
 td.c{text-align:center;white-space:nowrap}
 tbody td:first-child{min-width:260px}
 .y{color:var(--green);font-weight:800}.p{color:#e0b23a;font-weight:800}.n{color:#ef6b6b;font-weight:800}.u{color:var(--mute)}
 tr.grp td{background:#0f0f19;color:var(--mute);font-weight:700;text-transform:uppercase;font-size:.75rem;letter-spacing:.06em}
 td small{display:block;color:var(--mute);font-size:.82rem;margin-top:.15rem}
 .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
 .legend{color:var(--mute);font-size:.85rem;margin-top:.8rem}
 .vs h3{display:flex;justify-content:space-between;align-items:center;gap:.5rem}
 .vs .cat{color:var(--mute);font-size:.8rem;font-weight:500}
 .crumb{color:var(--mute);font-size:.9rem;margin-bottom:1rem}.crumb a{color:var(--mute)}
 .win{border-left:3px solid #e0b23a}
 .money{border-left:3px solid var(--green)}
 .trust{display:flex;gap:1.4rem;justify-content:center;flex-wrap:wrap;margin-top:1.6rem;color:var(--mute);font-size:.9rem}
 .trust b{color:#fff}
 .ba{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem}
 .ba .side{border-radius:18px;padding:2rem 1.6rem}
 .ba .before{background:#15151f;border:1px solid var(--line)}
 .ba .after{background:#0f5132;border:1px solid #1d7a4f}
 .ba .lab{font-size:.85rem;font-weight:700;color:var(--mute);text-align:center}
 .ba .after .lab{color:#b9f0d3}
 .ba h3{font-size:clamp(1.6rem,3.5vw,2.3rem);font-weight:900;text-align:center;margin:.3rem 0 1.4rem;line-height:1.1;letter-spacing:-.02em}
 .ba ul{list-style:none;padding:0;margin:0}
 .ba li{display:flex;justify-content:space-between;gap:1rem;padding:.75rem 0;border-top:1px solid rgba(255,255,255,.08);font-size:.92rem;text-transform:uppercase;letter-spacing:.03em}
 .ba li span.m{font-weight:900}
 .ba .before li span.m{color:#ef6b6b}.ba .after li span.m{color:#7ff0b4}
 .act-wrap{display:grid;grid-template-columns:minmax(260px,330px) 1fr;gap:1.2rem;background:#2b2f8f;border-radius:20px;padding:1.2rem}
 .act-tabs{background:var(--bg);border-radius:14px;padding:1.2rem}
 .act-tabs h3{font-size:1.5rem;font-weight:900;margin:0 0 .8rem}
 .act-tab{display:block;width:100%;text-align:left;background:none;border:0;color:var(--text);padding:.8rem .7rem;border-radius:10px;cursor:pointer;font:inherit}
 .act-tab small{display:block;color:var(--mute);font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;margin-top:.2rem}
 .act-tab.on{background:#1c1c2b}
 .act-stage{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:1.4rem;align-items:center;padding:.6rem}
 .phone{background:#000;border-radius:34px;padding:1.2rem .9rem;min-height:440px;border:6px solid #111;box-shadow:0 20px 50px rgba(0,0,0,.4)}
 .phone .who{color:#fff;font-weight:700;font-size:.9rem;margin:.2rem .3rem 1rem}
 .bub{border-radius:16px;padding:.55rem .8rem;margin:.45rem 0;font-size:.86rem;max-width:88%;line-height:1.35}
 .bub.in{background:#26262f;color:#e8e8ef}
 .bub.out{background:#6b4cf6;color:#fff;margin-left:auto}
 .bub.sys{background:none;color:#8a8aa2;font-size:.75rem;text-align:center;max-width:100%}
 .act-note{color:#e6e8ff;font-size:1rem;border-left:2px solid #c9ceff;padding-left:1rem}
 .act-note b{display:block;font-size:1.25rem;margin-bottom:.4rem;color:#fff}
 .act-pane{display:none}.act-pane.on{display:contents}
 .billing{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:.25rem;margin:0 0 1.6rem;position:relative}
 .billing button{background:none;border:0;color:var(--mute);font:inherit;font-weight:700;padding:.45rem 1.1rem;border-radius:999px;cursor:pointer;letter-spacing:.04em;font-size:.85rem}
 .billing button.on{background:#fff;color:#0b0b12}
 .billing .save{position:absolute;top:-1.3rem;right:-.4rem;background:var(--green);color:#06210f;font-size:.72rem;font-weight:800;border-radius:6px;padding:.1rem .45rem}
 .plan .yr{display:none}.yearly .plan .yr{display:block}.yearly .plan .mo{display:none}
 .plan .bill{color:var(--mute);font-size:.85rem;margin:.15rem 0 0}
 .toggles{display:flex;flex-wrap:wrap;justify-content:center;gap:1rem;margin:1.6rem 0 .6rem}
 .toggles .billing{margin:0}
 .where{text-align:center;color:var(--mute);font-size:.9rem;margin:0 0 1.4rem}
 .plan .total{font-size:.9rem;margin:.2rem 0 0}
 .plan .trial{display:block;text-align:center;font-size:.88rem;margin-top:.5rem}
 .stack{width:100%;border-collapse:collapse;margin:0 0 2rem;font-size:.95rem}
 .stack th,.stack td{border-bottom:1px solid var(--line);padding:.7rem .6rem;text-align:left;vertical-align:top}
 .stack th{color:var(--mute);font-weight:700;font-size:.8rem;letter-spacing:.04em;text-transform:uppercase}
 .stack td:last-child{white-space:nowrap;text-align:right}.stack th:last-child{text-align:right}
 .stack td small{display:block;color:var(--mute);font-size:.78rem}
 .stack .sum td{font-weight:800;text-decoration:line-through;text-decoration-color:rgba(255,255,255,.35)}
 .stack .you td{font-weight:800;font-size:1.15rem;color:var(--green);border-bottom:0}
 .plans.two{grid-template-columns:repeat(auto-fit,minmax(280px,1fr));max-width:820px;margin:0 auto}
 .bonus{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin:2rem 0 1rem}
 .bonus div{border:1px dashed var(--line);border-radius:12px;padding:1rem}
 .bonus b{display:block;margin-bottom:.3rem}
 @media (max-width:760px){.stack thead{display:none}.stack,.stack tbody,.stack tr,.stack td{display:block;width:100%}.stack tr{border-bottom:1px solid var(--line);padding:.7rem 0}.stack td,.stack td:last-child{border:0;padding:.15rem 0;text-align:left;white-space:normal}.stack .sum,.stack .you{display:flex;justify-content:space-between;gap:1rem}.stack .sum td,.stack .you td{width:auto}}
 .float-cta{position:fixed;right:18px;bottom:18px;z-index:9;background:#f5d90a;color:#14140a;font-weight:800;border-radius:12px;padding:.85rem 1.2rem;text-decoration:none;box-shadow:0 10px 30px rgba(0,0,0,.35)}
 @media (max-width:900px){.act-wrap,.act-stage{grid-template-columns:1fr}}
 @media (max-width:760px){.links{display:none}.hero{padding:3.5rem 0 2.5rem}section{padding:3rem 0}}
`;

/** Plan-button target: a prefilled email to the contact, or sign-in without one. */
export function contactHrefFor(email = '') {
  return (plan) => (email
    ? `mailto:${esc(email)}?subject=${encodeURIComponent(`Content Engine: ${plan} plan`)}`
    : LOGIN_PATH);
}

/** <head> and the opening <body> shared by the landing and comparison pages. */
export function landingHead(title, description, extra = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">${extra}
<style>${HOME_CSS}</style></head><body>`;
}

/** Top bar. `base` is '' on the home page (same-page anchors) and '/' elsewhere. */
export function landingNav(base = '') {
  return `<nav class="top"><div class="wrap">
  <a class="brand" href="/">Content Engine</a>
  <span class="links"><a href="${base}#how">How it works</a><a href="${base}#features">Features</a><a href="${base}#pricing">Pricing</a><a href="/compare">Compare</a><a href="/kb">Help</a><a href="${base}#faq">FAQ</a></span>
  <a class="btn sm" href="${LOGIN_PATH}">Sign in</a>
</div></nav>`;
}

/** Footer and the closing tags. */
export function landingFooter(email = '') {
  return `<footer><div class="wrap"><span>Content Engine</span><a href="/kb">Help and answers</a><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="/refund">Refund policy</a><a href="/shipping">Shipping policy</a>${email ? `<a href="mailto:${esc(email)}">Contact</a>` : ''}</div></footer>
</body></html>`;
}

/** Path of one comparison page. */
export const comparePath = (c) => `/compare/content-engine-vs-${c.slug}`;

/** One verdict cell: the mark, with the note as a tooltip and screen-reader text. */
function mark([v, note]) {
  const m = VERDICT[v] || VERDICT.u;
  return `<span class="${m.cls}" title="${esc(`${m.word}: ${note}`)}">${m.sym}</span><span class="sr">${esc(m.word)}</span>`;
}

/** The full matrix: every row, Content Engine first, then each competitor. */
export function compareMatrix(list = COMPETITORS, cur = 'inr') {
  const us = usFor(cur);
  const head = `<tr><th>Feature</th><th class="us">Content Engine</th>${list.map((c) => `<th><a href="${comparePath(c)}">${esc(c.name)}</a></th>`).join('')}</tr>`;
  const body = rowsFor(cur).map((r) => (r.group
    ? `<tr class="grp"><td colspan="${list.length + 2}">${esc(r.group)}</td></tr>`
    : `<tr><td>${esc(r.label)}</td><td class="c us">${mark(us[r.key])}</td>${list.map((c) => `<td class="c">${mark(c.rows[r.key] || ['u', 'Not listed.'])}</td>`).join('')}</tr>`)).join('');
  return `<div class="tbl"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>
<p class="legend"><span class="y">✓</span> yes · <span class="p">◐</span> partly or on higher plans only · <span class="n">✗</span> no, by their own word · <span class="u">?</span> not listed on their website. Read from each company's own website on ${esc(CHECKED_ON)}. Hover a mark for the detail; each name opens the full comparison with sources.</p>`;
}

/** Cards linking to each comparison page. */
export function compareCards(list = COMPETITORS) {
  return `<div class="grid g3">${list.map((c) => `<a class="card vs" href="${comparePath(c)}" style="text-decoration:none;color:inherit"><h3>Content Engine vs ${esc(c.name)} <span class="cat">${esc(c.category)}</span></h3><p>${esc(c.oneLine)}</p></a>`).join('')}</div>`;
}

/** The landing page's comparison section. */
export function compareSection(cur = 'inr') {
  return `<section id="compare"><div class="wrap">
  <h2>Content Engine vs the rest</h2>
  <p class="kicker">Most tools schedule the post you made. Content Engine makes it, posts it every day and turns the comments into leads. Here is every feature, side by side.</p>
  ${compareMatrix(competitorsFor(curOf(cur)), cur)}
  <h3 class="gt" style="margin:2.4rem 0 1rem">Read a full comparison</h3>
  ${compareCards(competitorsFor(curOf(cur)))}
</div></section>`;
}

/**
 * A plan's price in one currency, monthly and yearly (yearly on #pricing).
 * Rupees: before 18% GST, with the total. Dollars: the price, nothing else.
 */
export function priceBlock(lim, extra = '', cur = 'inr') {
  if (curOf(cur) === 'usd') {
    const u = lim.priceUsd;
    return `<div class="mo"><p class="price">${usd(u)}<small> / month${extra}</small></p><p class="bill">Billed monthly in US dollars</p></div>
  <div class="yr"><p class="price">${usdc(Math.round((u * 10 * 100) / 12) / 100)}<small> / month${extra}</small></p><p class="total">${usd(u * 10)} a year</p><p class="bill">Billed yearly: 12 months for the price of 10</p></div>`;
  }
  const m = lim.priceInr;
  const yInr = Math.round((m * 10) / 12);
  return `<div class="mo"><p class="price">₹${inr(m)}<small> ${GST_NOTE} / month${extra}</small></p><p class="total">₹${inr(withGst(m))} a month with 18% GST</p><p class="bill">Billed monthly</p></div>
  <div class="yr"><p class="price">₹${inr(yInr)}<small> ${GST_NOTE} / month${extra}</small></p><p class="total">₹${inr(m * 10)} ${GST_NOTE} a year, ₹${inr(withGst(m * 10))} with 18% GST</p><p class="bill">Billed yearly: 12 months for the price of 10</p></div>`;
}

function planCard(id, contactHref, cur = 'inr') {
  const lim = PLANS[id];
  const u = lim.unit || lim;
  const f = PLAN_FEATURES[id];
  const client = lim.perUnit === 'client';
  const limits = [
    client ? 'Per client: its own workspace and login' : 'Per funnel (brand)',
    `${u.channels} channels`,
    `${u.posts} finished posts a month`,
    client ? '1 user per client, plus yours' : `1 user; more at ${curOf(cur) === 'usd' ? usdc(EXTRAS.user.usd) : `₹${inr(EXTRAS.user.inr)} + GST`} a month each`,
    'AI included, no keys needed',
  ];
  const best = id === 'brand';
  return `<div class="card plan${best ? ' best' : ''}">
  ${best ? '<span class="badge">Founding price</span>' : ''}
  <h3>${esc(lim.label)}</h3>
  ${priceBlock({ priceInr: u.priceInr, priceUsd: u.priceUsd }, client ? ' per client' : ' per funnel', cur)}
  <p class="ptag">${esc(f.tag)}</p>
  <ul>
    ${limits.map((l) => `<li class="lim">${esc(l)}</li>`).join('')}
    ${f.lead ? `<li class="head">${esc(f.lead)}</li>` : ''}
    ${f.lines.map((l) => `<li>${esc(l)}</li>`).join('')}
  </ul>
  <a class="btn${best ? '' : ' ghost'}" data-buy="${id}" href="/buy?plan=${id}">${client ? 'Buy for my clients' : 'Get Always-On Brand'}</a>
  ${best ? `<a class="trial" href="${contactHref('7-day trial')}">or start the 7-day trial</a>` : ''}
</div>`;
}

/** The value stack: what it solves, and what that costs without us. */
function stackTable(cur = 'inr') {
  const d = curOf(cur) === 'usd';
  const cell = (r) => (r[d ? 'usd' : 'inr'] === null ? 'Included' : d ? usd(r.usd) : `₹${inr(r.inr)}`);
  return `<table class="stack"><thead><tr><th>You want</th><th>What we do</th><th>Without us, a month</th></tr></thead><tbody>
    ${VALUE_STACK.map((r) => `<tr><td><b>${esc(r.want)}</b></td><td>${esc(r.does)}</td><td>${cell(r)}${r.costs ? `<small>${esc(r.costs)}</small>` : ''}</td></tr>`).join('')}
    <tr class="sum"><td colspan="2">What it would cost you a month</td><td>${d ? `${usd(STACK_TOTAL.usd)}+` : `₹${inr(STACK_TOTAL.inr)}+`}</td></tr>
    <tr class="you"><td colspan="2">What you pay, per funnel</td><td>${d ? usd(PLANS.brand.priceUsd) : `₹${inr(PLANS.brand.priceInr)} ${GST_NOTE}`}</td></tr>
  </tbody></table>`;
}

/**
 * The public home (landing) page. `email` is the contact address for the plan
 * buttons ('' = they open sign-in instead, since there is no self sign-up).
 */
export function homePage({ email = '', cur = 'inr' } = {}) {
  const c = curOf(cur);
  const d = c === 'usd';
  const contactHref = contactHrefFor(email);
  const trialHref = contactHref('7-day trial');
  const cards = (items) => items.map(([t, p]) => `<div class="card"><h3>${esc(t)}</h3><p>${esc(p)}</p></div>`).join('');

  return `${landingHead('Content Engine: a post every day on every channel, made and published for you',
    `Content Engine makes, checks and publishes one post a day per brand to ${CHANNELS.join(', ')}. Ready videos, AI videos and image posts, approved by you, with comment-to-DM lead capture.`)}
${landingNav('')}

<header class="hero"><div class="wrap">
  <span class="pill">One post a day, per brand, on every channel</span>
  <h1>Grow your personal or company brand. <em>Automate your social presence</em>, set it up once a month.</h1>
  <p class="subhead">Your social media, made, checked and posted every single day.</p>
  <p class="lead">Content Engine turns your videos, or nothing at all, into finished posts with copy, thumbnails, voice and music. You approve. It publishes to every channel, reports what went live and turns comments into leads.</p>
  <div class="cta"><a class="btn" href="${trialHref}">Start the 7-day trial</a><a class="btn ghost" href="#pricing">See pricing</a></div>
  <div class="chips">${CHANNELS.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
  <div class="trust"><span><b>✓</b> You approve every post</span>${d ? '<span><b>$</b> One simple price per brand</span>' : '<span><b>₹</b> Priced in rupees, GST invoice</span>'}<span><b>↺</b> Cancel any time, one click</span></div>
</div></header>

<section id="how"><div class="wrap">
  <h2>How it works</h2>
  <p class="kicker">Set it up once. After that, the only daily job left is pressing Approve.</p>
  <div class="grid g5">${STEPS.map(([t, p], i) => `<div class="card"><span class="num">${i + 1}</span><h3>${esc(t)}</h3><p>${esc(p)}</p></div>`).join('')}</div>
  <div class="stats">
    <div class="stat"><b>3 lanes</b><span>so a day is never skipped</span></div>
    <div class="stat"><b>10 channels</b><span>per funnel, from one approval</span></div>
    <div class="stat"><b>3 sizes</b><span>16:9, 9:16 and 4:5, for every platform</span></div>
    <div class="stat"><b>1 email</b><span>a day, every evening</span></div>
  </div>
</div></section>

<section id="before-after"><div class="wrap">
  <div class="ba">
    <div class="side before"><div class="lab">Before Content Engine</div><h3>All making,<br>no posting</h3><ul>${BEFORE.map((t) => `<li>${esc(t)}<span class="m">✗</span></li>`).join('')}</ul></div>
    <div class="side after"><div class="lab">With Content Engine</div><h3>Posts made,<br>leads in</h3><ul>${AFTER.map((t) => `<li>${esc(t)}<span class="m">✓</span></li>`).join('')}</ul></div>
  </div>
</div></section>

<section id="action"><div class="wrap">
  <div class="act-wrap">
    <div class="act-tabs"><h3>See it in action</h3>${SCENES.map((sc, i) => `<button type="button" class="act-tab${i ? '' : ' on'}" data-i="${i}" onclick="actShow(${i})">${esc(sc.tab)}<small>See it ›</small></button>`).join('')}</div>
    <div class="act-stage">${SCENES.map((sc, i) => `<div class="act-pane${i ? '' : ' on'}" data-i="${i}"><div class="phone"><div class="who">‹ ${esc(sc.who)}</div>${sc.chat.map(([k, t]) => `<div class="bub ${k}">${esc(t)}</div>`).join('')}</div><div class="act-note"><b>${esc(sc.note[0])}</b>${esc(sc.note[1])}</div></div>`).join('')}</div>
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
  <h2>Always-On Brand</h2>
  <p class="kicker">Your brand posts every day on 10 channels, and comments turn into customers, without you making a single post. One plan, everything in it.</p>
  ${stackTable(c)}
  <div class="toggles">
    <div class="billing" role="group" aria-label="Billing"><span class="save">2 months free</span><button type="button" class="on" data-b="mo" onclick="bill('mo')">MONTHLY</button><button type="button" data-b="yr" onclick="bill('yr')">YEARLY</button></div>
  </div>
  ${d ? '' : '<p class="where">Prices in rupees, before 18% GST.</p>'}
  <div class="grid plans two">${['brand', 'agency'].map((id) => planCard(id, contactHref, c)).join('')}</div>
  <div class="bonus">${BONUSES.map(([t, p]) => `<div><b>${esc(t)}</b>${esc(p)}</div>`).join('')}</div>
  ${d
    ? `<p class="fine">Priced per funnel (brand) with 10 channels each; Agency per client. Add 30 more posts for ${usd(EXTRAS.posts30.usd)}, an AI video for ${usd(EXTRAS.aiVideo.usd)}, another user for ${usdc(EXTRAS.user.usd)} a month. Pay yearly: 10 months, get 12. Prices in US dollars. Costs without us are typical market prices, not quotes.</p>`
    : `<p class="fine">Priced per funnel (brand) with 10 channels each; Agency per client. Add 30 more posts for ₹${inr(EXTRAS.posts30.inr)} ${GST_NOTE} (₹${inr(withGst(EXTRAS.posts30.inr))} with GST), an AI video for ₹${inr(EXTRAS.aiVideo.inr)} ${GST_NOTE} (₹${inr(withGst(EXTRAS.aiVideo.inr))} with GST), another user for ₹${inr(EXTRAS.user.inr)} ${GST_NOTE} (₹${inr(withGst(EXTRAS.user.inr))} with GST) a month. Pay yearly: 10 months, get 12. Prices in Indian rupees, before GST: 18% GST is added to every price and shown on your GST invoice. Costs without us are typical market prices, not quotes.</p>`}
</div></section>

${compareSection(c)}

<section id="faq"><div class="wrap">
  <h2>Questions</h2>
  <p class="kicker">The short answers.</p>
  ${faqFor(c).map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${escGst(a)}</p></details>`).join('')}
</div></section>

<section class="final"><div class="wrap">
  <h2>Stop making posts. Start revenue from posts.</h2>
  <p class="kicker" style="margin:0 auto 1.6rem">Seven days free, then ${d ? usd(PLANS.brand.priceUsd) : `₹${inr(PLANS.brand.priceInr)} + GST`} a funnel. Or buy now and your workspace is ready the moment you pay.</p>
  <div class="cta"><a class="btn" href="${trialHref}">Start the 7-day trial</a><a class="btn ghost" href="${LOGIN_PATH}">Sign in</a></div>
</div></section>

<a class="float-cta" href="${trialHref}">Start the 7-day trial ›</a>
<script>
function actShow(i){document.querySelectorAll('.act-tab,.act-pane').forEach(function(e){e.classList.toggle('on',e.getAttribute('data-i')==String(i));});}
var B='mo';
function links(){document.querySelectorAll('a[data-buy]').forEach(function(a){a.href='/buy?plan='+a.getAttribute('data-buy')+'&bill='+B;});}
function bill(b){B=b;document.getElementById('pricing').classList.toggle('yearly',b==='yr');document.querySelectorAll('.billing button[data-b]').forEach(function(e){e.classList.toggle('on',e.getAttribute('data-b')===b);});links();}
</script>
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
<h2>Payment</h2>
<p>Plans are paid in advance and are not refunded. You can cancel any time and keep using your plan until the end of the period you paid for (see the <a href="/refund">refund and cancellation policy</a>). Nothing is shipped (see the <a href="/shipping">shipping policy</a>).</p>
<h2>Access</h2>
<p>The owner may remove access at any time. You may stop using it at any time and ask for your data to be deleted (see the <a href="/privacy">privacy policy</a>).</p>
<h2>Contact</h2>
<p>${contactLine(email)}</p>`);
}

/** The refund and cancellation policy: no refunds, cancel any time, use until the paid period ends. */
export function refundPage({ email = '', cur = 'inr' } = {}) {
  return shell('Refund and cancellation policy: Content Engine', `
<h1>Refund and cancellation policy</h1>
<p class="sub">Last updated ${UPDATED}</p>
<p>Content Engine is a subscription, paid in advance for a month or a year. This page explains what happens when you pay, cancel or stop.</p>
<h2>No refunds</h2>
<p>Payments are not refunded, in full or in part. This covers monthly and yearly plans, the unused part of a period, unused posts or AI videos, upgrades, and extra post or AI video packs.</p>
<h2>Cancel any time</h2>
<p>Cancel with one click: in the app, open <b>Plan</b> and press <b>Cancel my plan</b>. You can also write to ${contactLine(email)}. There is no cancellation fee and no notice period. Cancelling stops the next renewal, so you are not charged again. Changed your mind before the period ends? If you were set up by us, press <b>Keep my plan</b>; if you paid online, buy the plan again from the <a href="/#pricing">pricing</a> when the period ends.</p>
<h2>${curOf(cur) === 'usd' ? 'Currency' : 'Currency and GST'}</h2>
<p>${curOf(cur) === 'usd' ? 'Plans are paid in US dollars. The amount is shown before you pay.' : 'Plans are paid in Indian rupees, with 18% GST added and shown at checkout.'} The payment is taken by Razorpay.</p>
<h2>Use it until the end of what you paid for</h2>
<p>After you cancel, your workspace keeps working, with every feature of your plan, until the last day of the period you have already paid for. On that day it stops posting and is paused. What happens to your data after that is set out in the <a href="/privacy">privacy policy</a>.</p>
<h2>Trial</h2>
<p>The 7-day trial is free. If you do not continue after it, nothing is charged.</p>
<h2>Billing mistakes</h2>
<p>If you were charged twice for the same period, or charged after you had cancelled, write to ${contactLine(email)} and the mistaken charge is returned to the account it came from. This is a correction of an error, not a refund of a payment you meant to make.</p>
<h2>Contact</h2>
<p>${contactLine(email)}</p>`);
}

/** The shipping and delivery policy: nothing is shipped, the service is delivered online. */
export function shippingPage({ email = '' } = {}) {
  return shell('Shipping and delivery policy: Content Engine', `
<h1>Shipping and delivery policy</h1>
<p class="sub">Last updated ${UPDATED}</p>
<h2>Nothing is shipped</h2>
<p>Content Engine is software used online. It is a digital service, so there are no physical goods, nothing is sent by post or courier, and there are no shipping or delivery charges.</p>
<h2>How you receive it</h2>
<p>Once your workspace is set up, you are sent your sign-in details by email and use the service in your web browser. Everything it makes (posts, pictures, videos, reports) is delivered inside the app, to your connected social accounts and to your email.</p>
<h2>Where it is available</h2>
<p>It works anywhere you can open the website. There is no delivery address and no delivery area.</p>
<h2>Did not get access?</h2>
<p>If you paid and have not received your sign-in details, write to ${contactLine(email)}.</p>`);
}

export default { UPDATED, LOGIN_PATH, CHANNELS, PLAN_FEATURES, inr, homePage, privacyPage, termsPage, refundPage, shippingPage };
