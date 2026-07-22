-- Expand the Developer API scope mask for effects:read (64) and
-- effects:control (128). Active credentials that previously held every
-- available scope inherit the two new scopes; narrower and revoked keys keep
-- their original least-privilege mask.

CREATE TABLE mxqr_developer_api_keys_effects_v2 (
  key_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(key_id) = 16 AND key_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  room_code TEXT NOT NULL
    CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  secret_digest TEXT NOT NULL UNIQUE
    CHECK (length(secret_digest) = 43 AND secret_digest NOT GLOB '*[^A-Za-z0-9_-]*'),
  digest_version INTEGER NOT NULL DEFAULT 1 CHECK (digest_version = 1),
  scope_mask INTEGER NOT NULL CHECK (scope_mask BETWEEN 1 AND 255),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER,
  last_used_hour INTEGER,
  CHECK (
    (status = 'active' AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= created_at)
  )
);

INSERT INTO mxqr_developer_api_keys_effects_v2 (
  key_id,
  room_code,
  label,
  secret_digest,
  digest_version,
  scope_mask,
  status,
  created_at,
  updated_at,
  expires_at,
  revoked_at,
  last_used_hour
)
SELECT
  key_id,
  room_code,
  label,
  secret_digest,
  digest_version,
  CASE WHEN status = 'active' AND scope_mask = 63 THEN 255 ELSE scope_mask END,
  status,
  created_at,
  updated_at,
  expires_at,
  revoked_at,
  last_used_hour
FROM mxqr_developer_api_keys;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_active_insert;
DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_active_update;
DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_expiry_audit;
DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_natural_expiry_audit;
DROP INDEX IF EXISTS idx_mxqr_developer_api_keys_room_status_expiry;
DROP INDEX IF EXISTS idx_mxqr_developer_api_keys_status_expiry;
DROP TABLE mxqr_developer_api_keys;
ALTER TABLE mxqr_developer_api_keys_effects_v2 RENAME TO mxqr_developer_api_keys;

CREATE INDEX idx_mxqr_developer_api_keys_room_status_expiry
  ON mxqr_developer_api_keys (room_code, status, expires_at);

CREATE INDEX idx_mxqr_developer_api_keys_status_expiry
  ON mxqr_developer_api_keys (status, expires_at);

-- Rebuilding mxqr_developer_api_keys drops every trigger attached to the old
-- table. Restore the permanent room-tombstone fence before credentials can be
-- issued against the migrated table.
CREATE TRIGGER trg_mxqr_developer_api_keys_decommissioned_room
BEFORE INSERT ON mxqr_developer_api_keys
WHEN EXISTS (
  SELECT 1 FROM mxqr_developer_api_room_tombstones
  WHERE room_code = NEW.room_code
)
BEGIN
  SELECT RAISE(ABORT, 'PRO_ROOM_DECOMMISSIONED');
END;

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
    (actor_id, action, result, key_id, room_code, created_at)
  VALUES
    ('system:expiry', 'key.expire', 'expired', NEW.key_id, NEW.room_code, NEW.expires_at);
END;

CREATE TRIGGER trg_mxqr_developer_api_keys_active_insert
BEFORE INSERT ON mxqr_developer_api_keys
WHEN NEW.status = 'active' AND (
  SELECT count(*) FROM mxqr_developer_api_keys
  WHERE room_code = NEW.room_code AND status = 'active'
) >= 3
BEGIN
  SELECT RAISE(ABORT, 'developer_api_active_key_limit');
END;

CREATE TRIGGER trg_mxqr_developer_api_keys_active_update
BEFORE UPDATE OF status, room_code ON mxqr_developer_api_keys
WHEN NEW.status = 'active' AND OLD.status <> 'active' AND (
  SELECT count(*) FROM mxqr_developer_api_keys
  WHERE room_code = NEW.room_code AND status = 'active' AND key_id <> NEW.key_id
) >= 3
BEGIN
  SELECT RAISE(ABORT, 'developer_api_active_key_limit');
END;
