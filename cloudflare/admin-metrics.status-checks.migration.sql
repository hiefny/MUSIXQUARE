-- Public /status check ledger (registry record RO-57): one row per component
-- and 15-minute slot, where o passed, p failed and m was recorded during
-- maintenance; a slot without a row reads as no check. It holds no room code,
-- account, IP or other user identifier. The newest checked_at wins for a slot,
-- and the App Worker cron removes rows older than 48 hours.
CREATE TABLE IF NOT EXISTS mxqr_status_checks (
  component TEXT NOT NULL CHECK (component IN ('website','rooms','connection','pro')),
  slot_at INTEGER NOT NULL CHECK (typeof(slot_at)='integer' AND slot_at >= 0 AND slot_at % 60000 = 0),
  result TEXT NOT NULL CHECK (result IN ('o','p','m')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 48),
  checked_at INTEGER NOT NULL CHECK (typeof(checked_at)='integer' AND checked_at >= 0),
  source TEXT NOT NULL CHECK (source IN ('cron','browser')),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 32),
  PRIMARY KEY (component, slot_at)
);
