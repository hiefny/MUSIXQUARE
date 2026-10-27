import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRO_ROOM_BOT_REQUEST_LEASE_MS,
  PRO_ROOM_PLAYBACK_COMMAND_ATTEMPTS,
  PRO_ROOM_PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS,
  PRO_ROOM_REQUEST_RECEIPT_TTL_MS,
  proRoomCompletionReceiptTtlMs,
  proRoomPlaybackReceiptTtlMs,
} from '../../../cloudflare/pro-room-receipt-timing.ts';
import { MusixquareProRoom } from '../../../cloudflare/pro-room-worker.ts';
import { DEFAULT_CONTROL_REQUEST_TIMEOUT_MS } from '../../core/request-lifetime.ts';

/**
 * RO-53: a browser receipt only has to outlive every request that can carry
 * the same key again. These are the windows in active page time; on a frozen
 * page a timer-driven resend can arrive later, and the fences (compare-and-set
 * revisions, the playback revision, asset state and presence) keep such a late
 * resend from applying anything twice.
 */
function wranglerSeconds(name: string): number {
  const toml = readFileSync(resolve('cloudflare/wrangler.pro-room.toml'), 'utf8');
  const value = toml.match(new RegExp(`^${name} = "(\\d+)"$`, 'mu'))?.[1];
  if (value === undefined) throw new Error(`${name} is missing from wrangler.pro-room.toml`);
  return Number(value);
}

// The configured seconds the Worker accepts (presenceTtlMs, assetGcGraceMs and
// reservationTtlSeconds in cloudflare/pro-room-worker.ts write them inline). A
// value outside its range falls back to the default. The parity test below
// pins these copies against the Worker itself.
const PRESENCE_TTL_SECONDS_RANGE = [15, 300] as const;
const ASSET_GC_GRACE_SECONDS_RANGE = [60, 24 * 60 * 60] as const;
const RESERVATION_TTL_SECONDS_RANGE = [60, 60 * 60] as const;

type ConfiguredSecondsReader = (env: Record<string, unknown>) => number;

/** How the Worker reads one configured value, in seconds, for a given environment. */
const WORKER_CONFIGURED_SECONDS = {
  PRESENCE_TTL_SECONDS: (env) =>
    MusixquareProRoom.prototype.presenceTtlMs.call({ env } as unknown as MusixquareProRoom) / 1000,
  ASSET_GC_GRACE_SECONDS: (env) =>
    MusixquareProRoom.prototype.assetGcGraceMs.call({ env } as unknown as MusixquareProRoom) / 1000,
  RESERVATION_TTL_SECONDS: (env) =>
    MusixquareProRoom.prototype.reservationTtlSeconds.call({ env } as unknown as MusixquareProRoom),
} satisfies Record<string, ConfiguredSecondsReader>;

/** The Worker's default for a configured value: what it reads when nothing is set. */
function workerDefaultSeconds(name: keyof typeof WORKER_CONFIGURED_SECONDS): number {
  return WORKER_CONFIGURED_SECONDS[name]({});
}

describe('PRO room browser receipt windows (RO-53)', () => {
  it('keeps the request window the owner chose', () => {
    expect(PRO_ROOM_REQUEST_RECEIPT_TTL_MS).toBe(2 * 60 * 1000);
  });

  it('uses the configured-value ranges the Worker itself accepts', () => {
    for (const [name, [min, max]] of [
      ['PRESENCE_TTL_SECONDS', PRESENCE_TTL_SECONDS_RANGE],
      ['ASSET_GC_GRACE_SECONDS', ASSET_GC_GRACE_SECONDS_RANGE],
      ['RESERVATION_TTL_SECONDS', RESERVATION_TTL_SECONDS_RANGE],
    ] as const) {
      const read = (value: number) => WORKER_CONFIGURED_SECONDS[name]({ [name]: String(value) });
      const fallback = workerDefaultSeconds(name);
      expect(fallback, `${name} default`).toBeGreaterThanOrEqual(min);
      expect(fallback, `${name} default`).toBeLessThanOrEqual(max);
      expect(read(min), `${name} lowest accepted`).toBe(min);
      expect(read(max), `${name} highest accepted`).toBe(max);
      // The default lies inside the range, so these probes differ from it.
      expect(read(min - 1), `${name} below the range`).toBe(fallback);
      expect(read(max + 1), `${name} above the range`).toBe(fallback);
    }
  });

  it('covers twice the longest same-key window of every single-request sender', () => {
    const longestSameKeyWindowMs = Math.max(
      // Every browser control request: one send, a 15 s deadline, no retry.
      DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
      // Playback: one key across its bounded attempts in active page time.
      PRO_ROOM_PLAYBACK_COMMAND_ATTEMPTS * PRO_ROOM_PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS,
      // BOT: execute must reach the room inside the context lease.
      PRO_ROOM_BOT_REQUEST_LEASE_MS,
    );
    expect(longestSameKeyWindowMs).toBe(PRO_ROOM_BOT_REQUEST_LEASE_MS);
    expect(PRO_ROOM_REQUEST_RECEIPT_TTL_MS).toBeGreaterThanOrEqual(2 * longestSameKeyWindowMs);
  });

  it('keeps playback receipts for twice the presence window a frozen page can resend in', () => {
    // A frozen page resends its second attempt when its timer runs again. The
    // Worker refuses it once the device's presence lapsed, so the latest a
    // stored command can be resent is one presence window plus one attempt.
    const presenceSeconds = [
      ...PRESENCE_TTL_SECONDS_RANGE,
      wranglerSeconds('PRESENCE_TTL_SECONDS'),
      workerDefaultSeconds('PRESENCE_TTL_SECONDS'),
    ];
    for (const seconds of presenceSeconds) {
      const presenceTtlMs = seconds * 1000;
      const ttlMs = proRoomPlaybackReceiptTtlMs(presenceTtlMs);
      expect(ttlMs, `${seconds} s presence`).toBeGreaterThanOrEqual(
        2 * (presenceTtlMs + PRO_ROOM_PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS),
      );
      expect(ttlMs, `${seconds} s presence`).toBeGreaterThanOrEqual(
        PRO_ROOM_REQUEST_RECEIPT_TTL_MS,
      );
    }
    // Production presence (45 s) fits inside the shared request window.
    expect(proRoomPlaybackReceiptTtlMs(wranglerSeconds('PRESENCE_TTL_SECONDS') * 1000)).toBe(
      PRO_ROOM_REQUEST_RECEIPT_TTL_MS,
    );
    expect(proRoomPlaybackReceiptTtlMs(300_000)).toBe(2 * (300_000 + 6_000));
  });

  it('keeps a completion receipt at least as long as the unnamed asset it describes', () => {
    // An unnamed asset is collected one GC grace after completion; a same-key
    // retry before then must replay rather than turn into ASSET_NOT_FOUND.
    const graceSeconds = [
      ...ASSET_GC_GRACE_SECONDS_RANGE,
      wranglerSeconds('ASSET_GC_GRACE_SECONDS'),
      workerDefaultSeconds('ASSET_GC_GRACE_SECONDS'),
    ];
    for (const seconds of graceSeconds) {
      const ttlMs = proRoomCompletionReceiptTtlMs(seconds * 1000);
      expect(ttlMs, `${seconds} s grace`).toBeGreaterThanOrEqual(seconds * 1000);
      expect(ttlMs, `${seconds} s grace`).toBeGreaterThanOrEqual(PRO_ROOM_REQUEST_RECEIPT_TTL_MS);
    }
    expect(proRoomCompletionReceiptTtlMs(wranglerSeconds('ASSET_GC_GRACE_SECONDS') * 1000)).toBe(
      15 * 60 * 1000,
    );
  });

  it('keeps a reservation receipt inside the request window', () => {
    // Reserve takes min(reservation expiry, now + window). In production the
    // reservation outlasts the window, so the window decides.
    expect(wranglerSeconds('RESERVATION_TTL_SECONDS') * 1000).toBeGreaterThan(
      PRO_ROOM_REQUEST_RECEIPT_TTL_MS,
    );
    // Even the shortest reservation the Worker accepts outlasts twice the
    // reserve request's one-send deadline, the only time its key is sent.
    expect(RESERVATION_TTL_SECONDS_RANGE[0] * 1000).toBeGreaterThanOrEqual(
      2 * DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
    );
  });
});
