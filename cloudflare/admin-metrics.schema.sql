-- Retire the pre-aggregate API limiter table. Runtime rate limiting no longer
-- reads or writes this table, so keeping it only creates schema drift.
DROP TABLE IF EXISTS mxqr_api_rate_limits;

-- Per-article overrides preserve the existing KV visibility snapshot without
-- read/modify/write races. An explicit unhide must remain a hidden=0 row.
CREATE TABLE IF NOT EXISTS mxqr_soro_article_visibility (
  slug TEXT PRIMARY KEY NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 120
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND substr(slug, 1, 1) GLOB '[a-z0-9]'
    AND substr(slug, -1, 1) GLOB '[a-z0-9]'
    AND instr(slug, '--') = 0
  ),
  hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE IF NOT EXISTS mxqr_metric_buckets (
  bucket_minute INTEGER NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (bucket_minute, event)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_metric_buckets_event_minute
  ON mxqr_metric_buckets (event, bucket_minute);

-- Permanent, aggregate-only counters used by public editorial surfaces.
-- Minute buckets remain bounded operational telemetry; this table is never
-- touched by their retention cleanup. Only a fresh standard-room `room_opened`
-- bucket increment contributes, so PRO rooms and host reconnects stay out of
-- the public total by construction.
CREATE TABLE IF NOT EXISTS mxqr_lifetime_metric_totals (
  event TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
);

CREATE TRIGGER IF NOT EXISTS mxqr_lifetime_room_opened_insert
AFTER INSERT ON mxqr_metric_buckets
WHEN NEW.event = 'room_opened' AND NEW.count > 0
BEGIN
  INSERT INTO mxqr_lifetime_metric_totals (event, count)
  VALUES ('room_opened', NEW.count)
  ON CONFLICT(event) DO UPDATE SET count = count + excluded.count;
END;

CREATE TRIGGER IF NOT EXISTS mxqr_lifetime_room_opened_increment
AFTER UPDATE OF count ON mxqr_metric_buckets
WHEN NEW.event = 'room_opened' AND NEW.count > OLD.count
BEGIN
  INSERT INTO mxqr_lifetime_metric_totals (event, count)
  VALUES ('room_opened', NEW.count - OLD.count)
  ON CONFLICT(event) DO UPDATE SET count = count + excluded.count;
END;

-- This is both the initial backfill and the idempotent repair path. Triggers
-- are installed first so a room opening while this schema is applied is
-- serialized either before the snapshot (and included in SUM) or after it
-- (and added by the trigger). MAX prevents a later baseline reapplication from
-- reducing the permanent total after old minute buckets have expired.
INSERT INTO mxqr_lifetime_metric_totals (event, count)
SELECT 'room_opened', COALESCE(SUM(count), 0)
FROM mxqr_metric_buckets
WHERE event = 'room_opened'
ON CONFLICT(event) DO UPDATE SET
  count = MAX(mxqr_lifetime_metric_totals.count, excluded.count);

-- Permanent daily increments for the administrator's service-lifetime chart.
-- A day is the UTC Unix-day number. Keeping aggregate increments instead of
-- visitor, room, or request identities preserves the existing metrics privacy
-- boundary while allowing the minute buckets to retain their 90-day horizon.
CREATE TABLE IF NOT EXISTS mxqr_lifetime_metric_days (
  day_epoch INTEGER NOT NULL CHECK (day_epoch >= 0),
  event TEXT NOT NULL CHECK (event IN ('room_opened', 'guest_joined')),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day_epoch, event)
);

CREATE TRIGGER IF NOT EXISTS mxqr_lifetime_guest_joined_insert
AFTER INSERT ON mxqr_metric_buckets
WHEN NEW.event = 'guest_joined' AND NEW.count > 0
BEGIN
  INSERT INTO mxqr_lifetime_metric_totals (event, count)
  VALUES ('guest_joined', NEW.count)
  ON CONFLICT(event) DO UPDATE SET count = count + excluded.count;
END;

CREATE TRIGGER IF NOT EXISTS mxqr_lifetime_guest_joined_increment
AFTER UPDATE OF count ON mxqr_metric_buckets
WHEN NEW.event = 'guest_joined' AND NEW.count > OLD.count
BEGIN
  INSERT INTO mxqr_lifetime_metric_totals (event, count)
  VALUES ('guest_joined', NEW.count - OLD.count)
  ON CONFLICT(event) DO UPDATE SET count = count + excluded.count;
END;

CREATE TRIGGER IF NOT EXISTS mxqr_lifetime_metric_day_insert
AFTER INSERT ON mxqr_metric_buckets
WHEN NEW.event IN ('room_opened', 'guest_joined') AND NEW.count > 0
BEGIN
  INSERT INTO mxqr_lifetime_metric_days (day_epoch, event, count)
  VALUES (NEW.bucket_minute / 1440, NEW.event, NEW.count)
  ON CONFLICT(day_epoch, event) DO UPDATE SET count = count + excluded.count;
END;

CREATE TRIGGER IF NOT EXISTS mxqr_lifetime_metric_day_increment
AFTER UPDATE OF count ON mxqr_metric_buckets
WHEN NEW.event IN ('room_opened', 'guest_joined') AND NEW.count > OLD.count
BEGIN
  INSERT INTO mxqr_lifetime_metric_days (day_epoch, event, count)
  VALUES (NEW.bucket_minute / 1440, NEW.event, NEW.count - OLD.count)
  ON CONFLICT(day_epoch, event) DO UPDATE SET count = count + excluded.count;
END;

-- Analytics collection began on 2026-06-18 and the first application of this
-- contract is still within the 90-day minute-bucket horizon, so this seeds the
-- complete measured history. MAX keeps later baseline repairs monotonic after
-- old minute buckets have expired.
INSERT INTO mxqr_lifetime_metric_days (day_epoch, event, count)
SELECT bucket_minute / 1440, event, SUM(count)
FROM mxqr_metric_buckets
WHERE event IN ('room_opened', 'guest_joined')
GROUP BY bucket_minute / 1440, event
ON CONFLICT(day_epoch, event) DO UPDATE SET
  count = MAX(mxqr_lifetime_metric_days.count, excluded.count);

INSERT INTO mxqr_lifetime_metric_totals (event, count)
SELECT event, COALESCE(SUM(count), 0)
FROM mxqr_metric_buckets
WHERE event IN ('room_opened', 'guest_joined')
GROUP BY event
ON CONFLICT(event) DO UPDATE SET
  count = MAX(mxqr_lifetime_metric_totals.count, excluded.count);

INSERT INTO mxqr_lifetime_metric_totals (event, count)
VALUES ('guest_joined', 0)
ON CONFLICT(event) DO NOTHING;

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

-- Bounded full repair must revisit every immutable room incarnation, including
-- delayed reverse-edge writes after an earlier successful cleanup. This cursor
-- is progress only; it never changes room authority or marks cleanup permanent.
CREATE TABLE IF NOT EXISTS mxqr_pro_room_retirement_cursor (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991
  ),
  completed_at INTEGER,
  room_code TEXT,
  room_generation INTEGER,
  CHECK (
    (completed_at IS NULL AND room_code IS NULL AND room_generation IS NULL)
    OR (
      completed_at IS NOT NULL AND typeof(completed_at) = 'integer' AND completed_at >= 0
      AND room_code IS NOT NULL AND length(room_code) = 6
      AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'
      AND room_generation IS NOT NULL AND typeof(room_generation) = 'integer'
      AND room_generation BETWEEN 0 AND 9007199254740991
    )
  )
);

INSERT OR IGNORE INTO mxqr_pro_room_retirement_cursor (singleton, revision) VALUES (1, 0);

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

-- Generic PRO entitlement control plane. Campaigns are acquisition sources,
-- never room types; room authority remains bound to (room_code, room_generation).
-- Voucher plaintext is never stored: only keyed HMAC-SHA256 digests are retained.
CREATE TABLE IF NOT EXISTS mxqr_pro_grant_campaigns (
  campaign_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(campaign_id) = 31
    AND substr(campaign_id, 1, 9) = 'campaign_'
    AND campaign_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  slug TEXT NOT NULL UNIQUE CHECK (
    length(slug) BETWEEN 1 AND 64
    AND slug GLOB '[a-z0-9]*'
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND substr(slug, -1) GLOB '[a-z0-9]'
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'ended', 'revoked')),
  starts_at INTEGER CHECK (starts_at IS NULL OR starts_at >= 0),
  ends_at INTEGER CHECK (ends_at IS NULL OR ends_at >= 0),
  per_account_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_account_limit BETWEEN 1 AND 10),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS mxqr_pro_grant_voucher_batches (
  campaign_id TEXT NOT NULL REFERENCES mxqr_pro_grant_campaigns(campaign_id),
  request_id TEXT NOT NULL CHECK (
    length(request_id) = 28
    AND substr(request_id, 1, 6) = 'batch_'
    AND request_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 43
    AND request_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('committed', 'revoked')),
  voucher_count INTEGER NOT NULL CHECK (voucher_count BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (campaign_id, request_id)
);

CREATE TABLE IF NOT EXISTS mxqr_pro_grant_vouchers (
  voucher_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(voucher_id) = 30
    AND substr(voucher_id, 1, 8) = 'voucher_'
    AND voucher_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  campaign_id TEXT NOT NULL REFERENCES mxqr_pro_grant_campaigns(campaign_id),
  batch_request_id TEXT NOT NULL CHECK (
    length(batch_request_id) = 28
    AND substr(batch_request_id, 1, 6) = 'batch_'
    AND batch_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  code_digest TEXT NOT NULL UNIQUE CHECK (
    length(code_digest) = 43
    AND code_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  room_code TEXT NOT NULL CHECK (
    length(room_code) = 6
    AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'
  ),
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('available', 'redeemed', 'revoked')),
  redeemed_account_id TEXT CHECK (
    redeemed_account_id IS NULL
    OR (
      length(redeemed_account_id) = 27
      AND substr(redeemed_account_id, 1, 5) = 'acct_'
      AND redeemed_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  redeemed_at INTEGER CHECK (redeemed_at IS NULL OR redeemed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (room_code, room_generation),
  FOREIGN KEY (campaign_id, batch_request_id)
    REFERENCES mxqr_pro_grant_voucher_batches(campaign_id, request_id),
  CHECK (
    (status = 'redeemed' AND redeemed_account_id IS NOT NULL AND redeemed_at IS NOT NULL)
    OR (status <> 'redeemed' AND redeemed_account_id IS NULL AND redeemed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_vouchers_campaign_status
ON mxqr_pro_grant_vouchers(campaign_id, status, room_code, room_generation);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_vouchers_batch
ON mxqr_pro_grant_vouchers(campaign_id, batch_request_id, room_code);

CREATE TABLE IF NOT EXISTS mxqr_pro_grant_account_fences (
  account_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(account_id) = 27
    AND substr(account_id, 1, 5) = 'acct_'
    AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  reason TEXT NOT NULL CHECK (reason = 'account_deleted'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE IF NOT EXISTS mxqr_pro_grants (
  grant_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(grant_id) = 28
    AND substr(grant_id, 1, 6) = 'grant_'
    AND grant_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  product_code TEXT NOT NULL CHECK (product_code = 'pro_room'),
  plan_code TEXT NOT NULL CHECK (
    length(plan_code) BETWEEN 3 AND 80
    AND plan_code GLOB '[a-z0-9]*'
    AND plan_code NOT GLOB '*[^a-z0-9_:-]*'
  ),
  account_id TEXT NOT NULL CHECK (
    length(account_id) = 27
    AND substr(account_id, 1, 5) = 'acct_'
    AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_type TEXT NOT NULL CHECK (source_type IN ('campaign', 'purchase', 'manual', 'legacy')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (
    status IN ('pending_activation', 'active', 'suspended', 'orphaned', 'revoked')
  ),
  valid_from INTEGER NOT NULL CHECK (valid_from >= 0),
  valid_until INTEGER CHECK (valid_until IS NULL OR valid_until > valid_from),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (source_type, source_ref, account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_grants_one_current_pro_per_account
ON mxqr_pro_grants(account_id, product_code)
WHERE product_code = 'pro_room'
  AND status IN ('pending_activation', 'active', 'suspended');

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grants_validity_status
ON mxqr_pro_grants(status, valid_until, valid_from, account_id);

CREATE TABLE IF NOT EXISTS mxqr_pro_grant_allocations (
  allocation_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(allocation_id) = 33
    AND substr(allocation_id, 1, 11) = 'allocation_'
    AND allocation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  grant_id TEXT NOT NULL UNIQUE REFERENCES mxqr_pro_grants(grant_id),
  room_code TEXT NOT NULL CHECK (
    length(room_code) = 6
    AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'
  ),
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'active', 'suspended', 'orphaned', 'revoked')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (room_code, room_generation)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_allocations_room_status
ON mxqr_pro_grant_allocations(room_code, room_generation, status);

-- Product-wide serialization point for every route that can create or move a
-- PRO owner. Grant rows remain the acquisition ledger, while this table also
-- covers legacy activation and ownership transfer paths that live in other D1
-- databases. Transfer-source rows keep the source account occupied while
-- leaving the room index available for the target reservation in the batch.
CREATE TABLE IF NOT EXISTS mxqr_pro_account_entitlements (
  entitlement_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL CHECK (
    length(account_id) = 27
    AND substr(account_id, 1, 5) = 'acct_'
    AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  room_code TEXT NOT NULL CHECK (
    length(room_code) = 6
    AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'
  ),
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('grant', 'legacy_activation', 'owner_transfer')
  ),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 128),
  transfer_request_id TEXT CHECK (
    transfer_request_id IS NULL
    OR (
      length(transfer_request_id) BETWEEN 16 AND 64
      AND transfer_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'reserved',
      'active',
      'suspended',
      'transfer_source_reserved',
      'transfer_source_active',
      'transfer_source_suspended',
      'transfer_source_orphaned',
      'transfer_target_pending',
      'transferred',
      'orphaned',
      'revoked'
    )
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (source_kind, source_ref),
  CHECK (
    status NOT IN (
      'transfer_source_reserved',
      'transfer_source_active',
      'transfer_source_suspended',
      'transfer_source_orphaned',
      'transfer_target_pending',
      'transferred'
    )
    OR transfer_request_id IS NOT NULL
  ),
  CHECK (source_kind <> 'owner_transfer' OR transfer_request_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_account_entitlements_one_current_account
ON mxqr_pro_account_entitlements(account_id)
WHERE status IN (
  'reserved',
  'active',
  'suspended',
  'transfer_source_reserved',
  'transfer_source_active',
  'transfer_source_suspended'
);

-- Orphaning releases the deleted account but deliberately keeps its exact
-- room incarnation unavailable until an explicit room lifecycle operation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_account_entitlements_one_reserved_room
ON mxqr_pro_account_entitlements(room_code, room_generation)
WHERE status IN ('reserved', 'active', 'suspended', 'orphaned');

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_account_entitlements_room_status
ON mxqr_pro_account_entitlements(room_code, room_generation, status);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_account_entitlements_transfer_request
ON mxqr_pro_account_entitlements(transfer_request_id, status)
WHERE transfer_request_id IS NOT NULL;

-- Upgrade existing grant-backed allocations into the central serializer. New
-- voucher redemptions insert this row before mutating their voucher.
INSERT OR IGNORE INTO mxqr_pro_account_entitlements (
  account_id,
  room_code,
  room_generation,
  source_kind,
  source_ref,
  transfer_request_id,
  status,
  created_at,
  updated_at
)
SELECT grant.account_id,
       allocation.room_code,
       allocation.room_generation,
       'grant',
       grant.grant_id,
       NULL,
       CASE grant.status
         WHEN 'pending_activation' THEN 'reserved'
         WHEN 'active' THEN 'active'
         WHEN 'suspended' THEN 'suspended'
         WHEN 'orphaned' THEN 'orphaned'
         ELSE 'revoked'
       END,
       grant.created_at,
       MAX(grant.updated_at, allocation.updated_at)
  FROM mxqr_pro_grants grant
  JOIN mxqr_pro_grant_allocations allocation ON allocation.grant_id = grant.grant_id;

CREATE TABLE IF NOT EXISTS mxqr_pro_grant_redemptions (
  redemption_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(redemption_id) = 33
    AND substr(redemption_id, 1, 11) = 'redemption_'
    AND redemption_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  campaign_id TEXT NOT NULL REFERENCES mxqr_pro_grant_campaigns(campaign_id),
  voucher_id TEXT NOT NULL UNIQUE REFERENCES mxqr_pro_grant_vouchers(voucher_id),
  grant_id TEXT NOT NULL UNIQUE REFERENCES mxqr_pro_grants(grant_id),
  account_id TEXT NOT NULL CHECK (
    length(account_id) = 27
    AND substr(account_id, 1, 5) = 'acct_'
    AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('redeemed', 'fulfilled', 'orphaned', 'revoked')),
  claim_generation INTEGER CHECK (claim_generation IS NULL OR claim_generation >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_redemptions_account_campaign
ON mxqr_pro_grant_redemptions(account_id, campaign_id, status, created_at);

CREATE TABLE IF NOT EXISTS mxqr_pro_grant_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 8 AND 120),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 80),
  result TEXT NOT NULL CHECK (length(result) BETWEEN 2 AND 80),
  campaign_id TEXT,
  voucher_id TEXT,
  grant_id TEXT,
  allocation_id TEXT,
  redemption_id TEXT,
  room_code TEXT CHECK (
    room_code IS NULL
    OR (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]')
  ),
  room_generation INTEGER CHECK (room_generation IS NULL OR room_generation >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK ((room_code IS NULL) = (room_generation IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_audit_campaign_created
ON mxqr_pro_grant_audit(campaign_id, created_at);

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_campaigns_no_delete
BEFORE DELETE ON mxqr_pro_grant_campaigns
BEGIN
  SELECT RAISE(ABORT, 'PRO grant campaigns are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_voucher_batches_no_delete
BEFORE DELETE ON mxqr_pro_grant_voucher_batches
BEGIN
  SELECT RAISE(ABORT, 'PRO grant voucher batches are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_voucher_material_immutable
BEFORE UPDATE OF campaign_id, batch_request_id, code_digest, room_code, room_generation
ON mxqr_pro_grant_vouchers
WHEN NEW.campaign_id <> OLD.campaign_id
  OR NEW.batch_request_id <> OLD.batch_request_id
  OR NEW.code_digest <> OLD.code_digest
  OR NEW.room_code <> OLD.room_code
  OR NEW.room_generation <> OLD.room_generation
BEGIN
  SELECT RAISE(ABORT, 'PRO grant voucher material is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_voucher_registry_guard
BEFORE INSERT ON mxqr_pro_grant_vouchers
WHEN NOT EXISTS (
  SELECT 1
  FROM mxqr_pro_room_registry registry
  WHERE registry.room_code = NEW.room_code
    AND registry.room_generation = NEW.room_generation
    AND registry.status = 'registered'
    AND registry.activation_state = 'unactivated'
)
OR EXISTS (
  SELECT 1
  FROM mxqr_pro_account_entitlements entitlement
  WHERE entitlement.room_code = NEW.room_code
    AND entitlement.room_generation = NEW.room_generation
    AND entitlement.status IN (
      'reserved',
      'active',
      'suspended',
      'orphaned',
      'transfer_source_reserved',
      'transfer_source_active',
      'transfer_source_suspended',
      'transfer_source_orphaned',
      'transfer_target_pending'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'PRO grant voucher room is unavailable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_vouchers_no_delete
BEFORE DELETE ON mxqr_pro_grant_vouchers
BEGIN
  SELECT RAISE(ABORT, 'PRO grant vouchers are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grants_no_delete
BEFORE DELETE ON mxqr_pro_grants
BEGIN
  SELECT RAISE(ABORT, 'PRO grants are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_account_fences_no_update
BEFORE UPDATE ON mxqr_pro_grant_account_fences
BEGIN
  SELECT RAISE(ABORT, 'PRO grant account fences are append-only');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_account_fences_no_delete
BEFORE DELETE ON mxqr_pro_grant_account_fences
BEGIN
  SELECT RAISE(ABORT, 'PRO grant account fences are append-only');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_allocations_no_delete
BEFORE DELETE ON mxqr_pro_grant_allocations
BEGIN
  SELECT RAISE(ABORT, 'PRO grant allocations are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_redemptions_no_delete
BEFORE DELETE ON mxqr_pro_grant_redemptions
BEGIN
  SELECT RAISE(ABORT, 'PRO grant redemptions are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_account_entitlements_material_immutable
BEFORE UPDATE OF account_id, room_code, room_generation, source_kind, source_ref, created_at
ON mxqr_pro_account_entitlements
WHEN NEW.account_id <> OLD.account_id
  OR NEW.room_code <> OLD.room_code
  OR NEW.room_generation <> OLD.room_generation
  OR NEW.source_kind <> OLD.source_kind
  OR NEW.source_ref <> OLD.source_ref
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'PRO account entitlement material is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_account_entitlements_no_delete
BEFORE DELETE ON mxqr_pro_account_entitlements
BEGIN
  SELECT RAISE(ABORT, 'PRO account entitlements are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_audit_no_update
BEFORE UPDATE ON mxqr_pro_grant_audit
BEGIN
  SELECT RAISE(ABORT, 'PRO grant audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_audit_no_delete
BEFORE DELETE ON mxqr_pro_grant_audit
BEGIN
  SELECT RAISE(ABORT, 'PRO grant audit is append-only');
END;
