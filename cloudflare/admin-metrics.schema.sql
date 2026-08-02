-- Retire the pre-aggregate API limiter table. Runtime rate limiting no longer
-- reads or writes this table, so keeping it only creates schema drift.
DROP TABLE IF EXISTS mxqr_api_rate_limits;

CREATE TABLE IF NOT EXISTS mxqr_metric_buckets (
  bucket_minute INTEGER NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (bucket_minute, event)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_metric_buckets_event_minute
  ON mxqr_metric_buckets (event, bucket_minute);

-- Access-gated PRO room registry. Playback state and media metadata remain in
-- each room's Durable Object; raw activation claims are never stored here.
CREATE TABLE IF NOT EXISTS mxqr_pro_room_registry (
  room_code TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  suspension_reason TEXT,
  activation_state TEXT NOT NULL DEFAULT 'unactivated',
  room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Immutable incarnation tombstones. room_code is reusable only after the
-- preceding generation has reached the terminal decommissioned state. The
-- room Durable Object keeps the destructive-saga tombstone; this table keeps
-- the control-plane history after the public room-code pointer advances.
CREATE TABLE IF NOT EXISTS mxqr_pro_room_generation_history (
  room_code TEXT NOT NULL,
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  status TEXT NOT NULL CHECK (status = 'decommissioned'),
  decommissioned_at INTEGER NOT NULL,
  request_id TEXT,
  PRIMARY KEY (room_code, room_generation)
);

-- Append-only allocation ledger for every incarnation, including the active
-- generation. The registry is only a mutable public-code pointer; this ledger
-- is the permanent proof that a (room_code, room_generation) identity was
-- already issued and therefore can never be issued again after corruption or
-- pointer loss.
CREATE TABLE IF NOT EXISTS mxqr_pro_room_generation_allocations (
  room_code TEXT NOT NULL,
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  allocated_at INTEGER NOT NULL CHECK (allocated_at >= 0),
  PRIMARY KEY (room_code, room_generation)
);

-- Keep schema application idempotent on an existing database. Current pointer
-- rows are the best allocation-time source; immutable history fills any older
-- generation that is no longer current.
INSERT OR IGNORE INTO mxqr_pro_room_generation_allocations (
  room_code,
  room_generation,
  allocated_at
)
SELECT room_code, room_generation, created_at
FROM mxqr_pro_room_registry;

INSERT OR IGNORE INTO mxqr_pro_room_generation_allocations (
  room_code,
  room_generation,
  allocated_at
)
SELECT room_code, room_generation, decommissioned_at
FROM mxqr_pro_room_generation_history;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_allocations_no_update
BEFORE UPDATE ON mxqr_pro_room_generation_allocations
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation allocation is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_allocations_no_delete
BEFORE DELETE ON mxqr_pro_room_generation_allocations
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation allocation is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_history_no_update
BEFORE UPDATE ON mxqr_pro_room_generation_history
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_history_no_delete
BEFORE DELETE ON mxqr_pro_room_generation_history
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_history_requires_allocation
BEFORE INSERT ON mxqr_pro_room_generation_history
WHEN NOT EXISTS (
  SELECT 1
  FROM mxqr_pro_room_generation_allocations
  WHERE room_code = NEW.room_code
    AND room_generation = NEW.room_generation
)
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation allocation is missing');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_no_delete
BEFORE DELETE ON mxqr_pro_room_registry
BEGIN
  SELECT RAISE(ABORT, 'PRO room registry pointers are immutable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_room_code_immutable
BEFORE UPDATE OF room_code ON mxqr_pro_room_registry
WHEN NEW.room_code <> OLD.room_code
BEGIN
  SELECT RAISE(ABORT, 'PRO room registry code is immutable');
END;

-- The legacy registry table predates a status CHECK constraint. Additive
-- triggers reject malformed future writes and make deletion states terminal
-- for the current incarnation. Only the separately guarded generation + 1
-- transition may move a decommissioned public-code pointer to provisioning.
CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_status_insert_guard
BEFORE INSERT ON mxqr_pro_room_registry
WHEN NEW.status NOT IN (
  'registered',
  'provisioning',
  'suspended',
  'decommissioning',
  'decommissioned'
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid PRO room registry status');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_status_transition_guard
BEFORE UPDATE OF status, room_generation ON mxqr_pro_room_registry
WHEN NEW.status NOT IN (
    'registered',
    'provisioning',
    'suspended',
    'decommissioning',
    'decommissioned'
  )
  OR (
    NEW.room_generation = OLD.room_generation
    AND (
      (
        OLD.status = 'decommissioning'
        AND NEW.status NOT IN ('decommissioning', 'decommissioned')
      )
      OR (
        OLD.status = 'decommissioned'
        AND NEW.status <> 'decommissioned'
      )
    )
  )
  OR (
    NEW.room_generation = OLD.room_generation
    AND OLD.status <> 'decommissioned'
    AND NEW.status = 'decommissioned'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM mxqr_pro_room_generation_allocations
        WHERE room_code = NEW.room_code
          AND room_generation = NEW.room_generation
      )
      OR NOT EXISTS (
        SELECT 1
        FROM mxqr_pro_room_generation_history
        WHERE room_code = NEW.room_code
          AND room_generation = NEW.room_generation
          AND status = 'decommissioned'
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Invalid PRO room registry status or terminal evidence transition');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_suspension_reason_insert_guard
BEFORE INSERT ON mxqr_pro_room_registry
WHEN (
  NEW.status = 'suspended'
  AND (
    NEW.suspension_reason IS NULL
    OR NEW.suspension_reason NOT IN (
      'operator_suspended',
      'owner_account_deleted',
      'ownership_transfer_pending'
    )
  )
) OR (NEW.status <> 'suspended' AND NEW.suspension_reason IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Invalid PRO room suspension reason');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_suspension_reason_update_guard
BEFORE UPDATE OF status, suspension_reason ON mxqr_pro_room_registry
WHEN (
  NEW.status = 'suspended'
  AND (
    NEW.suspension_reason IS NULL
    OR NEW.suspension_reason NOT IN (
      'operator_suspended',
      'owner_account_deleted',
      'ownership_transfer_pending'
    )
  )
) OR (NEW.status <> 'suspended' AND NEW.suspension_reason IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Invalid PRO room suspension reason');
END;

-- A missing pointer may never recreate generation zero when any immutable
-- evidence for that code remains. Repairing a lost pointer is an explicit
-- operator procedure, never an automatic registration path.
CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_initial_generation_guard
BEFORE INSERT ON mxqr_pro_room_registry
WHEN NOT EXISTS (
    SELECT 1
    FROM mxqr_pro_room_registry
    WHERE room_code = NEW.room_code
  )
  AND (
    NEW.room_generation <> 0
    OR EXISTS (
      SELECT 1
      FROM mxqr_pro_room_generation_allocations
      WHERE room_code = NEW.room_code
    )
    OR EXISTS (
      SELECT 1
      FROM mxqr_pro_room_generation_history
      WHERE room_code = NEW.room_code
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'PRO room registry repair required');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_allocate_initial_generation
AFTER INSERT ON mxqr_pro_room_registry
BEGIN
  INSERT INTO mxqr_pro_room_generation_allocations (
    room_code,
    room_generation,
    allocated_at
  ) VALUES (
    NEW.room_code,
    NEW.room_generation,
    NEW.created_at
  );
END;

-- A decommissioned public room code can advance to its next immutable
-- generation only after the approved release workflow has verified every D1
-- migration and generation-aware dependency Worker. Runtime code reads this
-- singleton fail-closed; creating the schema alone never enables reuse.
CREATE TABLE IF NOT EXISTS mxqr_pro_room_generation_cutover (
  contract_version INTEGER PRIMARY KEY CHECK (contract_version = 1),
  status TEXT NOT NULL CHECK (status IN ('disabled', 'ready')),
  release_sha TEXT,
  ever_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ever_enabled IN (0, 1)),
  floor_release_sha TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (
    (status = 'disabled' AND release_sha IS NULL)
    OR (
      status = 'ready'
      AND ever_enabled = 1
      AND length(release_sha) = 40
      AND release_sha NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    (ever_enabled = 0 AND floor_release_sha IS NULL)
    OR (
      ever_enabled = 1
      AND length(floor_release_sha) = 40
      AND floor_release_sha NOT GLOB '*[^0-9a-f]*'
    )
  )
);

INSERT OR IGNORE INTO mxqr_pro_room_generation_cutover (
  contract_version,
  status,
  release_sha,
  ever_enabled,
  floor_release_sha,
  updated_at
) VALUES (1, 'disabled', NULL, 0, NULL, 0);

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_cutover_floor_immutable
BEFORE UPDATE OF status, release_sha, ever_enabled, floor_release_sha
ON mxqr_pro_room_generation_cutover
WHEN (
    OLD.ever_enabled = 1
    AND (
      NEW.ever_enabled <> 1
      OR NEW.floor_release_sha IS NOT OLD.floor_release_sha
    )
  )
  OR (
    OLD.ever_enabled = 0
    AND NEW.ever_enabled = 1
    AND (
      NEW.status <> 'ready'
      OR NEW.release_sha IS NULL
      OR NEW.floor_release_sha IS NOT NEW.release_sha
      OR length(NEW.release_sha) <> 40
      OR NEW.release_sha GLOB '*[^0-9a-f]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation rollback floor is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_generation_cutover_no_delete
BEFORE DELETE ON mxqr_pro_room_generation_cutover
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation cutover is permanent');
END;

-- Generation changes are the sole pointer transition that allocates a new
-- immutable identity. SQLite executes this trigger and the registry UPDATE in
-- one transaction, so a competing registration cannot expose a pointer
-- without its allocation or allocate the same identity twice.
CREATE TRIGGER IF NOT EXISTS mxqr_pro_room_registry_allocate_next_generation
BEFORE UPDATE OF room_generation ON mxqr_pro_room_registry
WHEN NEW.room_generation <> OLD.room_generation
BEGIN
  SELECT CASE
    WHEN OLD.status <> 'decommissioned'
      OR NEW.status <> 'provisioning'
      OR NEW.room_generation <> OLD.room_generation + 1
      OR NEW.room_generation > 9007199254740991
    THEN RAISE(ABORT, 'Invalid PRO room generation transition')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM mxqr_pro_room_generation_allocations
      WHERE room_code = OLD.room_code
        AND room_generation = OLD.room_generation
    )
    THEN RAISE(ABORT, 'PRO room current generation allocation is missing')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM mxqr_pro_room_generation_history
      WHERE room_code = OLD.room_code
        AND room_generation = OLD.room_generation
        AND status = 'decommissioned'
    )
    THEN RAISE(ABORT, 'PRO room generation history is missing')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM mxqr_pro_room_generation_cutover
      WHERE contract_version = 1
        AND status = 'ready'
        AND ever_enabled = 1
        AND length(release_sha) = 40
        AND release_sha NOT GLOB '*[^0-9a-f]*'
        AND length(floor_release_sha) = 40
        AND floor_release_sha NOT GLOB '*[^0-9a-f]*'
    )
    THEN RAISE(ABORT, 'PRO room generation cutover is not ready')
  END;
  INSERT INTO mxqr_pro_room_generation_allocations (
    room_code,
    room_generation,
    allocated_at
  ) VALUES (
    NEW.room_code,
    NEW.room_generation,
    NEW.created_at
  );
END;

-- Append-only application audit metadata. actor_id is an HMAC pseudonym; raw
-- Access identity, PINs, claims and activation URLs must never be stored here.
CREATE TABLE IF NOT EXISTS mxqr_pro_room_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  room_code TEXT NOT NULL,
  room_generation INTEGER NOT NULL DEFAULT 0 CHECK (room_generation >= 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_room_admin_audit_incarnation_created
ON mxqr_pro_room_admin_audit(room_code, room_generation, created_at);

-- Secret-free, durable owner-transfer reconciliation journal. Bearer claims,
-- PINs, commit proofs, cookies and revocation receipts must never be stored.
-- The exact transaction identifiers let App/cron finish the D1 projections
-- after the browser or an inter-Worker response disappears post-commit.
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

-- Issuance ledger for claims that may never be opened. The monotonically
-- increasing DO claim generation is enough to correlate a later PREPARE and
-- records natural expiry without persisting the bearer, nonce or its hash.
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
