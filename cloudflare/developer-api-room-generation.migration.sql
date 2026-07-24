-- Forward-only migration: bind every Developer API credential and audit row to
-- one immutable PRO-room incarnation. Existing rows become generation zero.
-- Apply only when PRAGMA table_info(mxqr_developer_api_keys) does not yet
-- contain room_generation; the current baseline already contains this shape.

CREATE TABLE IF NOT EXISTS mxqr_developer_api_room_generation_tombstones (
  room_code TEXT NOT NULL
    CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
  room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0),
  request_id TEXT NOT NULL,
  decommissioned_at INTEGER NOT NULL CHECK (decommissioned_at >= 0),
  PRIMARY KEY (room_code, room_generation)
);

INSERT OR IGNORE INTO mxqr_developer_api_room_generation_tombstones
  (room_code, room_generation, request_id, decommissioned_at)
SELECT room_code, 0, request_id, decommissioned_at
FROM mxqr_developer_api_room_tombstones;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_room_tombstones_monotonic;
CREATE TRIGGER trg_mxqr_developer_api_room_tombstones_monotonic
BEFORE UPDATE ON mxqr_developer_api_room_tombstones
WHEN NEW.room_code <> OLD.room_code
  OR NEW.request_id <> OLD.request_id
  OR NEW.decommissioned_at > OLD.decommissioned_at
BEGIN
  SELECT RAISE(ABORT, 'developer_api_room_tombstone_immutable');
END;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_room_tombstones_no_delete;
CREATE TRIGGER trg_mxqr_developer_api_room_tombstones_no_delete
BEFORE DELETE ON mxqr_developer_api_room_tombstones
BEGIN
  SELECT RAISE(ABORT, 'developer_api_room_tombstone_immutable');
END;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_room_generation_tombstones_monotonic;
CREATE TRIGGER trg_mxqr_developer_api_room_generation_tombstones_monotonic
BEFORE UPDATE ON mxqr_developer_api_room_generation_tombstones
WHEN NEW.room_code <> OLD.room_code
  OR NEW.room_generation <> OLD.room_generation
  OR NEW.request_id <> OLD.request_id
  OR NEW.decommissioned_at > OLD.decommissioned_at
BEGIN
  SELECT RAISE(ABORT, 'developer_api_room_generation_tombstone_immutable');
END;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_room_generation_tombstones_no_delete;
CREATE TRIGGER trg_mxqr_developer_api_room_generation_tombstones_no_delete
BEFORE DELETE ON mxqr_developer_api_room_generation_tombstones
BEGIN
  SELECT RAISE(ABORT, 'developer_api_room_generation_tombstone_immutable');
END;

ALTER TABLE mxqr_developer_api_keys
  ADD COLUMN room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0);
ALTER TABLE mxqr_developer_api_audit
  ADD COLUMN room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0);
ALTER TABLE mxqr_developer_api_admin_audit
  ADD COLUMN room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0);

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_incarnation_immutable;
CREATE TRIGGER trg_mxqr_developer_api_keys_incarnation_immutable
BEFORE UPDATE OF room_code, room_generation ON mxqr_developer_api_keys
WHEN NEW.room_code <> OLD.room_code
  OR NEW.room_generation <> OLD.room_generation
BEGIN
  SELECT RAISE(ABORT, 'developer_api_key_incarnation_immutable');
END;

DROP INDEX IF EXISTS idx_mxqr_developer_api_keys_room_status_expiry;
CREATE INDEX idx_mxqr_developer_api_keys_room_status_expiry
  ON mxqr_developer_api_keys (room_code, room_generation, status, expires_at);

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_decommissioned_room;
CREATE TRIGGER trg_mxqr_developer_api_keys_decommissioned_room
BEFORE INSERT ON mxqr_developer_api_keys
WHEN EXISTS (
  SELECT 1 FROM mxqr_developer_api_room_generation_tombstones
  WHERE room_code = NEW.room_code AND room_generation = NEW.room_generation
)
OR (
  NEW.room_generation = 0 AND EXISTS (
    SELECT 1 FROM mxqr_developer_api_room_tombstones
    WHERE room_code = NEW.room_code
  )
)
BEGIN
  SELECT RAISE(ABORT, 'PRO_ROOM_DECOMMISSIONED');
END;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_active_insert;
CREATE TRIGGER trg_mxqr_developer_api_keys_active_insert
BEFORE INSERT ON mxqr_developer_api_keys
WHEN NEW.status = 'active' AND (
  SELECT count(*) FROM mxqr_developer_api_keys
  WHERE room_code = NEW.room_code
    AND room_generation = NEW.room_generation
    AND status = 'active'
) >= 3
BEGIN
  SELECT RAISE(ABORT, 'developer_api_active_key_limit');
END;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_active_update;
CREATE TRIGGER trg_mxqr_developer_api_keys_active_update
BEFORE UPDATE OF status, room_code, room_generation ON mxqr_developer_api_keys
WHEN NEW.status = 'active'
  AND (
    OLD.status <> 'active'
    OR OLD.room_code <> NEW.room_code
    OR OLD.room_generation <> NEW.room_generation
  )
  AND (
    SELECT count(*) FROM mxqr_developer_api_keys
    WHERE room_code = NEW.room_code
      AND room_generation = NEW.room_generation
      AND status = 'active'
      AND key_id <> NEW.key_id
  ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'developer_api_active_key_limit');
END;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_audit_decommissioned_room;
CREATE TRIGGER trg_mxqr_developer_api_audit_decommissioned_room
BEFORE INSERT ON mxqr_developer_api_audit
WHEN EXISTS (
  SELECT 1 FROM mxqr_developer_api_room_generation_tombstones
  WHERE room_code = NEW.room_code AND room_generation = NEW.room_generation
)
OR (
  NEW.room_generation = 0 AND EXISTS (
    SELECT 1 FROM mxqr_developer_api_room_tombstones
    WHERE room_code = NEW.room_code
  )
)
BEGIN
  SELECT RAISE(IGNORE);
END;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_admin_audit_decommissioned_room;
CREATE TRIGGER trg_mxqr_developer_api_admin_audit_decommissioned_room
BEFORE INSERT ON mxqr_developer_api_admin_audit
WHEN EXISTS (
  SELECT 1 FROM mxqr_developer_api_room_generation_tombstones
  WHERE room_code = NEW.room_code AND room_generation = NEW.room_generation
)
OR (
  NEW.room_generation = 0 AND EXISTS (
    SELECT 1 FROM mxqr_developer_api_room_tombstones
    WHERE room_code = NEW.room_code
  )
)
BEGIN
  SELECT RAISE(IGNORE);
END;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_natural_expiry_audit;
CREATE TRIGGER trg_mxqr_developer_api_keys_natural_expiry_audit
AFTER UPDATE OF status, revoked_at, updated_at ON mxqr_developer_api_keys
WHEN OLD.status = 'active'
  AND NEW.status = 'revoked'
  AND NEW.expires_at = OLD.expires_at
  AND NEW.revoked_at = OLD.expires_at
  AND NEW.updated_at = CASE
    WHEN OLD.updated_at > OLD.expires_at THEN OLD.updated_at
    ELSE OLD.expires_at
  END
BEGIN
  INSERT OR IGNORE INTO mxqr_developer_api_admin_audit
    (actor_id, action, result, key_id, room_code, room_generation, created_at)
  VALUES
    (
      'system:expiry',
      'key.expire',
      'expired',
      NEW.key_id,
      NEW.room_code,
      NEW.room_generation,
      NEW.expires_at
    );
END;
