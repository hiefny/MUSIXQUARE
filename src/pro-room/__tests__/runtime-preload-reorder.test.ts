/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as audioContext from '../../audio/context.ts';
import * as audioEngine from '../../audio/engine.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, setState } from '../../core/state.ts';
import { clearManagedTimer } from '../../core/timers.ts';
import { getCurrentAudioBuffer, getPlayerNode } from '../../player/_state.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import { initPlaylist } from '../../player/playlist.ts';
import { schedulePreload } from '../../storage/preload.ts';
import type { QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  capabilitiesForProRoomRole,
  type ProRoomR2Source,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ProRoomAssetCache } from '../media-cache.ts';
import { preloadProRoomPlaylistFile, resolveProRoomPlaylistFile } from '../media-hooks.ts';
import { ProRoomMediaTransfer } from '../media-transfer.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { joinProRoom } from '../runtime.ts';
import {
  cancelProPlaybackPreparation,
  createProPlaybackAuthorityToken,
  prepareProPlaybackAuthority,
} from '../playback-authority-hooks.ts';

const downloadMedia = ProRoomMediaTransfer.prototype.download;

const CURRENT_YOUTUBE_ID = '30000000-0000-4000-8000-000000000003' as QueueItemId;
const FOREGROUND_QUEUE_ITEM_ID = '30000000-0000-4000-8000-000000000004' as QueueItemId;
const FOREGROUND_SOURCE: ProRoomR2Source = {
  kind: 'pro-r2',
  assetId: 'asset_00000000004',
  version: 1,
  byteLength: 1,
  mime: 'audio/flac',
};
const FOREGROUND_FILE = new File(['c'], 'current.flac', { type: 'audio/flac' });
const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_00001';
const CACHE_QUEUE_ITEM_ID = '30000000-0000-4000-8000-000000000001' as QueueItemId;
const PROMOTE_QUEUE_ITEM_ID = '30000000-0000-4000-8000-000000000002' as QueueItemId;

const CACHE_SOURCE: ProRoomR2Source = {
  kind: 'pro-r2',
  assetId: 'asset_00000000001',
  version: 1,
  byteLength: 4,
  mime: 'audio/flac',
};
const PROMOTE_SOURCE: ProRoomR2Source = {
  kind: 'pro-r2',
  assetId: 'asset_00000000002',
  version: 1,
  byteLength: 4,
  mime: 'audio/flac',
};

const CACHE_FILE = new File(['warm'], 'cached-before-selection.flac', {
  type: 'audio/flac',
});
const PROMOTED_FILE = new File(['play'], 'promoted-in-flight.flac', {
  type: 'audio/flac',
});

function roomSnapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      {
        queueItemId: CURRENT_YOUTUBE_ID,
        name: 'Current YouTube',
        source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
      },
      {
        queueItemId: FOREGROUND_QUEUE_ITEM_ID,
        name: FOREGROUND_FILE.name,
        source: FOREGROUND_SOURCE,
      },
      {
        queueItemId: CACHE_QUEUE_ITEM_ID,
        name: CACHE_FILE.name,
        source: CACHE_SOURCE,
      },
      {
        queueItemId: PROMOTE_QUEUE_ITEM_ID,
        name: PROMOTED_FILE.name,
        source: PROMOTE_SOURCE,
      },
    ],
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
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: 'member_0000000001',
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Owner',
          devicePlatform: 'other',
          role: 'owner',
          capabilities: [...capabilitiesForProRoomRole('owner')],
          joinedAtMs: 1,
        },
      ],
    },
    quota: {
      limitBytes: PRO_ROOM_QUOTA_BYTES,
      perAssetLimitBytes: PRO_ROOM_MAX_ASSET_BYTES,
      usedBytes: CACHE_SOURCE.byteLength + PROMOTE_SOURCE.byteLength,
      reservedBytes: 0,
    },
    viewer: {
      memberId: 'member_0000000001',
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: 'presence_0000000001',
      displayName: 'Owner',
      role: 'owner',
      capabilities: [...capabilitiesForProRoomRole('owner')],
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: 'member_0000000001',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
    ],
  };
}

function signalingAccess(): ProRoomSignalingAccess {
  return {
    ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: Date.now() + 60_000,
    role: 'member',
    coordinatorEpoch: 1,
    presenceIncarnationId: 'presence_0000000001',
    ticketSequence: 1,
    pendingPlaybackTransition: null,
  };
}

interface PendingDownload {
  input: Parameters<ProRoomMediaTransfer['download']>[0];
  complete(): void;
}

describe('PRO preload target changes', { concurrent: false }, () => {
  let cache: ProRoomAssetCache;
  let downloads: PendingDownload[];
  const restoreSpies: Array<{ mockRestore(): void }> = [];

  beforeEach(async () => {
    // Real cache accounting, scaled to real tiny Files: either next asset
    // fits alongside current C, but speculative A and B cannot coexist.
    cache = new ProRoomAssetCache(6);
    downloads = [];
    restoreSpies.push(
      vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockResolvedValue(roomSnapshot()),
      vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockResolvedValue(roomSnapshot()),
      vi
        .spyOn(ProRoomApiClient.prototype, 'createSignalingTicket')
        .mockResolvedValue(signalingAccess()),
      vi.spyOn(ProRoomApiClient.prototype, 'getSettingsSync').mockResolvedValue({
        schemaVersion: 1,
        view: 'settings-sync',
        roomCode: ROOM_CODE,
        revision: 0,
        updatedAtMs: 1,
        masterVolume: 1,
        effects: createDefaultRoomEffectsState(),
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
        schemaVersion: 1,
        view: 'queue-mode',
        roomCode: ROOM_CODE,
        revision: 0,
        playlistRevision: 1,
        updatedAtMs: 1,
        repeatMode: 0,
        shuffleEnabled: false,
        shuffleOrder: [],
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
        generation: 0,
        status: 'idle',
        ownerParticipantId: null,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication: null,
      }),
      vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined),
      vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined),
      vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined),
      vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {}),
      vi.spyOn(ProRoomMediaTransfer.prototype, 'cache', 'get').mockImplementation(() => cache),
      vi.spyOn(ProRoomMediaTransfer.prototype, 'download').mockImplementation(
        (input) =>
          new Promise<File>((resolve, reject) => {
            const abort = () => reject(new Error('PRO_ROOM_MEDIA_ABORTED'));
            if (input.signal?.aborted) {
              abort();
              return;
            }
            input.signal?.addEventListener('abort', abort, { once: true });
            downloads.push({
              input,
              complete() {
                input.signal?.removeEventListener('abort', abort);
                if (input.signal?.aborted) return;
                const file =
                  input.source.assetId === CACHE_SOURCE.assetId
                    ? CACHE_FILE
                    : input.source.assetId === PROMOTE_SOURCE.assetId
                      ? PROMOTED_FILE
                      : FOREGROUND_FILE;
                // Hold the response before the real transfer's body admission.
                // This is the window in which returning to A can still hit cache.
                cache.prepareForIncoming(input.source.byteLength, input.retainedEncodedBytes ?? 0);
                cache.put(input.source, file);
                input.onProgress?.(1);
                resolve(file);
              },
            });
          }),
      ),
    );
    await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
    setState('playlist.currentQueueItemId', CURRENT_YOUTUBE_ID);
    setPlaybackYouTubePlaying();
    clearManagedTimer('preloadScheduleTimer');
  });

  afterEach(async () => {
    clearManagedTimer('preloadScheduleTimer');
    setState('files.current', null);
    if (getState('room.context').kind === 'pro') {
      const closeSession = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced);
      const previousCloseCalls = closeSession.mock.calls.length;
      requestProRoomLeave();
      await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
      await vi.waitFor(() =>
        expect(closeSession.mock.calls.length).toBeGreaterThan(previousCloseCalls),
      );
    }
    for (const spy of restoreSpies.splice(0).reverse()) spy.mockRestore();
  });

  function reorderNext(queueItemId: QueueItemId, rowFile = false): void {
    const items = getState('playlist.items');
    const current = items.find((item) => item.queueItemId === CURRENT_YOUTUBE_ID)!;
    const selected = items.find((item) => item.queueItemId === queueItemId)!;
    const next = rowFile ? { ...selected, file: CACHE_FILE } : selected;
    setState('playlist.items', [
      current,
      next,
      ...items.filter(
        (item) => item.queueItemId !== CURRENT_YOUTUBE_ID && item.queueItemId !== queueItemId,
      ),
    ]);
    // Accepted queue projections call this same scheduler; canonical asset
    // identity is unchanged by moving rows.
    schedulePreload(0);
  }

  async function requestFor(source: ProRoomR2Source): Promise<PendingDownload> {
    await vi.waitFor(() =>
      expect(downloads.some((request) => request.input.source.assetId === source.assetId)).toBe(
        true,
      ),
    );
    return downloads.find((request) => request.input.source.assetId === source.assetId)!;
  }

  async function expectSettledTarget(queueItemId: QueueItemId): Promise<void> {
    await vi.waitFor(() => {
      expect(getState('preload.activeTarget')?.queueItemId).toBe(queueItemId);
      expect(getState('preload.isPreloading')).toBe(false);
    });
  }

  async function warmA(): Promise<void> {
    reorderNext(CACHE_QUEUE_ITEM_ID);
    (await requestFor(CACHE_SOURCE)).complete();
    await expectSettledTarget(CACHE_QUEUE_ITEM_ID);
    expect(cache.get(CACHE_SOURCE)).toBe(CACHE_FILE);
  }

  it.each(['cache', 'row File'])('cancels obsolete B before returning A from %s', async (hit) => {
    await warmA();
    reorderNext(PROMOTE_QUEUE_ITEM_ID);
    const b = await requestFor(PROMOTE_SOURCE);
    reorderNext(CACHE_QUEUE_ITEM_ID, hit === 'row File');
    await expectSettledTarget(CACHE_QUEUE_ITEM_ID);

    expect(b.input.signal?.aborted).toBe(true);
    b.complete();
    await Promise.resolve();
    expect(cache.get(CACHE_SOURCE)).toBe(CACHE_FILE);
    expect(cache.get(PROMOTE_SOURCE)).toBeNull();
    await expect(resolveProRoomPlaylistFile(CACHE_QUEUE_ITEM_ID)).resolves.toBe(CACHE_FILE);
    expect(downloads).toHaveLength(2);
  });

  it.each(['cache', 'row File'])(
    'drops deferred B when the next target returns to A from %s',
    async (hit) => {
      await warmA();
      const foreground = resolveProRoomPlaylistFile(FOREGROUND_QUEUE_ITEM_ID);
      const current = await requestFor(FOREGROUND_SOURCE);
      reorderNext(PROMOTE_QUEUE_ITEM_ID);
      await vi.waitFor(() =>
        expect(getState('preload.activeTarget')?.queueItemId).toBe(PROMOTE_QUEUE_ITEM_ID),
      );
      const deferredB = preloadProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);
      expect(downloads).toHaveLength(2);

      reorderNext(CACHE_QUEUE_ITEM_ID, hit === 'row File');
      await expectSettledTarget(CACHE_QUEUE_ITEM_ID);
      expect(current.input.signal?.aborted).toBe(false);
      current.complete();
      await expect(foreground).resolves.toBe(FOREGROUND_FILE);
      // Give a stale deferred continuation the opportunity to claim the lane.
      // Settling it also keeps the negative control from hanging until timeout.
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      downloads
        .find((request) => request.input.source.assetId === PROMOTE_SOURCE.assetId)
        ?.complete();
      await expect(deferredB).resolves.toBeNull();
      expect(downloads).toHaveLength(2);
      expect(cache.get(CACHE_SOURCE)).toBe(CACHE_FILE);
    },
  );

  it('retains the same speculative download across repeated requests', async () => {
    const first = preloadProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);
    const b = await requestFor(PROMOTE_SOURCE);
    const second = preloadProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);
    expect(second).toBe(first);
    expect(b.input.signal?.aborted).toBe(false);
    b.complete();
    await expect(first).resolves.toBe(PROMOTED_FILE);
    expect(downloads).toHaveLength(1);
  });

  it('retains the same deferred target until the foreground lane is released', async () => {
    const foreground = resolveProRoomPlaylistFile(FOREGROUND_QUEUE_ITEM_ID);
    const current = await requestFor(FOREGROUND_SOURCE);
    const first = preloadProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);
    const second = preloadProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);
    expect(second).toBe(first);
    expect(current.input.signal?.aborted).toBe(false);
    expect(downloads).toHaveLength(1);

    current.complete();
    await expect(foreground).resolves.toBe(FOREGROUND_FILE);
    const b = await requestFor(PROMOTE_SOURCE);
    expect(b.input.signal?.aborted).toBe(false);
    b.complete();
    await expect(first).resolves.toBe(PROMOTED_FILE);
    expect(downloads).toHaveLength(2);
  });

  it('preserves B after foreground promotion when the next target returns to cached A', async () => {
    await warmA();
    reorderNext(PROMOTE_QUEUE_ITEM_ID);
    const b = await requestFor(PROMOTE_SOURCE);
    const foreground = resolveProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);
    reorderNext(CACHE_QUEUE_ITEM_ID);
    await expectSettledTarget(CACHE_QUEUE_ITEM_ID);
    expect(b.input.signal?.aborted).toBe(false);
    b.complete();
    await expect(foreground).resolves.toBe(PROMOTED_FILE);
    expect(downloads).toHaveLength(2);
  });

  async function startPartialPreload() {
    const signals: AbortSignal[] = [];
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    const cancelBody = vi.fn();
    const fetchMedia = vi.fn<typeof fetch>(async (_url, init) => {
      signals.push(init!.signal as AbortSignal);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodies.push(controller);
            controller.enqueue(new Uint8Array([1, 2]));
          },
          cancel: cancelBody,
        }),
        { status: 200, headers: { 'content-length': '4' } },
      );
    });
    const getMediaDownload = vi.fn().mockImplementation(async (_code, assetId) => ({
      asset: assetId === PROMOTE_SOURCE.assetId ? PROMOTE_SOURCE : CACHE_SOURCE,
      url: 'http://worker.localhost:8789/local-download',
      expiresAtMs: Date.now() + 60_000,
    }));
    const transfer = new ProRoomMediaTransfer({
      cache,
      fetch: fetchMedia,
      api: {
        endpoint: 'http://worker.localhost:8789/api/pro-room',
        getMediaDownload,
        createMediaReservation: vi.fn(),
        completeMedia: vi.fn(),
        deleteMedia: vi.fn(),
      },
    });
    vi.mocked(ProRoomMediaTransfer.prototype.download).mockImplementation((input) =>
      downloadMedia.call(transfer, input),
    );
    reorderNext(PROMOTE_QUEUE_ITEM_ID);
    await vi.waitFor(() => expect(fetchMedia).toHaveBeenCalledOnce());
    expect(getState('preload.activeTarget')?.queueItemId).toBe(PROMOTE_QUEUE_ITEM_ID);
    expect(getState('playlist.currentQueueItemId')).toBe(CURRENT_YOUTUBE_ID);
    initPlaylist();
    return { signals, bodies, cancelBody, fetchMedia, getMediaDownload };
  }

  function prepareFile(queueItemId: QueueItemId, transitionId: string) {
    const authority = createProPlaybackAuthorityToken({
      roomId: ROOM_CODE,
      roomEpoch: 1,
      basePlaybackRevision: 0,
      transitionId,
    });
    const preparation = prepareProPlaybackAuthority({
      authority,
      queueItemId,
      positionSeconds: 0,
      youtubeSubIndex: null,
      youtubeVideoId: null,
    });
    return { authority, preparation };
  }

  it('adopts the partial preload body when the server prepares that queue item', async () => {
    const { signals, bodies, cancelBody, fetchMedia, getMediaDownload } =
      await startPartialPreload();
    const buffer = { duration: 120 } as AudioBuffer;
    const decode = vi.fn().mockResolvedValue(buffer);
    const createBufferSource = vi.fn();
    restoreSpies.push(
      vi.spyOn(audioEngine, 'initAudio').mockResolvedValue(undefined),
      vi.spyOn(audioContext, 'getAudioContext').mockReturnValue({
        state: 'running',
        sampleRate: 48_000,
        decodeAudioData: decode,
        createBufferSource,
      } as unknown as AudioContext),
    );
    const { authority, preparation } = prepareFile(
      PROMOTE_QUEUE_ITEM_ID,
      'server-preload-promotion',
    );
    try {
      await vi.waitFor(() =>
        expect(getState('playlist.currentQueueItemId')).toBe(PROMOTE_QUEUE_ITEM_ID),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect.soft(signals[0]?.aborted).toBe(false);
      expect.soft(cancelBody).not.toHaveBeenCalled();
      expect(fetchMedia).toHaveBeenCalledOnce();
      expect(getMediaDownload).toHaveBeenCalledOnce();
      bodies[0]!.enqueue(new Uint8Array([3, 4]));
      bodies[0]!.close();
      await expect(preparation).resolves.toMatchObject({
        status: 'ready',
        queueItemId: PROMOTE_QUEUE_ITEM_ID,
        mediaKind: 'file',
      });
      expect(decode).toHaveBeenCalledOnce();
      expect(new Uint8Array(decode.mock.calls[0]![0] as ArrayBuffer)).toEqual(
        new Uint8Array([1, 2, 3, 4]),
      );
      expect(getCurrentAudioBuffer()).toBe(buffer);
      expect(getState('files.current')?.queueItemId).toBe(PROMOTE_QUEUE_ITEM_ID);
      expect(getState('playback.activity')).toBe('paused');
      expect(getPlayerNode()).toBeNull();
      expect(createBufferSource).not.toHaveBeenCalled();
      expect(fetchMedia).toHaveBeenCalledOnce();
    } finally {
      cancelProPlaybackPreparation(authority);
      await preparation;
    }
  });

  it('cancels the adopted partial body when a newer server PREPARE owns another row', async () => {
    const { signals, cancelBody, fetchMedia } = await startPartialPreload();
    const old = prepareFile(PROMOTE_QUEUE_ITEM_ID, 'server-preload-old');
    await vi.waitFor(() =>
      expect(getState('playlist.currentQueueItemId')).toBe(PROMOTE_QUEUE_ITEM_ID),
    );
    expect(signals[0]?.aborted).toBe(false);

    const next = prepareFile(CACHE_QUEUE_ITEM_ID, 'server-preload-new');
    try {
      await vi.waitFor(() => expect(fetchMedia).toHaveBeenCalledTimes(2));
      await expect(old.preparation).resolves.toMatchObject({ status: 'superseded' });
      expect(signals[0]?.aborted).toBe(true);
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(signals[1]?.aborted).toBe(false);
      expect(getState('playlist.currentQueueItemId')).toBe(CACHE_QUEUE_ITEM_ID);
      expect(getCurrentAudioBuffer()).toBeNull();
      expect(getState('files.current')).toBeNull();
      expect(cache.get(PROMOTE_SOURCE)).toBeNull();
    } finally {
      cancelProPlaybackPreparation(next.authority);
      await next.preparation;
    }
  });

  it('cancels the adopted partial body when the participant leaves the room', async () => {
    const { signals, cancelBody, fetchMedia } = await startPartialPreload();
    const { preparation } = prepareFile(PROMOTE_QUEUE_ITEM_ID, 'server-preload-leave');
    await vi.waitFor(() =>
      expect(getState('playlist.currentQueueItemId')).toBe(PROMOTE_QUEUE_ITEM_ID),
    );
    expect(signals[0]?.aborted).toBe(false);
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await expect(preparation).resolves.toMatchObject({ status: 'superseded' });
    expect(signals[0]?.aborted).toBe(true);
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(fetchMedia).toHaveBeenCalledOnce();
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getState('files.current')).toBeNull();
    expect(getState('playlist.items').every((item) => !item.file)).toBe(true);
    expect(cache.get(PROMOTE_SOURCE)).toBeNull();
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
  });

  it.each(['preload', 'foreground'] as const)(
    'retires an old %s completion after rejoining the same room with the same queue item',
    async (mode) => {
      let resolveOld!: (file: File) => void;
      let oldSignal: AbortSignal | undefined;
      vi.mocked(ProRoomMediaTransfer.prototype.download).mockImplementationOnce((input) => {
        oldSignal = input.signal;
        // Model a body completion already queued when abort reaches the adapter.
        return new Promise<File>((resolve) => (resolveOld = resolve));
      });
      const oldDownload =
        mode === 'preload'
          ? preloadProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID)
          : resolveProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);
      await vi.waitFor(() => expect(oldSignal).toBeDefined());

      requestProRoomLeave();
      await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
      expect(oldSignal?.aborted).toBe(true);
      await joinProRoom({ code: ROOM_CODE, pin: '12345678' });
      clearManagedTimer('preloadScheduleTimer');
      const successor = resolveProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID);
      const current = await requestFor(PROMOTE_SOURCE);

      resolveOld(new File(['old'], 'retired-room.flac', { type: 'audio/flac' }));
      await expect(oldDownload).resolves.toBeNull();
      expect(
        getState('playlist.items').find((item) => item.queueItemId === PROMOTE_QUEUE_ITEM_ID)?.file,
      ).toBeUndefined();
      expect(current.input.signal?.aborted).toBe(false);
      expect(resolveProRoomPlaylistFile(PROMOTE_QUEUE_ITEM_ID)).toBe(successor);

      current.complete();
      await expect(successor).resolves.toBe(PROMOTED_FILE);
      expect(
        getState('playlist.items').find((item) => item.queueItemId === PROMOTE_QUEUE_ITEM_ID)?.file,
      ).toBe(PROMOTED_FILE);
    },
  );
});
