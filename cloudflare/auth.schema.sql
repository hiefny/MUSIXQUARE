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
  -- Appended by the global-nickname migration. SQLite places ALTER-added
  -- columns after the last column and before table-level constraints.
  nickname_key TEXT
    CHECK (nickname_key IS NULL OR length(nickname_key) BETWEEN 1 AND 512),
  CHECK (length(account_id) = 27 AND substr(account_id, 1, 5) = 'acct_'),
  CHECK (length(google_subject_hash) = 43),
  -- New writes are capped at 12 by account-auth.js. Keep 20 here so accounts
  -- created before the policy change remain readable until their next rename.
  CHECK (nickname IS NULL OR (length(nickname) BETWEEN 1 AND 20)),
  CHECK (
    (profile_complete = 0 AND nickname IS NULL) OR
    (profile_complete = 1 AND nickname IS NOT NULL)
  ),
  CHECK (created_at > 0 AND updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_accounts_nickname_key
  ON mxqr_accounts(nickname_key)
  WHERE nickname_key IS NOT NULL;

-- Account-scoped lifetime aggregates. This one-to-one row deliberately keeps
-- no room code, media identity, title, event timestamp, or per-play history.
-- Missing rows read as zero so existing accounts need no write-time backfill.
CREATE TABLE IF NOT EXISTS mxqr_account_stats (
  account_id TEXT PRIMARY KEY NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0
    CHECK (session_count BETWEEN 0 AND 9007199254740991),
  listening_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (listening_seconds BETWEEN 0 AND 9007199254740991),
  track_count INTEGER NOT NULL DEFAULT 0
    CHECK (track_count BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (account_id) REFERENCES mxqr_accounts(account_id) ON DELETE CASCADE
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
-- account is deleted. Room content is deliberately not copied into this
-- database, and every edge names the exact reusable room incarnation.
CREATE TABLE IF NOT EXISTS mxqr_account_pro_room_generations (
  account_id TEXT NOT NULL,
  room_code TEXT NOT NULL,
  room_generation INTEGER NOT NULL DEFAULT 0,
  first_linked_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, room_code, room_generation),
  FOREIGN KEY (account_id) REFERENCES mxqr_accounts(account_id) ON DELETE CASCADE,
  CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
  CHECK (room_generation >= 0),
  CHECK (first_linked_at > 0 AND last_seen_at >= first_linked_at)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_account_pro_room_generations_account
  ON mxqr_account_pro_room_generations(account_id);

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

-- Public translation contributions are account-owned; deleting an account
-- cascades its suggestions, votes and proposal-specific review history.
CREATE TABLE IF NOT EXISTS mxqr_translation_suggestions (
  suggestion_id TEXT PRIMARY KEY NOT NULL CHECK (length(suggestion_id) = 36),
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  locale TEXT NOT NULL CHECK (length(locale) BETWEEN 2 AND 12),
  surface TEXT NOT NULL CHECK (surface IN ('app', 'about')),
  translation_key TEXT NOT NULL CHECK (length(translation_key) BETWEEN 1 AND 200),
  source_en TEXT NOT NULL CHECK (length(source_en) <= 32768),
  source_ko TEXT NOT NULL CHECK (length(source_ko) <= 32768),
  current_text TEXT NOT NULL CHECK (length(current_text) <= 32768),
  proposed_text TEXT NOT NULL CHECK (length(proposed_text) BETWEEN 1 AND 32768),
  reason TEXT NOT NULL CHECK (length(reason) <= 4000),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  vote_count INTEGER NOT NULL DEFAULT 0 CHECK (vote_count >= 0),
  approved_at INTEGER,
  CHECK ((status = 'approved' AND approved_at IS NOT NULL AND approved_at > 0) OR
         (status <> 'approved' AND approved_at IS NULL)),
  UNIQUE (account_id, request_id),
  FOREIGN KEY (account_id) REFERENCES mxqr_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mxqr_translation_suggestions_locale_top
  ON mxqr_translation_suggestions(locale, status, vote_count DESC, created_at DESC, suggestion_id);
CREATE INDEX IF NOT EXISTS idx_mxqr_translation_suggestions_locale_new
  ON mxqr_translation_suggestions(locale, status, created_at DESC, suggestion_id);
CREATE INDEX IF NOT EXISTS idx_mxqr_translation_suggestions_account
  ON mxqr_translation_suggestions(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_translation_suggestions_approved
  ON mxqr_translation_suggestions(locale, surface, translation_key)
  WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS mxqr_translation_votes (
  suggestion_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (suggestion_id, account_id),
  FOREIGN KEY (suggestion_id) REFERENCES mxqr_translation_suggestions(suggestion_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES mxqr_accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mxqr_translation_votes_account
  ON mxqr_translation_votes(account_id);

CREATE TRIGGER IF NOT EXISTS trg_mxqr_translation_votes_insert
AFTER INSERT ON mxqr_translation_votes
BEGIN
  UPDATE mxqr_translation_suggestions SET vote_count = vote_count + 1
    WHERE suggestion_id = NEW.suggestion_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_mxqr_translation_votes_delete
AFTER DELETE ON mxqr_translation_votes
BEGIN
  UPDATE mxqr_translation_suggestions SET vote_count = vote_count - 1
    WHERE suggestion_id = OLD.suggestion_id;
END;

CREATE TABLE IF NOT EXISTS mxqr_translation_reviews (
  review_id TEXT PRIMARY KEY NOT NULL CHECK (length(review_id) = 36),
  suggestion_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approved', 'rejected', 'pending', 'withdrawn', 'superseded')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'author')),
  revision INTEGER NOT NULL CHECK (revision >= 2),
  reviewed_at INTEGER NOT NULL CHECK (reviewed_at > 0),
  FOREIGN KEY (suggestion_id) REFERENCES mxqr_translation_suggestions(suggestion_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mxqr_translation_reviews_suggestion
  ON mxqr_translation_reviews(suggestion_id, revision);
