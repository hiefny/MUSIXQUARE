-- Forward-only exact-incarnation ownership authority fence. App Worker
-- ownership sagas activate the fence and revoke keys in one D1 batch; key
-- issuance uses the same table as an atomic insertion predicate.
CREATE TABLE mxqr_developer_api_room_authority_fences (
  room_code TEXT NOT NULL
    CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
  room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'cleared')),
  reason TEXT NOT NULL
    CHECK (reason IN ('owner_account_deleted', 'ownership_transfer_pending')),
  fence_digest TEXT NOT NULL
    CHECK (length(fence_digest) = 43 AND fence_digest NOT GLOB '*[^A-Za-z0-9_-]*'),
  fenced_at INTEGER NOT NULL CHECK (fenced_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= fenced_at),
  PRIMARY KEY (room_code, room_generation)
);

CREATE INDEX idx_mxqr_developer_api_room_authority_fences_status
  ON mxqr_developer_api_room_authority_fences (status, room_code, room_generation);

CREATE TRIGGER trg_mxqr_developer_api_keys_authority_fenced_insert
BEFORE INSERT ON mxqr_developer_api_keys
WHEN EXISTS (
  SELECT 1 FROM mxqr_developer_api_room_authority_fences
  WHERE room_code = NEW.room_code
    AND room_generation = NEW.room_generation
    AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'DEVELOPER_API_AUTHORITY_FENCED');
END;


CREATE TRIGGER trg_mxqr_developer_api_keys_authority_fenced_update
BEFORE UPDATE OF status ON mxqr_developer_api_keys
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM mxqr_developer_api_room_authority_fences
  WHERE room_code = NEW.room_code
    AND room_generation = NEW.room_generation
    AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'DEVELOPER_API_AUTHORITY_FENCED');
END;
