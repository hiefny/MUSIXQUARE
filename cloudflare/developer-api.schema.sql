-- MUSIXQUARE Developer API uses a dedicated D1 database. Do not merge these
-- tables into the admin metrics database: key revocation and audit retention
-- are a separate security boundary.

CREATE TABLE IF NOT EXISTS mxqr_developer_api_keys (
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

CREATE INDEX IF NOT EXISTS idx_mxqr_developer_api_keys_room_status_expiry
  ON mxqr_developer_api_keys (room_code, status, expires_at);

-- The private beta intentionally caps credential fan-out. Rotation must
-- revoke an old key before issuing a fourth active key for the same room.
CREATE TRIGGER IF NOT EXISTS trg_mxqr_developer_api_keys_active_insert
BEFORE INSERT ON mxqr_developer_api_keys
WHEN NEW.status = 'active' AND (
  SELECT count(*) FROM mxqr_developer_api_keys
  WHERE room_code = NEW.room_code AND status = 'active'
) >= 3
BEGIN
  SELECT RAISE(ABORT, 'developer_api_active_key_limit');
END;

CREATE TRIGGER IF NOT EXISTS trg_mxqr_developer_api_keys_active_update
BEFORE UPDATE OF status, room_code ON mxqr_developer_api_keys
WHEN NEW.status = 'active' AND OLD.status <> 'active' AND (
  SELECT count(*) FROM mxqr_developer_api_keys
  WHERE room_code = NEW.room_code AND status = 'active' AND key_id <> NEW.key_id
) >= 3
BEGIN
  SELECT RAISE(ABORT, 'developer_api_active_key_limit');
END;

-- Mutation audit only. Never store raw keys, request bodies, filenames,
-- titles, participant names, PINs, or presigned URLs in this table.
CREATE TABLE IF NOT EXISTS mxqr_developer_api_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  room_code TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mxqr_developer_api_audit_created_at
  ON mxqr_developer_api_audit (created_at);

-- Access-gated operator actions use an HMAC pseudonym in actor_id. Raw Access
-- identity and the one-time full API key are never persisted.
CREATE TABLE IF NOT EXISTS mxqr_developer_api_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  key_id TEXT NOT NULL,
  room_code TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mxqr_developer_api_admin_audit_created_at
  ON mxqr_developer_api_admin_audit (created_at);
