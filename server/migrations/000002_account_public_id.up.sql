-- Adds the externally visible account identifier.
--
-- account IDs are base64url(SHA-256("shatters-account-v1" || identity_key)),
-- computed in application code because the hashing domain lives there.
--
-- v0.1.0 predates any client-facing release: dev-era rows cannot be backfilled
-- deterministically in SQL (no pgcrypto dependency policy), so they are removed
-- here. Referenced prekeys/envelopes go with them via ON DELETE CASCADE.
DELETE FROM accounts;

ALTER TABLE accounts ADD COLUMN public_id text NOT NULL UNIQUE;
