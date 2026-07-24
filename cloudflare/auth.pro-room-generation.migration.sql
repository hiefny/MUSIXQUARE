-- Forward-only migration: preserve account-to-PRO-room cleanup authority when
-- a six-digit public room code is reused for a later immutable incarnation.
-- Existing reverse-index rows become generation zero. Apply this migration
-- before any Worker can register or issue credentials for generation one.

CREATE TABLE mxqr_account_pro_room_generations (
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

INSERT OR IGNORE INTO mxqr_account_pro_room_generations (
  account_id,
  room_code,
  room_generation,
  first_linked_at,
  last_seen_at
)
SELECT
  account_id,
  room_code,
  0,
  first_linked_at,
  last_seen_at
FROM mxqr_account_pro_rooms;

CREATE INDEX idx_mxqr_account_pro_room_generations_account
  ON mxqr_account_pro_room_generations(account_id);
