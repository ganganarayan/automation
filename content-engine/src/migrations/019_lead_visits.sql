-- Landing-page visits for DM'd leads. Additive only.
--
-- Each lead gets its own short code. The link in their DM points at
-- /api/v1/go/{code}, which marks them clicked and sends them on to the
-- landing page (visit_target) with ?lc={code}. The landing-page script
-- reports page views and form submits back against the same code.

ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS visit_code      text DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 10);
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS visit_target    text;          -- where /go/{code} sends them
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS clicked_at      timestamptz;   -- first click of the DM link
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS click_count     integer NOT NULL DEFAULT 0;
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS visited_at      timestamptz;   -- landing page script saw them
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS last_seen_at    timestamptz;
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS form_at         timestamptz;   -- they submitted a form on the page
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS form_data       jsonb;
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS ig_label_status text;          -- the Instagram/Facebook inbox label: ok | failed: …

CREATE UNIQUE INDEX IF NOT EXISTS captured_leads_visit_code_idx ON captured_leads (visit_code);
