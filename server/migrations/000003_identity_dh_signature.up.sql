-- Binds the X25519 identity key to the Ed25519 identity key.
--
-- The DH key was published in prekey bundles with nothing vouching for it,
-- unlike the signed prekey. An operator could therefore substitute its own and
-- control the DH2 input to X3DH. Session confidentiality survived - DH1 and DH3
-- need the signed prekey's private half - but that key contributed no entropy
-- an attacker lacked, which is not what the handshake claims.
--
-- The signature covers "shatters-idk-v1" || identity_dh_key and is verified at
-- registration and again by clients consuming a bundle.
--
-- Pre-1.0 and pre-release: existing rows cannot produce a signature, since only
-- the account holder's private key can, and the server has never had it. They
-- are removed, as in 000002. Referenced prekeys and envelopes follow via
-- ON DELETE CASCADE.
DELETE FROM accounts;

ALTER TABLE accounts ADD COLUMN identity_dh_signature bytea NOT NULL;
