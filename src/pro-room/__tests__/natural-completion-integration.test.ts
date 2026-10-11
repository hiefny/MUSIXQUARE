import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MusixquareProRoom } from '../../../cloudflare/pro-room-worker.ts';

const metadata = vi.hoisted(() => ({ file: vi.fn(), youtube: vi.fn() }));
vi.mock('../../../cloudflare/pro-room-media-duration.ts', () => ({
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
