/**
 * Public pages (no sign-in): home, privacy policy, terms of service.
 *
 * Purpose:      What the bare domain shows before sign-in, and the two policy
 *               pages Google's OAuth consent screen (Branding) links to, so the
 *               Google sign-in for "Connect Google Drive" can be published.
 *               The Sign in button opens the app on the same domain.
 * Responsibility: Pure HTML rendering (no settings / DB / I/O).
 * Dependencies: none.
 *
 * Routes (app.js): GET /  ·  GET /privacy  ·  GET /terms
 */

export const UPDATED = '01-11-2026';
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

/** The public home page. */
export function homePage() {
  return shell('Content Engine', `
<h1>Content Engine</h1>
<p class="sub">A private tool that plans, makes and schedules daily social media posts for our own brands.</p>
<ul>
  <li>Posts ready videos, AI-made narrated videos and image posts, one a day per brand.</li>
  <li>Every post is approved by a person before it goes out.</li>
  <li>Schedules through connected social accounts and reports when each post is live.</li>
</ul>
<p>Access is by invitation only.</p>
<p><a class="btn" href="${LOGIN_PATH}">Sign in</a></p>`);
}

/** The privacy policy. `email` is the contact address ('' = "the site owner"). */
export function privacyPage({ email = '' } = {}) {
  return shell('Privacy policy — Content Engine', `
<h1>Privacy policy</h1>
<p class="sub">Last updated ${UPDATED}</p>
<p>Content Engine is a private, invite-only tool used to create and schedule social media posts for our own brands. This page explains what it stores and why.</p>
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
  return shell('Terms of service — Content Engine', `
<h1>Terms of service</h1>
<p class="sub">Last updated ${UPDATED}</p>
<p>Content Engine is a private tool, available only to people the owner invites. By signing in you agree to these terms.</p>
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

export default { UPDATED, LOGIN_PATH, homePage, privacyPage, termsPage };
