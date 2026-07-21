-- One-time production migration for globally unique, command-safe account
-- nicknames. Run only after the App Worker that writes nickname_key is live.
-- The production preflight verifies the resulting sqlite_master definition.
ALTER TABLE mxqr_accounts
  ADD COLUMN nickname_key TEXT
    CHECK (nickname_key IS NULL OR length(nickname_key) BETWEEN 1 AND 512);

-- The preflight migration audit must first prove that every current nickname's
-- JS NFKC/lowercase key equals SQLite lower(nickname). This is true for the
-- production rows at the time this migration was authored; do not assume it
-- for a future database without repeating that audit.
UPDATE mxqr_accounts
   SET nickname_key = lower(nickname)
 WHERE nickname IS NOT NULL;

CREATE UNIQUE INDEX idx_mxqr_accounts_nickname_key
  ON mxqr_accounts(nickname_key)
  WHERE nickname_key IS NOT NULL;
