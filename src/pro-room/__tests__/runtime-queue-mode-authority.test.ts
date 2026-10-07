/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearManagedTimer, getManagedTimer } from '../../core/timers.ts';
import { toggleRepeat, toggleShuffle } from '../../player/playlist.ts';
import type { QueueItemId } from '../../types/index.ts';
import { ProRoomApiClient, type ProRoomSignalingAccess } from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { captureProRoomMediaHookSession, handleProRoomYouTubeForSession } from '../media-hooks.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import type { ProRoomQueueModeSnapshot } from '../queue-mode.ts';
import { acceptProRoomRealtimeFrameForTests, joinProRoom } from '../runtime.ts';

const ROOM = '000001';
const ITEM = '56000000-0000-4000-8000-000000000001' as QueueItemId;
const nativeCreateSession = ProRoomApiClient.prototype.createSession;
const nativeGetQueueMode = ProRoomApiClient.prototype.getQueueMode;
const nativeUpdateQueueMode = ProRoomApiClient.prototype.updateQueueMode;

function snapshot(revision = 1, canMutateQueue = true): ProRoomSnapshot {
  const permissions: ProRoomPermissionSet = {
    'media.add': canMutateQueue,
    'playback.control': true,
    'members.kick': false,
    'chat.notice': false,
  };
  const capabilities = [...capabilitiesForProRoomRole('controller', permissions)];
  const member = {
    memberId: 'member_0000000002',
    memberDisplayNumber: 1,
    isAuthenticated: true,
    displayName: 'Controller',
    role: 'controller' as const,
  };
  return {
    schemaVersion: 1,
    roomCode: ROOM,
    status: 'active',
    runtime: 'awake',
    revision,
    playlistRevision: 1,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [
      { queueItemId: ITEM, name: 'Track', source: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } },
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
      revision,
      coordinatorParticipantId: null,
      participants: [
        {
          ...member,
          participantId: 'participant_00002',
          capabilities,
          devicePlatform: 'other',
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
      ...member,
      participantId: 'participant_00002',
      presenceIncarnationId: 'presence_0000000002',
      capabilities,
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
        onlineDeviceCount: 0,
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
      },
      { ...member, permissions, inheritedPermissions: [], onlineDeviceCount: 1 },
    ],
  };
}

describe('PRO queue-mode checkpoint authority across pending HTTP responses', () => {
  let canonical: ProRoomSnapshot;
  let mode: ProRoomQueueModeSnapshot;
  let puts: Array<{ repeatMode: 0 | 1 | 2; baseRevision: number }>;
  let responseBody: ReadableStreamDefaultController<Uint8Array>;
  let deniedResponse: Response | undefined;
  let responseCancelled: boolean;
  let holdFirstResponse: boolean;
  let responseStatus: number;
  let holdQueueModeRead: boolean;
  let readResponse: Response | undefined;
  let readBody: ReadableStreamDefaultController<Uint8Array>;
  let readBodyCancelled: boolean;

  beforeEach(async () => {
    resetState();
    canonical = snapshot();
    mode = {
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: ROOM,
      revision: 0,
      playlistRevision: 1,
      updatedAtMs: 1,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    };
    puts = [];
    deniedResponse = undefined;
    readResponse = undefined;
    responseCancelled = false;
    readBodyCancelled = false;
    holdFirstResponse = true;
    holdQueueModeRead = false;
    responseStatus = 403;
    const controlClient = new ProRoomApiClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/sessions')) {
          return Response.json({
            snapshot: canonical,
            session: { expiresAtMs: Date.now() + 60_000 },
          });
        }
        expect(url.pathname.endsWith('/queue-mode')).toBe(true);
        if (init?.method === 'GET') {
          readResponse = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                readBody = controller;
                controller.enqueue(new TextEncoder().encode(JSON.stringify(mode).slice(0, -1)));
              },
              cancel() {
                readBodyCancelled = true;
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
          return readResponse;
        }
        const body = JSON.parse(String(init?.body));
        puts.push(body);
        if (puts.length === 1 && holdFirstResponse) {
          // The real API parser waits for the unfinished 403 body. Revocation
          // may be observed through the independent heartbeat during this read.
          deniedResponse = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                responseBody = controller;
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      error:
                        responseStatus === 403 ? 'PERMISSION_REQUIRED' : 'TEMPORARILY_UNAVAILABLE',
                    }).slice(0, -1),
                  ),
                );
              },
              cancel() {
                responseCancelled = true;
              },
            }),
            { status: responseStatus, headers: { 'content-type': 'application/json' } },
          );
          return deniedResponse;
        }
        expect(canonical.viewer?.capabilities).toContain('queue.mutate');
        expect(body.baseRevision).toBe(mode.revision);
        expect(body.playlistRevision).toBe(canonical.playlistRevision);
        expect(body.shuffleEnabled ? [...body.shuffleOrder].sort() : body.shuffleOrder).toEqual(
          body.shuffleEnabled ? canonical.playlist.map((item) => item.queueItemId).sort() : [],
        );
        mode = {
          ...mode,
          repeatMode: body.repeatMode,
          shuffleEnabled: body.shuffleEnabled,
          shuffleOrder: body.shuffleOrder,
          revision: mode.revision + 1,
        };
        return Response.json(mode);
      },
    });
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockImplementation((input, signal) =>
      nativeCreateSession.call(controlClient, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'updateQueueMode').mockImplementation((input, signal) =>
      nativeUpdateQueueMode.call(controlClient, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation(async () => canonical);
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockResolvedValue({
      ticket: `v1.${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
      expiresAtMs: Date.now() + 60_000,
      role: 'member',
      coordinatorEpoch: 1,
      presenceIncarnationId: 'presence_0000000002',
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
    vi.spyOn(ProRoomApiClient.prototype, 'getQueueMode').mockImplementation((code, signal) =>
      holdQueueModeRead
        ? nativeGetQueueMode.call(controlClient, code, signal)
        : Promise.resolve(mode),
    );
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
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(ProRoomApiClient.prototype.getQueueMode).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearManagedTimer('preloadScheduleTimer');
    vi.useFakeTimers();
  });

  afterEach(async () => {
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetState();
  });

  async function observeAuthority(revision: number, canMutateQueue: boolean) {
    const authority = snapshot(revision, canMutateQueue);
    canonical = {
      ...canonical,
      revision,
      presence: authority.presence,
      viewer: authority.viewer,
      administrators: authority.administrators,
    };
    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM,
      coordinatorEpoch: 1,
      event: { type: 'pro-presence-snapshot', presenceRevision: revision },
    });
    await vi.waitFor(() =>
      expect(getState('room.context').capabilities.includes('queue.mutate')).toBe(canMutateQueue),
    );
  }

  function finishResponse() {
    if (!responseCancelled) {
      responseBody.enqueue(new TextEncoder().encode('}'));
      responseBody.close();
    }
  }

  it('does not retry a retired repeat edit after revocation and regrant during the denied response body', async () => {
    toggleRepeat();
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(deniedResponse?.body?.locked).toBe(true);
    expect(mode.repeatMode).toBe(0);
    await observeAuthority(2, false);
    await observeAuthority(3, true);
    finishResponse();
    await vi.advanceTimersByTimeAsync(1_250);

    expect.soft(getManagedTimer('pro-room-queue-mode-checkpoint-debounce')).toBeNull();
    expect.soft(puts).toHaveLength(1);
    expect(mode.repeatMode).toBe(0);

    toggleRepeat();
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(mode.repeatMode).toBe(getState('playlist.repeatMode'));
  });

  it('retires a debounced edit when queue permission disappears before its first request', async () => {
    holdFirstResponse = false;
    toggleRepeat();
    await observeAuthority(2, false);
    await observeAuthority(3, true);
    await vi.advanceTimersByTimeAsync(500);
    expect.soft(puts).toHaveLength(0);
    expect(mode.repeatMode).toBe(0);

    toggleRepeat();
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(mode.repeatMode).toBe(getState('playlist.repeatMode'));
  });

  it('keeps the existing transient retry when queue permission stays valid', async () => {
    responseStatus = 503;
    toggleRepeat();
    await vi.waitFor(() => expect(deniedResponse?.body?.locked).toBe(true));
    expect(puts).toHaveLength(1);
    finishResponse();
    await vi.advanceTimersByTimeAsync(1_250);
    expect(puts).toHaveLength(2);
    expect(mode.repeatMode).toBe(1);
    expect(getState('playlist.repeatMode')).toBe(1);
  });

  it('does not let an old denial replace a fresh post-regrant edit debounce', async () => {
    toggleRepeat();
    await vi.waitFor(() => expect(deniedResponse?.body?.locked).toBe(true));
    await observeAuthority(2, false);
    await observeAuthority(3, true);
    toggleRepeat();
    const latestRepeat = getState('playlist.repeatMode');
    finishResponse();

    // The fresh gesture owns the normal 350ms debounce. The old request must
    // not replace it with its own one-second retry after its body completes.
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(2);
    expect(mode.repeatMode).toBe(latestRepeat);
    expect(getState('playlist.repeatMode')).toBe(latestRepeat);
  });

  it.each(['shuffle', 'repeat'] as const)(
    'retires denied fields while preserving a fresh %s gesture before authority refresh',
    async (freshField) => {
      toggleRepeat();
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(1);
      expect(deniedResponse?.body?.locked).toBe(true);
      // The 403 can arrive before the independent heartbeat observes lost
      // authority. A fresh field has its own debounce while that body waits.
      if (freshField === 'shuffle') toggleShuffle();
      else toggleRepeat();
      finishResponse();
      await vi.advanceTimersByTimeAsync(400);

      expect(puts).toHaveLength(2);
      expect(mode.repeatMode).toBe(freshField === 'repeat' ? 2 : 0);
      expect(mode.shuffleEnabled).toBe(freshField === 'shuffle');
      expect(getState('playlist.repeatMode')).toBe(mode.repeatMode);
      expect(getState('playlist.isShuffle')).toBe(mode.shuffleEnabled);
    },
  );

  it.each([false, true])(
    'retires a repeat edit queued behind a real queue-mode GET across revocation (fresh shuffle=%s)',
    async (freshShuffle) => {
      holdFirstResponse = false;
      holdQueueModeRead = true;
      canonical = {
        ...canonical,
        revision: 2,
        playlistRevision: 2,
        playlist: [
          ...canonical.playlist,
          {
            queueItemId: '56000000-0000-4000-8000-000000000002' as QueueItemId,
            name: 'Other participant added track',
            source: { kind: 'youtube', videoId: 'M7lc1UVf-VE' },
          },
        ],
      };
      mode = { ...mode, playlistRevision: 2 };
      acceptProRoomRealtimeFrameForTests({
        type: 'pro-server-event',
        version: 1,
        roomCode: ROOM,
        coordinatorEpoch: 1,
        event: { type: 'pro-room-invalidated', roomRevision: 2, playlistRevision: 2 },
      });
      await vi.waitFor(() => expect(readResponse?.body?.locked).toBe(true));
      toggleRepeat();
      await vi.advanceTimersByTimeAsync(400);
      expect(puts).toHaveLength(0);
      await observeAuthority(3, false);
      await observeAuthority(4, true);
      if (freshShuffle) toggleShuffle();
      holdQueueModeRead = false;
      if (!readBodyCancelled) {
        readBody.enqueue(new TextEncoder().encode('}'));
        readBody.close();
      }
      await vi.advanceTimersByTimeAsync(400);
      expect.soft(puts).toHaveLength(freshShuffle ? 1 : 0);
      expect(mode.repeatMode).toBe(0);
      expect(getState('playlist.repeatMode')).toBe(0);
      expect(mode.shuffleEnabled).toBe(freshShuffle);
    },
  );

  it('keeps a fresh repeat gesture equal to the retired value across a canonical GET', async () => {
    holdFirstResponse = false;
    holdQueueModeRead = true;
    toggleRepeat();
    expect(getState('playlist.repeatMode')).toBe(1);
    canonical = { ...canonical, revision: 2, queueModeRevision: 1 };
    mode = { ...mode, revision: 1, repeatMode: 2 };
    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM,
      coordinatorEpoch: 1,
      event: { type: 'pro-room-invalidated', roomRevision: 2, queueModeRevision: 1 },
    });
    await vi.waitFor(() => expect(readResponse?.body?.locked).toBe(true));
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(0);
    await observeAuthority(3, false);
    expect(getState('playlist.repeatMode')).toBe(0);
    await observeAuthority(4, true);
    toggleRepeat();
    expect(getState('playlist.repeatMode')).toBe(1);
    holdQueueModeRead = false;
    if (!readBodyCancelled) {
      readBody.enqueue(new TextEncoder().encode('}'));
      readBody.close();
    }
    await vi.advanceTimersByTimeAsync(400);
    expect(puts).toHaveLength(1);
    expect(mode.repeatMode).toBe(1);
    expect(getState('playlist.repeatMode')).toBe(1);
  });

  it('does not publish a denied field when another append invalidates the required queue-mode GET', async () => {
    vi.spyOn(ProRoomApiClient.prototype, 'updateCompactSnapshot').mockImplementation(
      async (input) => {
        expect(input.baseRevision).toBe(canonical.revision);
        const items = new Map(canonical.playlist.map((item) => [item.queueItemId, item]));
        for (const item of input.upserts) items.set(item.queueItemId, item);
        canonical = {
          ...canonical,
          revision: canonical.revision + 1,
          playlistRevision: canonical.playlistRevision + 1,
          playlist: input.playlistOrder!.map((id) => items.get(id)!),
        };
        // Server reconcileQueueModePlaylist keeps the queue-mode revision when
        // shuffle is OFF: both old and next shuffle orders are empty.
        expect(mode.shuffleEnabled).toBe(false);
        mode = { ...mode, playlistRevision: canonical.playlistRevision };
        return canonical;
      },
    );
    const append = async (suffix: number) => {
      const session = captureProRoomMediaHookSession();
      expect(session).not.toBeNull();
      const queueItemId =
        `56000000-0000-4000-8000-${String(suffix).padStart(12, '0')}` as QueueItemId;
      expect(
        handleProRoomYouTubeForSession(
          session!,
          {
            queueItemId,
            type: 'youtube',
            name: `Added ${suffix}`,
            videoId: 'M7lc1UVf-VE',
            playlistId: null,
          },
          'https://youtube.com/watch?v=M7lc1UVf-VE',
        ),
      ).toBe(true);
      await vi.waitFor(() => expect(getState('playlist.items')).toHaveLength(suffix));
    };

    toggleRepeat();
    await vi.advanceTimersByTimeAsync(400);
    expect(deniedResponse?.body?.locked).toBe(true);
    await append(2);
    toggleShuffle();
    holdQueueModeRead = true;
    finishResponse();
    await vi.advanceTimersByTimeAsync(400);
    expect(readResponse?.body?.locked).toBe(true);
    expect(puts).toHaveLength(1);
    await append(3);
    expect(mode.revision).toBe(0);
    holdQueueModeRead = false;
    readBody.enqueue(new TextEncoder().encode('}'));
    readBody.close();
    await vi.advanceTimersByTimeAsync(400);

    expect(mode.repeatMode).toBe(0);
    // The next valid reconciliation may publish the fresh shuffle edit.
    // Every accepted write is checked against the actual current queue above.
    await vi.advanceTimersByTimeAsync(1_250);
    expect(puts).toHaveLength(2);
    expect(mode.repeatMode).toBe(0);
    expect(mode.shuffleEnabled).toBe(true);
  });
});
