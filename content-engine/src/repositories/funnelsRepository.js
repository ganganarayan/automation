/**
 * funnels + funnel_config data access.
 *
 * Purpose:      Manage a tenant's funnels (brand/campaign scopes) and their
 *               per-funnel configuration, and resolve a funnel into the shape
 *               the poster needs.
 * Responsibility: The only place funnels / funnel_config SQL runs.
 * Dependencies: core/db.
 *
 * A funnel is fully self-contained: it owns its content source, publishing
 * accounts, style, and schedule. There is no env fallback at funnel level —
 * everything is set in the app.
 */
import { query } from '../core/db.js';

/**
 * The config fields a funnel form edits — the ONE template every funnel shares.
 * No image compositing/overlay: the generated image is used as-is (layout is
 * handled in the image prompt).
 */
export const FUNNEL_FIELDS = [
  { key: 'sheet_id', label: 'Content sheet ID' },
  { key: 'sheet_tab', label: 'Sheet tab name (blank = first tab)', placeholder: 'e.g. Sheet1 / Content' },
  { key: 'drive_folder_id', label: 'Drive folder ID (image uploads)' },
  { key: 'postforme_accounts', label: 'Post for Me account IDs (JSON array)', type: 'json' },
  { key: 'account_map', label: 'Account map (JSON id → {platform,account_name})', type: 'json' },
  { key: 'approval_email', label: 'Approval email' },
  { key: 'cta_link', label: 'CTA / assessment link' },
  { key: 'audience_prefix', label: 'Audience prefix (caption line, optional)' },
  { key: 'generate_time', label: 'Generate/approval time (IST)', type: 'time', default: '22:00' },
  { key: 'generate_days', label: 'Days to run (blank = every day)', type: 'weekdays' },
  { key: 'publish_time', label: 'Publish time (IST)', type: 'time', default: '08:02' },
  {
    key: 'image_size',
    label: 'Image size',
    type: 'select',
    default: 'square',
    options: [
      { value: 'square', label: 'Square (1:1)' },
      { value: 'portrait', label: 'Portrait (2:3)' },
    ],
  },
  { key: 'ig_webhook_url', label: 'IG-comment webhook URL (optional)' },
  // Comment-to-DM defaults for this funnel (used when the content row has none).
  { key: 'capture_keyword', label: 'Auto-DM keyword (blank = off)', placeholder: 'e.g. guide' },
  { key: 'capture_dm_text', label: 'Auto-DM message', type: 'textarea' },
  { key: 'capture_dm_link', label: 'Auto-DM link' },
  { key: 'capture_public_replies', label: 'Public reply variants (one per line)', type: 'textarea' },
  {
    key: 'manual_stepper',
    label: 'Manual stepper',
    type: 'select',
    default: 'off',
    options: [
      { value: 'off', label: 'Off — scheduler runs the pipeline automatically' },
      { value: 'on', label: 'On — step each stage by hand in the app' },
    ],
  },
];

export async function listByTenant(tenantId = 'default') {
  const { rows } = await query(
    'SELECT id, tenant_id, name, style, active, created_at FROM funnels WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return rows;
}

/** All active funnels across tenants (for the daily cron). */
export async function listActive() {
  const { rows } = await query(
    'SELECT id, tenant_id, name, style, active FROM funnels WHERE active = true ORDER BY tenant_id, name',
  );
  return rows;
}

export async function get(id) {
  const { rows } = await query('SELECT * FROM funnels WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function findByName(tenantId, name) {
  const { rows } = await query('SELECT * FROM funnels WHERE tenant_id = $1 AND name = $2', [tenantId, name]);
  return rows[0] || null;
}

export async function create({ tenantId = 'default', name }) {
  const { rows } = await query(
    `INSERT INTO funnels (tenant_id, name) VALUES ($1, $2)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING *`,
    [tenantId, name],
  );
  return rows[0] || findByName(tenantId, name);
}

export async function setActive(id, active) {
  await query('UPDATE funnels SET active = $2 WHERE id = $1', [id, !!active]);
}

export async function remove(id) {
  await query('DELETE FROM funnels WHERE id = $1', [id]);
}

export async function getConfig(id) {
  const { rows } = await query('SELECT key, value FROM funnel_config WHERE funnel_id = $1', [id]);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setConfig(id, key, value) {
  await query(
    `INSERT INTO funnel_config (funnel_id, key, value, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (funnel_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [id, key, value],
  );
}

export async function delConfig(id, key) {
  await query('DELETE FROM funnel_config WHERE funnel_id = $1 AND key = $2', [id, key]);
}

/** Resolve a funnel + its config into the shape the poster consumes. */
export async function resolve(funnel) {
  const c = await getConfig(funnel.id);
  const json = (v, f) => {
    if (!v) return f;
    try {
      return JSON.parse(v);
    } catch {
      return f;
    }
  };
  return {
    id: funnel.id,
    tenantId: funnel.tenant_id,
    name: funnel.name,
    active: funnel.active,
    sheetId: c.sheet_id || '',
    sheetTab: c.sheet_tab || '', // blank = auto-detect the first tab
    driveFolder: c.drive_folder_id || '',
    // NOTE: no postformeKey here — the Post for Me key is central (API Keys page,
    // tenant settings). A funnel only chooses WHICH connected accounts it posts to.
    accounts: json(c.postforme_accounts, []),
    accountMap: json(c.account_map, {}),
    approvalEmail: c.approval_email || '',
    ctaLink: c.cta_link || '',
    audiencePrefix: c.audience_prefix || '',
    generateTime: c.generate_time || '22:00',
    generateDays: c.generate_days || '', // '' = daily
    publishTime: c.publish_time || '08:02',
    imageSize: (c.image_size || 'square').toLowerCase() === 'portrait' ? '1024x1536' : '1024x1024',
    igWebhookUrl: c.ig_webhook_url || '',
    captureKeyword: (c.capture_keyword || '').trim(),
    captureDmText: c.capture_dm_text || '',
    captureDmLink: c.capture_dm_link || '',
    capturePublicReplies: String(c.capture_public_replies || '')
      .split('\n').map((s) => s.trim()).filter(Boolean),
    manualStepper: (c.manual_stepper || 'off').toLowerCase() === 'on',
  };
}

export default {
  FUNNEL_FIELDS,
  listByTenant, listActive, get, findByName, create, setActive, remove,
  getConfig, setConfig, delConfig, resolve,
};
