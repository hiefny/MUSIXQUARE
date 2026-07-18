import { describe, expect, it, vi } from 'vitest';
import {
  ProRoomApiError,
  type UpdateProRoomCompactSnapshotInput,
  type UpdateProRoomSnapshotInput,
} from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_MAX_PLAYLIST_ITEMS,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPlaylistWireItem,
  type ProRoomR2Source,
  type ProRoomSnapshot,
} from '../contracts.ts';
import {
  ProRoomPlaylistStateManager,
  type ProRoomPlaylistMediaTransferForTests as ProRoomPlaylistMediaTransfer,
  type ProRoomPlaylistStateApiForTests as ProRoomPlaylistStateApi,
} from '../playlist-state-manager.ts';

const ROOM_CODE = '000000';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

function youtube(
  queueItemId: string,
  videoId = 'dQw4w9WgXcQ',
  name = `video-${queueItemId}`,
): ProRoomPlaylistWireItem {
  return { queueItemId, name, source: { kind: 'youtube', videoId } };
}

function r2(
  queueItemId: string,
  assetId: string,
  name = `${assetId}.flac`,
): ProRoomPlaylistWireItem {
  return {
    queueItemId,
    name,
    source: {
      kind: 'pro-r2',
      assetId,
      version: 1,
      byteLength: 4,
      mime: 'audio/flac',
    },
  };
}

function activeSnapshot(overrides: Partial<ProRoomSnapshot> = {}): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 0,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 1,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1,
    },
    presence: {
      coordinatorEpoch: 1,
      revision: 1,
      coordinatorParticipantId: 'participant_00001',
      participants: [
        {
          participantId: 'participant_00001',
          displayName: 'Developer',
          role: 'owner',
          joinedAtMs: 1,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: 0,
      reservedBytes: 0,
    },
    viewer: {
      memberId: 'member_0000000001',
      participantId: 'participant_00001',
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Developer',
      role: 'owner',
      capabilities: [
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'coordinator.eligible',
        'members.manage',
        'room.configure',
      ],
      coordinatorEligible: true,
    },
    ...overrides,
  };
}

function asset(assetId: string): ProRoomR2Source {
  return {
    kind: 'pro-r2',
    assetId,
    version: 1,
    byteLength: 4,
    mime: 'audio/flac',
  };
}

function mediaTransfer(
  overrides: Partial<ProRoomPlaylistMediaTransfer> = {},
): ProRoomPlaylistMediaTransfer {
  return {
    upload: vi.fn(async () => ({
      asset: asset('asset_00000000001'),
      quota: {
        limitBytes: PRO_ROOM_QUOTA_BYTES,
        perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
        usedBytes: 4,
        reservedBytes: 0,
      },
    })),
    deleteAsset: vi.fn(async () => undefined),
    ...overrides,
  };
}

function updatingApi(initial: ProRoomSnapshot, events?: string[]) {
  let server = initial;
  const api = {
    getSnapshot: vi.fn(async () => server),
    updateSnapshot: vi.fn(async (input: UpdateProRoomSnapshotInput) => {
      events?.push(`update:${input.playlist.at(-1)?.name ?? 'empty'}`);
      const playlistChanged = JSON.stringify(server.playlist) !== JSON.stringify(input.playlist);
      server = activeSnapshot({
        ...server,
        revision: server.revision + 1,
        playlistRevision: server.playlistRevision + (playlistChanged ? 1 : 0),
        playlist: input.playlist,
        currentQueueItemId: input.currentQueueItemId,
        playback: input.playback,
      });
      return server;
    }),
  } satisfies ProRoomPlaylistStateApi;
  return { api, current: () => server };
}

function factories(queueItemIds: string[] = [A, B, C, D]) {
  let key = 0;
  let queue = 0;
  return {
    createIdempotencyKey: vi.fn(() => `idempotency-${++key}`),
    createQueueItemId: vi.fn(() => queueItemIds[queue++]!),
  };
}

describe('PRO room playlist state manager', () => {
  it('uses compact mutations and upserts only changed playlist rows', async () => {
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [youtube(A), youtube(B, 'bbbbbbbbbbb')],
    });
    const updateSnapshot = vi.fn();
    const updateCompactSnapshot = vi.fn(
      async (input: UpdateProRoomCompactSnapshotInput): Promise<ProRoomSnapshot> => {
        const existing = new Map(initial.playlist.map((item) => [item.queueItemId, item]));
        for (const item of input.upserts) existing.set(item.queueItemId, item);
        return activeSnapshot({
          ...initial,
          revision: initial.revision + 1,
          playlistRevision: initial.playlistRevision + 1,
          playlist: (input.playlistOrder ?? initial.playlist.map((item) => item.queueItemId)).map(
            (queueItemId) => existing.get(queueItemId)!,
          ),
          currentQueueItemId: input.currentQueueItemId,
          playback: input.playback,
        });
      },
    );
    const api = {
      getSnapshot: vi.fn(async () => initial),
      updateSnapshot,
      updateCompactSnapshot,
    } satisfies ProRoomPlaylistStateApi;
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    await manager.updateMetadata(B, { title: 'Changed title' });

    expect(updateSnapshot).not.toHaveBeenCalled();
    expect(updateCompactSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        playlistOrder: null,
        upserts: [expect.objectContaining({ queueItemId: B, title: 'Changed title' })],
      }),
      undefined,
    );
  });

  it('falls back once when a cached client reaches a pre-compact Worker', async () => {
    const initial = activeSnapshot({ playlistRevision: 1, playlist: [youtube(A)] });
    const updateCompactSnapshot = vi.fn(async () => {
      throw new ProRoomApiError('NOT_FOUND', 404);
    });
    const updateSnapshot = vi.fn(async (input: UpdateProRoomSnapshotInput) =>
      activeSnapshot({
        ...initial,
        revision: initial.revision + 1,
        playlistRevision: initial.playlistRevision + 1,
        playlist: input.playlist,
        currentQueueItemId: input.currentQueueItemId,
        playback: input.playback,
      }),
    );
    const api = {
      getSnapshot: vi.fn(async () => initial),
      updateSnapshot,
      updateCompactSnapshot,
    } satisfies ProRoomPlaylistStateApi;
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    await manager.updateMetadata(A, { title: 'Legacy bridge' });

    expect(updateCompactSnapshot).toHaveBeenCalledOnce();
    expect(updateSnapshot).toHaveBeenCalledOnce();
    expect(updateSnapshot.mock.calls[0]![0].playlist[0]).toMatchObject({
      queueItemId: A,
      title: 'Legacy bridge',
    });
  });

  it('projects every accepted authoritative snapshot through the injected sink', async () => {
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [youtube(A), r2(B, 'asset_00000000001')],
    });
    const { api } = updatingApi(initial);
    const sink = vi.fn();
    const invalidateCoordinator = vi.fn();
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink,
      invalidateCoordinator,
      ...factories(),
    });

    await manager.acceptSnapshot(initial);

    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]![0].playlist).toEqual([
      expect.objectContaining({ queueItemId: A, type: 'youtube', videoId: 'dQw4w9WgXcQ' }),
      expect.objectContaining({ queueItemId: B, type: 'file', videoId: null }),
    ]);
    expect(sink.mock.calls[0]![0].playlist[1]).not.toHaveProperty('file');
    expect(invalidateCoordinator).not.toHaveBeenCalled();
  });

  it('retries the same authoritative snapshot when its projection sink fails once', async () => {
    const initial = activeSnapshot({ playlistRevision: 1, playlist: [youtube(A)] });
    const { api } = updatingApi(initial);
    const sinkFailure = new Error('projection-temporarily-unavailable');
    const sink = vi.fn().mockRejectedValueOnce(sinkFailure).mockResolvedValueOnce(undefined);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink,
      ...factories(),
    });

    await expect(manager.acceptSnapshot(initial)).rejects.toBe(sinkFailure);
    expect(manager.snapshot).toBeNull();

    await expect(manager.acceptSnapshot(initial)).resolves.toEqual(initial);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(manager.snapshot).toEqual(initial);
  });

  it('atomically selects a first YouTube item without claiming that playback already started', async () => {
    const initial = activeSnapshot();
    const { api } = updatingApi(initial);
    const invalidateCoordinator = vi.fn();
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      invalidateCoordinator,
      now: () => 1_000,
      ...factories([A]),
    });
    await manager.acceptSnapshot(initial);

    const accepted = await manager.addYouTube({ name: 'First video', videoId: 'dQw4w9WgXcQ' });

    expect(accepted.currentQueueItemId).toBe(A);
    expect(accepted.playback).toEqual({
      coordinatorEpoch: 1,
      revision: 1,
      state: 'paused',
      queueItemId: A,
      positionSeconds: 0,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      updatedAtMs: 1_000,
    });
    expect(invalidateCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        previous: initial,
        next: accepted,
        playlistChanged: true,
        playbackChanged: true,
      }),
    );
  });

  it('atomically selects the first uploaded file and leaves later appends on that selection', async () => {
    const initial = activeSnapshot();
    const { api } = updatingApi(initial);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      now: () => 2_000,
      ...factories([A, B]),
    });
    await manager.acceptSnapshot(initial);

    const accepted = await manager.addLocalFiles([
      { file: new File(['one'], 'one.flac', { type: 'audio/flac' }) },
      { file: new File(['two'], 'two.flac', { type: 'audio/flac' }) },
    ]);

    expect(accepted.playlist.map((item) => item.queueItemId)).toEqual([A, B]);
    expect(accepted.currentQueueItemId).toBe(A);
    expect(accepted.playback).toMatchObject({
      revision: 1,
      state: 'paused',
      queueItemId: A,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
    });
  });

  it('does not steal the first selection when a concurrent append wins the CAS race', async () => {
    const initial = activeSnapshot();
    const remote = activeSnapshot({
      revision: 2,
      playlistRevision: 1,
      playlist: [youtube(A)],
      currentQueueItemId: A,
      playback: {
        coordinatorEpoch: 1,
        revision: 1,
        state: 'paused',
        queueItemId: A,
        positionSeconds: 0,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
        updatedAtMs: 10,
      },
    });
    let calls = 0;
    const api = {
      getSnapshot: vi.fn(async () => remote),
      updateSnapshot: vi.fn(async (input: UpdateProRoomSnapshotInput) => {
        calls += 1;
        if (calls === 1) throw new ProRoomApiError('REVISION_CONFLICT', 409);
        return activeSnapshot({
          ...remote,
          revision: 3,
          playlistRevision: 2,
          playlist: input.playlist,
          currentQueueItemId: input.currentQueueItemId,
          playback: input.playback,
        });
      }),
    } satisfies ProRoomPlaylistStateApi;
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories([B]),
    });
    await manager.acceptSnapshot(initial);

    const accepted = await manager.addYouTube({
      name: 'Concurrent second',
      videoId: 'bbbbbbbbbbb',
    });

    expect(accepted.playlist.map((item) => item.queueItemId)).toEqual([A, B]);
    expect(accepted.currentQueueItemId).toBe(A);
    expect(accepted.playback).toEqual(remote.playback);
  });

  it('refreshes and rebases once on a CAS conflict with a fresh key for the changed body', async () => {
    const initial = activeSnapshot({ playlistRevision: 1, playlist: [youtube(A)] });
    const remote = activeSnapshot({
      revision: 2,
      playlistRevision: 2,
      playlist: [youtube(A), youtube(C, 'aaaaaaaaaaa', 'remote')],
    });
    const requests: UpdateProRoomSnapshotInput[] = [];
    const api = {
      getSnapshot: vi.fn(async () => remote),
      updateSnapshot: vi.fn(async (input: UpdateProRoomSnapshotInput) => {
        requests.push(input);
        if (requests.length === 1) throw new ProRoomApiError('REVISION_CONFLICT', 409);
        return activeSnapshot({
          ...remote,
          revision: 3,
          playlistRevision: 3,
          playlist: input.playlist,
          currentQueueItemId: input.currentQueueItemId,
          playback: input.playback,
        });
      }),
    } satisfies ProRoomPlaylistStateApi;
    const sink = vi.fn();
    const invalidateCoordinator = vi.fn();
    const generated = factories([D]);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink,
      invalidateCoordinator,
      ...generated,
    });
    await manager.acceptSnapshot(initial);

    const result = await manager.addYouTube({
      queueItemId: B,
      name: 'local',
      videoId: 'bbbbbbbbbbb',
    });

    expect(api.getSnapshot).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.baseRevision).toBe(1);
    expect(requests[0]!.playlist.map((item) => item.queueItemId)).toEqual([A, B]);
    expect(requests[1]!.baseRevision).toBe(2);
    expect(requests[1]!.playlist.map((item) => item.queueItemId)).toEqual([A, C, B]);
    expect(requests[1]!.idempotencyKey).not.toBe(requests[0]!.idempotencyKey);
    expect(result.playlist.map((item) => item.queueItemId)).toEqual([A, C, B]);
    // Appending alone intentionally does not invent a playback transition;
    // the runtime coordinator selects/starts media separately.
    expect(result.currentQueueItemId).toBeNull();
    expect(result.playback.state).toBe('idle');
    expect(generated.createQueueItemId).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledTimes(3);
    expect(invalidateCoordinator).toHaveBeenCalledTimes(2);
  });

  it('does not loop when the rebased CAS attempt also conflicts', async () => {
    const initial = activeSnapshot();
    const remote = activeSnapshot({ revision: 2 });
    const api = {
      getSnapshot: vi.fn(async () => remote),
      updateSnapshot: vi.fn(async () => {
        throw new ProRoomApiError('REVISION_CONFLICT', 409);
      }),
    } satisfies ProRoomPlaylistStateApi;
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories([A]),
    });
    await manager.acceptSnapshot(initial);

    await expect(
      manager.addYouTube({ name: 'local', videoId: 'bbbbbbbbbbb' }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(api.updateSnapshot).toHaveBeenCalledTimes(2);
    expect(api.getSnapshot).toHaveBeenCalledOnce();
  });

  it('uploads local files sequentially and only persists canonical R2 rows', async () => {
    const events: string[] = [];
    const initial = activeSnapshot();
    const { api } = updatingApi(initial, events);
    const sources = [asset('asset_00000000001'), asset('asset_00000000002')];
    const media = mediaTransfer({
      upload: vi.fn(async (input) => {
        events.push(`upload:${input.file.name}`);
        return {
          asset: sources.shift()!,
          quota: {
            limitBytes: PRO_ROOM_QUOTA_BYTES,
            perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
            usedBytes: 4,
            reservedBytes: 0,
          },
        };
      }),
    });
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: media,
      sink: vi.fn(),
      ...factories([A, B]),
    });
    await manager.acceptSnapshot(initial);

    const result = await manager.addLocalFiles([
      { file: new File(['aaaa'], 'one.flac', { type: 'audio/flac' }) },
      { file: new File(['bbbb'], 'two.flac', { type: 'audio/flac' }) },
    ]);

    expect(events).toEqual([
      'upload:one.flac',
      'update:one.flac',
      'upload:two.flac',
      'update:two.flac',
    ]);
    expect(result.playlist.map((item) => item.source)).toEqual([
      asset('asset_00000000001'),
      asset('asset_00000000002'),
    ]);
    expect(api.updateSnapshot).toHaveBeenCalledTimes(2);
    expect(media.deleteAsset).not.toHaveBeenCalled();
  });

  it('best-effort deletes an uploaded asset if its playlist append fails', async () => {
    const initial = activeSnapshot();
    const originalFailure = new Error('connection-lost-after-request');
    const cleanupFailure = new ProRoomApiError('ASSET_IN_USE', 409);
    const api = {
      getSnapshot: vi.fn(async () => initial),
      updateSnapshot: vi.fn(async () => {
        throw originalFailure;
      }),
    } satisfies ProRoomPlaylistStateApi;
    const media = mediaTransfer({
      deleteAsset: vi.fn(async () => {
        throw cleanupFailure;
      }),
    });
    const reportMediaCleanupError = vi.fn();
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: media,
      sink: vi.fn(),
      reportMediaCleanupError,
      ...factories([A]),
    });
    await manager.acceptSnapshot(initial);

    await expect(manager.addLocalFiles([{ file: new File(['aaaa'], 'one.flac') }])).rejects.toBe(
      originalFailure,
    );
    expect(media.deleteAsset).toHaveBeenCalledWith({
      code: ROOM_CODE,
      assetId: 'asset_00000000001',
    });
    expect(reportMediaCleanupError).toHaveBeenCalledWith({
      reason: 'uploaded-orphan',
      assetId: 'asset_00000000001',
      error: cleanupFailure,
    });
  });

  it('removes multiple rows in one CAS, clears the current checkpoint, and frees unreferenced assets', async () => {
    const assetOne = 'asset_00000000001';
    const assetTwo = 'asset_00000000002';
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [r2(A, assetOne), youtube(B), r2(C, assetTwo)],
      currentQueueItemId: A,
      playback: {
        coordinatorEpoch: 1,
        revision: 9,
        state: 'playing',
        queueItemId: A,
        positionSeconds: 42,
        youtubeVideoId: null,
        youtubeSubIndex: null,
        updatedAtMs: 99,
      },
    });
    const { api } = updatingApi(initial);
    const cleanupFailure = new Error('cleanup-temporarily-unavailable');
    const media = mediaTransfer({
      deleteAsset: vi.fn(async ({ assetId }) => {
        if (assetId === assetTwo) throw cleanupFailure;
      }),
    });
    const reportMediaCleanupError = vi.fn();
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: media,
      sink: vi.fn(),
      reportMediaCleanupError,
      now: () => 1_234,
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    const result = await manager.removeMany([A, C]);

    expect(api.updateSnapshot).toHaveBeenCalledOnce();
    const request = api.updateSnapshot.mock.calls[0]![0];
    expect(request.playlist.map((item) => item.queueItemId)).toEqual([B]);
    expect(request.currentQueueItemId).toBeNull();
    expect(request.playback).toEqual({
      coordinatorEpoch: 1,
      revision: 10,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1_234,
    });
    expect(media.deleteAsset).toHaveBeenCalledTimes(2);
    expect(reportMediaCleanupError).toHaveBeenCalledWith({
      reason: 'removed-unreferenced',
      assetId: assetTwo,
      error: cleanupFailure,
    });
    expect(result.playlist.map((item) => item.queueItemId)).toEqual([B]);
  });

  it('does not delete a shared R2 asset while a surviving row still references it', async () => {
    const sharedAsset = 'asset_00000000001';
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [r2(A, sharedAsset, 'first.flac'), r2(B, sharedAsset, 'second.flac')],
    });
    const { api } = updatingApi(initial);
    const media = mediaTransfer();
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: media,
      sink: vi.fn(),
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    await manager.remove(A);

    expect(media.deleteAsset).not.toHaveBeenCalled();
  });

  it('reorders without altering the authoritative playback checkpoint', async () => {
    const playback = {
      coordinatorEpoch: 1,
      revision: 5,
      state: 'paused' as const,
      queueItemId: A,
      positionSeconds: 12.5,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      updatedAtMs: 90,
    };
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [youtube(A), youtube(B)],
      currentQueueItemId: A,
      playback,
    });
    const { api } = updatingApi(initial);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    await manager.reorder([B, A]);

    const request = api.updateSnapshot.mock.calls[0]![0];
    expect(request.playlist.map((item) => item.queueItemId)).toEqual([B, A]);
    expect(request.currentQueueItemId).toBe(A);
    expect(request.playback).toEqual(playback);
  });

  it('refreshes a member manager that trails the relayed playlist before reordering', async () => {
    const initial = activeSnapshot({
      revision: 1,
      playlistRevision: 1,
      playlist: [youtube(A), youtube(B)],
    });
    const relayed = activeSnapshot({
      revision: 2,
      playlistRevision: 2,
      playlist: [youtube(A), youtube(B), youtube(C)],
    });
    const api = {
      getSnapshot: vi.fn(async () => relayed),
      updateSnapshot: vi.fn(async (input: UpdateProRoomSnapshotInput) =>
        activeSnapshot({
          ...relayed,
          revision: 3,
          playlistRevision: 3,
          playlist: input.playlist,
          currentQueueItemId: input.currentQueueItemId,
          playback: input.playback,
        }),
      ),
    } satisfies ProRoomPlaylistStateApi;
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    const accepted = await manager.reorder([B, A, C], { baseRevision: relayed.revision });

    expect(api.getSnapshot).toHaveBeenCalledOnce();
    expect(api.updateSnapshot).toHaveBeenCalledOnce();
    expect(api.updateSnapshot.mock.calls[0]![0]).toMatchObject({
      baseRevision: relayed.revision,
      playlist: [youtube(B), youtube(A), youtube(C)],
    });
    expect(accepted.playlist.map((item) => item.queueItemId)).toEqual([B, A, C]);
  });

  it('does not refresh when only the manager room clock is ahead of the queue view', async () => {
    const initial = activeSnapshot({
      revision: 3,
      playlistRevision: 1,
      playlist: [youtube(A), youtube(B)],
    });
    const { api } = updatingApi(initial);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    await manager.reorder([B, A], { baseRevision: 2 });

    expect(api.getSnapshot).not.toHaveBeenCalled();
    expect(api.updateSnapshot).toHaveBeenCalledOnce();
    expect(api.updateSnapshot.mock.calls[0]![0].baseRevision).toBe(initial.revision);
  });

  it('rebases a trailing manager reorder over a concurrent appended row', async () => {
    const initial = activeSnapshot({
      revision: 1,
      playlistRevision: 1,
      playlist: [youtube(A), youtube(B)],
    });
    const concurrent = activeSnapshot({
      revision: 3,
      playlistRevision: 3,
      playlist: [youtube(A), youtube(B), youtube(C), youtube(D)],
    });
    const api = {
      getSnapshot: vi.fn(async () => concurrent),
      updateSnapshot: vi.fn(async (input: UpdateProRoomSnapshotInput) =>
        activeSnapshot({
          ...concurrent,
          revision: 4,
          playlistRevision: 4,
          playlist: input.playlist,
          currentQueueItemId: input.currentQueueItemId,
          playback: input.playback,
        }),
      ),
    } satisfies ProRoomPlaylistStateApi;
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    const accepted = await manager.reorder([B, A, C], { baseRevision: 2 });

    expect(api.getSnapshot).toHaveBeenCalledOnce();
    expect(api.updateSnapshot.mock.calls[0]![0].playlist.map((item) => item.queueItemId)).toEqual([
      B,
      A,
      C,
      D,
    ]);
    expect(accepted.playlist.map((item) => item.queueItemId)).toEqual([B, A, C, D]);
  });

  it('updates metadata by queue identity without changing source or playback state', async () => {
    const playback = {
      coordinatorEpoch: 1,
      revision: 5,
      state: 'paused' as const,
      queueItemId: A,
      positionSeconds: 12.5,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      updatedAtMs: 90,
    };
    const original = {
      ...youtube(A),
      title: 'Old title',
      artist: 'Old artist',
      thumbnail: 'https://example.test/old.jpg',
    };
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [original],
      currentQueueItemId: A,
      playback,
    });
    const { api } = updatingApi(initial);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    const result = await manager.updateMetadata(A, {
      name: 'Renamed',
      title: 'New title',
      artist: null,
    });

    expect(result.playlist[0]).toEqual({
      queueItemId: A,
      name: 'Renamed',
      title: 'New title',
      thumbnail: 'https://example.test/old.jpg',
      source: original.source,
    });
    expect(result.currentQueueItemId).toBe(A);
    expect(result.playback).toEqual(playback);
  });

  it('updates the current queue anchor and advances playback once with the current coordinator epoch', async () => {
    const basePresence = activeSnapshot().presence;
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [youtube(A), youtube(B)],
      playback: {
        coordinatorEpoch: 3,
        revision: 4,
        state: 'idle',
        queueItemId: null,
        positionSeconds: 0,
        youtubeVideoId: null,
        youtubeSubIndex: null,
        updatedAtMs: 100,
      },
      presence: { ...basePresence, coordinatorEpoch: 3 },
    });
    const { api } = updatingApi(initial);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      now: () => 500,
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    const result = await manager.updatePlayback({
      state: 'playing',
      queueItemId: B,
      positionSeconds: 12.5,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubeSubIndex: 3,
    });

    expect(api.updateSnapshot).toHaveBeenCalledOnce();
    const request = api.updateSnapshot.mock.calls[0]![0];
    expect(request.playlist).toEqual(initial.playlist);
    expect(request.currentQueueItemId).toBe(B);
    expect(request.playback).toEqual({
      coordinatorEpoch: 3,
      revision: 5,
      state: 'playing',
      queueItemId: B,
      positionSeconds: 12.5,
      youtubeVideoId: 'aaaaaaaaaaa',
      youtubeSubIndex: 3,
      updatedAtMs: 500,
    });
    expect(result.currentQueueItemId).toBe(B);
    expect(result.playback).toEqual(request.playback);
  });

  it('treats a timestamp-only playback update as a no-op', async () => {
    const playback = {
      coordinatorEpoch: 1,
      revision: Number.MAX_SAFE_INTEGER,
      state: 'playing' as const,
      queueItemId: A,
      positionSeconds: 12.5,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      updatedAtMs: 90,
    };
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [youtube(A)],
      currentQueueItemId: A,
      playback,
    });
    const { api } = updatingApi(initial);
    const now = vi.fn(() => 1_000);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      now,
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    const result = await manager.updatePlayback({
      state: 'playing',
      queueItemId: A,
      positionSeconds: 12.5,
      updatedAtMs: 999,
    });

    expect(result.playback).toEqual(playback);
    expect(api.updateSnapshot).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it('clears playback atomically and never moves updatedAt backwards', async () => {
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [youtube(A)],
      currentQueueItemId: A,
      playback: {
        coordinatorEpoch: 1,
        revision: 5,
        state: 'paused',
        queueItemId: A,
        positionSeconds: 8,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
        updatedAtMs: 900,
      },
    });
    const { api } = updatingApi(initial);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      now: () => 5_000,
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    const result = await manager.updatePlayback({
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      updatedAtMs: 100,
    });

    expect(result.currentQueueItemId).toBeNull();
    expect(result.playback).toEqual({
      coordinatorEpoch: 1,
      revision: 6,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 900,
    });
  });

  it('rebases playback revision, timestamp, and default epoch from the refreshed snapshot', async () => {
    const initial = activeSnapshot({
      playlistRevision: 1,
      playlist: [youtube(A), youtube(B)],
      currentQueueItemId: A,
      playback: {
        coordinatorEpoch: 1,
        revision: 9,
        state: 'playing',
        queueItemId: A,
        positionSeconds: 1,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
        updatedAtMs: 100,
      },
    });
    const remote = activeSnapshot({
      revision: 2,
      playlistRevision: 1,
      playlist: [youtube(A), youtube(B)],
      currentQueueItemId: A,
      playback: {
        coordinatorEpoch: 2,
        revision: 0,
        state: 'paused',
        queueItemId: A,
        positionSeconds: 3,
        youtubeVideoId: 'dQw4w9WgXcQ',
        youtubeSubIndex: 0,
        updatedAtMs: 110,
      },
      presence: {
        ...initial.presence,
        coordinatorEpoch: 2,
        revision: 2,
      },
    });
    const requests: UpdateProRoomSnapshotInput[] = [];
    const api = {
      getSnapshot: vi.fn(async () => remote),
      updateSnapshot: vi.fn(async (input: UpdateProRoomSnapshotInput) => {
        requests.push(input);
        if (requests.length === 1) throw new ProRoomApiError('REVISION_CONFLICT', 409);
        return activeSnapshot({
          ...remote,
          revision: 3,
          currentQueueItemId: input.currentQueueItemId,
          playback: input.playback,
        });
      }),
    } satisfies ProRoomPlaylistStateApi;
    const now = vi.fn().mockReturnValueOnce(120).mockReturnValueOnce(130);
    const generated = factories();
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      now,
      ...generated,
    });
    await manager.acceptSnapshot(initial);

    const result = await manager.updatePlayback({
      state: 'playing',
      queueItemId: B,
      positionSeconds: 7,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.playback).toMatchObject({
      coordinatorEpoch: 1,
      revision: 10,
      updatedAtMs: 120,
    });
    expect(requests[1]!.playback).toEqual({
      coordinatorEpoch: 2,
      revision: 1,
      state: 'playing',
      queueItemId: B,
      positionSeconds: 7,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
      updatedAtMs: 130,
    });
    expect(requests[1]!.idempotencyKey).not.toBe(requests[0]!.idempotencyKey);
    expect(result.playback).toEqual(requests[1]!.playback);
  });

  it('rejects inconsistent or unsafe playback checkpoints before mutation', async () => {
    const initial = activeSnapshot({ playlistRevision: 1, playlist: [youtube(A)] });
    const { api } = updatingApi(initial);
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: mediaTransfer(),
      sink: vi.fn(),
      ...factories(),
    });
    await manager.acceptSnapshot(initial);

    await expect(
      manager.updatePlayback({ state: 'idle', queueItemId: A, positionSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_PLAYLIST_PLAYBACK_IDLE_INVALID' });
    await expect(
      manager.updatePlayback({ state: 'idle', queueItemId: null, positionSeconds: 1 }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_PLAYLIST_PLAYBACK_IDLE_INVALID' });
    await expect(
      manager.updatePlayback({ state: 'playing', queueItemId: null, positionSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_PLAYLIST_QUEUE_ITEM_ID_INVALID' });
    await expect(
      manager.updatePlayback({ state: 'paused', queueItemId: B, positionSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_PLAYLIST_QUEUE_ITEM_NOT_FOUND' });
    for (const positionSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        manager.updatePlayback({ state: 'playing', queueItemId: A, positionSeconds }),
      ).rejects.toMatchObject({ code: 'PRO_ROOM_PLAYLIST_PLAYBACK_INVALID' });
    }
    await expect(
      manager.updatePlayback({
        state: 'playing',
        queueItemId: A,
        positionSeconds: 0,
        updatedAtMs: 1.5,
      }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_PLAYLIST_PLAYBACK_INVALID' });
    await expect(
      manager.updatePlayback({
        state: 'playing',
        queueItemId: A,
        positionSeconds: 0,
        coordinatorEpoch: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_PLAYLIST_PLAYBACK_INVALID' });
    await expect(
      manager.updatePlayback({
        state: 'playing',
        queueItemId: A,
        positionSeconds: 0,
        coordinatorEpoch: 2,
      }),
    ).rejects.toMatchObject({
      code: 'PRO_ROOM_PLAYLIST_PLAYBACK_COORDINATOR_EPOCH_MISMATCH',
    });
    expect(api.updateSnapshot).not.toHaveBeenCalled();
  });

  it('enforces the 1000-row limit before upload or snapshot mutation', async () => {
    const fullPlaylist = Array.from({ length: PRO_ROOM_MAX_PLAYLIST_ITEMS }, (_, index) =>
      youtube(`00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`),
    );
    const initial = activeSnapshot({ playlistRevision: 1, playlist: fullPlaylist });
    const { api } = updatingApi(initial);
    const media = mediaTransfer();
    const createIdempotencyKey = vi.fn(() => 'idempotency-unused');
    const manager = new ProRoomPlaylistStateManager({
      code: ROOM_CODE,
      api,
      mediaTransfer: media,
      sink: vi.fn(),
      createIdempotencyKey,
      createQueueItemId: () => A,
    });
    await manager.acceptSnapshot(initial);

    await expect(
      manager.addLocalFiles([{ file: new File(['aaaa'], 'overflow.flac') }]),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_PLAYLIST_LIMIT_REACHED' });
    await expect(
      manager.addYouTube({ name: 'overflow', videoId: 'bbbbbbbbbbb' }),
    ).rejects.toMatchObject({ code: 'PRO_ROOM_PLAYLIST_LIMIT_REACHED' });
    expect(media.upload).not.toHaveBeenCalled();
    expect(api.updateSnapshot).not.toHaveBeenCalled();
    expect(createIdempotencyKey).not.toHaveBeenCalled();
  });
});
