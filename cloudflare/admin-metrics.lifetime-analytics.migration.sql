-- Preserve the complete measured room-open and guest-join history for the
-- administrator's cumulative analytics chart. Analytics collection began on
-- 2026-06-18; this migration is applied within the existing 90-day retention
-- horizon, so the retained minute buckets provide a complete initial backfill.
-- Only aggregate counts are retained: no room, account, visitor, or request
-- identity is introduced.

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

-- Install triggers before the snapshots. D1 serializes a concurrent bucket
-- write either before a snapshot (included by SUM) or after it (added by the
-- trigger). MAX also makes reapplication safe after bucket retention cleanup.
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
