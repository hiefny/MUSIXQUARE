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
