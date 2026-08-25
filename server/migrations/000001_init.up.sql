-- Initial shatters schema.
-- All user-owned material stored here is PUBLIC key data or opaque ciphertext;
-- the server never holds private keys or plaintext (see docs/threat-model.md).

CREATE TABLE accounts (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_key     bytea       NOT NULL UNIQUE,
    identity_dh_key  bytea       NOT NULL UNIQUE,
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at     timestamptz
);

CREATE TABLE signed_prekeys (
    account_id uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id         integer     NOT NULL CHECK (id >= 0),
    public_key bytea       NOT NULL,
    signature  bytea       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, id)
);

CREATE TABLE one_time_prekeys (
    account_id uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id         integer     NOT NULL CHECK (id >= 0),
    public_key bytea       NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, id)
);

CREATE TABLE auth_challenges (
    nonce      bytea       PRIMARY KEY,
    account_id uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX auth_challenges_expiry_idx ON auth_challenges (expires_at);

CREATE TABLE session_tokens (
    token_hash bytea       PRIMARY KEY,
    account_id uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_tokens_expiry_idx ON session_tokens (expires_at);

-- Opaque message blobs for offline delivery (dead drops). The server cannot
-- read payload; it only routes by recipient and enforces TTL and size caps.
CREATE TABLE envelopes (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id    uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    recipient_id uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    payload      bytea       NOT NULL CHECK (octet_length(payload) <= 65536),
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    fetched_at   timestamptz
);
CREATE INDEX envelopes_recipient_idx ON envelopes (recipient_id, expires_at);
