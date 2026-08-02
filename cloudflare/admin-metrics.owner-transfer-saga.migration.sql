-- Durable, secret-free owner-transfer saga journal. This migration is
-- additive and intentionally forward-only because the intent must exist
-- before PREPARE can suspend the DO, and cron may need the row to adopt and
-- finish a transfer after any later App/D1 response boundary is lost.
CREATE TABLE IF NOT EXISTS mxqr_pro_room_owner_transfer_sagas (
  room_code TEXT NOT NULL
    CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  claim_generation INTEGER CHECK (claim_generation IS NULL OR claim_generation >= 0),
  transfer_id TEXT
    CHECK (
      transfer_id IS NULL
      OR (
      length(transfer_id) = 31
      AND substr(transfer_id, 1, 9) = 'transfer_'
      AND transfer_id NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  request_id TEXT NOT NULL
    CHECK (
      length(request_id) BETWEEN 16 AND 64
      AND request_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  target_account_id TEXT NOT NULL
    CHECK (
      length(target_account_id) = 27
      AND substr(target_account_id, 1, 5) = 'acct_'
      AND target_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  previous_owner_account_id TEXT
    CHECK (
      previous_owner_account_id IS NULL
      OR (
        length(previous_owner_account_id) = 27
        AND substr(previous_owner_account_id, 1, 5) = 'acct_'
        AND previous_owner_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
        AND previous_owner_account_id <> target_account_id
      )
    ),
  fence_digest TEXT CHECK (
    fence_digest IS NULL
    OR (
      length(fence_digest) = 43
      AND fence_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  state TEXT NOT NULL CHECK (state IN (
    'intent',
    'prepared',
    'committed',
    'registry_active',
    'old_owner_edge_retired',
    'verified',
    'complete',
    'target_deleted',
    'expired',
    'superseded'
  )),
  intent_at INTEGER NOT NULL CHECK (intent_at >= 0),
  prepared_at INTEGER CHECK (prepared_at IS NULL OR prepared_at >= 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > 0
    AND (prepared_at IS NULL OR expires_at > prepared_at)
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at >= intent_at),
  CHECK (
    (
      transfer_id IS NULL
      AND claim_generation IS NULL
      AND previous_owner_account_id IS NULL
      AND fence_digest IS NULL
      AND prepared_at IS NULL
      AND state IN ('intent', 'expired', 'superseded')
    )
    OR (
      transfer_id IS NOT NULL
      AND claim_generation IS NOT NULL
      AND fence_digest IS NOT NULL
      AND prepared_at IS NOT NULL
      AND state <> 'intent'
    )
  ),
  PRIMARY KEY (room_code, room_generation, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_room_owner_transfer_sagas_txn
ON mxqr_pro_room_owner_transfer_sagas(room_code, room_generation, transfer_id)
WHERE transfer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_room_owner_transfer_sagas_state_updated
ON mxqr_pro_room_owner_transfer_sagas(state, updated_at, room_code, room_generation);

CREATE TABLE IF NOT EXISTS mxqr_pro_room_owner_transfer_issuances (
  room_code TEXT NOT NULL
    CHECK (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'),
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  claim_generation INTEGER NOT NULL CHECK (claim_generation >= 0),
  target_account_id TEXT NOT NULL CHECK (
    length(target_account_id) = 27
    AND substr(target_account_id, 1, 5) = 'acct_'
    AND target_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  transfer_id TEXT CHECK (
    transfer_id IS NULL
    OR (
      length(transfer_id) = 31
      AND substr(transfer_id, 1, 9) = 'transfer_'
      AND transfer_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  request_id TEXT CHECK (
    request_id IS NULL
    OR (
      length(request_id) BETWEEN 16 AND 64
      AND request_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  state TEXT NOT NULL CHECK (state IN ('issued', 'prepared', 'expired', 'superseded')),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  updated_at INTEGER NOT NULL CHECK (updated_at >= issued_at),
  CHECK ((transfer_id IS NULL) = (request_id IS NULL)),
  CHECK (state <> 'prepared' OR transfer_id IS NOT NULL),
  PRIMARY KEY (room_code, room_generation, claim_generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_room_owner_transfer_issuances_txn
ON mxqr_pro_room_owner_transfer_issuances(room_code, room_generation, transfer_id, request_id)
WHERE transfer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_room_owner_transfer_issuances_state_expiry
ON mxqr_pro_room_owner_transfer_issuances(state, expires_at, room_code, room_generation);

-- Exact-once expiry audits are coupled to the successful conditional state
-- transition. Retrying the same expiry update cannot emit a duplicate row.
CREATE TRIGGER IF NOT EXISTS trg_mxqr_pro_room_owner_transfer_issuance_expiry_audit
AFTER UPDATE OF state ON mxqr_pro_room_owner_transfer_issuances
WHEN OLD.state = 'issued' AND NEW.state = 'expired'
BEGIN
  INSERT INTO mxqr_pro_room_admin_audit
    (actor_id, action, result, room_code, room_generation, created_at)
  VALUES
    ('system:owner-transfer', 'owner_transfer_claim.expire', 'expired',
     NEW.room_code, NEW.room_generation, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_mxqr_pro_room_owner_transfer_saga_expiry_audit
AFTER UPDATE OF state ON mxqr_pro_room_owner_transfer_sagas
WHEN OLD.state IN ('intent', 'prepared') AND NEW.state = 'expired'
BEGIN
  INSERT INTO mxqr_pro_room_admin_audit
    (actor_id, action, result, room_code, room_generation, created_at)
  VALUES
    ('system:owner-transfer', 'owner_transfer.prepare', 'expired',
     NEW.room_code, NEW.room_generation, NEW.updated_at);
END;
