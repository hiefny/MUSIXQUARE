import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRO_ROOM_FILE_DURATION_READER } from '../../../cloudflare/pro-room-media-duration.ts';
import { MusixquareProRoom } from '../../../cloudflare/pro-room-worker.ts';

const metadata = vi.hoisted(() => ({ file: vi.fn(), youtube: vi.fn() }));
vi.mock('../../../cloudflare/pro-room-media-duration.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readProRoomFileDuration: metadata.file,
}));
vi.mock('../../../cloudflare/pro-youtube-duration.ts', () => ({
  resolveProYouTubeDuration: metadata.youtube,
}));

type Room = NonNullable<MusixquareProRoom['room']>;
type QueueItem = Room['playlist'][number];
type Command = Parameters<MusixquareProRoom['applyPlaybackAuthorityCommand']>[0];
type CommandInput = Command extends infer Value
  ? Value extends Command
    ? Omit<Value, 'baseRevision'>
    : never
  : never;

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const VIDEO_A = 'dQw4w9WgXcQ';
const VIDEO_B = '9bZkp7q19f0';
const OWNER = 'participant_owner_0001';
const LISTENER = 'participant_listener_01';
const NOW = Date.UTC(2026, 9, 12, 0, 0, 0);

// Exercise the real Durable Object transaction, persisted room state, alarm,
// queue reducer and playback broadcast outbox. Only the independently tested
// external metadata parsers are replaced; no browser sends ENDED in this suite.
class MemoryStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  failNextPut = false;

  async get(key: string | string[]): Promise<unknown> {
    if (Array.isArray(key)) {
      return new Map(key.map((entry) => [entry, structuredClone(this.data.get(entry))]));
    }
    return structuredClone(this.data.get(key));
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('Injected durable write failure');
    }
    if (typeof key === 'string') {
      this.data.set(key, structuredClone(value));
      return;
    }
    for (const [entry, content] of Object.entries(key)) {
      this.data.set(entry, structuredClone(content));
    }
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key))
      return key.reduce((count, entry) => count + +this.data.delete(entry), 0);
    return this.data.delete(key);
  }

  async transaction<T>(operation: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    const before = structuredClone([...this.data]);
    try {
      return await operation(this);
    } catch (error) {
      this.data.clear();
      for (const [key, value] of before) this.data.set(key, value);
      throw error;
    }
  }

  async setAlarm(value: number): Promise<void> {
    this.alarm = value;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

function youtubeItem(queueItemId: string, videoIds?: string[]): QueueItem {
  return {
    queueItemId,
    name: 'YouTube test occurrence',
    source: {
      kind: 'youtube',
      videoId: VIDEO_A,
      ...(videoIds ? { playlistId: 'PLabcdefghijklmnop', videoIds } : {}),
    },
  };
}

function fileItem(queueItemId: string): QueueItem {
  return {
    queueItemId,
    name: 'Local test track',
    source: {
      kind: 'pro-r2',
      assetId: `asset_${queueItemId}`,
      version: 1,
      byteLength: 4096,
      mime: 'audio/wav',
    },
  };
}

const workers = new Set<MusixquareProRoom>();

async function fixture(playlist: QueueItem[] = [fileItem(FIRST), youtubeItem(SECOND)]) {
  const storage = new MemoryStorage();
  const background: Promise<unknown>[] = [];
  const broadcasts: Record<string, any>[] = [];
  const state = {
    storage,
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  };
  const env = {
    PRO_MEDIA_BUCKET: { get: vi.fn(), head: vi.fn() },
    PRO_SIGNALING_SECRET: 'signaling-secret-'.padEnd(48, 's'),
    PRO_SIGNALING_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          broadcasts.push((await request.json()) as Record<string, any>);
          return Response.json({ broadcast: true, eligible: 1, sent: 1 });
        },
      }),
    },
  };
  const createWorker = () => {
    const worker = new MusixquareProRoom(state as never, env as never);
    workers.add(worker);
    return worker;
  };
  const context = {
    worker: createWorker(),
    storage,
    background,
    broadcasts,
    createWorker,
    get room(): Room {
      if (!this.worker.room) throw new Error('Fixture room not initialized');
      return this.worker.room;
    },
    async settle(): Promise<void> {
      for (let round = 0; round < 30; round += 1) {
        await Promise.resolve();
        if (background.length === 0) return;
        await Promise.all(background.splice(0));
      }
      throw new Error('Duration/background work did not settle');
    },
  };
  await context.worker.ensureReady(
    new Request('https://pro-room.internal/v1/rooms/000000/bootstrap', {
      headers: { 'x-mxqr-pro-room-code': '000000', 'x-mxqr-pro-room-generation': '0' },
    }),
  );
  const room = context.room;
  room.status = 'active';
  room.runtime = 'awake';
  room.passwordRequired = false;
  room.ownerMemberId = 'member_owner_00000001';
  room.playlist = structuredClone(playlist);
  room.playlistRevision = 1;
  for (const [participantId, role] of [
    [OWNER, 'owner'],
    [LISTENER, 'member'],
  ] as const) {
    const sessionHash = `${participantId}_session_hash`;
    const memberId = role === 'owner' ? room.ownerMemberId : 'member_listener_0001';
    const presenceIncarnationId = `presence_${participantId}`;
    room.sessions[sessionHash] = {
      participantId,
      memberId,
      displayName: role,
      role,
      authEpoch: room.authEpoch,
      roomGeneration: room.roomGeneration,
      createdAtMs: NOW,
      expiresAtMs: NOW + 86_400_000,
      signalingTicketSequence: 1,
      presenceIncarnationId,
    };
    room.presence.participants[participantId] = {
      participantId,
      presenceIncarnationId,
      sessionHash,
      memberId,
      displayName: role,
      role,
      developerControlVersion: 0,
      devicePlatform: 'other',
      joinedAtMs: NOW,
      lastSeenAtMs: NOW,
    };
  }
  for (const item of playlist) {
    if (item.source.kind !== 'pro-r2') continue;
    room.assets[item.source.assetId] = {
      status: 'ready',
      assetId: item.source.assetId,
      objectKey: `fixture/${item.source.assetId}/object`,
      version: item.source.version,
      byteLength: item.source.byteLength,
      mime: item.source.mime,
      roomGeneration: room.roomGeneration,
      completedAtMs: NOW,
    };
  }
  await context.worker.persist();
  await context.settle();
  return context;
}

type Context = Awaited<ReturnType<typeof fixture>>;

async function command(context: Context, input: CommandInput, settle = true) {
  const outcome = context.worker.applyPlaybackAuthorityCommand(
    { ...input, baseRevision: context.room.playback.revision } as Command,
    Date.now(),
  );
  expect(outcome.error).toBeUndefined();
  context.worker.enqueuePlaybackOutcome(outcome, Date.now());
  await context.worker.persist();
  if (settle) await context.settle();
  return outcome;
}

async function finishPrepare(context: Context, settle = true) {
  const pending = context.room.pendingPlaybackTransition;
  expect(pending).not.toBeNull();
  // Model all still-present endpoints becoming ready without granting them
  // playback control. HTTP authorization/readiness is covered separately.
  const outcome = context.worker.commitPendingPlaybackTransition(Date.now());
  context.worker.enqueuePlaybackOutcome(outcome, Date.now());
  await context.worker.persist();
  if (settle) await context.settle();
  vi.setSystemTime(context.room.playback.updatedAtMs);
  return pending!.transitionId;
}

async function start(context: Context, queueItemId = FIRST) {
  await command(context, { type: 'select', queueItemId, state: 'playing', positionSeconds: 0 });
  await finishPrepare(context);
}

async function leaveOwner(context: Context) {
  expect(context.worker.removePresence(OWNER, Date.now())).toBe(true);
  await context.worker.persist();
  await context.settle();
  expect(
    Object.values(context.room.presence.participants).map((participant) => participant.role),
  ).toEqual(['member']);
}

async function alarmAt(context: Context, at: number, keepListener = true) {
  vi.setSystemTime(at);
  if (keepListener && context.room.presence.participants[LISTENER]) {
    context.room.presence.participants[LISTENER].lastSeenAtMs = at;
  }
  context.storage.alarm = null; // Cloudflare removes the due alarm before delivery.
  await context.worker.alarm();
  await context.settle();
}

async function reachEnd(context: Context) {
  const end = context.worker.naturalPlaybackEndAtMs();
  expect(end).not.toBeNull();
  await alarmAt(context, end!);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  metadata.file.mockReset().mockResolvedValue(4);
  metadata.youtube.mockReset().mockResolvedValue({ kind: 'finite', durationSeconds: 5 });
});

afterEach(() => {
  for (const worker of workers) {
    worker.clearAlarmMaintenanceRetry();
    worker.invalidatePendingHeartbeatFlush();
  }
  workers.clear();
  vi.useRealTimers();
});

describe('PRO natural completion with ordinary listeners and no active controller', () => {
  it('arms the durable end alarm and commits the successor at its bounded preparation deadline', async () => {
    const context = await fixture();
    await start(context);
    await leaveOwner(context);
    const end = context.worker.naturalPlaybackEndAtMs()!;
    expect(context.storage.alarm).toBe(end);
    await alarmAt(context, context.storage.alarm!);
    const pending = context.room.pendingPlaybackTransition!;
    expect(pending.target.queueItemId).toBe(SECOND);
    expect(context.storage.alarm).toBe(pending.deadlineAtMs);
    await alarmAt(context, context.storage.alarm!);
    expect(context.room.pendingPlaybackTransition).toBeNull();
    expect(context.room.playback).toMatchObject({ state: 'playing', queueItemId: SECOND });
    expect(context.storage.alarm).toBe(context.worker.naturalPlaybackEndAtMs());
    expect(
      context.broadcasts.filter(
        (message) =>
          message.event?.type === 'pro-playback-prepare' &&
          message.event.transitionId === pending.transitionId,
      ),
    ).toHaveLength(1);
    expect(
      context.broadcasts.filter(
        (message) =>
          message.event?.type === 'pro-playback-commit' &&
          message.event.transitionId === pending.transitionId,
      ),
    ).toHaveLength(1);
  });

  it('continues file → YouTube playlist occurrences → file → idle after the owner leaves', async () => {
    const context = await fixture([
      fileItem(FIRST),
      youtubeItem(SECOND, [VIDEO_A, VIDEO_B, VIDEO_A]),
      fileItem(THIRD),
    ]);
    await start(context);
    await leaveOwner(context);

    for (const [queueItemId, youtubeVideoId, youtubeSubIndex] of [
      [SECOND, VIDEO_A, 0],
      [SECOND, VIDEO_B, 1],
      [SECOND, VIDEO_A, 2],
      [THIRD, null, null],
    ] as const) {
      await reachEnd(context);
      expect(context.room.pendingPlaybackTransition?.target).toMatchObject({
        queueItemId,
        youtubeVideoId,
        youtubeSubIndex,
      });
      await finishPrepare(context);
      expect(context.room.playback.state).toBe('playing');
    }
    await reachEnd(context);
    expect(context.room.playback).toMatchObject({ state: 'idle', queueItemId: null });
    expect(context.room.pendingPlaybackTransition).toBeNull();
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    expect(metadata.file).toHaveBeenCalledTimes(2);
    expect(metadata.youtube.mock.calls.map((call) => call[1])).toEqual([VIDEO_A, VIDEO_B, VIDEO_A]);
  });

  it('repeats the exact duplicate-video subindex once and fences the old deadline', async () => {
    const context = await fixture([youtubeItem(FIRST, [VIDEO_A, VIDEO_A])]);
    context.room.queueMode.repeatMode = 2;
    await command(context, {
      type: 'select',
      queueItemId: FIRST,
      state: 'playing',
      positionSeconds: 0,
      youtubeVideoId: VIDEO_A,
      youtubeSubIndex: 1,
    });
    await finishPrepare(context);
    await leaveOwner(context);
    const revision = context.room.playback.revision;
    await reachEnd(context);
    const transitionId = context.room.pendingPlaybackTransition!.transitionId;
    await alarmAt(context, Date.now());
    expect(context.room.pendingPlaybackTransition?.transitionId).toBe(transitionId);
    await finishPrepare(context);
    expect(context.room.playback).toMatchObject({
      revision: revision + 1,
      queueItemId: FIRST,
      youtubeVideoId: VIDEO_A,
      youtubeSubIndex: 1,
      positionSeconds: 0,
    });
    await alarmAt(context, Date.now());
    expect(context.room.pendingPlaybackTransition).toBeNull();
  });

  it('uses the latest shuffle and repeat-all policy at the ending boundary', async () => {
    const context = await fixture([fileItem(FIRST), youtubeItem(SECOND), fileItem(THIRD)]);
    await start(context, SECOND);
    await leaveOwner(context);
    context.room.queueMode = {
      revision: 1,
      updatedAtMs: Date.now(),
      repeatMode: 1,
      shuffleEnabled: true,
      shuffleOrder: [THIRD, FIRST, SECOND],
    };
    await context.worker.persist();
    await reachEnd(context);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(THIRD);
  });

  it('does not let an old end deadline override a backward seek', async () => {
    const context = await fixture();
    await start(context);
    const oldEnd = context.worker.naturalPlaybackEndAtMs()!;
    vi.setSystemTime(oldEnd - 10);
    await command(context, { type: 'seek', positionSeconds: 0 });
    const seekId = context.room.pendingPlaybackTransition!.transitionId;
    await alarmAt(context, oldEnd);
    expect(context.room.pendingPlaybackTransition?.transitionId).toBe(seekId);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(FIRST);
    await finishPrepare(context);
    await leaveOwner(context);
    const newEnd = context.worker.naturalPlaybackEndAtMs()!;
    expect(newEnd).toBeGreaterThan(oldEnd + 3_000);
    await alarmAt(context, newEnd - 1);
    expect(context.room.pendingPlaybackTransition).toBeNull();
    await alarmAt(context, newEnd);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(SECOND);
  });

  it('preserves a selected successor being prepared at the old track end', async () => {
    const context = await fixture([fileItem(FIRST), youtubeItem(SECOND), fileItem(THIRD)]);
    await start(context);
    const oldEnd = context.worker.naturalPlaybackEndAtMs()!;
    vi.setSystemTime(oldEnd - 10);
    await command(context, {
      type: 'select',
      queueItemId: THIRD,
      state: 'playing',
      positionSeconds: 0,
    });
    const selectionId = context.room.pendingPlaybackTransition!.transitionId;
    await alarmAt(context, oldEnd);
    expect(context.room.pendingPlaybackTransition?.transitionId).toBe(selectionId);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(THIRD);
  });

  it('keeps explicit pause paused even when the old alarm fires and the owner leaves', async () => {
    const context = await fixture();
    await start(context);
    const oldEnd = context.worker.naturalPlaybackEndAtMs()!;
    vi.setSystemTime(oldEnd - 500);
    await command(context, { type: 'pause' });
    await leaveOwner(context);
    await alarmAt(context, oldEnd + 60_000);
    expect(context.room.playback).toMatchObject({ state: 'paused', queueItemId: FIRST });
    expect(context.room.pendingPlaybackTransition).toBeNull();
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
  });

  it('sleeps instead of advancing if the final listener expires at the same deadline', async () => {
    metadata.file.mockResolvedValue(45);
    const context = await fixture();
    await start(context);
    await leaveOwner(context);
    const end = context.worker.naturalPlaybackEndAtMs()!;
    context.room.presence.participants[LISTENER]!.lastSeenAtMs =
      end - context.worker.presenceTtlMs();
    await context.worker.persist();
    await alarmAt(context, end, false);
    expect(context.room.runtime).toBe('sleeping');
    expect(context.room.playback.queueItemId).toBe(FIRST);
    expect(context.room.pendingPlaybackTransition).toBeNull();
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    expect(Object.keys(context.room.presence.participants)).toEqual([]);
  });

  it('retains the authoritative duration and completes once after a cold DO restart', async () => {
    const context = await fixture();
    await start(context);
    await leaveOwner(context);
    const end = context.worker.naturalPlaybackEndAtMs()!;
    const fileCalls = metadata.file.mock.calls.length;
    context.worker = context.createWorker();
    await context.worker.ready;
    expect(context.worker.naturalPlaybackEndAtMs()).toBe(end);
    await alarmAt(context, end + 1_000);
    const transitionId = context.room.pendingPlaybackTransition!.transitionId;
    await alarmAt(context, end + 1_000);
    expect(context.room.pendingPlaybackTransition?.transitionId).toBe(transitionId);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(SECOND);
    expect(metadata.file).toHaveBeenCalledTimes(fileCalls);
  });

  it('rolls back a natural end whose durable write fails and retries without publishing a phantom transition', async () => {
    const context = await fixture();
    await start(context);
    await leaveOwner(context);
    const end = context.worker.naturalPlaybackEndAtMs()!;
    const before = structuredClone({
      playback: context.room.playback,
      pending: context.room.pendingPlaybackTransition,
      outbox: context.room.pendingPlaybackBroadcasts,
    });
    const delivered = context.broadcasts.length;
    context.storage.failNextPut = true;
    await expect(alarmAt(context, end)).rejects.toThrow('Injected durable write failure');
    expect({
      playback: context.room.playback,
      pending: context.room.pendingPlaybackTransition,
      outbox: context.room.pendingPlaybackBroadcasts,
    }).toEqual(before);
    expect(context.broadcasts).toHaveLength(delivered);
    await alarmAt(context, end + 1);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(SECOND);
  });

  it('backs off a natural end refused by room state capacity instead of re-arming at once', async () => {
    const context = await fixture();
    await start(context);
    await leaveOwner(context);
    const end = context.worker.naturalPlaybackEndAtMs()!;
    // Fill the bounded core so the successor PREPARE and its outbox cannot fit.
    const asset = context.room.assets[`asset_${FIRST}`]!;
    const { playlist, ...core } = context.room;
    const encoded = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 2,
        core,
        playlistOrder: playlist.map((item) => item.queueItemId),
      }),
    );
    asset.name = 'x'.repeat(1200 * 1024 - encoded - 256);
    await context.worker.persist();
    const playback = structuredClone(context.room.playback);
    const delivered = context.broadcasts.length;
    await alarmAt(context, end);
    expect(context.room.pendingPlaybackTransition).toBeNull();
    expect(context.room.playback).toEqual(playback);
    expect(context.broadcasts).toHaveLength(delivered);
    const retryAt = context.storage.alarm!;
    expect(retryAt).toBeGreaterThanOrEqual(end + 30_000);
    expect(context.worker.naturalPlaybackEndAtMs()).toBe(retryAt);
    // Ordinary requests prune too; they must not repeat the refused work.
    const advance = vi.spyOn(context.worker, 'advanceCompletedPlayback');
    vi.setSystemTime(end + 1_000);
    await context.worker.prune(Date.now());
    expect(advance).not.toHaveBeenCalled();
    // Once capacity is available again, the retry completes the track. The
    // rollback restored a cloned room, so read the current asset record.
    delete context.room.assets[`asset_${FIRST}`]!.name;
    await context.worker.persist();
    expect(context.storage.alarm).toBe(retryAt);
    await alarmAt(context, retryAt);
    expect(advance).toHaveBeenCalledOnce();
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(SECOND);
  });

  it('drops a capacity retry when the playback it was measured against changes', async () => {
    const context = await fixture();
    await start(context);
    await leaveOwner(context);
    const end = context.worker.naturalPlaybackEndAtMs()!;
    const asset = context.room.assets[`asset_${FIRST}`]!;
    const { playlist, ...core } = context.room;
    const encoded = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 2,
        core,
        playlistOrder: playlist.map((item) => item.queueItemId),
      }),
    );
    asset.name = 'x'.repeat(1200 * 1024 - encoded - 256);
    await context.worker.persist();
    await alarmAt(context, end);
    expect(context.worker.naturalPlaybackEndAtMs()).toBeGreaterThanOrEqual(end + 30_000);
    delete context.room.assets[`asset_${FIRST}`]!.name;
    await command(context, { type: 'seek', positionSeconds: 1 });
    await finishPrepare(context);
    expect(context.worker.naturalPlaybackEndAtMs()).toBe(
      context.room.playback.updatedAtMs + 3_000 + 2_000,
    );
  });

  it.each(['version', 'deletion'] as const)(
    'backs off a file probe whose asset fails its %s identity check instead of re-arming at once',
    async (change) => {
      const context = await fixture();
      const asset = context.room.assets[`asset_${FIRST}`]!;
      if (change === 'version') asset.version = 2; // The queue row still names version 1.
      if (change === 'deletion')
        asset.deletionPending = {
          reason: 'orphan-gc',
          originalStatus: 'ready',
          requestedAtMs: NOW,
          retryAtMs: NOW + 3_600_000,
        };
      await context.worker.persist();
      await start(context);
      await leaveOwner(context);
      expect(metadata.file).not.toHaveBeenCalled();
      expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
      const probe = context.room.playbackDurationProbe!;
      expect(probe).toMatchObject({ attempts: 1 });
      expect(probe.retryAtMs).toBeGreaterThanOrEqual(NOW + 5 * 60_000);
      expect(context.storage.alarm).toBeGreaterThan(Date.now() + 1_000);
      await alarmAt(context, Date.now() + 1_000);
      expect(context.room.playbackDurationProbe).toEqual(probe);
      expect(context.room.playback).toMatchObject({ state: 'playing', queueItemId: FIRST });
    },
  );

  it('does not block a new selection on metadata I/O or apply the previous track result to it', async () => {
    let completeFile!: (duration: number | null) => void;
    metadata.file.mockImplementationOnce(
      () =>
        new Promise<number | null>((resolve) => {
          completeFile = resolve;
        }),
    );
    const context = await fixture();
    await command(
      context,
      { type: 'select', queueItemId: FIRST, state: 'playing', positionSeconds: 0 },
      false,
    );
    await finishPrepare(context, false);
    expect(metadata.file).toHaveBeenCalledOnce();
    await command(
      context,
      { type: 'select', queueItemId: SECOND, state: 'playing', positionSeconds: 0 },
      false,
    );
    await finishPrepare(context, false);
    expect(context.room.playback.queueItemId).toBe(SECOND);
    completeFile(0.001);
    await context.settle();
    expect(
      Object.values(context.room.playbackDurations).map((entry) => entry.identity.queueItemId),
    ).toEqual([SECOND]);
    const end = context.worker.naturalPlaybackEndAtMs()!;
    expect(end - context.room.playback.updatedAtMs).toBeGreaterThanOrEqual(5_000);
    await alarmAt(context, context.room.playback.updatedAtMs + 1);
    expect(context.room.pendingPlaybackTransition).toBeNull();
  });

  it('discards a pending duration response when the room becomes empty and stays asleep', async () => {
    let completeFile!: (duration: number | null) => void;
    metadata.file.mockImplementationOnce(
      () =>
        new Promise<number | null>((resolve) => {
          completeFile = resolve;
        }),
    );
    const context = await fixture();
    await command(
      context,
      { type: 'select', queueItemId: FIRST, state: 'playing', positionSeconds: 0 },
      false,
    );
    await finishPrepare(context, false);
    context.worker.removePresence(OWNER, Date.now());
    context.worker.removePresence(LISTENER, Date.now());
    await context.worker.persist();
    completeFile(0.001);
    await context.settle();
    await alarmAt(context, Date.now() + 60_000, false);
    expect(context.room.runtime).toBe('sleeping');
    expect(context.room.playback.queueItemId).toBe(FIRST);
    expect(context.room.playbackDurationProbe).toBeNull();
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    expect(context.room.pendingPlaybackTransition).toBeNull();
  });

  it('freezes an empty room and resumes its remaining time rather than charging time asleep', async () => {
    const context = await fixture();
    await start(context);
    const originalSpan =
      context.worker.naturalPlaybackEndAtMs()! - context.room.playback.updatedAtMs;
    await leaveOwner(context);
    vi.setSystemTime(context.room.playback.updatedAtMs + 1_000);
    context.worker.removePresence(LISTENER, Date.now());
    await context.worker.persist();
    expect(context.room.playback.positionSeconds).toBe(1);
    vi.setSystemTime(Date.now() + 3_600_000);
    const [sessionHash, session] = Object.entries(context.room.sessions).find(
      ([, entry]) => entry.participantId === LISTENER,
    )!;
    expect(context.worker.joinPresence(session, sessionHash, Date.now())).toBe(true);
    await context.worker.persist();
    await context.settle();
    expect(context.room.pendingPlaybackTransition).toMatchObject({
      resumeFromSleep: true,
      target: { queueItemId: FIRST, positionSeconds: 1 },
    });
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    await finishPrepare(context);
    expect(context.worker.naturalPlaybackEndAtMs()! - context.room.playback.updatedAtMs).toBe(
      originalSpan - 1_000,
    );
    await reachEnd(context);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(SECOND);
  });

  it('suspends file end scheduling while a live-audio publication is being established', async () => {
    const context = await fixture();
    await start(context);
    const previousEnd = context.worker.naturalPlaybackEndAtMs()!;
    context.room.systemAudio = {
      generation: 1,
      status: 'preparing',
      ownerParticipantId: OWNER,
      ownerPresenceIncarnationId: context.room.presence.participants[OWNER]!.presenceIncarnationId,
      leaseId: 'l'.repeat(43),
      claimExpiresAt: previousEnd + 20_000,
      liveExpiresAt: null,
      publication: null,
    };
    await context.worker.persist();
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    await alarmAt(context, previousEnd);
    expect(context.room.systemAudio.status).toBe('preparing');
    expect(context.room.playback.queueItemId).toBe(FIRST);
    expect(context.room.pendingPlaybackTransition).toBeNull();
  });

  it('settles a legacy YouTube playlist without a manifest as paused instead of looping alarms', async () => {
    const legacy = youtubeItem(FIRST);
    if (legacy.source.kind !== 'youtube') throw new Error('Invalid test fixture');
    legacy.source.playlistId = 'PLabcdefghijklmnop';
    const context = await fixture([legacy, fileItem(SECOND)]);
    await start(context);
    await leaveOwner(context);
    await reachEnd(context);
    expect(context.room.playback).toMatchObject({
      state: 'paused',
      queueItemId: FIRST,
      positionSeconds: 5,
    });
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    await alarmAt(context, Date.now() + 10_000);
    expect(context.room.pendingPlaybackTransition).toBeNull();
    expect(context.room.playback.state).toBe('paused');
  });

  it('refreshes long-video metadata at expiry and refuses stale scheduling while refresh is pending', async () => {
    let completeRefresh!: (value: { kind: 'finite'; durationSeconds: number }) => void;
    metadata.youtube.mockResolvedValueOnce({ kind: 'finite', durationSeconds: 7_200 });
    metadata.youtube.mockImplementationOnce(
      () =>
        new Promise<{ kind: 'finite'; durationSeconds: number }>((resolve) => {
          completeRefresh = resolve;
        }),
    );
    const context = await fixture([youtubeItem(FIRST), fileItem(SECOND)]);
    await start(context);
    await leaveOwner(context);
    const originalEnd = context.worker.naturalPlaybackEndAtMs()!;
    const evidence = Object.values(context.room.playbackDurations)[0]!;
    const refreshAt = evidence.checkedAtMs + 3_600_000;
    vi.setSystemTime(refreshAt);
    context.room.presence.participants[LISTENER]!.lastSeenAtMs = refreshAt;
    context.storage.alarm = null;
    await context.worker.alarm();
    expect(metadata.youtube).toHaveBeenCalledTimes(2);
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    expect(context.room.pendingPlaybackTransition).toBeNull();
    completeRefresh({ kind: 'finite', durationSeconds: 7_300 });
    await context.settle();
    expect(context.worker.naturalPlaybackEndAtMs()).toBe(originalEnd + 100_000);
  });

  it('removes a previously finite deadline when trusted metadata now reports live', async () => {
    metadata.youtube.mockResolvedValueOnce({ kind: 'finite', durationSeconds: 7_200 });
    metadata.youtube.mockResolvedValue({ kind: 'live' });
    const context = await fixture([youtubeItem(FIRST), fileItem(SECOND)]);
    await start(context);
    await leaveOwner(context);
    const originalEnd = context.worker.naturalPlaybackEndAtMs()!;
    const evidence = Object.values(context.room.playbackDurations)[0]!;
    await alarmAt(context, evidence.checkedAtMs + 3_600_000);
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    await alarmAt(context, originalEnd);
    expect(context.room.playback).toMatchObject({ state: 'playing', queueItemId: FIRST });
    expect(context.room.pendingPlaybackTransition).toBeNull();
  });

  it('defers a provider-confirmed unplayable video until COMMIT and skips to its next playlist occurrence', async () => {
    metadata.youtube.mockImplementation(async (_env, videoId) =>
      videoId === VIDEO_A ? { kind: 'unplayable' } : { kind: 'finite', durationSeconds: 5 },
    );
    const context = await fixture([youtubeItem(FIRST, [VIDEO_A, VIDEO_B]), fileItem(SECOND)]);
    await command(context, {
      type: 'select',
      queueItemId: FIRST,
      state: 'playing',
      positionSeconds: 0,
    });
    const preparing = context.room.pendingPlaybackTransition!.transitionId;
    expect(Object.values(context.room.playbackDurations)[0]?.durationSeconds).toBeNull();
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    await alarmAt(context, Date.now() + 100);
    expect(context.room.pendingPlaybackTransition?.transitionId).toBe(preparing);
    await finishPrepare(context);
    await leaveOwner(context);
    await reachEnd(context);
    expect(context.room.pendingPlaybackTransition?.target).toMatchObject({
      queueItemId: FIRST,
      youtubeVideoId: VIDEO_B,
      youtubeSubIndex: 1,
    });
    await finishPrepare(context);
    await reachEnd(context);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(SECOND);
    expect(context.room.automaticUnavailableSkips).toBe(0);
  });

  it('stops a repeat-all playlist after one full pass of provider-confirmed unplayable occurrences', async () => {
    metadata.youtube.mockResolvedValue({ kind: 'unplayable' });
    const context = await fixture([youtubeItem(FIRST, [VIDEO_A, VIDEO_A])]);
    context.room.queueMode.repeatMode = 1;
    await start(context);
    await leaveOwner(context);
    await reachEnd(context);
    expect(context.room.pendingPlaybackTransition?.target.youtubeSubIndex).toBe(1);
    await finishPrepare(context);
    await reachEnd(context);
    expect(context.room.playback).toMatchObject({ state: 'idle', queueItemId: null });
    expect(context.room.pendingPlaybackTransition).toBeNull();
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    const delivered = context.broadcasts.length;
    await alarmAt(context, Date.now() + 10_000);
    expect(context.broadcasts).toHaveLength(delivered);
  });

  it('does not let a late unplayable verdict skip a newer selected track', async () => {
    let complete!: (value: { kind: 'unplayable' }) => void;
    metadata.youtube.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const context = await fixture([youtubeItem(FIRST), fileItem(SECOND)]);
    await command(
      context,
      { type: 'select', queueItemId: FIRST, state: 'playing', positionSeconds: 0 },
      false,
    );
    await finishPrepare(context, false);
    await command(
      context,
      { type: 'select', queueItemId: SECOND, state: 'playing', positionSeconds: 0 },
      false,
    );
    await finishPrepare(context, false);
    complete({ kind: 'unplayable' });
    await context.settle();
    await leaveOwner(context);
    await alarmAt(context, Date.now() + 1);
    expect(context.room.playback).toMatchObject({ state: 'playing', queueItemId: SECOND });
    expect(context.room.pendingPlaybackTransition).toBeNull();
    expect(context.room.automaticUnavailableSkips).toBe(0);
  });

  it.each(['live', 'unavailable', 'retry'] as const)(
    'never invents a finite end or globally skips a YouTube %s response',
    async (kind) => {
      metadata.youtube.mockResolvedValue({ kind });
      const context = await fixture([youtubeItem(FIRST), fileItem(SECOND)]);
      await start(context);
      await leaveOwner(context);
      expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
      await alarmAt(context, Date.now() + 60_000);
      expect(context.room.playback).toMatchObject({ state: 'playing', queueItemId: FIRST });
      expect(context.room.pendingPlaybackTransition).toBeNull();
    },
  );
});

describe('PRO YouTube metadata backoff and confirmed missing videos', () => {
  const notFound = { kind: 'unavailable', reason: 'not-found' } as const;

  async function playingYouTube() {
    const context = await fixture([youtubeItem(FIRST), fileItem(SECOND)]);
    await start(context);
    await leaveOwner(context);
    return context;
  }

  async function nextLookup(context: Context) {
    const at = context.room.playbackDurationProbe!.retryAtMs;
    await alarmAt(context, at);
    return at;
  }

  it.each([
    [
      'live',
      () => metadata.youtube.mockResolvedValue({ kind: 'live' }),
      [60_000, 120_000, 240_000, 480_000, 900_000, 900_000],
    ],
    [
      'unavailable',
      () => metadata.youtube.mockResolvedValue({ kind: 'unavailable' }),
      [60_000, 120_000, 240_000, 480_000, 900_000, 900_000],
    ],
    // Failed lookups are not answers: they keep the quick first retries.
    [
      'retry',
      () => metadata.youtube.mockResolvedValue({ kind: 'retry' }),
      [5_000, 30_000, 240_000, 480_000, 900_000, 900_000],
    ],
    [
      'failed',
      () => metadata.youtube.mockRejectedValue(new Error('metadata network failure')),
      [5_000, 30_000, 240_000, 480_000, 900_000, 900_000],
    ],
  ])(
    'backs off %s lookups up to fifteen minutes without skipping',
    async (_kind, configure, expected) => {
      configure();
      const context = await playingYouTube();
      const delays = [context.room.playbackDurationProbe!.retryAtMs - NOW];
      for (let lookup = 0; lookup < 5; lookup += 1) {
        const at = await nextLookup(context);
        delays.push(context.room.playbackDurationProbe!.retryAtMs - at);
      }
      expect(delays).toEqual(expected);
      expect(metadata.youtube).toHaveBeenCalledTimes(6);
      // Liveness alarms in between do not repeat the provider lookup.
      await alarmAt(context, Date.now() + 60_000);
      expect(metadata.youtube).toHaveBeenCalledTimes(6);
      expect(context.room.playbackDurationProbe).not.toHaveProperty('notFoundAtMs');
      expect(context.room.playback).toMatchObject({ state: 'playing', queueItemId: FIRST });
      expect(context.room.pendingPlaybackTransition).toBeNull();
    },
  );

  it('skips a video YouTube reports missing only after a second answer a minute later', async () => {
    metadata.youtube.mockResolvedValue(notFound);
    const context = await playingYouTube();
    expect(context.room.playbackDurationProbe).toMatchObject({ attempts: 1, notFoundAtMs: NOW });
    expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    // An early repeated answer is not a separate confirmation.
    vi.setSystemTime(NOW + 59_000);
    context.room.playbackDurationProbe!.retryAtMs = Date.now();
    context.worker.startPlaybackDurationProbe();
    await context.settle();
    expect(context.room.playbackDurationProbe).toMatchObject({ attempts: 2, notFoundAtMs: NOW });
    expect(context.room.playbackDurations).toEqual({});
    context.room.playbackDurationProbe!.retryAtMs = NOW + 60_000;
    await nextLookup(context);
    expect(metadata.youtube).toHaveBeenCalledTimes(3);
    expect(Object.values(context.room.playbackDurations)).toEqual([
      expect.objectContaining({ durationSeconds: null, source: 'server' }),
    ]);
    // The existing unplayable path then skips to the next queue item.
    await alarmAt(context, context.storage.alarm!);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(SECOND);
    expect(context.room.automaticUnavailableSkips).toBe(1);
  });

  it.each([
    ['a failed lookup', () => metadata.youtube.mockResolvedValueOnce({ kind: 'retry' }), true],
    ['a thrown lookup', () => metadata.youtube.mockRejectedValueOnce(new Error('network')), true],
    ['a live answer', () => metadata.youtube.mockResolvedValueOnce({ kind: 'live' }), false],
    [
      'an older App unavailable answer',
      () => metadata.youtube.mockResolvedValueOnce({ kind: 'unavailable' }),
      false,
    ],
  ])('treats %s between two not-found answers correctly', async (_label, between, confirms) => {
    metadata.youtube.mockResolvedValueOnce(notFound);
    between();
    metadata.youtube.mockResolvedValue(notFound);
    const context = await playingYouTube();
    await nextLookup(context);
    expect(context.room.playbackDurations).toEqual({});
    await nextLookup(context);
    expect(metadata.youtube).toHaveBeenCalledTimes(3);
    if (confirms) {
      expect(Object.values(context.room.playbackDurations)[0]?.durationSeconds).toBeNull();
    } else {
      // The withdrawn answer restarts the rule from this lookup.
      expect(context.room.playbackDurations).toEqual({});
      expect(context.room.playbackDurationProbe!.notFoundAtMs).toBe(Date.now());
    }
  });

  it('keeps the first not-found answer across Durable Object eviction', async () => {
    metadata.youtube.mockResolvedValue(notFound);
    const context = await playingYouTube();
    const retryAt = context.room.playbackDurationProbe!.retryAtMs;
    context.worker = context.createWorker();
    await context.worker.ready;
    expect(context.room.playbackDurationProbe).toMatchObject({ notFoundAtMs: NOW });
    await alarmAt(context, retryAt);
    expect(Object.values(context.room.playbackDurations)[0]?.durationSeconds).toBeNull();
  });

  it.each([
    ['malformed', 'soon'],
    ['negative', -1],
    ['future', NOW + 3_600_000],
  ])('drops a %s stored not-found marker without discarding the probe', async (_label, value) => {
    metadata.youtube.mockResolvedValue({ kind: 'live' });
    const context = await playingYouTube();
    const probe = structuredClone(context.room.playbackDurationProbe!);
    (context.room.playbackDurationProbe as unknown as Record<string, unknown>).notFoundAtMs = value;
    context.worker.normalizeLoadedPlaybackAuthority();
    expect(context.room.playbackDurationProbe).toEqual(probe);
  });

  it('drops a not-found marker stored on a file probe', async () => {
    metadata.file.mockResolvedValue(null);
    const context = await fixture();
    await start(context);
    const probe = structuredClone(context.room.playbackDurationProbe!);
    expect(probe.identity.mediaKind).toBe('file');
    context.room.playbackDurationProbe!.notFoundAtMs = NOW;
    context.worker.normalizeLoadedPlaybackAuthority();
    expect(context.room.playbackDurationProbe).toEqual(probe);
  });
});

describe('PRO file lengths stored before the current duration reader', () => {
  // 8.9.5-8.10.0 stored server lengths from an MP3/MP4 reader that could
  // undercount, and the uploading client's own reading, without a version.
  async function restartWithUnversionedLengths(source: 'server' | 'upload' | 'controller') {
    const context = await fixture([fileItem(FIRST), fileItem(SECOND), fileItem(THIRD)]);
    await start(context);
    await leaveOwner(context);
    expect(metadata.file).toHaveBeenCalledOnce();
    const stored = context.storage.data.get('pro-room:v2:core') as { core: Room };
    for (const queueItemId of [FIRST, SECOND, THIRD]) {
      stored.core.assets[`asset_${queueItemId}`]!.duration = {
        assetVersion: 1,
        byteLength: 4096,
        roomGeneration: 0,
        durationSeconds: 1,
        checkedAtMs: NOW,
        source: source as 'server',
      };
    }
    const entries = Object.values(stored.core.playbackDurations);
    expect(entries).toEqual([expect.objectContaining({ source: 'server' })]);
    Object.assign(entries[0]!, { durationSeconds: 1, source });
    delete entries[0]!.reader;
    context.worker = context.createWorker();
    await context.worker.ready;
    return context;
  }

  it.each(['server', 'upload'] as const)(
    'measures the playing file again instead of ending it from an unversioned %s length',
    async (source) => {
      const context = await restartWithUnversionedLengths(source);
      metadata.file.mockResolvedValue(30);
      expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
      await alarmAt(context, Date.now() + 1_000);
      expect(metadata.file).toHaveBeenCalledTimes(2);
      expect(metadata.file.mock.calls[1]?.[1]).toBe(`fixture/asset_${FIRST}/object`);
      expect(context.room.assets[`asset_${FIRST}`]!.duration).toMatchObject({
        durationSeconds: 30,
        source: 'server',
        reader: PRO_ROOM_FILE_DURATION_READER,
      });
      expect(context.worker.naturalPlaybackEndAtMs()).toBe(
        context.room.playback.updatedAtMs + 32_000,
      );
      expect(context.room.playback).toMatchObject({ state: 'playing', queueItemId: FIRST });
      // Other assets wait for their own playback instead of a deployment-wide sweep.
      expect(context.room.pendingAssetDurationProbes ?? []).toEqual([]);
      expect(context.room.assets[`asset_${SECOND}`]!.duration).toMatchObject({
        durationSeconds: 1,
        source,
      });
      await reachEnd(context);
      await finishPrepare(context);
      expect(context.room.playback.queueItemId).toBe(SECOND);
      await context.settle();
      expect(metadata.file).toHaveBeenCalledTimes(3);
      expect(context.worker.naturalPlaybackEndAtMs()).toBe(
        context.room.playback.updatedAtMs + 32_000,
      );
    },
  );

  it('keeps an unversioned controller-decoded length', async () => {
    const context = await restartWithUnversionedLengths('controller');
    expect(context.worker.naturalPlaybackEndAtMs()).toBe(context.room.playback.updatedAtMs + 1_000);
    await alarmAt(context, Date.now() + 500);
    expect(metadata.file).toHaveBeenCalledOnce();
    await reachEnd(context);
    expect(context.room.pendingPlaybackTransition?.target.queueItemId).toBe(SECOND);
  });
});

describe('PRO metadata answers refused by room state capacity', () => {
  type YouTubeAnswer = Awaited<ReturnType<typeof metadata.youtube>>;

  // Pad the core until `margin` more bytes would exceed the 1.2 MB state limit.
  function fillCore(context: Context, margin: number) {
    const asset = context.room.assets[`asset_${SECOND}`]!;
    asset.name = '';
    const { playlist, ...core } = context.room;
    const encoded = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 2,
        core,
        playlistOrder: playlist.map((item) => item.queueItemId),
      }),
    );
    asset.name = 'x'.repeat(1200 * 1024 - encoded - margin);
  }

  async function answerInFullRoom(
    answer: YouTubeAnswer,
    margin: number,
    { attempts = 0, notFoundAgoMs }: { attempts?: number; notFoundAgoMs?: number } = {},
  ) {
    let deliver!: (value: YouTubeAnswer) => void;
    const context = await fixture([youtubeItem(FIRST), fileItem(SECOND)]);
    await start(context);
    expect(metadata.youtube).toHaveBeenCalledOnce();
    // Start the next lookup with the requested attempt count and hold it open.
    metadata.youtube.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    context.room.playbackDurations = {};
    context.room.playbackDurationProbe = {
      identity: {
        queueItemId: FIRST,
        mediaKind: 'youtube',
        youtubeVideoId: VIDEO_A,
        youtubeSubIndex: 0,
      },
      attempts,
      retryAtMs: Date.now(),
      ...(notFoundAgoMs === undefined ? {} : { notFoundAtMs: Date.now() - notFoundAgoMs }),
    };
    context.worker.startPlaybackDurationProbe();
    expect(context.worker.playbackDurationLookup).not.toBeNull();
    fillCore(context, margin);
    await context.worker.persist();
    const before = structuredClone(context.room.playbackDurationProbe);
    const at = Date.now();
    deliver(answer);
    await context.settle();
    expect(metadata.youtube).toHaveBeenCalledTimes(2);
    return { context, before: before!, at };
  }

  it('records the backoff alone when a finite answer does not fit', async () => {
    const { context, before, at } = await answerInFullRoom(
      { kind: 'finite', durationSeconds: 5 },
      40,
    );
    expect(context.room.playbackDurations).toEqual({});
    expect(context.room.playbackDurationProbe).toEqual({
      ...before,
      attempts: 1,
      retryAtMs: at + 60_000,
    });
    const stored = context.storage.data.get('pro-room:v2:core') as { core: Room };
    expect(stored.core.playbackDurationProbe).toEqual(context.room.playbackDurationProbe);
    expect(context.storage.alarm).toBeGreaterThan(at + 10_000);
    // The 10 s lookup watchdog no longer repeats the provider call.
    await alarmAt(context, at + 10_000);
    await alarmAt(context, at + 30_000);
    expect(metadata.youtube).toHaveBeenCalledTimes(2);
    expect(context.room.playback).toMatchObject({ state: 'playing', queueItemId: FIRST });
  });

  it('keeps only an already stored not-found answer when the first one does not fit', async () => {
    const { context, before, at } = await answerInFullRoom(
      { kind: 'unavailable', reason: 'not-found' },
      10,
    );
    expect(before).not.toHaveProperty('notFoundAtMs');
    expect(context.room.playbackDurationProbe).toEqual({
      ...before,
      attempts: 1,
      retryAtMs: at + 60_000,
    });
    await alarmAt(context, at + 10_000);
    expect(metadata.youtube).toHaveBeenCalledTimes(2);
  });

  it('keeps a stored not-found answer when its confirming skip does not fit', async () => {
    const { context, before, at } = await answerInFullRoom(
      { kind: 'unavailable', reason: 'not-found' },
      40,
      { notFoundAgoMs: 60_000 },
    );
    expect(before.notFoundAtMs).toBe(at - 60_000);
    expect(context.room.playbackDurations).toEqual({});
    expect(context.room.playbackDurationProbe).toEqual({
      ...before,
      attempts: 1,
      retryAtMs: at + 60_000,
    });
    await alarmAt(context, at + 10_000);
    expect(metadata.youtube).toHaveBeenCalledTimes(2);
  });

  it('holds the backoff in memory when even the attempt count does not fit', async () => {
    // Attempt 9 -> 10 adds one byte to an otherwise exactly full core.
    const { context, before, at } = await answerInFullRoom(
      { kind: 'finite', durationSeconds: 5 },
      0,
      { attempts: 9 },
    );
    expect(context.room.playbackDurationProbe).toEqual(before);
    expect(context.room.playbackDurations).toEqual({});
    // Neither the next watchdog nor a direct start repeats the lookup.
    await alarmAt(context, at + 10_000);
    context.worker.startPlaybackDurationProbe();
    expect(context.worker.playbackDurationLookup).toBeNull();
    expect(context.storage.alarm).toBeGreaterThan(Date.now() + 1_000);
    expect(metadata.youtube).toHaveBeenCalledTimes(2);
    // The full backoff (60 s x 2^4, capped at 15 minutes) then retries once.
    await alarmAt(context, at + 900_000);
    expect(metadata.youtube).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['finite', { kind: 'finite', durationSeconds: 5 }],
    ['unplayable', { kind: 'unplayable' }],
  ] as const)(
    'withdraws a stored not-found answer when a %s answer does not fit',
    async (_label, answer) => {
      const { context, before, at } = await answerInFullRoom(answer, 30, {
        notFoundAgoMs: 30_000,
      });
      expect(context.room.playbackDurations).toEqual({});
      const { notFoundAtMs, ...withdrawn } = before;
      expect(notFoundAtMs).toBe(at - 30_000);
      expect(context.room.playbackDurationProbe).toEqual({
        ...withdrawn,
        attempts: 1,
        retryAtMs: at + 60_000,
      });
      // With space again, one transient "not found" more than a minute after
      // the withdrawn one restarts the two-answer rule instead of skipping.
      context.room.assets[`asset_${SECOND}`]!.name = '';
      metadata.youtube.mockResolvedValue({ kind: 'unavailable', reason: 'not-found' });
      await alarmAt(context, at + 60_000);
      expect(metadata.youtube).toHaveBeenCalledTimes(3);
      expect(context.room.playbackDurations).toEqual({});
      expect(context.room.playbackDurationProbe).toMatchObject({ notFoundAtMs: at + 60_000 });
      expect(context.worker.naturalPlaybackEndAtMs()).toBeNull();
    },
  );

  it('drops a memory-only backoff when its probe is replaced by a fresh one', async () => {
    const { context, before, at } = await answerInFullRoom(
      { kind: 'finite', durationSeconds: 5 },
      0,
      { attempts: 9 },
    );
    expect(context.room.playbackDurationProbe).toEqual(before);
    // The owner frees space, then pauses and resumes the same occurrence.
    context.room.assets[`asset_${SECOND}`]!.name = '';
    await command(context, { type: 'pause' });
    expect(context.room.playbackDurationProbe).toBeNull();
    vi.setSystemTime(at + 5_000);
    await command(context, { type: 'play' });
    // The new probe starts its own lookup instead of inheriting the backoff.
    expect(metadata.youtube).toHaveBeenCalledTimes(3);
    expect(Object.values(context.room.playbackDurations)).toEqual([
      expect.objectContaining({ durationSeconds: 5, source: 'server' }),
    ]);
    expect(context.room.playbackDurationProbe).toBeNull();
  });
});
