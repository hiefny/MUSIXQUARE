-- A finite allocation per admin-issued claim; retries retain the same row.
-- No bearer token, signature, nonce, PIN, cookie or claim hash is retained.
CREATE TABLE IF NOT EXISTS mxqr_pro_room_owner_transfer_intent_admissions (
  room_code TEXT NOT NULL CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 16 AND 64 AND request_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  claim_generation INTEGER NOT NULL CHECK (claim_generation >= 0),
  target_account_id TEXT NOT NULL CHECK (length(target_account_id) = 27 AND substr(target_account_id, 1, 5) = 'acct_' AND target_account_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
  PRIMARY KEY (room_code, room_generation, request_id),
  FOREIGN KEY (room_code, room_generation, claim_generation)
    REFERENCES mxqr_pro_room_owner_transfer_issuances(room_code, room_generation, claim_generation)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_room_owner_transfer_intent_admissions_claim
ON mxqr_pro_room_owner_transfer_intent_admissions(room_code, room_generation, claim_generation);
