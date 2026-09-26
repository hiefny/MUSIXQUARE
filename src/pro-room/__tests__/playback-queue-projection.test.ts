/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as audioContext from '../../audio/context.ts';
import * as audioEngine from '../../audio/engine.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState } from '../../core/state.ts';
import { clearManagedTimer } from '../../core/timers.ts';
import { initPlaylist } from '../../player/playlist.ts';
import { schedulePreload } from '../../storage/preload.ts';
import type { QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomR2Source,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ProRoomAssetCache } from '../media-cache.ts';
import { handleProRoomTrackRemoval, handleProRoomTrackReorder } from '../media-hooks.ts';
import { ProRoomMediaTransfer } from '../media-transfer.ts';
import * as serverClock from '../network-bridge.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import { acceptProRoomRealtimeFrameForTests, joinProRoom } from '../runtime.ts';

const ROOM = '000001';
const PARTICIPANT = 'participant_00001';
const A = '53000000-0000-4000-8000-000000000001' as QueueItemId;
const B = '53000000-0000-4000-8000-000000000002' as QueueItemId;
const C = '53000000-0000-4000-8000-000000000003' as QueueItemId;
const TRANSITION = `transition_${'b'.repeat(22)}`;
const sources: ProRoomR2Source[] = [1, 2, 3].map((value) => ({
  kind: 'pro-r2',
  assetId: `asset_0000000000${value}`,
  version: 1,
  byteLength: 4,
  mime: 'audio/flac',
}));
const nativeDownload = ProRoomMediaTransfer.prototype.download;

function roomSnapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM,
    status: 'active',
    runtime: 'awake',
    revision: 1,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [A, B, C].map((queueItemId, index) => ({
      queueItemId,
      name: `${index}.flac`,
      source: sources[index]!,
    })),
    currentQueueItemId: A,
    playback: {
      coordinatorEpoch: 1,
      revision: 1,
      state: 'playing',
      queueItemId: A,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 10_000,
    },
    presence: {
      coordinatorEpoch: 1,
      revision: 1,
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT,
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
      usedBytes: 12,
      reservedBytes: 0,
    },
    viewer: {
      memberId: 'member_0000000001',
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT,
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

function deliver(event: Record<string, unknown> & { type: string }): void {
  acceptProRoomRealtimeFrameForTests({
    type: 'pro-server-event',
    version: 1,
    roomCode: ROOM,
    coordinatorEpoch: 1,
    event,
  });
}

describe('PRO queue projection during persistent media preparation', { concurrent: false }, () => {
  let canonical: ProRoomSnapshot;
  let signal: AbortSignal;
  let body: ReadableStreamDefaultController<Uint8Array>;
  let cancelBody: ReturnType<typeof vi.fn<(reason?: unknown) => void>>;
  let fetchMedia: ReturnType<typeof vi.fn<typeof fetch>>;
  let reportReady: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    canonical = roomSnapshot();
    cancelBody = vi.fn<(reason?: unknown) => void>();
    const cache = new ProRoomAssetCache(32);
    cache.put(
      sources[0]!,
      new File([new Uint8Array([1, 2, 3, 4])], '0.flac', { type: 'audio/flac' }),
    );
    fetchMedia = vi.fn<typeof fetch>(async (_url, init) => {
      const originalBRequest = fetchMedia.mock.calls.length === 1;
      if (originalBRequest) signal = init!.signal as AbortSignal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (originalBRequest) body = controller;
            controller.enqueue(new Uint8Array([1, 2]));
          },
          cancel: cancelBody,
        }),
        { status: 200, headers: { 'content-length': '4' } },
      );
    });
    const transfer = new ProRoomMediaTransfer({
      cache,
      fetch: fetchMedia,
      api: {
        endpoint: 'http://worker.localhost:8789/api/pro-room',
        getMediaDownload: vi.fn(async (_code, assetId) => ({
          asset: sources.find((source) => source.assetId === assetId)!,
          url: 'http://worker.localhost:8789/local-download',
          expiresAtMs: Date.now() + 60_000,
        })),
        createMediaReservation: vi.fn(),
        completeMedia: vi.fn(),
        deleteMedia: vi.fn(),
      },
    });
    vi.spyOn(ProRoomMediaTransfer.prototype, 'cache', 'get').mockReturnValue(cache);
    vi.spyOn(ProRoomMediaTransfer.prototype, 'download').mockImplementation((input) =>
      nativeDownload.call(transfer, input),
    );
    vi.spyOn(ProRoomMediaTransfer.prototype, 'deleteAsset').mockResolvedValue({
      assetId: sources[2]!.assetId,
      quota: canonical.quota,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockImplementation(async () => canonical);
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation(async () => canonical);
    vi.spyOn(ProRoomApiClient.prototype, 'updateCompactSnapshot').mockImplementation(
      async (input) => {
        expect(input.currentQueueItemId).toBe(canonical.currentQueueItemId);
        canonical = {
          ...canonical,
          revision: canonical.revision + 1,
          playlistRevision: canonical.playlistRevision + 1,
          playlist: input.playlistOrder!.map((queueItemId) =>
            canonical.playlist.find((item) => item.queueItemId === queueItemId)!,
          ),
        };
        return canonical;
      },
    );
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue({
      ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
      expiresAtMs: Date.now() + 60_000,
      role: 'member',
      coordinatorEpoch: 1,
      presenceIncarnationId: 'presence_0000000001',
      ticketSequence: 1,
      pendingPlaybackTransition: null,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getSettingsSync').mockResolvedValue({
      schemaVersion: 1,
      view: 'settings-sync',
      roomCode: ROOM,
      revision: 0,
      updatedAtMs: 1,
      masterVolume: 1,
      effects: createDefaultRoomEffectsState(),
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockResolvedValue({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM,
      revision: 0,
      playlistRevision: 1,
      updatedAtMs: 1,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
    vi.spyOn(ProRoomApiClient.prototype, 'getSystemAudioState').mockResolvedValue({
      generation: 0,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    });
    vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined);
    vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined);
    reportReady = vi
      .spyOn(ProRoomApiClient.prototype, 'reportPlaybackTransitionReady')
      .mockResolvedValue('waiting');
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
    vi.spyOn(serverClock, 'isProRoomServerClockCalibrated').mockReturnValue(true);
    vi.spyOn(serverClock, 'getProRoomServerNow').mockReturnValue(10_000);
    vi.spyOn(serverClock, 'waitForFreshProRoomServerClockCalibration').mockResolvedValue(true);
    vi.spyOn(audioEngine, 'initAudio').mockResolvedValue(undefined);
    vi.spyOn(audioContext, 'ensureRunning').mockResolvedValue(undefined);
    vi.spyOn(audioContext, 'getCurrentTime').mockReturnValue(10);
    vi.spyOn(audioContext, 'getAudioContext').mockReturnValue({
      state: 'running',
      sampleRate: 48_000,
      currentTime: 10,
      decodeAudioData: vi.fn().mockResolvedValue({ duration: 120 } as AudioBuffer),
      createBufferSource: () => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
        buffer: null,
      }),
    } as unknown as AudioContext);
    initPlaylist();
  });

  async function startPreparingB(idle = false): Promise<void> {
    if (idle) {
      canonical = {
        ...canonical,
        currentQueueItemId: null,
        playback: { ...canonical.playback, state: 'idle', queueItemId: null },
      };
    }
    await joinProRoom({ code: ROOM, pin: '12345678' });
    if (!idle) {
      await vi.waitFor(() => expect(getState('playback.activity')).toBe('playing'));
      expect(getState('files.current')?.queueItemId).toBe(A);
    }
    clearManagedTimer('preloadScheduleTimer');
    if (!idle) {
      schedulePreload(0);
      await vi.waitFor(() => expect(fetchMedia).toHaveBeenCalledOnce());
      expect(getState('preload.activeTarget')?.queueItemId).toBe(B);
    }
    deliver({
      type: 'pro-playback-prepare',
      transitionId: TRANSITION,
      serverTimeMs: 10_000,
      deadlineAtMs: 13_000,
      basePlaybackRevision: 1,
      target: { ...canonical.playback, state: 'playing', revision: 2, queueItemId: B },
    });
    await vi.waitFor(() => expect(getState('playlist.currentQueueItemId')).toBe(B));
    await vi.waitFor(() => expect(fetchMedia).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(false);
    expect(canonical.currentQueueItemId).toBe(idle ? null : A);
  }

  async function finishPreparingB(): Promise<void> {
    expect(reportReady).not.toHaveBeenCalled();
    body.enqueue(new Uint8Array([3, 4]));
    body.close();
    await vi.waitFor(() =>
      expect(reportReady).toHaveBeenCalledWith(
        expect.objectContaining({ transitionId: TRANSITION, status: 'ready' }),
      ),
    );
    expect(fetchMedia).toHaveBeenCalledOnce();
    expect(getState('files.current')?.queueItemId).toBe(B);
    expect(getState('playback.activity')).toBe('paused');
  }

  afterEach(async () => {
    clearManagedTimer('preloadScheduleTimer');
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
    vi.restoreAllMocks();
  });

  it('keeps B preparation alive when an unrelated C deletion still projects canonical A', async () => {
    await startPreparingB();
    expect(handleProRoomTrackRemoval([C])).toBe(true);
    await vi.waitFor(() =>
      expect(getState('playlist.items').some((item) => item.queueItemId === C)).toBe(false),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(canonical.currentQueueItemId).toBe(A);
    expect(canonical.playlist.some((item) => item.queueItemId === B)).toBe(true);
    expect.soft(signal.aborted).toBe(false);
    expect.soft(cancelBody).not.toHaveBeenCalled();
    expect.soft(getState('playlist.currentQueueItemId')).toBe(B);
    await finishPreparingB();

    const decode = vi.mocked(audioContext.getAudioContext()!.decodeAudioData);
    const preparedDecodeCount = decode.mock.calls.length;
    // A real transition commit updates its timestamp to the scheduled instant.
    // Heartbeat recovery must still reuse this exact prepared B occurrence.
    canonical = {
      ...canonical,
      revision: canonical.revision + 1,
      currentQueueItemId: B,
      playback: {
        ...canonical.playback,
        revision: 2,
        queueItemId: B,
        updatedAtMs: 10_100,
      },
    };
    deliver({ type: 'pro-room-invalidated' });
    await vi.waitFor(() => expect(getState('playback.activity')).toBe('playing'));
    expect(getState('files.current')?.queueItemId).toBe(B);
    expect(fetchMedia).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledTimes(preparedDecodeCount);
  });

  it('keeps B preparation alive when a reorder projects an idle canonical selection', async () => {
    await startPreparingB(true);
    expect(handleProRoomTrackReorder(C, A, getState('playlist.revision'))).toBe(true);
    await vi.waitFor(() =>
      expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([C, A, B]),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(canonical.currentQueueItemId).toBeNull();
    expect.soft(signal.aborted).toBe(false);
    expect.soft(cancelBody).not.toHaveBeenCalled();
    expect.soft(getState('playlist.currentQueueItemId')).toBe(B);
    await finishPreparingB();
  });

  it('cancels B preparation when the accepted deletion actually removes B', async () => {
    await startPreparingB();
    expect(handleProRoomTrackRemoval([B])).toBe(true);
    await vi.waitFor(() =>
      expect(getState('playlist.items').some((item) => item.queueItemId === B)).toBe(false),
    );
    deliver({
      type: 'pro-playback-cancel',
      transitionId: TRANSITION,
      serverTimeMs: 10_000,
      reason: 'queue-item-removed',
    });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(fetchMedia).toHaveBeenCalledOnce();
    expect(getState('playlist.currentQueueItemId')).toBe(A);
    expect(getState('files.current')?.queueItemId).not.toBe(B);
  });

  it('ignores an older projection but lets a newer canonical playback checkpoint cancel B', async () => {
    await startPreparingB();
    const olderSnapshot = canonical;
    expect(handleProRoomTrackRemoval([C])).toBe(true);
    await vi.waitFor(() => expect(getState('playlist.items')).toHaveLength(2));
    const acceptedSnapshot = canonical;
    const heartbeat = vi.mocked(ProRoomApiClient.prototype.heartbeat);
    const count = heartbeat.mock.calls.length;
    heartbeat.mockResolvedValueOnce(olderSnapshot);
    deliver({ type: 'pro-room-invalidated' });
    await vi.waitFor(() => expect(heartbeat.mock.calls.length).toBeGreaterThan(count));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([A, B]);
    expect(getState('playlist.currentQueueItemId')).toBe(B);
    expect(signal.aborted).toBe(false);
    expect(reportReady).not.toHaveBeenCalled();

    // A missed direct pause COMMIT is repaired by the next real heartbeat.
    // Its playback revision supersedes B's base even though B still exists.
    canonical = {
      ...acceptedSnapshot,
      revision: acceptedSnapshot.revision + 1,
      playback: { ...acceptedSnapshot.playback, revision: 2, state: 'paused' },
    };
    deliver({ type: 'pro-room-invalidated' });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    await vi.waitFor(() => expect(getState('playlist.currentQueueItemId')).toBe(A));
    await vi.waitFor(() => expect(getState('files.current')?.queueItemId).toBe(A));
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(getState('playback.activity')).toBe('paused');
    expect(reportReady).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });

  it('cancels the old B stream if its canonical asset source changes under the same queue ID', async () => {
    await startPreparingB();
    canonical = {
      ...canonical,
      revision: canonical.revision + 1,
      playlistRevision: canonical.playlistRevision + 1,
      playlist: canonical.playlist.map((item) =>
        item.queueItemId === B ? { ...item, source: { ...sources[1]!, version: 2 } } : item,
      ),
    };
    deliver({ type: 'pro-room-invalidated' });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(getState('playlist.currentQueueItemId')).toBe(A);
    expect(getState('files.current')?.queueItemId).not.toBe(B);
    expect(reportReady).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });
});
