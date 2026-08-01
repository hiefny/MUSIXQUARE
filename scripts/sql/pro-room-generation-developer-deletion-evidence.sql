-- Developer-credential deletion evidence for the two generation-zero rooms
-- covered by the initial room-code reuse cutover. The generation-scoped fence
-- must remain while every credential and audit row is gone.
WITH required_room_codes(room_code) AS (
  VALUES ('000002'), ('000003')
)
SELECT
  required.room_code,
  (
    SELECT COUNT(*)
    FROM mxqr_developer_api_room_generation_tombstones AS tombstone
    WHERE tombstone.room_code = required.room_code
      AND tombstone.room_generation = 0
  ) AS generation_tombstone_count,
  (
    SELECT tombstone.request_id
    FROM mxqr_developer_api_room_generation_tombstones AS tombstone
    WHERE tombstone.room_code = required.room_code
      AND tombstone.room_generation = 0
    LIMIT 1
  ) AS generation_request_id,
  (
    SELECT tombstone.decommissioned_at
    FROM mxqr_developer_api_room_generation_tombstones AS tombstone
    WHERE tombstone.room_code = required.room_code
      AND tombstone.room_generation = 0
    LIMIT 1
  ) AS generation_decommissioned_at,
  (
    SELECT COUNT(*)
    FROM mxqr_developer_api_room_generation_tombstones AS tombstone
    WHERE tombstone.room_code = required.room_code
      AND tombstone.room_generation <> 0
  ) AS other_generation_tombstone_count,
  (
    SELECT COUNT(*)
    FROM mxqr_developer_api_keys AS api_key
    WHERE api_key.room_code = required.room_code
  ) AS key_count,
  (
    SELECT COUNT(*)
    FROM mxqr_developer_api_audit AS audit
    WHERE audit.room_code = required.room_code
  ) AS api_audit_count,
  (
    SELECT COUNT(*)
    FROM mxqr_developer_api_admin_audit AS audit
    WHERE audit.room_code = required.room_code
  ) AS admin_audit_count
FROM required_room_codes AS required
ORDER BY required.room_code;
