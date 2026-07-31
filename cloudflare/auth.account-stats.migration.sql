-- Forward-only additive migration for account-scoped lifetime aggregates.
-- The row contains counters only: no room code, media identity, title, event
-- timestamp, or per-play history. An older App Worker safely ignores it.

CREATE TABLE mxqr_account_stats (
  account_id TEXT PRIMARY KEY NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0
    CHECK (session_count BETWEEN 0 AND 9007199254740991),
  listening_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (listening_seconds BETWEEN 0 AND 9007199254740991),
  track_count INTEGER NOT NULL DEFAULT 0
    CHECK (track_count BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (account_id) REFERENCES mxqr_accounts(account_id) ON DELETE CASCADE
);
