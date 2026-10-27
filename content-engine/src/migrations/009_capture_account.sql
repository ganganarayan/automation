-- The private reply (DM) is sent as the account that owns the post — POST
-- /{account-id}/messages — and the access token is stored per account id, so we
-- record which account each lead/rule belongs to. account_id = the IG user id
-- (Instagram) or Page id (Facebook) from the webhook entry. Additive only.

ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE keyword_rules  ADD COLUMN IF NOT EXISTS account_id text;
