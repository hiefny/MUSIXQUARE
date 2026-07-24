-- Add an immutable incarnation identity behind each reusable six-digit PRO
-- room address. Apply this once before deploying Workers that can register a
-- new generation for a previously decommissioned room code.

ALTER TABLE mxqr_pro_room_registry
  ADD COLUMN room_generation INTEGER NOT NULL DEFAULT 0
    CHECK (room_generation >= 0);

ALTER TABLE mxqr_pro_room_admin_audit
  ADD COLUMN room_generation INTEGER NOT NULL DEFAULT 0
    CHECK (room_generation >= 0);

CREATE INDEX idx_mxqr_pro_room_admin_audit_incarnation_created
ON mxqr_pro_room_admin_audit(room_code, room_generation, created_at);

CREATE TABLE mxqr_pro_room_generation_history (
  room_code TEXT NOT NULL,
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  status TEXT NOT NULL CHECK (status = 'decommissioned'),
  decommissioned_at INTEGER NOT NULL,
  request_id TEXT,
  PRIMARY KEY (room_code, room_generation)
);

-- Rows that reached decommissioned under the legacy single-incarnation
-- control plane are authoritative completed deletions. Preserve them as
-- generation zero before any room code can be reassigned.
INSERT OR IGNORE INTO mxqr_pro_room_generation_history (
  room_code,
  room_generation,
  status,
  decommissioned_at,
  request_id
)
SELECT
  room_code,
  room_generation,
  'decommissioned',
  updated_at,
  NULL
FROM mxqr_pro_room_registry
WHERE status = 'decommissioned';

-- Every incarnation allocation is permanent, including the current active or
-- in-progress pointer. History alone is insufficient because it only contains
-- completed deletions; losing an active pointer must not make generation zero
-- available again.
CREATE TABLE mxqr_pro_room_generation_allocations (
  room_code TEXT NOT NULL,
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  allocated_at INTEGER NOT NULL CHECK (allocated_at >= 0),
  PRIMARY KEY (room_code, room_generation)
);

INSERT INTO mxqr_pro_room_generation_allocations (
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

CREATE TRIGGER mxqr_pro_room_generation_allocations_no_update
BEFORE UPDATE ON mxqr_pro_room_generation_allocations
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation allocation is immutable');
END;

CREATE TRIGGER mxqr_pro_room_generation_allocations_no_delete
BEFORE DELETE ON mxqr_pro_room_generation_allocations
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation allocation is immutable');
END;

CREATE TRIGGER mxqr_pro_room_generation_history_no_update
BEFORE UPDATE ON mxqr_pro_room_generation_history
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation history is immutable');
END;

CREATE TRIGGER mxqr_pro_room_generation_history_no_delete
BEFORE DELETE ON mxqr_pro_room_generation_history
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation history is immutable');
END;

CREATE TRIGGER mxqr_pro_room_generation_history_requires_allocation
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

CREATE TRIGGER mxqr_pro_room_registry_no_delete
BEFORE DELETE ON mxqr_pro_room_registry
BEGIN
  SELECT RAISE(ABORT, 'PRO room registry pointers are immutable');
END;

CREATE TRIGGER mxqr_pro_room_registry_room_code_immutable
BEFORE UPDATE OF room_code ON mxqr_pro_room_registry
WHEN NEW.room_code <> OLD.room_code
BEGIN
  SELECT RAISE(ABORT, 'PRO room registry code is immutable');
END;

CREATE TRIGGER mxqr_pro_room_registry_status_insert_guard
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

CREATE TRIGGER mxqr_pro_room_registry_status_transition_guard
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

CREATE TRIGGER mxqr_pro_room_registry_initial_generation_guard
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

CREATE TRIGGER mxqr_pro_room_registry_allocate_initial_generation
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

-- This singleton remains disabled until the approved release workflow has
-- verified the admin/auth/Developer schemas, deployed every generation-aware
-- dependency Worker, and completed their live smokes. Merely applying the
-- migration must never make a decommissioned room code reusable.
CREATE TABLE mxqr_pro_room_generation_cutover (
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

INSERT INTO mxqr_pro_room_generation_cutover (
  contract_version,
  status,
  release_sha,
  ever_enabled,
  floor_release_sha,
  updated_at
) VALUES (1, 'disabled', NULL, 0, NULL, 0);

CREATE TRIGGER mxqr_pro_room_generation_cutover_floor_immutable
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

CREATE TRIGGER mxqr_pro_room_generation_cutover_no_delete
BEFORE DELETE ON mxqr_pro_room_generation_cutover
BEGIN
  SELECT RAISE(ABORT, 'PRO room generation cutover is permanent');
END;

CREATE TRIGGER mxqr_pro_room_registry_allocate_next_generation
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
