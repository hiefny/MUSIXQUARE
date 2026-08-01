-- Forward-only launch cutover: decommission fences always identify an exact
-- room generation.

DROP TRIGGER IF EXISTS trg_mxqr_developer_api_room_tombstones_monotonic;
DROP TRIGGER IF EXISTS trg_mxqr_developer_api_room_tombstones_no_delete;
DROP TABLE IF EXISTS mxqr_developer_api_room_tombstones;
