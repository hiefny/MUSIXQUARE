SELECT
  CASE
    WHEN EXISTS (
      SELECT 1
        FROM sqlite_schema
       WHERE type = 'table' AND name = 'mxqr_account_stats'
    )
    THEN 1 ELSE 0
  END AS table_present,
  CASE
    WHEN (SELECT COUNT(*) FROM pragma_table_info('mxqr_account_stats')) = 4
     AND (
      SELECT COUNT(*)
        FROM pragma_table_info('mxqr_account_stats')
       WHERE (
         name = 'account_id'
         AND pk = 1
         AND "notnull" = 1
         AND lower(type) = 'text'
       )
          OR (
            name IN ('session_count', 'listening_seconds', 'track_count')
            AND pk = 0
            AND "notnull" = 1
            AND lower(type) = 'integer'
            AND dflt_value = '0'
          )
     ) = 4
     AND EXISTS (
       SELECT 1
         FROM sqlite_schema
        WHERE type = 'table'
          AND name = 'mxqr_account_stats'
          AND lower(sql) LIKE '%check (session_count between 0 and 9007199254740991)%'
          AND lower(sql) LIKE '%check (listening_seconds between 0 and 9007199254740991)%'
          AND lower(sql) LIKE '%check (track_count between 0 and 9007199254740991)%'
     )
    THEN 1 ELSE 0
  END AS columns_ready,
  CASE
    WHEN EXISTS (
      SELECT 1
        FROM pragma_foreign_key_list('mxqr_account_stats')
       WHERE "table" = 'mxqr_accounts'
         AND "from" = 'account_id'
         AND "to" = 'account_id'
         AND upper(on_delete) = 'CASCADE'
    )
    THEN 1 ELSE 0
  END AS foreign_key_ready,
  CASE
    WHEN EXISTS (
      SELECT 1
        FROM sqlite_schema
       WHERE type = 'table' AND name = 'mxqr_account_stats'
    )
     AND (SELECT COUNT(*) FROM pragma_table_info('mxqr_account_stats')) = 4
     AND (
       SELECT COUNT(*)
         FROM pragma_table_info('mxqr_account_stats')
        WHERE (
          name = 'account_id'
          AND pk = 1
          AND "notnull" = 1
          AND lower(type) = 'text'
        )
           OR (
             name IN ('session_count', 'listening_seconds', 'track_count')
             AND pk = 0
             AND "notnull" = 1
             AND lower(type) = 'integer'
             AND dflt_value = '0'
           )
     ) = 4
     AND EXISTS (
       SELECT 1
         FROM sqlite_schema
        WHERE type = 'table'
          AND name = 'mxqr_account_stats'
          AND lower(sql) LIKE '%check (session_count between 0 and 9007199254740991)%'
          AND lower(sql) LIKE '%check (listening_seconds between 0 and 9007199254740991)%'
          AND lower(sql) LIKE '%check (track_count between 0 and 9007199254740991)%'
     )
     AND EXISTS (
       SELECT 1
         FROM pragma_foreign_key_list('mxqr_account_stats')
        WHERE "table" = 'mxqr_accounts'
          AND "from" = 'account_id'
          AND "to" = 'account_id'
          AND upper(on_delete) = 'CASCADE'
     )
    THEN 1 ELSE 0
  END AS schema_ready;
