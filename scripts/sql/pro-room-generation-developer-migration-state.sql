SELECT
  (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_developer_api_keys')
    WHERE name = 'room_generation'
  ) AS keys_generation_column,
  (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_developer_api_audit')
    WHERE name = 'room_generation'
  ) AS audit_generation_column,
  (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_developer_api_admin_audit')
    WHERE name = 'room_generation'
  ) AS admin_audit_generation_column,
  (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_developer_api_keys')
    WHERE name = 'room_generation'
  )
  + (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_developer_api_audit')
    WHERE name = 'room_generation'
  )
  + (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_developer_api_admin_audit')
    WHERE name = 'room_generation'
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table'
      AND name = 'mxqr_developer_api_room_generation_tombstones'
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'index'
      AND name = 'idx_mxqr_developer_api_keys_room_status_expiry'
      AND instr(lower(sql), 'room_generation') > 0
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name IN (
        'trg_mxqr_developer_api_keys_decommissioned_room',
        'trg_mxqr_developer_api_keys_active_insert',
        'trg_mxqr_developer_api_keys_active_update',
        'trg_mxqr_developer_api_audit_decommissioned_room',
        'trg_mxqr_developer_api_admin_audit_decommissioned_room'
      )
      AND instr(lower(sql), 'room_generation') > 0
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'trg_mxqr_developer_api_keys_natural_expiry_audit'
      AND instr(lower(sql), '(actor_id, action, result, key_id, room_code, room_generation, created_at)') > 0
      AND instr(lower(sql), 'new.room_generation') > 0
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'trg_mxqr_developer_api_keys_incarnation_immutable'
      AND instr(lower(sql), 'on mxqr_developer_api_keys') > 0
      AND instr(lower(sql), 'new.room_code <> old.room_code') > 0
      AND instr(lower(sql), 'new.room_generation <> old.room_generation') > 0
      AND instr(lower(sql), 'developer_api_key_incarnation_immutable') > 0
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'trg_mxqr_developer_api_room_generation_tombstones_monotonic'
      AND instr(lower(sql), 'on mxqr_developer_api_room_generation_tombstones') > 0
      AND instr(lower(sql), 'new.room_code <> old.room_code') > 0
      AND instr(lower(sql), 'new.room_generation <> old.room_generation') > 0
      AND instr(lower(sql), 'new.request_id <> old.request_id') > 0
      AND instr(lower(sql), 'new.decommissioned_at > old.decommissioned_at') > 0
      AND instr(lower(sql), 'developer_api_room_generation_tombstone_immutable') > 0
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'trg_mxqr_developer_api_room_generation_tombstones_no_delete'
      AND instr(lower(sql), 'before delete on mxqr_developer_api_room_generation_tombstones') > 0
      AND instr(lower(sql), 'developer_api_room_generation_tombstone_immutable') > 0
  ) AS features_present,
  14 AS features_expected;
