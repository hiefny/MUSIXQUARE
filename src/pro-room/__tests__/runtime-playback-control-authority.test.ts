/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearManagedTimer } from '../../core/timers.ts';
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
} from '../playback-authority-hooks.ts';
import { acceptProRoomRealtimeFrameForTests, joinProRoom } from '../runtime.ts';

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

describe('PRO playback control authority across pending HTTP responses', () => {
  let canonical: ProRoomSnapshot;
  let commands: ProRoomPlaybackCommand[];
  let responseBody: ReadableStreamDefaultController<Uint8Array>;
  let heldResponse: Response | undefined;
  let responseCancelled: boolean;
  let commandKeys: Array<string | null>;
  let firstCommandResponse: object;
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
    commandKeys = [];
    firstCommandResponse = {};
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
        commandKeys.push(new Headers(init?.headers).get('Idempotency-Key'));
        expect(canonical.viewer?.capabilities).toContain('playback.control');
        expect(command.baseRevision).toBe(canonical.playback.revision);
        if (commands.length === 1) {
          expect(command).toMatchObject({ type: 'seek', positionSeconds: 0 });
          firstCommandResponse = {
            schemaVersion: 1,
            roomCode: ROOM,
            status: 'unchanged',
            playback: canonical.playback,
            serverTimeMs: 1,
          };
          // The actual API parser waits for the unfinished HTTP body. Abort is
          // handled by the real bounded reader and its stream cancellation.
          heldResponse = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                responseBody = controller;
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify(firstCommandResponse).slice(0, -1)),
                );
              },
              cancel() {
                responseCancelled = true;
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
          return heldResponse;
        }
        if (commandKeys.at(-1) === commandKeys[0]) return Response.json(firstCommandResponse);
        expect(command.type).toBe('seek');
        if (command.type === 'seek') {
          canonical = {
            ...canonical,
            revision: canonical.revision + 1,
            playback: {
              ...canonical.playback,
              revision: canonical.playback.revision + 1,
              positionSeconds: command.positionSeconds,
            },
          };
        }
        return Response.json({
          schemaVersion: 1,
          roomCode: ROOM,
          status: 'committed',
          playback: canonical.playback,
          serverTimeMs: 1,
        });
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
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
    registerProPlaybackMediaEndpoint(null);
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
        executeAtMs: 1,
        playback: canonical.playback,
      },
    });
  }

  async function startPendingControl() {
    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: ITEM, positionSeconds: 0 },
      { wasPlaying: false },
    );
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    expect(heldResponse?.body?.locked).toBe(true);
  }

  async function queueSeekBehindPendingControl() {
    await startPendingControl();
    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: ITEM, positionSeconds: 42 },
      { wasPlaying: false },
    );
    expect(commands).toHaveLength(1);
  }

  it('retires an unsent seek when control is revoked and restored during an older response', async () => {
    await queueSeekBehindPendingControl();
    await observeAuthority(2, false);
    await observeAuthority(3, true);
    finishResponse();
    await vi.advanceTimersByTimeAsync(100);

    expect.soft(commands).toHaveLength(1);
    expect(canonical.playback.positionSeconds).toBe(0);

    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: ITEM, positionSeconds: 7 },
      { wasPlaying: false },
    );
    await vi.waitFor(() => expect(commands).toHaveLength(2));
    expect(canonical.playback.positionSeconds).toBe(7);
  });

  it('preserves the queued seek when playback authority stays current', async () => {
    await queueSeekBehindPendingControl();
    finishResponse();
    await vi.waitFor(() => expect(commands).toHaveLength(2));
    expect(canonical.playback.positionSeconds).toBe(42);
  });

  it('does not submit the queued seek while playback authority remains revoked', async () => {
    await queueSeekBehindPendingControl();
    await observeAuthority(2, false);
    finishResponse();
    await vi.advanceTimersByTimeAsync(100);

    expect(commands).toHaveLength(1);
    expect(canonical.playback.positionSeconds).toBe(0);
  });

  it('does not replay a lost command response after its authority is revoked and restored', async () => {
    await startPendingControl();
    await observeAuthority(2, false);
    await observeAuthority(3, true);
    responseBody.error(new TypeError('Connection lost during the command response body'));
    await vi.advanceTimersByTimeAsync(100);

    expect(commands).toHaveLength(1);
    expect(canonical.playback.positionSeconds).toBe(0);
  });

  it('replays a lost response once with the same idempotency key while authority stays current', async () => {
    await startPendingControl();
    responseBody.error(new TypeError('Connection lost during the command response body'));
    await vi.waitFor(() => expect(commands).toHaveLength(2));

    expect(commandKeys[0]).toBeTruthy();
    expect(commandKeys[1]).toBe(commandKeys[0]);
    expect(canonical.playback.positionSeconds).toBe(0);
    expect(canonical.playback.revision).toBe(1);
  });

  it("does not rebase a queued seek onto another participant's newly selected occurrence", async () => {
    await queueSeekBehindPendingControl();
    // Another controller selects B and pauses it while this client's old HTTP
    // body is pending. The latest direct pause COMMIT is authoritative even
    // when this participant missed the preceding selection frame.
    publishPlayback({ queueItemId: NEXT_ITEM, youtubeVideoId: 'M7lc1UVf-VE' });
    await vi.waitFor(() =>
      expect(getState('room.context').snapshotRevision).toBe(canonical.revision),
    );
    finishResponse();
    await vi.advanceTimersByTimeAsync(100);

    expect.soft(commands).toHaveLength(1);
    expect(canonical.playback.positionSeconds).toBe(0);

    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: NEXT_ITEM, positionSeconds: 7 },
      { wasPlaying: false },
    );
    await vi.waitFor(() => expect(commands).toHaveLength(2));
    expect(canonical.playback.positionSeconds).toBe(7);
  });

  it('retires a queued seek when the same queue occurrence advances to another sub-video', async () => {
    await queueSeekBehindPendingControl();
    publishPlayback({ youtubeVideoId: 'M7lc1UVf-VE', youtubeSubIndex: 1 });
    await vi.waitFor(() =>
      expect(getState('room.context').snapshotRevision).toBe(canonical.revision),
    );
    finishResponse();
    await vi.advanceTimersByTimeAsync(100);

    expect(commands).toHaveLength(1);
    expect(canonical.playback.positionSeconds).toBe(0);
  });

  it('preserves a queued seek across a newer revision of the same media source', async () => {
    await queueSeekBehindPendingControl();
    publishPlayback({ positionSeconds: 11 });
    await vi.waitFor(() =>
      expect(getState('room.context').snapshotRevision).toBe(canonical.revision),
    );
    finishResponse();
    await vi.waitFor(() => expect(commands).toHaveLength(2));

    expect(commands[1]).toMatchObject({ type: 'seek', baseRevision: 3, positionSeconds: 42 });
    expect(canonical.playback.positionSeconds).toBe(42);
  });

  it('retires A seek after B COMMIT applies even while its persisted heartbeat body is pending', async () => {
    await queueSeekBehindPendingControl();
    holdHeartbeat = true;
    publishPlayback({ queueItemId: NEXT_ITEM, youtubeVideoId: 'M7lc1UVf-VE' });
    await vi.waitFor(() => expect(heartbeatResponse?.body?.locked).toBe(true));
    expect(getState('playlist.currentQueueItemId')).toBe(NEXT_ITEM);
    expect(getState('room.context').snapshotRevision).toBe(1);
    finishResponse();
    await vi.advanceTimersByTimeAsync(100);

    expect(commands).toHaveLength(1);
    expect(canonical.playback.positionSeconds).toBe(0);
    await finishHeartbeat();
  });

  it('accepts a fresh B seek after B COMMIT applies while the persisted heartbeat body is pending', async () => {
    await startPendingControl();
    holdHeartbeat = true;
    publishPlayback({ queueItemId: NEXT_ITEM, youtubeVideoId: 'M7lc1UVf-VE' });
    await vi.waitFor(() => expect(heartbeatResponse?.body?.locked).toBe(true));
    expect(getState('playlist.currentQueueItemId')).toBe(NEXT_ITEM);
    expect(getState('room.context').snapshotRevision).toBe(1);
    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: NEXT_ITEM, positionSeconds: 7 },
      { wasPlaying: false },
    );
    finishResponse();
    await vi.waitFor(() => expect(commands).toHaveLength(2));

    expect(commands[1]).toMatchObject({ type: 'seek', baseRevision: 3, positionSeconds: 7 });
    expect(canonical.playback.positionSeconds).toBe(7);
    await finishHeartbeat();
  });

  it('does not revive the old A seek when canonical playback leaves A then returns to it', async () => {
    await queueSeekBehindPendingControl();
    publishPlayback({ queueItemId: NEXT_ITEM, youtubeVideoId: 'M7lc1UVf-VE' });
    await vi.waitFor(() =>
      expect(getState('room.context').snapshotRevision).toBe(canonical.revision),
    );
    publishPlayback({ queueItemId: ITEM, youtubeVideoId: 'dQw4w9WgXcQ' });
    await vi.waitFor(() =>
      expect(getState('room.context').snapshotRevision).toBe(canonical.revision),
    );
    finishResponse();
    await vi.advanceTimersByTimeAsync(100);

    expect(commands).toHaveLength(1);
    expect(canonical.playback.positionSeconds).toBe(0);
  });
});
