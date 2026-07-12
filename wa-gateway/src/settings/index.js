/**
 * Settings layer.
 *
 * Purpose:      The single place environment variables are read, validated,
 *               and exposed to the rest of the service. Nothing outside this
 *               module reads `process.env`.
 * Responsibility:
 *               - Validate the environment once at import time (fail fast).
 *               - Expose configuration as namespaced, relevantly-named groups
 *                 (settings.database, settings.evolution, settings.smtp, ...).
 *               - Provide the environment defaults that the tenant-aware
 *                 resolver (see core/tenantSettings.js) overlays per tenant.
 * Dependencies: zod for validation.
 */
import { z } from 'zod';

const SERVICE_NAME = 'wa-gateway';

/** Coerce common truthy/falsey string env values to a boolean. */
const boolFromEnv = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const intFromEnv = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

/** Parse a JSON env var, tolerating empty/unset values with a fallback. */
function parseJsonEnv(raw, fallback, label) {
  if (raw === undefined || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${label}: ${err.message}`);
  }
}

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: intFromEnv(8080),
  TZ: z.string().default('Asia/Kolkata'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  EVOLUTION_BASE_URL: z.string().optional().default(''),
  EVOLUTION_API_KEY: z.string().optional().default(''),

  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),

  TEMPLATES_SHEET_ID: z.string().optional().default(''),
  TEMPLATES_SHEET_TAB: z.string().optional().default('WA Msg Templates'),

  CALENDAR_LINK: z.string().optional().default(''),

  AUDIO_BANDS: z.string().optional().default(''),

  ALERT_EMAIL: z.string().optional().default(''),

  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: intFromEnv(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default(''),

  INTERNAL_API_KEY: z.string().optional().default(''),
  ADMIN_KEY: z.string().optional().default(''),

  GAP_MIN_SECONDS: intFromEnv(180),
  GAP_MAX_SECONDS: intFromEnv(240),
  SEND_WINDOW_START: intFromEnv(6),
  SEND_WINDOW_END: intFromEnv(24),
  DISPATCHER_TICK_SECONDS: intFromEnv(15),
  MAX_SEND_ATTEMPTS: intFromEnv(200),

  MODULE_CRM_RELAY_ENABLED: boolFromEnv(true),
  MODULE_DISPATCHER_ENABLED: boolFromEnv(true),
  MODULE_RAW_RELAY_ENABLED: boolFromEnv(true),
  MODULE_FORM_BOOKING_ENABLED: boolFromEnv(true),
  MODULE_EMOTIONAL_OUTREACH_ENABLED: boolFromEnv(true),
  MODULE_CONNECTION_MONITOR_ENABLED: boolFromEnv(true),
  MODULE_DELAY_RELAY_ENABLED: boolFromEnv(true),
  MODULE_ADMIN_ENABLED: boolFromEnv(true),
});

function build(rawEnv) {
  const parsed = schema.safeParse(rawEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment for ${SERVICE_NAME}:\n${issues}`);
  }
  const e = parsed.data;

  const googleServiceAccount = e.GOOGLE_SERVICE_ACCOUNT_JSON
    ? parseJsonEnv(e.GOOGLE_SERVICE_ACCOUNT_JSON, null, 'GOOGLE_SERVICE_ACCOUNT_JSON')
    : null;
  const audioBands = parseJsonEnv(e.AUDIO_BANDS, {}, 'AUDIO_BANDS');

  return Object.freeze({
    service: SERVICE_NAME,
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    tz: e.TZ,
    logLevel: e.LOG_LEVEL,

    database: Object.freeze({ url: e.DATABASE_URL }),

    evolution: Object.freeze({
      baseUrl: e.EVOLUTION_BASE_URL.replace(/\/+$/, ''),
      apiKey: e.EVOLUTION_API_KEY,
    }),

    google: Object.freeze({ serviceAccount: googleServiceAccount }),

    templates: Object.freeze({
      sheetId: e.TEMPLATES_SHEET_ID,
      sheetTab: e.TEMPLATES_SHEET_TAB,
    }),

    booking: Object.freeze({ calendarLink: e.CALENDAR_LINK }),

    outreach: Object.freeze({ audioBands }),

    alerts: Object.freeze({ email: e.ALERT_EMAIL }),

    smtp: Object.freeze({
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      from: e.SMTP_FROM || e.SMTP_USER,
    }),

    auth: Object.freeze({
      internalApiKey: e.INTERNAL_API_KEY,
      adminKey: e.ADMIN_KEY,
    }),

    dispatcher: Object.freeze({
      gapMinSeconds: e.GAP_MIN_SECONDS,
      gapMaxSeconds: e.GAP_MAX_SECONDS,
      sendWindowStart: e.SEND_WINDOW_START,
      sendWindowEnd: e.SEND_WINDOW_END,
      tickSeconds: e.DISPATCHER_TICK_SECONDS,
      maxAttempts: e.MAX_SEND_ATTEMPTS,
    }),

    modules: Object.freeze({
      crmRelay: e.MODULE_CRM_RELAY_ENABLED,
      dispatcher: e.MODULE_DISPATCHER_ENABLED,
      rawRelay: e.MODULE_RAW_RELAY_ENABLED,
      formBooking: e.MODULE_FORM_BOOKING_ENABLED,
      emotionalOutreach: e.MODULE_EMOTIONAL_OUTREACH_ENABLED,
      connectionMonitor: e.MODULE_CONNECTION_MONITOR_ENABLED,
      delayRelay: e.MODULE_DELAY_RELAY_ENABLED,
      admin: e.MODULE_ADMIN_ENABLED,
    }),
  });
}

/** Validated, immutable settings for the running process. */
export const settings = build(process.env);

/** Exposed for tests that need to build settings from a synthetic environment. */
export const buildSettings = build;

export default settings;
