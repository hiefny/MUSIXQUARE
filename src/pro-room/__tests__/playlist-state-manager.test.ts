import { describe, expect, it, vi } from 'vitest';
import { ProRoomApiError, type UpdateProRoomSnapshotInput } from '../api.ts';
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
  type ProRoomPlaylistMediaTransfer,
  type ProRoomPlaylistStateApi,
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

  it('updates metadata by queue identity without changing source or playback state', async () => {
    const playback = {
      coordinatorEpoch: 1,
      revision: 5,
      state: 'paused' as const,
      queueItemId: A,
      positionSeconds: 12.5,
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
