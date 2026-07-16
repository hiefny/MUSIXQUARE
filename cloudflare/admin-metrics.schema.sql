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
  activation_state TEXT NOT NULL DEFAULT 'unactivated',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Append-only application audit metadata. actor_id is an HMAC pseudonym; raw
-- Access identity, PINs, claims and activation URLs must never be stored here.
CREATE TABLE IF NOT EXISTS mxqr_pro_room_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  room_code TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
