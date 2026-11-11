/**
 * Admin sidebar (pure).
 *
 * Purpose:      One menu shared by every admin screen, so each thing you do has
 *               its own entry instead of being a button buried inside another
 *               page. Work pages are where the day happens (Today, Library,
 *               Calendar, Comments, Log and cost); Setup is configured once.
 * Responsibility: Markup + CSS only. No settings, DB or request access, so it
 *               stays unit-testable. The caller passes the signed-in session.
 * Dependencies: configManifest (itself pure) for the settings panel labels.
 *
 * The menu has two groups: WORK items are real pages, SETUP items are panels on
 * the settings page: rendered as tab buttons there (where show() owns them) and
 * as links to the right hash from anywhere else. The footer shows who is signed
 * in and the one Sign out button.
 */
import { CONFIG_MANIFEST } from '../services/configManifest.js';
import { workspaceRole, ROLE_LABEL } from './workspaceSpec.js';

const SETTINGS_PATH = '/api/v1/admin/settings';
export const HOME_PATH = '/api/v1/admin/today';

/** The screens you work in. Each one is a page of its own. */
export const WORK_ITEMS = [
  { id: 'today', label: 'Today', icon: '☀️', href: HOME_PATH },
  // Library = every instance; its "Ready videos" tab is the old Prepare page.
  { id: 'library', label: 'Library', icon: '🎬', href: '/api/v1/admin/instances' },
  { id: 'calendar', label: 'Calendar', icon: '📅', href: '/api/v1/admin/calendar' },
  { id: 'capture', label: 'Comments', icon: '🎯', href: '/api/v1/admin/capture' },
  // One picture + copy to every funnel, outside the daily lanes.
  { id: 'festival', label: 'Festival post', icon: '🪔', href: '/api/v1/admin/festival' },
  { id: 'log', label: 'Log and cost', icon: '🧾', href: '/api/v1/admin/log' },
];

/** The agency's Clients page (menu entry for an agency's admins only). */
export const CLIENTS_ITEM = { id: 'clients', label: 'Clients', icon: '🏢', href: '/api/v1/admin/clients' };

// Old `current` ids still passed by some pages → the menu entry they live under.
const CURRENT_ALIAS = { instances: 'library', prepare: 'library', dashboard: 'today' };

/** Resolve a page's `current` id to the WORK item it highlights. */
export function workItemFor(current = '') {
  return CURRENT_ALIAS[current] || current;
}

/**
 * The settings panels shown in the menu. tracking-bridge is still a panel on
 * the settings page, reached from inside Settings, not a menu entry.
 */
export function setupItems({ superAdmin = false, role = 'admin' } = {}) {
  return [
    { id: 'funnels', label: 'Funnels' },
    // Keys are an admin's: staff and a client's own people never see them.
    ...(role === 'admin' ? [{ id: 'api-keys', label: CONFIG_MANIFEST['api-keys'].label }] : []),
    { id: 'content-engine', label: CONFIG_MANIFEST['content-engine'].label },
    { id: 'users', label: 'Users' },
    ...(superAdmin ? [{ id: 'tenants', label: 'Tenants' }] : []),
  ];
}

/** "super_admin" → "super admin" for the footer. */
export function roleLabel(role = '') {
  return String(role || '').replace(/_/g, ' ');
}

/**
 * The sidebar's inner markup.
 *
 * @param {object} opts
 * @param {string} [opts.current] - WORK item id to highlight (old ids are aliased).
 * @param {string} [opts.key]     - access key, appended so a fresh tab stays in.
 * @param {boolean} [opts.tabs]   - true on the settings page: SETUP items become
 *                                  buttons wired to its own show() tab switcher.
 * @param {boolean} [opts.superAdmin] - adds the Tenants panel (also implied by
 *                                  a super_admin session).
 * @param {{email?:string, role?:string}|null} [opts.session] - signed-in user for the footer.
 */
export function navHtml({ current = '', key = '', tabs = false, superAdmin = false, session = null } = {}) {
  const on = workItemFor(current);
  const isSuper = superAdmin || !!(session && session.role === 'super_admin');

  // An agency's admins get their Clients page first, in every workspace they open.
  const items = session && session.agencyId ? [CLIENTS_ITEM, ...WORK_ITEMS] : WORK_ITEMS;
  const work = items
    .map((it) => `<a class="nv${on === it.id ? ' on' : ''}" href="${esc(withKey(it.href, key))}"><span class="nvi">${it.icon}</span>${esc(it.label)}</a>`)
    .join('');

  const setup = setupItems({ superAdmin: isSuper, role: isSuper ? 'admin' : workspaceRole(session, session && session.tenantId) })
    .map((it) => (tabs
      ? `<button type="button" class="nv nav" data-target="${esc(it.id)}" onclick="show('${esc(it.id)}')"><span class="nvi"></span>${esc(it.label)}</button>`
      : `<a class="nv" href="${esc(withKey(SETTINGS_PATH, key))}#${esc(it.id)}"><span class="nvi"></span>${esc(it.label)}</a>`))
    .join('');

  const here = session && Array.isArray(session.workspaces) && session.role !== 'super_admin' ? workspaceRole(session, session.tenantId) : '';
  const roleText = here && here !== 'admin' ? ROLE_LABEL[here] : (session && session.role ? roleLabel(session.role) : '');
  const who = session && session.email
    ? `<div class="nvwho">${esc(session.email)}${roleText ? `<span>${esc(roleText)}</span>` : ''}</div>`
    : '';

  return `<div class="brand">⚙️ automation</div>${switcherHtml(session)}
    <div class="nvlabel" style="margin-top:0">Work</div>
    <div class="nvgroup">${work}</div>
    <div class="nvlabel">Setup</div>
    <div class="nvgroup">${setup}</div>
    <div class="nvfoot">${who}
    <form method="post" action="/api/v1/admin/logout" style="margin:0"><button type="submit" class="nv"><span class="nvi">⎋</span>Sign out</button></form></div>`;
}

/**
 * The workspace switcher: only for someone with more than one workspace (an
 * agency admin and its clients). Posts to /admin/workspace, which checks again.
 * @param {{tenantId?:string, workspaces?:Array<{id:string,name:string,parentId:string|null}>}|null} session
 */
export function switcherHtml(session = null) {
  const list = (session && Array.isArray(session.workspaces)) ? session.workspaces : [];
  if (list.length < 2) return '';
  const cur = String(session.tenantId || '');
  const opts = list
    .map((w) => `<option value="${esc(w.id)}"${w.id === cur ? ' selected' : ''}>${esc(w.name)}${w.parentId ? ' (client)' : ''}</option>`)
    .join('');
  return `<form class="nvws" method="post" action="/api/v1/admin/workspace">
      <label for="nvws-sel">Workspace</label>
      <select id="nvws-sel" name="workspace" onchange="this.form.submit()">${opts}</select>
      <noscript><button type="submit" class="nv">Open</button></noscript>
    </form>`;
}

/**
 * Pages whose renderers have no request (instances.js) print a slot where the
 * menu goes; the route fills it with the session once it has one.
 */
export function navSlot(current = '') {
  return `<!--admin-nav:${String(current).replace(/[^a-z0-9_-]/gi, '')}-->`;
}

/** Replace every navSlot() in `html` with the menu (opts as for navHtml). */
export function fillNav(html, opts = {}) {
  return String(html).replace(/<!--admin-nav:([a-z0-9_-]*)-->/gi, (_m, current) => navHtml({ ...opts, current }));
}

/** Styling for the menu items themselves (every admin page includes this). */
export const NAV_CSS = `
 .brand{font-weight:600;color:#fff;padding:.3rem .7rem 1rem;font-size:.98rem}
 .nvgroup{display:flex;flex-direction:column}
 .nv{display:flex;align-items:center;gap:.5rem;width:100%;text-align:left;background:none;border:0;color:#c7c7d9;
     padding:.52rem .7rem;border-radius:8px;font-size:.9rem;cursor:pointer;text-decoration:none;margin-bottom:.1rem;font-family:inherit}
 .nv:hover{background:#1c1c2a}
 .nv.on,.nv.active{background:#2a2a44;color:#fff}
 .nvi{flex:0 0 1.1rem;text-align:center;font-size:.9rem}
 .nvlabel{color:#6f6f88;font-size:.67rem;text-transform:uppercase;letter-spacing:.09em;margin:1.1rem .7rem .4rem}
 .nvfoot{margin-top:1.1rem;border-top:1px solid #1e1e2c;padding-top:.7rem}
 .nvwho{color:#8a8aa2;font-size:.76rem;padding:0 .7rem .4rem;word-break:break-all}
 .nvwho span{display:block;color:#6f6f88;font-size:.7rem;margin-top:.1rem}
 .nvws{margin:0 .2rem .9rem;display:flex;flex-direction:column;gap:.25rem}
 .nvws label{color:#6f6f88;font-size:.67rem;text-transform:uppercase;letter-spacing:.09em;padding:0 .5rem}
 .nvws select{background:#1c1c2a;color:#fff;border:1px solid #2a2a44;border-radius:8px;padding:.42rem .5rem;font-size:.86rem;font-family:inherit;width:100%}`;

/** The page frame the menu sits in, for pages that have no layout of their own. */
export const NAV_SHELL_CSS = `
 .layout{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
 aside{background:#0f0f17;border-right:1px solid #1e1e2c;padding:1rem .7rem;position:sticky;top:0;height:100vh;overflow:auto}
 @media(max-width:760px){.layout{grid-template-columns:1fr}aside{position:static;height:auto}}`;

function withKey(href, key) {
  if (!key) return href;
  return `${href}${href.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { WORK_ITEMS, CLIENTS_ITEM, HOME_PATH, workItemFor, setupItems, roleLabel, navHtml, switcherHtml, navSlot, fillNav, NAV_CSS, NAV_SHELL_CSS };
