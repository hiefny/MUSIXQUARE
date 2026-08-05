-- Preserve the standard-room creation total beyond the 90-day operational
-- metric retention window. The source event is emitted only for a fresh
-- standard room; PRO room activity and host reconnects use different events.
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

-- Seed from every retained bucket after installing the triggers. D1 serializes
-- a concurrent bucket write either before this statement (included in SUM) or
-- after it (added by a trigger), avoiding a deploy-window gap. MAX makes the
-- migration idempotent without letting expired minute buckets lower the total.
INSERT INTO mxqr_lifetime_metric_totals (event, count)
SELECT 'room_opened', COALESCE(SUM(count), 0)
FROM mxqr_metric_buckets
WHERE event = 'room_opened'
ON CONFLICT(event) DO UPDATE SET
  count = MAX(mxqr_lifetime_metric_totals.count, excluded.count);
