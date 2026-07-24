SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'mxqr_account_pro_room_generations'
  )
  AND (
    SELECT COUNT(*) FROM pragma_table_info('mxqr_account_pro_room_generations')
    WHERE (name = 'account_id' AND pk = 1)
       OR (name = 'room_code' AND pk = 2)
       OR (
         name = 'room_generation'
         AND pk = 3
         AND "notnull" = 1
         AND lower(type) = 'integer'
         AND dflt_value = '0'
       )
  ) = 3
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'index'
      AND name = 'idx_mxqr_account_pro_room_generations_account'
  )
  THEN 1 ELSE 0
END AS schema_ready;
