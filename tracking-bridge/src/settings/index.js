/**
 * Settings layer.
 *
 * Purpose:      The single place environment variables are read, validated, and
 *               exposed. Nothing outside this module reads `process.env`.
 * Responsibility:
 *               - Validate the environment once at import time (fail fast).
 *               - Expose configuration as namespaced, relevantly-named groups.
 * Dependencies: zod.
 */
import { z } from 'zod';

const SERVICE_NAME = 'tracking-bridge';

const boolFromEnv = (def) =>
  z.string().optional().transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const intFromEnv = (def) =>
  z.string().optional().transform((v) => (v === undefined || v === '' ? def : Number(v))).pipe(z.number().int());

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

  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),

  META_PIXEL_ID: z.string().optional().default(''),
  META_CAPI_TOKEN: z.string().optional().default(''),
  META_API_VERSION: z.string().optional().default('v21.0'),
  META_TEST_EVENT_CODE: z.string().optional().default(''),
  EVENT_SOURCE_URL: z.string().optional().default(''),
  CONTENT_NAME: z.string().optional().default('Emotional Clarity Consultation 121'),

  META_AD_ACCOUNT_ID: z.string().optional().default(''),
  META_ADS_TOKEN: z.string().optional().default(''),
  INSIGHTS_SHEET_ID: z.string().optional().default(''),
  LOOKBACK_DAYS: intFromEnv(1),

  ASSESS360_URL: z.string().optional().default(''),
  ASSESS360_TOKEN: z.string().optional().default(''),

  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),

  ALERT_EMAIL: z.string().optional().default(''),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: intFromEnv(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().optional().default(''),

  MODULE_CAPI_ENABLED: boolFromEnv(true),
  MODULE_INSIGHTS_ENABLED: boolFromEnv(true),
});

function build(rawEnv) {
  const parsed = schema.safeParse(rawEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment for ${SERVICE_NAME}:\n${issues}`);
  }
  const e = parsed.data;

  return Object.freeze({
    service: SERVICE_NAME,
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    tz: e.TZ,
    logLevel: e.LOG_LEVEL,

    database: Object.freeze({ url: e.DATABASE_URL }),

    razorpay: Object.freeze({ webhookSecret: e.RAZORPAY_WEBHOOK_SECRET }),

    meta: Object.freeze({
      pixelId: e.META_PIXEL_ID,
      capiToken: e.META_CAPI_TOKEN,
      apiVersion: e.META_API_VERSION,
      testEventCode: e.META_TEST_EVENT_CODE,
      eventSourceUrl: e.EVENT_SOURCE_URL,
      contentName: e.CONTENT_NAME,
      adAccountId: e.META_AD_ACCOUNT_ID,
      adsToken: e.META_ADS_TOKEN,
    }),

    insights: Object.freeze({ sheetId: e.INSIGHTS_SHEET_ID, lookbackDays: e.LOOKBACK_DAYS }),

    assess360: Object.freeze({ url: e.ASSESS360_URL.replace(/\/+$/, ''), token: e.ASSESS360_TOKEN }),

    google: Object.freeze({
      serviceAccount: e.GOOGLE_SERVICE_ACCOUNT_JSON
        ? parseJsonEnv(e.GOOGLE_SERVICE_ACCOUNT_JSON, null, 'GOOGLE_SERVICE_ACCOUNT_JSON')
        : null,
    }),

    alerts: Object.freeze({ email: e.ALERT_EMAIL }),
    smtp: Object.freeze({
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      from: e.SMTP_FROM || e.SMTP_USER,
    }),

    // tracking-bridge is standalone/single-tenant in practice, but the auth
    // group is kept for interface parity with the shared middleware.
    auth: Object.freeze({ internalApiKey: '', adminKey: '' }),

    modules: Object.freeze({ capi: e.MODULE_CAPI_ENABLED, insights: e.MODULE_INSIGHTS_ENABLED }),
  });
}

export const settings = build(process.env);
export const buildSettings = build;
export default settings;
