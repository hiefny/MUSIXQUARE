SELECT
  (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_pro_room_registry')
    WHERE name = 'room_generation'
  ) AS registry_generation_column,
  (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_pro_room_admin_audit')
    WHERE name = 'room_generation'
  ) AS audit_generation_column,
  (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_pro_room_registry')
    WHERE name = 'room_generation'
  )
  + (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_pro_room_admin_audit')
    WHERE name = 'room_generation'
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table' AND name = 'mxqr_pro_room_generation_history'
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table' AND name = 'mxqr_pro_room_generation_allocations'
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name IN (
        'mxqr_pro_room_generation_history_no_update',
        'mxqr_pro_room_generation_history_no_delete'
      )
      AND instr(lower(sql), 'pro room generation history is immutable') > 0
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name IN (
        'mxqr_pro_room_generation_allocations_no_update',
        'mxqr_pro_room_generation_allocations_no_delete'
      )
      AND instr(lower(sql), 'pro room generation allocation is immutable') > 0
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_generation_history_requires_allocation'
      AND instr(lower(sql), 'pro room generation allocation is missing') > 0
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name IN (
        'mxqr_pro_room_registry_no_delete',
        'mxqr_pro_room_registry_room_code_immutable',
        'mxqr_pro_room_registry_initial_generation_guard',
        'mxqr_pro_room_registry_allocate_initial_generation'
      )
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND (
        (
          name = 'mxqr_pro_room_registry_status_insert_guard'
          AND instr(lower(sql), 'invalid pro room registry status') > 0
        )
        OR (
          name = 'mxqr_pro_room_registry_status_transition_guard'
          AND instr(lower(sql), 'old.status = ''decommissioning''') > 0
          AND instr(lower(sql), 'old.status = ''decommissioned''') > 0
          AND instr(lower(sql), 'new.room_generation = old.room_generation') > 0
          AND instr(lower(sql), 'mxqr_pro_room_generation_allocations') > 0
          AND instr(lower(sql), 'mxqr_pro_room_generation_history') > 0
          AND instr(lower(sql), 'terminal evidence transition') > 0
        )
      )
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_registry_allocate_next_generation'
      AND instr(lower(sql), 'mxqr_pro_room_generation_cutover') > 0
      AND instr(lower(sql), 'ever_enabled') > 0
      AND instr(lower(sql), 'mxqr_pro_room_generation_history') > 0
      AND instr(lower(sql), 'floor_release_sha not glob') > 0
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'index'
      AND name = 'idx_mxqr_pro_room_admin_audit_incarnation_created'
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table' AND name = 'mxqr_pro_room_generation_cutover'
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'trigger'
      AND name IN (
        'mxqr_pro_room_generation_cutover_floor_immutable',
        'mxqr_pro_room_generation_cutover_no_delete'
      )
  ) AS features_present,
  20 AS features_expected;
