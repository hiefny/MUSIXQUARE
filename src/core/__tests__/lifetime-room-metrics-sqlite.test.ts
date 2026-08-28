import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const ADMIN_SCHEMA = readFileSync(
  new URL('../../../cloudflare/admin-metrics.schema.sql', import.meta.url),
  'utf8',
);
const LIFETIME_ROOM_COUNT_MIGRATION = readFileSync(
  new URL('../../../cloudflare/admin-metrics.lifetime-room-count.migration.sql', import.meta.url),
  'utf8',
);
const LIFETIME_ANALYTICS_MIGRATION = readFileSync(
  new URL('../../../cloudflare/admin-metrics.lifetime-analytics.migration.sql', import.meta.url),
  'utf8',
);

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return null;
  }
})();

function openDatabase(): DatabaseSync {
  if (!sqlite) throw new Error('node:sqlite is unavailable');
  return new sqlite.DatabaseSync(':memory:');
}

function lifetimeTotal(db: DatabaseSync, event = 'room_opened'): number {
  const row = db
    .prepare('SELECT count FROM mxqr_lifetime_metric_totals WHERE event = ?')
    .get(event) as { count: number } | undefined;
  return Number(row?.count ?? -1);
}

function incrementBucket(db: DatabaseSync, minute: number, event: string, count = 1): void {
  db.prepare(
    `INSERT INTO mxqr_metric_buckets (bucket_minute, event, count)
     VALUES (?, ?, ?)
     ON CONFLICT(bucket_minute, event)
     DO UPDATE SET count = mxqr_metric_buckets.count + excluded.count`,
  ).run(minute, event, count);
}

(sqlite ? describe : describe.skip)('lifetime standard-room metric against SQLite/D1', () => {
  it('seeds retained rooms, counts only fresh standard-room events, and survives cleanup', () => {
    const db = openDatabase();
    try {
      db.exec(`
        CREATE TABLE mxqr_metric_buckets (
          bucket_minute INTEGER NOT NULL,
          event TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
          PRIMARY KEY (bucket_minute, event)
        );
      `);
      incrementBucket(db, 100, 'room_opened', 1_600);
      incrementBucket(db, 100, 'guest_joined', 1_900);
      incrementBucket(db, 100, 'host_reconnected', 50);
      incrementBucket(db, 100, 'pro_member_joined', 25);

      db.exec(LIFETIME_ROOM_COUNT_MIGRATION);
      expect(lifetimeTotal(db)).toBe(1_600);

      incrementBucket(db, 100, 'room_opened');
      incrementBucket(db, 101, 'room_opened', 2);
      incrementBucket(db, 101, 'host_reconnected', 20);
      incrementBucket(db, 101, 'pro_member_joined', 20);
      expect(lifetimeTotal(db)).toBe(1_603);

      db.exec('DELETE FROM mxqr_metric_buckets WHERE bucket_minute <= 100');
      expect(lifetimeTotal(db)).toBe(1_603);

      // Reapplying an idempotent baseline/migration after retention cleanup
      // must never replace the permanent total with the smaller retained sum.
      db.exec(LIFETIME_ROOM_COUNT_MIGRATION);
      expect(lifetimeTotal(db)).toBe(1_603);
    } finally {
      db.close();
    }
  });

  it('initializes a fresh canonical database at zero and tracks later rooms', () => {
    const db = openDatabase();
    try {
      db.exec(ADMIN_SCHEMA);
      expect(lifetimeTotal(db)).toBe(0);
      expect(lifetimeTotal(db, 'guest_joined')).toBe(0);
      incrementBucket(db, 200, 'room_opened');
      incrementBucket(db, 200, 'guest_joined');
      expect(lifetimeTotal(db)).toBe(1);
      expect(lifetimeTotal(db, 'guest_joined')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('backfills complete retained daily room and guest history and remains monotonic', () => {
    const db = openDatabase();
    try {
      db.exec(`
        CREATE TABLE mxqr_metric_buckets (
          bucket_minute INTEGER NOT NULL,
          event TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
          PRIMARY KEY (bucket_minute, event)
        );
      `);
      incrementBucket(db, 100 * 1440 + 5, 'room_opened', 3);
      incrementBucket(db, 100 * 1440 + 6, 'guest_joined', 8);
      incrementBucket(db, 101 * 1440 + 5, 'room_opened', 2);
      incrementBucket(db, 101 * 1440 + 6, 'guest_joined', 5);
      incrementBucket(db, 101 * 1440 + 7, 'host_reconnected', 99);

      db.exec(LIFETIME_ROOM_COUNT_MIGRATION);
      db.exec(LIFETIME_ANALYTICS_MIGRATION);
      expect(lifetimeTotal(db)).toBe(5);
      expect(lifetimeTotal(db, 'guest_joined')).toBe(13);
      expect(
        db
          .prepare(
            `SELECT day_epoch, event, count
               FROM mxqr_lifetime_metric_days
              ORDER BY day_epoch, event`,
          )
          .all(),
      ).toEqual([
        { day_epoch: 100, event: 'guest_joined', count: 8 },
        { day_epoch: 100, event: 'room_opened', count: 3 },
        { day_epoch: 101, event: 'guest_joined', count: 5 },
        { day_epoch: 101, event: 'room_opened', count: 2 },
      ]);

      incrementBucket(db, 101 * 1440 + 6, 'guest_joined', 2);
      incrementBucket(db, 102 * 1440, 'room_opened', 4);
      expect(lifetimeTotal(db)).toBe(9);
      expect(lifetimeTotal(db, 'guest_joined')).toBe(15);
      expect(
        db
          .prepare(
            `SELECT count FROM mxqr_lifetime_metric_days
              WHERE day_epoch = 101 AND event = 'guest_joined'`,
          )
          .get(),
      ).toEqual({ count: 7 });

      db.exec('DELETE FROM mxqr_metric_buckets');
      db.exec(LIFETIME_ANALYTICS_MIGRATION);
      expect(lifetimeTotal(db)).toBe(9);
      expect(lifetimeTotal(db, 'guest_joined')).toBe(15);
      expect(
        db.prepare('SELECT COALESCE(SUM(count), 0) AS count FROM mxqr_lifetime_metric_days').get(),
      ).toEqual({ count: 24 });
    } finally {
      db.close();
    }
  });
});
