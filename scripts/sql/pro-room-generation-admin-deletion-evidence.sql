-- First-generation cutover evidence for the two legacy rooms that completed
-- permanent deletion before public room codes became reusable. This query is
-- intentionally read-only. The release verifier rejects missing, duplicate,
-- later-generation, or too-recent evidence.
WITH required_room_codes(room_code) AS (
  VALUES ('000002'), ('000003')
)
SELECT
  required.room_code,
  registry.status AS registry_status,
  registry.room_generation AS registry_generation,
  registry.updated_at AS registry_updated_at,
  (
    SELECT COUNT(*)
    FROM mxqr_pro_room_generation_history AS history
    WHERE history.room_code = required.room_code
      AND history.room_generation = 0
      AND history.status = 'decommissioned'
  ) AS history_count,
  (
    SELECT history.decommissioned_at
    FROM mxqr_pro_room_generation_history AS history
    WHERE history.room_code = required.room_code
      AND history.room_generation = 0
      AND history.status = 'decommissioned'
    LIMIT 1
  ) AS history_decommissioned_at,
  (
    SELECT COUNT(*)
    FROM mxqr_pro_room_generation_allocations AS allocation
    WHERE allocation.room_code = required.room_code
      AND allocation.room_generation = 0
  ) AS allocation_count,
  (
    SELECT COUNT(*)
    FROM mxqr_pro_room_generation_allocations AS allocation
    WHERE allocation.room_code = required.room_code
      AND allocation.room_generation <> 0
  ) AS other_allocation_count,
  (
    SELECT COUNT(*)
    FROM mxqr_pro_room_admin_audit AS audit
    WHERE audit.room_code = required.room_code
      AND audit.room_generation = 0
      AND audit.action = 'room.delete'
      AND audit.result = 'authorized'
  ) AS authorized_delete_audit_count,
  (
    SELECT MAX(audit.created_at)
    FROM mxqr_pro_room_admin_audit AS audit
    WHERE audit.room_code = required.room_code
      AND audit.room_generation = 0
      AND audit.action = 'room.delete'
      AND audit.result = 'authorized'
  ) AS authorized_delete_audit_latest_at,
  CAST(unixepoch() AS INTEGER) * 1000 AS observed_at
FROM required_room_codes AS required
LEFT JOIN mxqr_pro_room_registry AS registry
  ON registry.room_code = required.room_code
ORDER BY required.room_code;
