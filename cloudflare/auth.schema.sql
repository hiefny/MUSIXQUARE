PRAGMA foreign_keys = ON;

-- Dedicated account-identity data boundary. Google subjects and browser
-- session tokens are HMAC-pseudonymized by the App Worker before they reach D1.
CREATE TABLE IF NOT EXISTS mxqr_accounts (
  account_id TEXT PRIMARY KEY NOT NULL,
  google_subject_hash TEXT NOT NULL UNIQUE,
  nickname TEXT,
  profile_complete INTEGER NOT NULL DEFAULT 0
    CHECK (profile_complete IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(account_id) = 27 AND substr(account_id, 1, 5) = 'acct_'),
  CHECK (length(google_subject_hash) = 43),
  CHECK (nickname IS NULL OR (length(nickname) BETWEEN 1 AND 20)),
  CHECK (
    (profile_complete = 0 AND nickname IS NULL) OR
    (profile_complete = 1 AND nickname IS NOT NULL)
  ),
  CHECK (created_at > 0 AND updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS mxqr_account_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES mxqr_accounts(account_id) ON DELETE CASCADE,
  CHECK (length(session_hash) = 43),
  CHECK (created_at > 0 AND last_seen_at >= created_at AND expires_at > last_seen_at)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_account_sessions_account
  ON mxqr_account_sessions(account_id);

CREATE INDEX IF NOT EXISTS idx_mxqr_account_sessions_expiry
  ON mxqr_account_sessions(expires_at);

-- Account deletion deliberately keeps only the HMAC session digests for a
-- short handoff window. Existing browsers can use their old HttpOnly cookie
-- to mint a deletion-only room proof, but can never recreate an authenticated
-- account session or an attachment assertion. There is intentionally no
-- foreign key: the account row is removed in the same transaction.
CREATE TABLE IF NOT EXISTS mxqr_account_deleted_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(session_hash) = 43),
  CHECK (length(account_id) = 27 AND substr(account_id, 1, 5) = 'acct_'),
  CHECK (deleted_at > 0 AND expires_at > deleted_at)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_account_deleted_sessions_expiry
  ON mxqr_account_deleted_sessions(expires_at);

-- Short-lived deletion fence. It prevents an already-started PRO request from
-- creating a new persistent authority edge while account deletion enumerates
-- and purges existing rooms. Failed cleanup removes the fence so deletion can
-- be retried; successful account deletion cascades it.
CREATE TABLE IF NOT EXISTS mxqr_account_deletions (
  account_id TEXT PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES mxqr_accounts(account_id) ON DELETE CASCADE,
  CHECK (started_at > 0)
);

-- Sparse reverse index used only to revoke persistent PRO authority when an
-- account is deleted. A row is created when a verified account is attached to
-- a PRO room; room content is deliberately not copied into this database.
CREATE TABLE IF NOT EXISTS mxqr_account_pro_rooms (
  account_id TEXT NOT NULL,
  room_code TEXT NOT NULL,
  first_linked_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, room_code),
  FOREIGN KEY (account_id) REFERENCES mxqr_accounts(account_id) ON DELETE CASCADE,
  CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
  CHECK (first_linked_at > 0 AND last_seen_at >= first_linked_at)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_account_pro_rooms_account
  ON mxqr_account_pro_rooms(account_id);

-- Consumed OAuth state digests make callback replay fail closed even if a
-- cleared flow cookie is copied and replayed outside the normal browser path.
CREATE TABLE IF NOT EXISTS mxqr_oauth_flows (
  state_hash TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(state_hash) = 43),
  CHECK (created_at > 0 AND expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_oauth_flows_expiry
  ON mxqr_oauth_flows(expires_at);
