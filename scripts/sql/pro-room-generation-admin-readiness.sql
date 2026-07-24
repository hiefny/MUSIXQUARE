SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('mxqr_pro_room_registry')
    WHERE name = 'room_generation'
      AND lower(type) = 'integer'
      AND "notnull" = 1
      AND dflt_value = '0'
  )
  AND EXISTS (
    SELECT 1 FROM pragma_table_info('mxqr_pro_room_admin_audit')
    WHERE name = 'room_generation'
      AND lower(type) = 'integer'
      AND "notnull" = 1
      AND dflt_value = '0'
  )
  AND (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_pro_room_generation_history')
    WHERE (name = 'room_code' AND pk = 1 AND "notnull" = 1)
       OR (
         name = 'room_generation'
         AND pk = 2
         AND "notnull" = 1
         AND lower(type) = 'integer'
       )
  ) = 2
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table'
      AND name = 'mxqr_pro_room_generation_history'
      AND instr(lower(sql), 'room_generation >= 0') > 0
  )
  AND (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_pro_room_generation_allocations')
    WHERE (name = 'room_code' AND pk = 1 AND "notnull" = 1)
       OR (
         name = 'room_generation'
         AND pk = 2
         AND "notnull" = 1
         AND lower(type) = 'integer'
       )
       OR (name = 'allocated_at' AND "notnull" = 1 AND lower(type) = 'integer')
  ) = 3
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_generation_history_no_update'
      AND instr(lower(sql), 'pro room generation history is immutable') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_generation_allocations_no_update'
      AND instr(lower(sql), 'pro room generation allocation is immutable') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_generation_allocations_no_delete'
      AND instr(lower(sql), 'pro room generation allocation is immutable') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_generation_history_requires_allocation'
      AND instr(lower(sql), 'pro room generation allocation is missing') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_registry_no_delete'
      AND instr(lower(sql), 'pro room registry pointers are immutable') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_registry_room_code_immutable'
      AND instr(lower(sql), 'pro room registry code is immutable') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_registry_status_insert_guard'
      AND instr(lower(sql), 'invalid pro room registry status') > 0
      AND instr(lower(sql), '''decommissioning''') > 0
      AND instr(lower(sql), '''decommissioned''') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_registry_status_transition_guard'
      AND instr(lower(sql), 'old.status = ''decommissioning''') > 0
      AND instr(lower(sql), 'old.status = ''decommissioned''') > 0
      AND instr(lower(sql), 'new.room_generation = old.room_generation') > 0
      AND instr(lower(sql), 'mxqr_pro_room_generation_allocations') > 0
      AND instr(lower(sql), 'mxqr_pro_room_generation_history') > 0
      AND instr(lower(sql), 'terminal evidence transition') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_registry_initial_generation_guard'
      AND instr(lower(sql), 'pro room registry repair required') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_registry_allocate_initial_generation'
      AND instr(lower(sql), 'mxqr_pro_room_generation_allocations') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_registry_allocate_next_generation'
      AND instr(lower(sql), 'mxqr_pro_room_generation_allocations') > 0
      AND instr(lower(sql), 'mxqr_pro_room_generation_history') > 0
      AND instr(lower(sql), 'mxqr_pro_room_generation_cutover') > 0
      AND instr(lower(sql), 'ever_enabled') > 0
      AND instr(lower(sql), 'release_sha not glob') > 0
      AND instr(lower(sql), 'floor_release_sha not glob') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_generation_history_no_delete'
      AND instr(lower(sql), 'pro room generation history is immutable') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'index'
      AND name = 'idx_mxqr_pro_room_admin_audit_incarnation_created'
  )
  AND EXISTS (
    SELECT 1 FROM pragma_table_info('mxqr_pro_room_generation_cutover')
    WHERE name = 'contract_version' AND pk = 1
  )
  AND EXISTS (
    SELECT 1 FROM pragma_table_info('mxqr_pro_room_generation_cutover')
    WHERE name = 'status' AND "notnull" = 1
  )
  AND EXISTS (
    SELECT 1 FROM pragma_table_info('mxqr_pro_room_generation_cutover')
    WHERE name = 'release_sha'
  )
  AND EXISTS (
    SELECT 1 FROM pragma_table_info('mxqr_pro_room_generation_cutover')
    WHERE name = 'ever_enabled'
      AND lower(type) = 'integer'
      AND "notnull" = 1
      AND dflt_value = '0'
  )
  AND EXISTS (
    SELECT 1 FROM pragma_table_info('mxqr_pro_room_generation_cutover')
    WHERE name = 'floor_release_sha'
  )
  AND EXISTS (
    SELECT 1 FROM pragma_table_info('mxqr_pro_room_generation_cutover')
    WHERE name = 'updated_at' AND "notnull" = 1
  )
  AND (
    SELECT COUNT(*) FROM mxqr_pro_room_generation_cutover
    WHERE contract_version = 1
      AND (
        (
          status = 'disabled'
          AND release_sha IS NULL
          AND (
            (ever_enabled = 0 AND floor_release_sha IS NULL)
            OR (
              ever_enabled = 1
              AND length(floor_release_sha) = 40
              AND floor_release_sha NOT GLOB '*[^0-9a-f]*'
            )
          )
        )
        OR (
          status = 'ready'
          AND ever_enabled = 1
          AND length(release_sha) = 40
          AND release_sha NOT GLOB '*[^0-9a-f]*'
          AND length(floor_release_sha) = 40
          AND floor_release_sha NOT GLOB '*[^0-9a-f]*'
        )
      )
  ) = 1
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_generation_cutover_floor_immutable'
      AND instr(lower(sql), 'old.ever_enabled = 1') > 0
      AND instr(lower(sql), 'old.ever_enabled = 0') > 0
      AND instr(lower(sql), 'new.ever_enabled = 1') > 0
      AND instr(lower(sql), 'new.status <> ''ready''') > 0
      AND instr(lower(sql), 'new.floor_release_sha is not new.release_sha') > 0
      AND instr(lower(sql), 'rollback floor is immutable') > 0
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'trigger'
      AND name = 'mxqr_pro_room_generation_cutover_no_delete'
      AND instr(lower(sql), 'generation cutover is permanent') > 0
  )
  AND NOT EXISTS (
    SELECT 1
    FROM mxqr_pro_room_registry
    WHERE status NOT IN (
      'registered',
      'provisioning',
      'suspended',
      'decommissioning',
      'decommissioned'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM mxqr_pro_room_registry AS registry
    LEFT JOIN mxqr_pro_room_generation_allocations AS allocation
      ON allocation.room_code = registry.room_code
     AND allocation.room_generation = registry.room_generation
    WHERE allocation.room_code IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM mxqr_pro_room_generation_history AS history
    LEFT JOIN mxqr_pro_room_generation_allocations AS allocation
      ON allocation.room_code = history.room_code
     AND allocation.room_generation = history.room_generation
    WHERE allocation.room_code IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM mxqr_pro_room_registry AS registry
    LEFT JOIN mxqr_pro_room_generation_history AS history
      ON history.room_code = registry.room_code
     AND history.room_generation = registry.room_generation
     AND history.status = 'decommissioned'
    WHERE registry.status = 'decommissioned'
      AND history.room_code IS NULL
  )
  THEN 1 ELSE 0
END AS schema_ready;
