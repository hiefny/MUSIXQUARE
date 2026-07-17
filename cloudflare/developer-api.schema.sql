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

CREATE INDEX IF NOT EXISTS idx_mxqr_developer_api_keys_room_status_expiry
  ON mxqr_developer_api_keys (room_code, status, expires_at);

-- The scheduled global expiry sweep cannot use the room-prefixed operator
-- index above. Keep its active-and-expired lookup bounded as key volume grows.
CREATE INDEX IF NOT EXISTS idx_mxqr_developer_api_keys_status_expiry
  ON mxqr_developer_api_keys (status, expires_at);

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

-- A key ID is never reactivated or reused. Keep concurrent idempotent revoke
-- requests from producing more than one operator audit row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_developer_api_admin_audit_key_revoke
  ON mxqr_developer_api_admin_audit (key_id, action)
  WHERE action = 'key.revoke';

-- Natural expiry is represented as a revocation at the credential's exact
-- expiry instant. The trigger makes the lifecycle transition and its audit
-- entry one SQLite transaction. The partial unique index plus OR IGNORE keeps
-- an accidental later reactivation/expiry from duplicating the audit record.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_developer_api_admin_audit_key_expiry
  ON mxqr_developer_api_admin_audit (key_id, action)
  WHERE action = 'key.expire';

CREATE TRIGGER IF NOT EXISTS trg_mxqr_developer_api_keys_natural_expiry_audit
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
