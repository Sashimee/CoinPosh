-- A token refresh keeps its answer for a short window so that a resend under the same
-- Idempotency-Key, from a client that never saw the first answer, gets it back instead of
-- rotating twice (which revokes the family). `fingerprint` is the SHA-256 of the signed body;
-- `response` is the token bundle sealed with AES-GCM under a key derived from AUTH_SECRET, never
-- plaintext; `error` is the refusal to repeat. Guest sign-up rows leave them NULL and stay
-- single-use.
ALTER TABLE auth_requests ADD COLUMN fingerprint TEXT;
ALTER TABLE auth_requests ADD COLUMN response TEXT;
ALTER TABLE auth_requests ADD COLUMN error TEXT;
