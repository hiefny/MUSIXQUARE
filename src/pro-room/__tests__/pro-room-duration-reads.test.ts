import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRO_ROOM_FILE_DURATION_READER } from '../../../cloudflare/pro-room-media-duration.ts';
import {
  activatedProRoom,
  fileItem,
  flacBytes,
  installBoundaryClock,
  MetadataService,
  type ProRoomBoundary,
  unknownBytes,
  youtubeItem,
} from './__helpers__/pro-room-owner-boundary.ts';

/**
 * C7-0 characterization of the PRO room's two file-duration readers (resource
 * RO-08 in docs/design/resource-ownership-registry.md): the registration probe
 * that measures each completed upload, and the playback probe that measures
 * the desired track. Both call the real `readProRoomFileDuration` over a fake
 * R2 bucket (see the fixture header); nothing inside the PRO room is mocked.
 * The tests pin, on unchanged main, the mutual exclusion of the two readers,
 * the retry ladder they share with the YouTube lookup, and the continuation
 * guards that keep a refused completion from starting a new read, so the
 * Phase 1 duration owner (plan steps C7-2, C7-6) can prove it is neutral.
 * Registry exception RO-32 keeps both readers.
 *
 * Observation points: R2 range reads (one prefix read per duration read),
 * metadata-service calls, the durable `pro-room:v2:core` record and the alarm.
 * The continuation guards are pinned here for a completion refused by service
 * maintenance; removing either guard fails exactly one of those two tests
 * (checked by mutation on c08b6c39). Completions refused for state capacity or
 * a changed generation take the same guarded exits, but reaching them needs a
 * nearly full core record or a re-provisioned incarnation, so they stay pinned
 * at the internal level in pro-room-worker.test.ts ("keeps optional duration
 * migration and registration queues from exhausting room state capacity",
 * "fences a late registration probe after generation changes").
 */

const NOW = Date.UTC(2026, 9, 22, 5, 0, 0);
const FIRST = '11111111-1111-4111-8111-111111111111';
const fixtures: ProRoomBoundary[] = [];

async function room(options: Parameters<typeof activatedProRoom>[0] = {}) {
  const fixture = await activatedProRoom(options);
  fixtures.push(fixture);
  return fixture;
}

/** Read starts as asset labels, in order. */
function readers(test: ProRoomBoundary, labels: Record<string, string>): string[] {
  return test.bucket.probeStarts().map((read) => labels[read.key] ?? read.key);
}

async function play(test: ProRoomBoundary, source: unknown) {
  await test.replacePlaylist([fileItem(FIRST, source)]);
  await test.ready(await test.select(FIRST));
}

beforeEach(() => {
  installBoundaryClock(NOW);
  // The playback probe warns once per unanswered track; keep the run quiet.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    expect(fixture.bucket.parkedReads).toBe(0);
    fixture.dispose();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('PRO file duration readers: one R2 read at a time', () => {
  it('measures a completed upload once through the registration reader', async () => {
    const test = await room();
    const alpha = await test.uploadFile('alpha', flacBytes(130.5));
    await test.settle();
    expect(readers(test, { [alpha.objectKey]: 'alpha' })).toEqual(['alpha']);
    expect(test.storedCore().assets[alpha.assetId].duration).toMatchObject({
      durationSeconds: 130.5,
      source: 'server',
      reader: PRO_ROOM_FILE_DURATION_READER,
    });
    expect(test.storedCore().pendingAssetDurationProbes).toEqual([]);
  });

  it('keeps registration from starting a second read while a playback file read is in flight', async () => {
    const test = await room();
    // Registration answers "unknown" for these bytes, so the playing file has
    // no evidence and the playback probe reads it again.
    const beta = await test.uploadFile('beta', unknownBytes());
    await test.settle();
    const hold = test.bucket.hold(beta.objectKey);
    await play(test, beta.source);
    await hold.parked;

    const gamma = await test.uploadFile('gamma', flacBytes(42));
    await test.settle();
    const labels = { [beta.objectKey]: 'beta', [gamma.objectKey]: 'gamma' };
    expect(test.storedCore().pendingAssetDurationProbes).toEqual([gamma.assetId]);
    expect(readers(test, labels)).toEqual(['beta', 'beta']);
    // Both readers are busy or blocked: the alarm waits for the 10 s watchdog.
    expect(test.storage.alarm).toBe(NOW + 10_000);

    hold.release();
    await test.settle();
    // The playback completion's own persist still sees its read in flight;
    // its settle hook then starts the queued registration read: still one
    // read at a time.
    expect(readers(test, labels)).toEqual(['beta', 'beta', 'gamma']);
    expect(test.storedCore().assets[gamma.assetId].duration).toMatchObject({
      durationSeconds: 42,
      source: 'server',
    });
    // A file with no trustworthy length is read again after 5 minutes.
    expect(test.storedCore().playbackDurationProbe).toMatchObject({
      attempts: 1,
      retryAtMs: NOW + 300_000,
    });
  });

  it('reads a queued asset that is also the desired track once and serves playback from it', async () => {
    const test = await room();
    let hold!: ReturnType<ProRoomBoundary['bucket']['hold']>;
    const alpha = await test.uploadFile('alpha', flacBytes(10), {
      beforeComplete: (objectKey) => {
        hold = test.bucket.hold(objectKey);
      },
    });
    await hold.parked;
    const beta = await test.uploadFile('beta', flacBytes(20));
    await test.settle();
    expect(test.storedCore().pendingAssetDurationProbes).toEqual([alpha.assetId, beta.assetId]);

    // The playing file is queued for registration but not being read; the
    // playback probe exists and waits. When alpha settles, both probes see
    // beta queued with no read in flight (the queued-but-idle case of plan
    // step C7-6). Today the registration reader takes it. Which reader reads
    // is not visible at this boundary: a busy-only predicate that lets the
    // playback probe read first produces the same reads, state and alarm.
    await play(test, beta.source);
    expect(test.storedCore().playbackDurationProbe).toMatchObject({
      identity: { mediaKind: 'file', assetId: beta.assetId },
      attempts: 0,
    });
    const labels = { [alpha.objectKey]: 'alpha', [beta.objectKey]: 'beta' };
    expect(readers(test, labels)).toEqual(['alpha']);

    hold.release();
    await test.settle();
    // One registration read of beta serves playback through reconcile.
    expect(readers(test, labels)).toEqual(['alpha', 'beta']);
    expect(test.storedCore().playbackDurationProbe).toBeNull();
    expect(Object.values(test.storedCore().playbackDurations)).toEqual([
      expect.objectContaining({ durationSeconds: 20, source: 'server' }),
    ]);
    await test.alarmAt(NOW + 60_000);
    expect(readers(test, labels)).toEqual(['alpha', 'beta']);
  });
});

describe('PRO duration readers: the shared retry ladder', () => {
  /** Offsets between consecutive read starts (R2) or lookups (YouTube). */
  const gaps = (times: number[]) => times.slice(1).map((time, index) => time - times[index]!);

  async function registrationMemoLadder() {
    // 8.10.0 stored a controller decode without a reader version. The playing
    // file's measurement is then queued through the registration reader and
    // a failed read is deferred by deferAssetDurationRead.
    const test = await room();
    const alpha = await test.uploadFile('alpha', flacBytes(100));
    await test.settle();
    await play(test, alpha.source);
    const stored = test.storage.data.get('pro-room:v2:core') as { core: Record<string, any> };
    const legacy = { durationSeconds: 3_600, source: 'controller' };
    Object.assign(stored.core.assets[alpha.assetId].duration, legacy);
    delete stored.core.assets[alpha.assetId].duration.reader;
    for (const evidence of Object.values(stored.core.playbackDurations) as Array<
      Record<string, unknown>
    >) {
      Object.assign(evidence, legacy);
      delete evidence.reader;
    }
    test.restart();
    test.bucket.fail(alpha.objectKey);
    const before = test.bucket.probeStarts().length;
    // The first heartbeat after the isolate restart reconciles and queues it.
    await test.advanceTo(NOW + 100);
    await test.heartbeat();
    await test.runUntil(NOW + 100 + 700_000);
    return gaps(
      test.bucket
        .probeStarts()
        .slice(before)
        .map((read) => read.at),
    );
  }

  async function playbackFileLadder() {
    const test = await room();
    const beta = await test.uploadFile('beta', unknownBytes());
    await test.settle();
    test.bucket.fail(beta.objectKey);
    const before = test.bucket.probeStarts().length;
    await play(test, beta.source);
    const retries: number[] = [];
    for (let retry = 0; retry < 4; retry += 1) {
      const probe = test.storedCore().playbackDurationProbe;
      retries.push(probe.retryAtMs - Date.now());
      await test.runUntil(probe.retryAtMs);
    }
    const reads = gaps(
      test.bucket
        .probeStarts()
        .slice(before)
        .map((read) => read.at),
    );
    expect(reads).toEqual(retries.slice(0, 4));
    return retries;
  }

  async function youtubeLookupLadder() {
    const metadata = new MetadataService();
    const test = await room({ metadata });
    await test.replacePlaylist([youtubeItem(FIRST, 'dQw4w9WgXcQ')]);
    await test.ready(await test.select(FIRST));
    for (let retry = 0; retry < 5; retry += 1) {
      await test.runUntil(test.storedCore().playbackDurationProbe.retryAtMs);
    }
    return gaps(metadata.calls.map((call) => call.at));
  }

  it('backs off 5 s then 30 s in all three readers; files then wait 5 min, YouTube doubles to 15 min', async () => {
    // Today the 5 s / 30 s / 5 min file ladder is written twice
    // (deferAssetDurationRead and an inline 300_000 literal in the playback
    // probe that duplicates PLAYBACK_DURATION_FILE_RETRY_MS); plan step C7-2
    // names it FILE_DURATION_READ_RETRY_MS. The YouTube lookup shares only the
    // first two rungs (provider quota policy stays separate).
    expect({
      registrationMemo: await registrationMemoLadder(),
      playbackFileRead: await playbackFileLadder(),
      youtubeLookup: await youtubeLookupLadder(),
    }).toEqual({
      registrationMemo: [5_000, 30_000, 300_000, 300_000],
      playbackFileRead: [5_000, 30_000, 300_000, 300_000],
      youtubeLookup: [5_000, 30_000, 240_000, 480_000, 900_000],
    });
  });
});

describe('PRO duration readers: refused completions do not restart a read', () => {
  // Devices cannot heartbeat through maintenance (every room route answers
  // 503), so these rooms keep presence for 300 s instead.
  it('leaves a registration read refused by maintenance queued until the post-maintenance alarm', async () => {
    const test = await room({ serviceControl: true, presenceTtlSeconds: 300 });
    let hold!: ReturnType<ProRoomBoundary['bucket']['hold']>;
    const alpha = await test.uploadFile('alpha', flacBytes(50), {
      beforeComplete: (objectKey) => {
        hold = test.bucket.hold(objectKey);
      },
    });
    await hold.parked;
    await test.setMaintenance(true);
    hold.release();
    await test.settle();
    // The completion returns without touching durable state and, because it
    // did not finish, restarts nothing (the `if (finished)` guard).
    expect(test.bucket.probeStarts(alpha.objectKey)).toHaveLength(1);
    expect(test.storedCore().pendingAssetDurationProbes).toEqual([alpha.assetId]);
    expect(test.storedCore().assets[alpha.assetId].duration).toBeUndefined();

    await test.alarmAt(NOW + 1_000);
    expect(test.storage.alarm).toBe(NOW + 61_000);
    expect(test.bucket.probeStarts(alpha.objectKey)).toHaveLength(1);

    await test.setMaintenance(false);
    await test.alarmAt(NOW + 61_000);
    expect(test.bucket.probeStarts(alpha.objectKey)).toHaveLength(2);
    expect(test.storedCore().assets[alpha.assetId].duration).toMatchObject({
      durationSeconds: 50,
      source: 'server',
    });
  });

  it('leaves an overdue playback probe refused by maintenance unread until the post-maintenance alarm', async () => {
    const test = await room({ serviceControl: true, presenceTtlSeconds: 300 });
    const beta = await test.uploadFile('beta', unknownBytes());
    await test.settle();
    const hold = test.bucket.hold(beta.objectKey);
    await play(test, beta.source);
    await hold.parked;
    const overdue = test.storedCore().playbackDurationProbe;
    expect(overdue).toMatchObject({ attempts: 0, retryAtMs: NOW });

    await test.setMaintenance(true);
    hold.release();
    await test.settle();
    // The stored probe is still overdue, yet its completion restarts only a
    // probe with a different key: no hot loop while maintenance lasts.
    expect(test.bucket.probeStarts(beta.objectKey)).toHaveLength(2);
    expect(test.storedCore().playbackDurationProbe).toEqual(overdue);
    await test.alarmAt(NOW + 1_000);
    expect(test.bucket.probeStarts(beta.objectKey)).toHaveLength(2);

    await test.setMaintenance(false);
    await test.alarmAt(NOW + 61_000);
    expect(test.bucket.probeStarts(beta.objectKey)).toHaveLength(3);
    expect(test.storedCore().playbackDurationProbe).toMatchObject({
      attempts: 1,
      retryAtMs: NOW + 61_000 + 300_000,
    });
  });
});
