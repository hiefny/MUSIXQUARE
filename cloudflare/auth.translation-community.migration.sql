PRAGMA foreign_keys = ON;

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
