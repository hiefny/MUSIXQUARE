SELECT
  (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table' AND name = 'mxqr_account_pro_room_generations'
  ) AS generation_table,
  (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'table' AND name = 'mxqr_account_pro_room_generations'
  )
  + (
    SELECT COUNT(*) FROM sqlite_schema
    WHERE type = 'index'
      AND name = 'idx_mxqr_account_pro_room_generations_account'
  ) AS features_present,
  2 AS features_expected;
