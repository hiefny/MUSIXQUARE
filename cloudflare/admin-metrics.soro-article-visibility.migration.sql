-- Per-article overrides preserve the existing KV visibility snapshot without
-- read/modify/write races. An explicit unhide must remain a hidden=0 row.
CREATE TABLE IF NOT EXISTS mxqr_soro_article_visibility (
  slug TEXT PRIMARY KEY NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 120
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND substr(slug, 1, 1) GLOB '[a-z0-9]'
    AND substr(slug, -1, 1) GLOB '[a-z0-9]'
    AND instr(slug, '--') = 0
  ),
  hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
