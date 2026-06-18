CREATE TABLE IF NOT EXISTS mxqr_metric_buckets (
  bucket_minute INTEGER NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (bucket_minute, event)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_metric_buckets_event_minute
  ON mxqr_metric_buckets (event, bucket_minute);
