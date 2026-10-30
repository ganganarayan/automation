/**
 * Admin sidebar (pure).
 *
 * Purpose:      One menu shared by every admin screen, so each thing you do has
 *               its own entry instead of being a button buried inside another
 *               page. Instances is a workspace you open and edit inside — it is
 *               not the hallway to manual runs, ready videos and comments.
 * Responsibility: Markup + CSS only. No settings, DB or request access, so it
 *               stays unit-testable.
 * Dependencies: configManifest (itself pure) for the settings panel labels.
 *
 * The menu has two groups: WORK items are real pages, SETUP items are panels on
 * the settings page — rendered as tab buttons there (where show() owns them) and
 * as links to the right hash from anywhere else.
 */
import { APPS, CONFIG_MANIFEST } from '../services/configManifest.js';

const SETTINGS_PATH = '/api/v1/admin/settings';

/** The screens you work in. Each one is a page of its own. */
export const WORK_ITEMS = [
  { id: 'instances', label: 'Instances', icon: '🎬', href: '/api/v1/admin/instances' },
  { id: 'manual', label: 'Manual run', icon: '🎛', href: '/api/v1/admin/instances/manual' },
  { id: 'ready-ai', label: 'Ready video + AI copy', icon: '✨', href: '/api/v1/admin/instances/ready-ai' },
  { id: 'capture', label: 'Comments', icon: '🎯', href: '/api/v1/admin/capture' },
];

/** The settings panels, in the order they appear on the settings page. */
export function setupItems() {
  return [
    { id: 'users', label: 'Users' },
    { id: 'funnels', label: 'Funnels' },
    ...APPS.map((a) => ({ id: a, label: CONFIG_MANIFEST[a].label })),
  ];
}

/**
 * The sidebar's inner markup.
 *
 * @param {object} opts
 * @param {string} [opts.current] - WORK item id to highlight.
 * @param {string} [opts.key]     - access key, appended so a fresh tab stays in.
 * @param {boolean} [opts.tabs]   - true on the settings page: SETUP items become
 *                                  buttons wired to its own show() tab switcher.
 */
export function navHtml({ current = '', key = '', tabs = false } = {}) {
  const work = WORK_ITEMS
    .map((it) => `<a class="nv${current === it.id ? ' on' : ''}" href="${esc(withKey(it.href, key))}"><span class="nvi">${it.icon}</span>${esc(it.label)}</a>`)
    .join('');

  const setup = setupItems()
    .map((it) => (tabs
      ? `<button type="button" class="nv nav" data-target="${esc(it.id)}" onclick="show('${esc(it.id)}')"><span class="nvi"></span>${esc(it.label)}</button>`
      : `<a class="nv" href="${esc(withKey(SETTINGS_PATH, key))}#${esc(it.id)}"><span class="nvi"></span>${esc(it.label)}</a>`))
    .join('');

  return `<div class="brand">⚙️ automation</div>
    <div class="nvgroup">${work}</div>
    <div class="nvlabel">Setup</div>
    <div class="nvgroup">${setup}</div>
    <a class="nv nvdash" href="${esc(withKey('/api/v1/dashboard', key))}"><span class="nvi">←</span>Dashboard</a>`;
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
 .nvdash{margin-top:1.1rem;color:#8a8aa2}`;

/** The page frame the menu sits in — for pages that have no layout of their own. */
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

export default { WORK_ITEMS, setupItems, navHtml, NAV_CSS, NAV_SHELL_CSS };
