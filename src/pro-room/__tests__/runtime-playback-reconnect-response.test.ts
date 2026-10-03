/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { getState, resetState } from '../../core/state.ts';
import { clearAllManagedTimers, clearManagedTimer } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  ProRoomApiClient,
  type ProRoomPlaybackCommand,
  type ProRoomPlaybackCommandResult,
  type ProRoomPlaybackPrepareEvent,
  type ProRoomSignalingAccess,
} from '../api.ts';
import {
  capabilitiesForProRoomRole,
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomPermissionSet,
  type ProRoomSnapshot,
} from '../contracts.ts';
import { requestProRoomLeave } from '../lifecycle-hook.ts';
import { ProRoomPlaybackController } from '../playback-controller.ts';
import {
  registerProPlaybackMediaEndpoint,
  routeProPlaybackCommand,
  type ProPlaybackCommitRequest,
} from '../playback-authority-hooks.ts';
import { joinProRoom } from '../runtime.ts';

type SocketEvent = { data?: unknown; reason: string };
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();
  constructor(
    readonly url: string,
    readonly protocols: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatch('open'));
  }
  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState !== FakeWebSocket.CLOSED) this.dispatch('close');
  }
  dispatch(type: string, data?: unknown): void {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN;
    if (type === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(type) ?? []) listener({ data, reason: '' });
  }
}

const ROOM = '000001';
const ITEM = '58000000-0000-4000-8000-000000000001' as QueueItemId;
const NEXT_ITEM = '58000000-0000-4000-8000-000000000002' as QueueItemId;
const nativeCreateSession = ProRoomApiClient.prototype.createSession;
const nativeExecuteCommand = ProRoomApiClient.prototype.executePlaybackCommand;
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

describe('PRO pending command responses across real channel recovery', () => {
  let canonical: ProRoomSnapshot;
  let nextResult: ProRoomPlaybackCommandResult | null;
  let holdCommand: boolean;
  let heldResponse: Response | null;
  let responseBody: ReadableStreamDefaultController<Uint8Array>;
  let responseCancelled: boolean;
  let ticketSequence: number;
  let pendingTicketTransition: ProRoomPlaybackPrepareEvent | null;
  let ticketWait: Promise<void> | null;
  let prepared: Array<{ transitionId: string | null; positionSeconds: number }>;
  let cancelled: Array<string | null>;
  let commits: Readonly<ProPlaybackCommitRequest>[];
  let commands: ProRoomPlaybackCommand[];
  let settlements: Array<{ status: string }>;
  let unsubscribeSettlement: () => void;

  beforeEach(async () => {
    resetState();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    (
      window as Window & { __MUSIXQUARE_TRANSPORT__?: Record<string, unknown> }
    ).__MUSIXQUARE_TRANSPORT__ = {
      provider: 'cloudflare',
      signalingUrl: 'wss://signal.example.test/api/rooms',
    };
    canonical = snapshot();
    canonical.playback = { ...canonical.playback, state: 'playing', updatedAtMs: Date.now() };
    nextResult = null;
    holdCommand = false;
    heldResponse = null;
    responseCancelled = false;
    ticketSequence = 0;
    pendingTicketTransition = null;
    ticketWait = null;
    prepared = [];
    cancelled = [];
    commits = [];
    commands = [];
    settlements = [];
    unsubscribeSettlement = bus.on('pro-playback:ui-control-settled', (event) =>
      settlements.push(event),
    );
    registerProPlaybackMediaEndpoint({
      prepare: async (request) => {
        prepared.push({
          transitionId: request.authority.transitionId,
          positionSeconds: request.positionSeconds,
        });
        return {
          status: 'ready',
          authority: request.authority,
          queueItemId: request.queueItemId,
          mediaKind: 'youtube',
          durationSeconds: 180,
          youtubeVideoId: request.youtubeVideoId ?? null,
          youtubeSubIndex: request.youtubeSubIndex ?? null,
        };
      },
      commit: async (request) => {
        commits.push(request);
        return { status: 'applied', authority: request.authority };
      },
      cancel: (authority) => {
        cancelled.push(authority.transitionId);
      },
    });
    const controlClient = new ProRoomApiClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/sessions'))
          return Response.json({
            snapshot: canonical,
            session: { expiresAtMs: Date.now() + 60_000 },
          });
        expect(url.pathname.endsWith('/playback/commands')).toBe(true);
        commands.push(JSON.parse(String(init?.body)) as ProRoomPlaybackCommand);
        const result = nextResult ?? {
          schemaVersion: 1,
          roomCode: ROOM,
          status: 'unchanged',
          playback: canonical.playback,
          serverTimeMs: Date.now(),
        };
        nextResult = null;
        if (!holdCommand) return Response.json(result);
        holdCommand = false;
        responseCancelled = false;
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
    vi.spyOn(ProRoomApiClient.prototype, 'heartbeat').mockImplementation(async () => canonical);
    vi.spyOn(ProRoomApiClient.prototype, 'createSignalingTicket').mockImplementation(async () => {
      if (ticketWait) await ticketWait;
      return {
        ticket: `${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
        expiresAtMs: Date.now() + 60_000,
        role: 'member',
        coordinatorEpoch: 1,
        presenceIncarnationId: 'presence_0000000002',
        ticketSequence: ++ticketSequence,
        pendingPlaybackTransition: pendingTicketTransition,
      };
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
    vi.spyOn(ProRoomApiClient.prototype, 'reportPlaybackTransitionReady').mockResolvedValue(
      'waiting',
    );
    vi.spyOn(ProRoomApiClient.prototype, 'closePresenceOnUnload').mockResolvedValue(undefined);
    vi.spyOn(ProRoomApiClient.prototype, 'closeSessionFenced').mockResolvedValue(undefined);
    await joinProRoom({ code: ROOM, pin: '12345678' });
    await vi.waitFor(() => expect(ProRoomApiClient.prototype.getQueueMode).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearManagedTimer('preloadScheduleTimer');
    prepared = [];
    cancelled = [];
    commits = [];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const closed = vi.mocked(ProRoomApiClient.prototype.closeSessionFenced).mock.calls.length;
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalledTimes(closed + 1),
    );
    unsubscribeSettlement();
    registerProPlaybackMediaEndpoint(null);
    clearAllManagedTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as Window & { __MUSIXQUARE_TRANSPORT__?: Record<string, unknown> })
      .__MUSIXQUARE_TRANSPORT__;
    resetState();
  });

  function prepare(positionSeconds: number, letter: string): ProRoomPlaybackPrepareEvent {
    const now = Date.now();
    return {
      type: 'pro-playback-prepare',
      transitionId: `transition_${letter.repeat(22)}`,
      serverTimeMs: now,
      deadlineAtMs: now + 3_000,
      basePlaybackRevision: canonical.playback.revision,
      target: {
        ...canonical.playback,
        revision: canonical.playback.revision + 1,
        positionSeconds,
        state: 'playing',
        updatedAtMs: now,
      },
    };
  }
  function prepareResult(transition: ProRoomPlaybackPrepareEvent): ProRoomPlaybackCommandResult {
    return {
      schemaVersion: 1,
      roomCode: ROOM,
      status: 'preparing',
      transition,
      playback: canonical.playback,
      serverTimeMs: Date.now(),
    };
  }
  function frame(event: unknown): void {
    FakeWebSocket.instances.at(-1)!.dispatch(
      'message',
      JSON.stringify({
        type: 'pro-server-event',
        version: 1,
        roomCode: ROOM,
        coordinatorEpoch: 1,
        event,
      }),
    );
  }
  async function beginHeldSeek(
    old: ProRoomPlaybackPrepareEvent,
    deliverPrepare = true,
  ): Promise<void> {
    nextResult = prepareResult(old);
    holdCommand = true;
    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: ITEM, positionSeconds: old.target.positionSeconds },
      { wasPlaying: true },
    );
    await vi.waitFor(() => expect(heldResponse?.body?.locked).toBe(true));
    if (deliverPrepare) {
      frame(old);
      await vi.waitFor(() => expect(prepared.at(-1)?.transitionId).toBe(old.transitionId));
    }
  }
  function finishResponse(): void {
    if (!responseCancelled) {
      responseBody.enqueue(new TextEncoder().encode('}'));
      responseBody.close();
    }
  }
  async function recover(pending: ProRoomPlaybackPrepareEvent | null): Promise<void> {
    const sockets = FakeWebSocket.instances.length;
    pendingTicketTransition = pending;
    FakeWebSocket.instances.at(-1)!.close();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(sockets + 1));
    if (pending)
      await vi.waitFor(() => expect(prepared.at(-1)?.transitionId).toBe(pending.transitionId));
  }
  async function commit(transition: ProRoomPlaybackPrepareEvent): Promise<void> {
    canonical = {
      ...canonical,
      revision: canonical.revision + 1,
      playback: { ...transition.target, updatedAtMs: Date.now() },
    };
    frame({
      type: 'pro-playback-commit',
      transitionId: transition.transitionId,
      serverTimeMs: Date.now(),
      executeAtMs: Date.now(),
      playback: canonical.playback,
    });
    await vi.waitFor(() =>
      expect(commits.at(-1)?.positionSeconds).toBeGreaterThanOrEqual(
        transition.target.positionSeconds,
      ),
    );
  }

  it.each([false, true])(
    'retains recovered B when old A response finishes (CANCEL received %s)',
    async (cancelReceived) => {
      const a = prepare(30, 'a');
      const b = prepare(80, 'b');
      await beginHeldSeek(a);
      if (cancelReceived)
        frame({
          type: 'pro-playback-cancel',
          transitionId: a.transitionId,
          serverTimeMs: Date.now(),
          reason: 'superseded',
        });
      await recover(b);
      finishResponse();
      await vi.advanceTimersByTimeAsync(10);
      expect(prepared.filter((item) => item.transitionId === a.transitionId)).toHaveLength(1);
      expect(prepared.at(-1)?.transitionId).toBe(b.transitionId);
      expect(cancelled).not.toContain(b.transitionId);
      expect(settlements.at(-1)?.status).toBe('superseded');
      await commit(b);
      expect(commits.at(-1)?.committedPlaybackRevision).toBe(b.target.revision);
    },
  );

  it('rejects a pre-recovery HTTP prepare even when its original WebSocket PREPARE was lost', async () => {
    const a = prepare(30, 'a');
    const b = prepare(80, 'b');
    await beginHeldSeek(a, false);
    await recover(b);
    finishResponse();
    await vi.advanceTimersByTimeAsync(10);
    expect(prepared.some((item) => item.transitionId === a.transitionId)).toBe(false);
    expect(cancelled).not.toContain(b.transitionId);
  });

  it('lets a recovered ticket retain the same still-pending A and settle its admitted UI on COMMIT', async () => {
    const a = prepare(30, 'a');
    await beginHeldSeek(a);
    await recover(a);
    const count = prepared.length;
    finishResponse();
    await vi.advanceTimersByTimeAsync(10);
    expect(prepared).toHaveLength(count);
    expect(settlements).toEqual([]);
    await commit(a);
    expect(settlements.at(-1)?.status).toBe('applied');
  });

  it('accepts a fresh same-revision HTTP replacement after channel recovery', async () => {
    const a = prepare(30, 'a');
    const b = prepare(80, 'b');
    const c = prepare(90, 'c');
    await beginHeldSeek(a);
    await recover(b);
    finishResponse();
    await vi.advanceTimersByTimeAsync(10);
    nextResult = prepareResult(c);
    routeProPlaybackCommand(
      { kind: 'seek', queueItemId: ITEM, positionSeconds: 90 },
      { wasPlaying: true },
    );
    await vi.waitFor(() => expect(prepared.at(-1)?.transitionId).toBe(c.transitionId));
    expect(commands).toHaveLength(2);
    expect(cancelled).toContain(b.transitionId);
    await commit(c);
    expect(settlements.at(-1)?.status).toBe('applied');
  });

  it('accepts a valid same-base replacement from the live channel', async () => {
    const a = prepare(30, 'a');
    const b = prepare(80, 'b');
    const c = prepare(90, 'c');
    await beginHeldSeek(a);
    await recover(b);
    finishResponse();
    await vi.advanceTimersByTimeAsync(10);
    frame(c);
    await vi.waitFor(() => expect(prepared.at(-1)?.transitionId).toBe(c.transitionId));
    expect(cancelled).toContain(b.transitionId);
  });

  it('does not revive an old response when the recovered transition was subsequently cancelled', async () => {
    const a = prepare(30, 'a');
    const b = prepare(80, 'b');
    await beginHeldSeek(a);
    await recover(b);
    frame({
      type: 'pro-playback-cancel',
      transitionId: b.transitionId,
      serverTimeMs: Date.now(),
      reason: 'superseded',
    });
    const count = prepared.length;
    finishResponse();
    await vi.advanceTimersByTimeAsync(10);
    expect(prepared).toHaveLength(count);
    expect(cancelled).toContain(b.transitionId);
  });

  it('retires the old HTTP prepare while the replacement ticket is still loading', async () => {
    const a = prepare(30, 'a');
    const b = prepare(80, 'b');
    await beginHeldSeek(a);
    let releaseTicket!: () => void;
    ticketWait = new Promise((resolve) => {
      releaseTicket = resolve;
    });
    const recovering = recover(b);
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.createSignalingTicket).toHaveBeenCalledTimes(2),
    );
    const count = prepared.length;
    finishResponse();
    await vi.advanceTimersByTimeAsync(10);
    expect(prepared).toHaveLength(count);
    releaseTicket();
    await recovering;
    expect(prepared.at(-1)?.transitionId).toBe(b.transitionId);
  });

  it('keeps a delayed obsolete PREPARE retired across repeated channel losses', async () => {
    const a = prepare(30, 'a');
    const b = prepare(80, 'b');
    await beginHeldSeek(a);
    await recover(b);
    await recover(b);
    const count = prepared.length;
    finishResponse();
    await vi.advanceTimersByTimeAsync(10);
    expect(prepared).toHaveLength(count);
    expect(prepared.at(-1)?.transitionId).toBe(b.transitionId);
  });

  it.each(['recovery', 'reset', 'stop'] as const)(
    'cannot complete a successor recovery with the old token after %s',
    async (boundary) => {
      const a = prepare(30, 'a');
      const b = prepare(80, 'b');
      const lease = { generation: 1, roomCode: ROOM };
      const results = [prepareResult(a), prepareResult(b)];
      const playback = new ProRoomPlaybackController({
        isActive: () => true,
        getCanonicalSnapshot: () => canonical,
        getPlaylistSnapshot: () => canonical,
        capturePlaylistLease: () => lease,
        isPlaylistLeaseCurrent: (candidate) => candidate === lease,
        getRoomAbortSignal: () => undefined,
        subscribePlaylistProjection: () => () => undefined,
        runHeartbeat: async () => undefined,
        reportPlaybackTransitionReady: async () => 'waiting',
        executePlaybackCommand: async () => results.shift()!,
        recoverTerminalSession: async () => undefined,
      });
      try {
        const previous = playback.beginControlChannelRecovery();
        if (boundary === 'reset') playback.resetPlaylistRuntime();
        if (boundary === 'stop') playback.stopLifecycle();
        const current = playback.beginControlChannelRecovery();
        playback.completeControlChannelRecovery(previous);
        await playback.enqueueIntent({
          kind: 'seek',
          roomId: ROOM,
          roomEpoch: 1,
          queueItemId: ITEM,
          positionSeconds: 30,
        });
        expect(prepared.some((item) => item.transitionId === a.transitionId)).toBe(false);
        playback.completeControlChannelRecovery(current);
        await playback.enqueueIntent({
          kind: 'seek',
          roomId: ROOM,
          roomEpoch: 1,
          queueItemId: ITEM,
          positionSeconds: 80,
        });
        expect(prepared.at(-1)?.transitionId).toBe(b.transitionId);
      } finally {
        playback.stopLifecycle();
      }
    },
  );

  it.each([false, true])(
    'does not let a seek issued offline claim the channel (response before ticket %s)',
    async (responseBeforeTicket) => {
      const a = prepare(30, 'a');
      const b = prepare(80, 'b');
      let releaseTicket!: () => void;
      ticketWait = new Promise((resolve) => {
        releaseTicket = resolve;
      });
      const recovering = recover(b);
      await vi.waitFor(() =>
        expect(ProRoomApiClient.prototype.createSignalingTicket).toHaveBeenCalledTimes(2),
      );
      await beginHeldSeek(a, false);
      if (responseBeforeTicket) {
        finishResponse();
        await vi.advanceTimersByTimeAsync(10);
      }
      releaseTicket();
      await recovering;
      if (!responseBeforeTicket) {
        finishResponse();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(prepared.some((item) => item.transitionId === a.transitionId)).toBe(false);
      expect(prepared.at(-1)?.transitionId).toBe(b.transitionId);
      expect(cancelled).not.toContain(b.transitionId);
      await commit(b);
    },
  );

  it('still applies a revision-valid committed HTTP result after recovery', async () => {
    const target = {
      ...canonical.playback,
      revision: canonical.playback.revision + 1,
      state: 'paused' as const,
      positionSeconds: 30,
      updatedAtMs: Date.now(),
    };
    nextResult = {
      schemaVersion: 1,
      roomCode: ROOM,
      status: 'committed',
      transition: null,
      playback: target,
      serverTimeMs: Date.now(),
    };
    holdCommand = true;
    routeProPlaybackCommand(
      { kind: 'pause', queueItemId: ITEM, positionSeconds: 30 },
      { wasPlaying: true },
    );
    await vi.waitFor(() => expect(heldResponse?.body?.locked).toBe(true));
    await recover(null);
    finishResponse();
    await vi.waitFor(() =>
      expect(commits.at(-1)).toMatchObject({
        state: 'paused',
        positionSeconds: 30,
        committedPlaybackRevision: target.revision,
      }),
    );
    expect(settlements.at(-1)?.status).toBe('applied');
  });

  it('cannot move an old pending response into a rejoined session with the same room and epoch', async () => {
    const a = prepare(30, 'a');
    await beginHeldSeek(a);
    requestProRoomLeave();
    await vi.waitFor(() => expect(getState('room.context').kind).toBe('standard'));
    await vi.waitFor(() =>
      expect(ProRoomApiClient.prototype.closeSessionFenced).toHaveBeenCalled(),
    );
    expect(responseCancelled).toBe(true);
    await joinProRoom({ code: ROOM, pin: '12345678' });
    const count = prepared.length;
    finishResponse();
    await vi.advanceTimersByTimeAsync(10);
    expect(prepared).toHaveLength(count);
    expect(getState('room.context').kind).toBe('pro');
  });
});
