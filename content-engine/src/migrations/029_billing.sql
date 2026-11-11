-- Self-serve billing through Razorpay subscriptions. Additive only.
--
-- billing_plans: the Razorpay plan made for each exact price (plan:bill:currency:amount).
-- checkouts: one row per Razorpay subscription started from the buy page, with
--   the buyer's details, the currency (INR in India, USD elsewhere) and the
--   GST split; tenant_id is set once the workspace is made.
-- billing_payments: every captured charge with its GST split, for GST invoices
--   and the accounts.
-- tenants.billing_sub_id / billing_currency: the subscription a paid workspace runs on.

CREATE TABLE IF NOT EXISTS billing_plans (
  key               text PRIMARY KEY,
  razorpay_plan_id  text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkouts (
  id          text PRIMARY KEY,
  plan        text NOT NULL,
  bill        text NOT NULL,
  currency    text NOT NULL,
  amount      integer NOT NULL,
  base        integer NOT NULL,
  gst         integer NOT NULL DEFAULT 0,
  name        text,
  business    text,
  email       text NOT NULL,
  phone       text,
  country     text NOT NULL,
  gstin       text,
  status      text NOT NULL DEFAULT 'created',
  tenant_id   text,
  payment_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  paid_at     timestamptz
);
CREATE INDEX IF NOT EXISTS checkouts_tenant_idx ON checkouts (tenant_id);

CREATE TABLE IF NOT EXISTS billing_payments (
  payment_id  text PRIMARY KEY,
  sub_id      text NOT NULL,
  tenant_id   text,
  currency    text NOT NULL,
  amount      integer NOT NULL,
  base        integer NOT NULL,
  gst         integer NOT NULL DEFAULT 0,
  gstin       text,
  paid_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_sub_id   text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_currency text;
