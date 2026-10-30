/**
 * Sign-in pages (pure).
 *
 * Purpose:      The sign-in form, the forced "choose your password" popup and
 *               the lockout reset form.
 * Responsibility: Markup + CSS only. No settings, DB or request access.
 * Dependencies: passwordSpec (for the minimum length shown in the hint).
 */
import { MIN_PASSWORD_LENGTH } from './passwordSpec.js';

const CSS = `
 *{box-sizing:border-box}
 body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b12;color:#e8e8ef;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
 .card{background:#15151f;border:1px solid #24243a;padding:1.5rem;border-radius:14px;width:100%;max-width:360px}
 h1{font-size:1.05rem;margin:0 0 .3rem}
 p{color:#a9a9bf;font-size:.85rem;line-height:1.45;margin:.3rem 0 .8rem}
 label{display:block;font-size:.8rem;color:#c7c7d9;margin:.7rem 0 .25rem}
 input{width:100%;padding:.65rem;border-radius:8px;border:1px solid #333348;background:#0b0b12;color:#fff;font-size:.95rem}
 button{width:100%;padding:.7rem;margin-top:1rem;border:0;border-radius:8px;background:#3b3b6a;color:#fff;font-size:.95rem;cursor:pointer}
 button:hover{background:#4a4a82}
 .err{background:#3a1620;color:#ffb3b3;border-radius:8px;padding:.5rem .65rem;font-size:.85rem;margin:.4rem 0}
 .ok{background:#123222;color:#a8f0c6;border-radius:8px;padding:.5rem .65rem;font-size:.85rem;margin:.4rem 0}
 .links{margin-top:.9rem;font-size:.8rem;text-align:center}
 .links a{color:#9d9dd8}
 .backdrop{position:fixed;inset:0;background:rgba(5,5,10,.82);display:grid;place-items:center;padding:16px}`;

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

/**
 * @param {object} o
 * @param {string} [o.next]   - where to land after sign-in (a /api/v1/ path).
 * @param {string} [o.error]
 * @param {string} [o.notice]
 * @param {string} [o.email]  - prefill after a failed attempt.
 */
export function loginPage({ next = '', error = '', notice = '', email = '' } = {}) {
  return shell('Sign in · automation', `<form class="card" method="post" action="/api/v1/admin/login">
  <h1>⚙️ automation</h1>
  <p>Sign in with your email and password.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  ${notice ? `<div class="ok">${esc(notice)}</div>` : ''}
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="em">Email</label>
  <input id="em" name="email" type="email" value="${esc(email)}" autocomplete="username" required ${email ? '' : 'autofocus'}>
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password" autocomplete="current-password" ${email ? 'autofocus' : ''}>
  <button type="submit">Sign in</button>
  <p style="margin-top:.9rem">First sign-in? Use your current access key as the password, or leave it blank if the app never had one. You will choose your own password next.</p>
  <div class="links"><a href="/api/v1/admin/reset">Locked out? Use the reset code</a></div>
</form>`);
}

/**
 * The forced first-time popup, or a normal password change.
 * @param {object} o
 * @param {string} o.email
 * @param {boolean} o.forced - true: first sign-in, no current password asked.
 * @param {string} [o.next]
 * @param {string} [o.error]
 */
export function passwordPage({ email, forced, next = '', error = '' }) {
  const form = `<form class="card" method="post" action="/api/v1/admin/password">
  <h1>${forced ? '🔐 Choose your password' : '🔐 Change password'}</h1>
  <p>${forced
    ? `Signed in as <b>${esc(email)}</b>. Set your own password before you continue. Every other browser is signed out.`
    : `Signed in as <b>${esc(email)}</b>. Every other browser is signed out after the change.`}</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="hidden" name="username" value="${esc(email)}" autocomplete="username">
  ${forced ? '' : `<label for="cur">Current password</label>
  <input id="cur" name="current" type="password" autocomplete="current-password" required>`}
  <label for="np">New password (at least ${MIN_PASSWORD_LENGTH} characters)</label>
  <input id="np" name="password" type="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" required autofocus>
  <label for="cp">Type it again</label>
  <input id="cp" name="confirm" type="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" required>
  <button type="submit">Save password</button>
  <div class="links">${forced
    ? '<a href="#" onclick="document.getElementById(\'so\').submit();return false">Sign out</a>'
    : `<a href="${esc(next || '/api/v1/admin/settings')}">Cancel</a>`}</div>
</form>
<form id="so" method="post" action="/api/v1/admin/logout"></form>`;
  return shell(forced ? 'Choose your password · automation' : 'Change password · automation',
    forced ? `<div class="backdrop">${form}</div>` : form);
}

/**
 * Lockout reset with the server's reset code.
 * @param {object} o
 * @param {boolean} o.enabled - false when no reset code is set on the server.
 * @param {string} [o.error]
 * @param {string} [o.email]
 */
export function resetPage({ enabled, error = '', email = '' }) {
  if (!enabled) {
    return shell('Reset · automation', `<div class="card"><h1>Reset is switched off</h1>
  <p>No reset code is set on this server. Add <b>SUPER_ADMIN_RESET_CODE</b> (12+ characters) to the service's variables on Railway, wait for the redeploy, then come back here.</p>
  <div class="links"><a href="/api/v1/admin/login">Back to sign in</a></div></div>`);
  }
  return shell('Reset · automation', `<form class="card" method="post" action="/api/v1/admin/reset">
  <h1>Reset super-admin password</h1>
  <p>Enter the reset code kept on the server, then choose a new password. Every signed-in browser is signed out.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <label for="em">Super-admin email</label>
  <input id="em" name="email" type="email" value="${esc(email)}" autocomplete="username" required>
  <label for="rc">Reset code</label>
  <input id="rc" name="code" type="password" autocomplete="off" required>
  <label for="np">New password (at least ${MIN_PASSWORD_LENGTH} characters)</label>
  <input id="np" name="password" type="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" required>
  <label for="cp">Type it again</label>
  <input id="cp" name="confirm" type="password" minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password" required>
  <button type="submit">Reset and sign in</button>
  <div class="links"><a href="/api/v1/admin/login">Back to sign in</a></div>
</form>`);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { loginPage, passwordPage, resetPage };
