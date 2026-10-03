/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, clearManagedTimer } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  ProRoomApiClient,
  type ProRoomPlaybackCommand,
  type ProRoomSignalingAccess,
} from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPlaybackCheckpoint,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ServerProRoomNetworkBridge } from '../network-bridge.ts';
import {
  registerProPlaybackMediaEndpoint,
  routeProPlaybackCommand,
  type ProPlaybackCommitRequest,
  type ProPlaybackCommitResult,
} from '../playback-authority-hooks.ts';
import { acceptProRoomRealtimeFrameForTests, joinProRoom } from '../runtime.ts';
import { setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import { loadYouTubeVideo, updateYouTubeUIForTests } from '../../youtube/iframe.ts';
import { applyProPlaybackYouTubeCommit } from '../../youtube/player.ts';
import {
  resetYouTubeModuleState,
  markYtPlayerReady,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../../youtube/_state.ts';
import { makeFakeYtPlayer } from '../../youtube/__tests__/__helpers__/fake-yt-player.ts';

const ROOM = '000001';
const ITEM = '58000000-0000-4000-8000-000000000001' as QueueItemId;
const NEXT_ITEM = '58000000-0000-4000-8000-000000000002' as QueueItemId;
const nativeCreateSession = ProRoomApiClient.prototype.createSession;
const nativeExecuteCommand = ProRoomApiClient.prototype.executePlaybackCommand;
const nativeHeartbeat = ProRoomApiClient.prototype.heartbeat;

function snapshot(revision = 1, canControl = true): ProRoomSnapshot {
  const permissions: ProRoomPermissionSet = {
    'media.add': true,
    'playback.control': canControl,
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
      {
        queueItemId: ITEM,
        name: 'Track',
        source: {
          kind: 'youtube',
          videoId: 'dQw4w9WgXcQ',
          playlistId: 'PL_CONTROL_AUTHORITY',
          videoIds: ['dQw4w9WgXcQ', 'M7lc1UVf-VE'],
        },
      },
      {
        queueItemId: NEXT_ITEM,
        name: 'Next track',
        source: { kind: 'youtube', videoId: 'M7lc1UVf-VE' },
      },
    ],
    currentQueueItemId: ITEM,
    playback: {
      coordinatorEpoch: 1,
      revision: 1,
      state: 'paused',
      queueItemId: ITEM,
      positionSeconds: 0,
      youtubeVideoId: 'dQw4w9WgXcQ',
      youtubeSubIndex: 0,
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

describe('PRO exact media observations across COMMIT and HTTP hydration', () => {
  let canonical: ProRoomSnapshot;
  let commands: ProRoomPlaybackCommand[];
  let responseBody: ReadableStreamDefaultController<Uint8Array>;
  let heldResponse: Response | undefined;
  let responseCancelled: boolean;
  let holdCommand: boolean;
  let holdHeartbeat: boolean;
  let heartbeatResponse: Response | undefined;
  let heartbeatBody: ReadableStreamDefaultController<Uint8Array>;
  let heartbeatCancelled: boolean;

  beforeEach(async () => {
    resetState();
    canonical = snapshot();
    commands = [];
    heldResponse = undefined;
    responseCancelled = false;
    holdCommand = false;
    holdHeartbeat = false;
    heartbeatResponse = undefined;
    heartbeatCancelled = false;
    registerProPlaybackMediaEndpoint({
      prepare: async (request) => ({
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube',
        durationSeconds: 180,
        youtubeVideoId: request.youtubeVideoId ?? null,
        youtubeSubIndex: request.youtubeSubIndex ?? null,
      }),
      commit: async (request) => {
        // Mirror the endpoint's already-applied renderer selection independently
        // of the later persisted snapshot heartbeat.
        setState('playlist.currentQueueItemId', request.queueItemId);
        return { status: 'applied', authority: request.authority };
      },
    });
    const controlClient = new ProRoomApiClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/sessions')) {
          return Response.json({
            snapshot: canonical,
            session: { expiresAtMs: Date.now() + 60_000 },
          });
        }
        if (url.pathname.endsWith('/presence/heartbeat')) {
          heartbeatResponse = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                heartbeatBody = controller;
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify({ snapshot: canonical }).slice(0, -1)),
                );
              },
              cancel() {
                heartbeatCancelled = true;
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
          return heartbeatResponse;
        }
        expect(url.pathname.endsWith('/playback/commands')).toBe(true);
        const command = JSON.parse(String(init?.body)) as ProRoomPlaybackCommand;
        commands.push(command);
        const result = {
          schemaVersion: 1,
          roomCode: ROOM,
          status: 'unchanged',
          playback: canonical.playback,
          serverTimeMs: 120_000,
        };
        if (!holdCommand) return Response.json(result);
        holdCommand = false;
        heldResponse = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              responseBody = controller;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(result).slice(0, -1)));
            },
            cancel() {
              responseCancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
        return heldResponse;
      },
    });
    vi.spyOn(ProRoomApiClient.prototype, 'createSession').mockImplementation((input, signal) =>
      nativeCreateSession.call(controlClient, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'executePlaybackCommand').mockImplementation(
      (input, signal) => nativeExecuteCommand.call(controlClient, input, signal),
    );
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation((...args) =>
      holdHeartbeat ? nativeHeartbeat.call(controlClient, ...args) : Promise.resolve(canonical),
    );
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
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'disconnect').mockImplementation(() => {});
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(ProRoomApiClient.prototype.getQueueMode).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearManagedTimer('preloadScheduleTimer');
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const closedSessions = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced).mock.calls
      .length;
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalledTimes(
        closedSessions + 1,
      ),
    );
    registerProPlaybackMediaEndpoint(null);
    clearAllManagedTimers();
    resetYouTubeModuleState();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetState();
  });

  async function observeAuthority(revision: number, canControl: boolean) {
    const authority = snapshot(revision, canControl);
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
      expect(getState('room.context').capabilities.includes('playback.control')).toBe(canControl),
    );
  }

  function finishResponse() {
    if (!responseCancelled) {
      responseBody.enqueue(new TextEncoder().encode('}'));
      responseBody.close();
    }
  }

  async function finishHeartbeat() {
    holdHeartbeat = false;
    if (!heartbeatCancelled) {
      heartbeatBody.enqueue(new TextEncoder().encode('}'));
      heartbeatBody.close();
    }
    await vi.waitFor(() =>
      expect(getState('room.context').snapshotRevision).toBe(canonical.revision),
    );
  }

  function publishPlayback(overrides: Partial<ProRoomPlaybackCheckpoint>) {
    canonical = {
      ...canonical,
      revision: canonical.revision + 2,
      currentQueueItemId: overrides.queueItemId ?? canonical.currentQueueItemId,
      playback: {
        ...canonical.playback,
        revision: canonical.playback.revision + 2,
        ...overrides,
      },
    };
    acceptProRoomRealtimeFrameForTests({
      type: 'pro-server-event',
      version: 1,
      roomCode: ROOM,
      coordinatorEpoch: 1,
      event: {
        type: 'pro-playback-commit',
        transitionId: null,
        serverTimeMs: 1,
        executeAtMs: canonical.playback.updatedAtMs,
        playback: canonical.playback,
      },
    });
  }

  async function startPendingControl() {
    holdCommand = true;
    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: ITEM, positionSeconds: 0 },
      { wasPlaying: false },
    );
    await vi.waitFor(() => expect(heldResponse?.body?.locked).toBe(true));
  }

  async function prepareObservation(duration: number, held: boolean) {
    resetYouTubeModuleState();
    document.body.innerHTML =
      '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    const fake = makeFakeYtPlayer({
      __videoId: 'dQw4w9WgXcQ',
      __playlist: [],
      __playlistIdx: -1,
      __duration: duration,
    });
    const player = Object.assign(fake, {
      cuePlaylist: vi.fn(),
      loadPlaylist: vi.fn(),
    }) as unknown as YouTubePlayerInstance;
    let events!: {
      onReady: (event: { target: YouTubePlayerInstance }) => void;
      onStateChange: (event: { data: number; target: YouTubePlayerInstance }) => void;
      onError: (event: { data: number; target: YouTubePlayerInstance }) => void;
    };
    vi.stubGlobal('YT', {
      Player: function (_id: string, options: { events: typeof events }) {
        events = options.events;
        fake.__onStateChange = (event) =>
          events.onStateChange({ data: event.data, target: player });
        return player;
      },
      PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    });
    setPlaybackYouTubePlaying();
    loadYouTubeVideo('dQw4w9WgXcQ', null, false, 0);
    events.onReady({ target: player });
    markYtPlayerReady(player);
    setYtAutoplayIntent(true);
    setPlaybackYouTubePlaying();
    const rendererCommit = vi.fn(async (request: Readonly<ProPlaybackCommitRequest>) => ({
      status: (await applyProPlaybackYouTubeCommit(request))
        ? ('applied' as const)
        : ('failed' as const),
      authority: request.authority,
    }));
    registerProPlaybackMediaEndpoint({ prepare: vi.fn(), commit: rendererCommit });
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'clockCalibrated', 'get').mockReturnValue(true);
    vi.spyOn(ServerProRoomNetworkBridge.prototype, 'serverNowMs', 'get').mockReturnValue(120_000);
    holdHeartbeat = held;
    publishPlayback({ state: 'playing', positionSeconds: 119, updatedAtMs: 119_000 });
    await vi.waitFor(() => expect(rendererCommit).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(0);
    expect(await rendererCommit.mock.results[0].value).toMatchObject({ status: 'applied' });
    if (held) {
      expect(heartbeatResponse?.body?.locked).toBe(true);
      expect(getState('room.context').snapshotRevision).toBe(1);
    } else {
      await vi.waitFor(() =>
        expect(getState('room.context').snapshotRevision).toBe(canonical.revision),
      );
    }
    return (kind: 'ended' | 'unavailable') => {
      fake.__videoId = 'dQw4w9WgXcQ';
      fake.__currentTime = 120;
      if (kind === 'ended') fake.__setState(0);
      else {
        fake.__setState(3, false);
        events.onError({ data: 150, target: player });
      }
    };
  }

  function observations() {
    return commands.filter((command) => command.type === 'ended' || command.type === 'unavailable');
  }

  it.each([
    ['ended', 0, false],
    ['unavailable', 120, false],
    ['ended', 0, true],
    ['unavailable', 120, true],
    ['ended', 120, true],
  ] as const)(
    'submits %s (duration %i, heartbeat held %s) from the applied renderer',
    async (kind, duration, held) => {
      const observe = await prepareObservation(duration, held);
      observe(kind);
      await vi.advanceTimersByTimeAsync(0);
      // The live COMMIT is sufficient authority even before the bounded HTTP
      // body reader can hydrate the older persisted snapshot.
      expect(observations()).toEqual([
        expect.objectContaining({
          type: kind,
          baseRevision: canonical.playback.revision,
          queueItemId: ITEM,
          youtubeVideoId: 'dQw4w9WgXcQ',
          youtubeSubIndex: 0,
        }),
      ]);
      if (held) await finishHeartbeat();
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        updateYouTubeUIForTests();
      }
      await vi.advanceTimersByTimeAsync(0);
      // This API fixture deliberately replies unchanged. Known-duration ENDED
      // retains its one canonical-boundary retry for early personal offsets.
      expect(observations()).toHaveLength(kind === 'ended' && duration > 0 ? 2 : 1);
      for (const command of observations()) {
        expect(command).toMatchObject({ type: kind, baseRevision: canonical.playback.revision });
      }
    },
  );

  it.each(['ended', 'unavailable'] as const)(
    'keeps queued %s while the applied occurrence remains current',
    async (kind) => {
      const observe = await prepareObservation(kind === 'ended' ? 0 : 120, true);
      await startPendingControl();
      observe(kind);
      await vi.advanceTimersByTimeAsync(0);
      expect(observations()).toEqual([]);
      finishResponse();
      await vi.waitFor(() => expect(observations()).toHaveLength(1));
      expect(observations()[0]).toMatchObject({
        type: kind,
        baseRevision: canonical.playback.revision,
      });
      await finishHeartbeat();
    },
  );

  describe.each(['ended', 'unavailable'] as const)('stale %s observation', (kind) => {
    it.each([
      ['same-video seek', { positionSeconds: 45 }],
      ['same-video pause', { state: 'paused' }],
      ['next sub-video', { youtubeVideoId: 'M7lc1UVf-VE', youtubeSubIndex: 1 }],
      ['next queue item', { queueItemId: NEXT_ITEM, youtubeVideoId: 'M7lc1UVf-VE' }],
    ] satisfies Array<[string, Partial<ProRoomPlaybackCheckpoint>]>)(
      'does not rebase after a newer %s COMMIT',
      async (_label, change) => {
        const observe = await prepareObservation(kind === 'ended' ? 0 : 120, false);
        await startPendingControl();
        observe(kind);
        // The old iframe already produced the observation. Apply the successor
        // endpoint without asking that intentionally ended fake iframe to load.
        registerProPlaybackMediaEndpoint({
          prepare: vi.fn(),
          commit: async (request) => ({ status: 'applied', authority: request.authority }),
        });
        publishPlayback(change);
        await vi.waitFor(() =>
          expect(getState('room.context').snapshotRevision).toBe(canonical.revision),
        );
        finishResponse();
        await vi.advanceTimersByTimeAsync(100);
        expect(observations()).toEqual([]);
      },
    );

    it('cannot revive after playback authority is revoked and restored', async () => {
      const observe = await prepareObservation(kind === 'ended' ? 0 : 120, false);
      await startPendingControl();
      observe(kind);
      await observeAuthority(canonical.revision + 1, false);
      await observeAuthority(canonical.revision + 1, true);
      finishResponse();
      await vi.advanceTimersByTimeAsync(100);
      expect(observations()).toEqual([]);
    });

    it('rejects an old observation as soon as a newer COMMIT is known, before it applies', async () => {
      const observe = await prepareObservation(kind === 'ended' ? 0 : 120, false);
      await startPendingControl();
      observe(kind);
      let releaseCommit!: () => void;
      const delayedCommit = vi.fn(
        (request: Readonly<ProPlaybackCommitRequest>) =>
          new Promise<ProPlaybackCommitResult>((resolve) => {
            releaseCommit = () => resolve({ status: 'applied', authority: request.authority });
          }),
      );
      registerProPlaybackMediaEndpoint({ prepare: vi.fn(), commit: delayedCommit });
      publishPlayback({ state: 'paused', positionSeconds: 45 });
      await vi.waitFor(() => expect(delayedCommit).toHaveBeenCalledOnce());
      expect(getState('room.context').snapshotRevision).toBe(3);
      finishResponse();
      await vi.advanceTimersByTimeAsync(100);
      expect(observations()).toEqual([]);
      releaseCommit();
      await vi.advanceTimersByTimeAsync(100);
      expect(observations()).toEqual([]);
    });

    it('cannot cross leave and rejoin of the same room and epoch', async () => {
      const observe = await prepareObservation(kind === 'ended' ? 0 : 120, false);
      await startPendingControl();
      observe(kind);
      requestProRoomLeave();
      await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
      await vi.waitFor(() =>
        expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
      );
      expect(responseCancelled).toBe(true);
      resetYouTubeModuleState();
      canonical = snapshot();
      await joinProRoom({ code: ROOM, pin: '12345678' });
      finishResponse();
      await vi.advanceTimersByTimeAsync(100);
      expect(getState('room.context').kind).toBe('pro');
      expect(observations()).toEqual([]);
    });
  });
});
