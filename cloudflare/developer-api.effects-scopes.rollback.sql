-- Emergency rollback for developer-api.effects-scopes.migration.sql.
--
-- Run this before restoring a Developer API Worker version that only accepts
-- scope masks through 63. The guard deliberately aborts instead of silently
-- granting a legacy scope to a credential that contains only effects scopes.

DROP TABLE IF EXISTS mxqr_developer_api_effects_rollback_guard;
CREATE TABLE mxqr_developer_api_effects_rollback_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
INSERT INTO mxqr_developer_api_effects_rollback_guard (ok)
SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM mxqr_developer_api_keys
    WHERE (scope_mask & 63) = 0
  ) THEN 0
  ELSE 1
END;
DROP TABLE mxqr_developer_api_effects_rollback_guard;

DROP TABLE IF EXISTS mxqr_developer_api_keys_effects_v1;
CREATE TABLE mxqr_developer_api_keys_effects_v1 (
  key_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(key_id) = 16 AND key_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  room_code TEXT NOT NULL
    CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  secret_digest TEXT NOT NULL UNIQUE
    CHECK (length(secret_digest) = 43 AND secret_digest NOT GLOB '*[^A-Za-z0-9_-]*'),
  digest_version INTEGER NOT NULL DEFAULT 1 CHECK (digest_version = 1),
  scope_mask INTEGER NOT NULL CHECK (scope_mask BETWEEN 1 AND 63),
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

INSERT INTO mxqr_developer_api_keys_effects_v1 (
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
  scope_mask & 63,
  status,
  created_at,
  updated_at,
  expires_at,
  revoked_at,
  last_used_hour
FROM mxqr_developer_api_keys;

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_active_insert;
DROP TRIGGER IF EXISTS trg_mxqr_developer_api_keys_active_update;
DROP INDEX IF EXISTS idx_mxqr_developer_api_keys_room_status_expiry;
DROP TABLE mxqr_developer_api_keys;
ALTER TABLE mxqr_developer_api_keys_effects_v1 RENAME TO mxqr_developer_api_keys;

CREATE INDEX idx_mxqr_developer_api_keys_room_status_expiry
  ON mxqr_developer_api_keys (room_code, status, expires_at);

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
