/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { PLAYBACK_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setCurrentAudioBuffer, setPlayerNode } from '../../player/_state.ts';
import { setPlaybackLifecycleState } from '../../player/ownership.ts';
import { applyProPlaybackFileCommit, stopAllMedia } from '../../player/transport.ts';
import type { QueueItemId } from '../../types/index.ts';
import type { ProRoomSignalingAccess } from '../../pro-room/api.ts';
import {
  PRO_ROOM_MAX_ASSET_BYTES,
  PRO_ROOM_QUOTA_BYTES,
  type ProRoomSnapshot,
} from '../../pro-room/contracts.ts';
import { ServerProRoomNetworkBridge, proRoomServerBridge } from '../../pro-room/network-bridge.ts';
import { ProRoomPlaybackController } from '../../pro-room/playback-controller.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackMediaEndpoint,
} from '../../pro-room/playback-authority-hooks.ts';

type SocketListener = (event: { data?: unknown; reason?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;
  closeCount = 0;
  private readonly listeners = new Map<string, Set<SocketListener>>();

  readonly protocols: string[];

  constructor(
    readonly url: string,
    protocols: string | string[] = [],
  ) {
    this.protocols = typeof protocols === 'string' ? [protocols] : [...protocols];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: SocketListener): void {
    const listeners = this.listeners.get(event) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: SocketListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCount += 1;
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
    this.dispatch('close');
  }

  dispatch(event: string, data?: unknown): void {
    if (event === 'open') this.readyState = FakeWebSocket.OPEN;
    if (event === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data, reason: event === 'close' ? (this.closeReason ?? '') : undefined });
    }
  }
}

const ROOM_CODE = '000001';
const PARTICIPANT_ID = 'participant_00001';
const INCARNATION_ID = 'presence_0000000001';
const MEMBER_ID = 'member_0000000001';
const OWNER_CAPABILITIES = [
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'members.manage',
  'room.configure',
] as const;

function snapshot(): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: ROOM_CODE,
    status: 'active',
    runtime: 'awake',
    revision: 4,
    playlistRevision: 0,
    effectsRevision: 0,
    queueModeRevision: 0,
    playlist: [],
    currentQueueItemId: null,
    playback: {
      coordinatorEpoch: 2,
      revision: 0,
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: 1,
    },
    presence: {
      coordinatorEpoch: 2,
      revision: 3,
      coordinatorParticipantId: null,
      participants: [
        {
          participantId: PARTICIPANT_ID,
          memberId: MEMBER_ID,
          memberDisplayNumber: 0,
          isAuthenticated: true,
          displayName: 'Equal member',
          devicePlatform: 'other',
          role: 'owner',
          capabilities: [...OWNER_CAPABILITIES],
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
      memberId: MEMBER_ID,
      memberDisplayNumber: 0,
      isAuthenticated: true,
      participantId: PARTICIPANT_ID,
      presenceIncarnationId: INCARNATION_ID,
      displayName: 'Equal member',
      role: 'owner',
      capabilities: [...OWNER_CAPABILITIES],
      coordinatorEligible: false,
    },
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: [
      {
        memberId: MEMBER_ID,
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Equal member',
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

function access(): ProRoomSignalingAccess {
  return {
    ticket: `${'a'.repeat(32)}.${'B'.repeat(43)}` as ProRoomSignalingAccess['ticket'],
    expiresAtMs: 10_000,
    role: 'member',
    coordinatorEpoch: 2,
    presenceIncarnationId: INCARNATION_ID,
    ticketSequence: 1,
    pendingPlaybackTransition: null,
  };
}

async function openBridge(
  bridge: ServerProRoomNetworkBridge,
  ticketSequence = 1,
): Promise<FakeWebSocket> {
  const connecting = bridge.connect(snapshot(), { ...access(), ticketSequence });
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('fake socket was not created');
  socket.dispatch('open');
  await connecting;
  return socket;
}

function clockRequests(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.channel === 'clock');
}

function answerClockRequest(
  socket: FakeWebSocket,
  request: Record<string, unknown>,
  serverTimeMs: number,
): void {
  const payload = request.payload as Record<string, unknown>;
  socket.dispatch(
    'message',
    JSON.stringify({
      type: 'pro-clock',
      version: 1,
      requestId: payload.requestId,
      clientSentAtMs: payload.clientSentAtMs,
      serverTimeMs,
    }),
  );
}

interface Output {
  when: number;
  position: number;
  stopsAt: number;
}

const audio = vi.hoisted(() => ({
  now: 100,
  monotonicMs: 1_000,
  initDelayMs: 200,
  outputs: [] as Output[],
  init: vi.fn(),
}));

vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => audio.now,
  getAudioContext: () => ({
    state: 'running',
    get currentTime() {
      return audio.now;
    },
    createBufferSource: () => {
      let output: Output | undefined;
      return {
        buffer: null,
        connect() {},
        disconnect() {},
        start(when: number, offset: number) {
          output = { when: Math.max(audio.now, when), position: offset, stopsAt: Infinity };
          audio.outputs.push(output);
        },
        stop(when = audio.now) {
          if (output) output.stopsAt = when;
        },
        onended: null,
      };
    },
  }),
  ensureRunning: vi.fn(),
  getPendingForegroundAudioContextClockHealthCheck: () => null,
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: audio.init,
  getFilePlaybackDestination: () => ({}),
}));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn(), sendToHost: vi.fn() }));
vi.mock('../../ui/toast.ts', () => ({ showLoader: vi.fn(), showToast: vi.fn() }));

function createFileController() {
  const current = snapshot();
  const queueItemId = '40000000-0000-4000-8000-000000000001' as QueueItemId;
  current.playlist = [
    {
      queueItemId,
      name: 'Resident file',
      source: {
        kind: 'pro-r2',
        assetId: 'asset_00000001',
        version: 1,
        byteLength: 1000,
        mime: 'audio/wav',
      },
    },
  ];
  current.currentQueueItemId = queueItemId;
  current.playback = { ...current.playback, revision: 1, state: 'playing', queueItemId };
  setState('network.appRole', 'host');
  setState('network.sessionCode', ROOM_CODE);
  setState('setup.sessionStarted', true);
  setState('room.context', {
    kind: 'pro',
    roomId: ROOM_CODE,
    role: 'member',
    coordinatorId: null,
    epoch: 2,
    snapshotRevision: current.revision,
    capabilities: [],
  });
  setState('playlist.currentQueueItemId', queueItemId);
  setState('playlist.items', [
    { queueItemId, type: 'file', videoId: '', playlistId: '', name: 'a.wav' },
  ]);
  const blob = new Blob(['audio']);
  setState('files.current', {
    queueItemId,
    indexHint: 0,
    name: 'a.wav',
    sessionId: 1,
    blob,
    mime: 'audio/wav',
    size: blob.size,
  });
  setCurrentAudioBuffer({ duration: 60, sampleRate: 48_000 } as AudioBuffer);
  setPlaybackLifecycleState(PLAYBACK_STATE.READY);
  const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (request) => ({
    status: (await applyProPlaybackFileCommit(request)) ? 'applied' : 'failed',
    authority: request.authority,
  }));
  const unregister = registerProPlaybackMediaEndpoint({
    prepare: async (request) => ({
      status: 'ready',
      authority: request.authority,
      queueItemId: request.queueItemId,
      mediaKind: 'file',
      durationSeconds: 60,
      youtubeSubIndex: null,
      youtubeVideoId: null,
    }),
    commit,
  });
  const controller = new ProRoomPlaybackController({
    isActive: () => true,
    getCanonicalSnapshot: () => current,
    getPlaylistSnapshot: () => current,
    capturePlaylistLease: () => ({ generation: 1, roomCode: ROOM_CODE }),
    isPlaylistLeaseCurrent: () => true,
    getRoomAbortSignal: () => undefined,
    subscribePlaylistProjection: () => () => undefined,
    runHeartbeat: vi.fn().mockResolvedValue(undefined),
    reportPlaybackTransitionReady: vi.fn(),
    executePlaybackCommand: vi.fn(),
    recoverTerminalSession: vi.fn().mockResolvedValue(undefined),
  });
  return { controller, current, commit, unregister };
}

async function advance(ms: number) {
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(50, remaining);
    audio.now += step / 1000;
    audio.monotonicMs += step;
    await vi.advanceTimersByTimeAsync(step);
    remaining -= step;
  }
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  resetState();
  bus.clear();
  resetProPlaybackAuthorityHooks();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  audio.now = 100;
  audio.monotonicMs = 1_000;
  audio.initDelayMs = 200;
  audio.outputs = [];
  audio.init.mockReset().mockImplementation(async () => {
    if (audio.initDelayMs > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, audio.initDelayMs));
  });
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.spyOn(performance, 'now').mockImplementation(() => audio.monotonicMs);
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  (
    window as Window & { __MUSIXQUARE_TRANSPORT__?: Record<string, unknown> }
  ).__MUSIXQUARE_TRANSPORT__ = {
    provider: 'cloudflare',
    signalingUrl: 'wss://signal.example.test/api/rooms',
  };
});

afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  proRoomServerBridge.disconnect();
  resetProPlaybackAuthorityHooks();
  clearAllManagedTimers();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as Window & { __MUSIXQUARE_TRANSPORT__?: Record<string, unknown> })
    .__MUSIXQUARE_TRANSPORT__;
  resetState();
});

async function beginFileCommit() {
  const socket = await openBridge(proRoomServerBridge);
  const fixture = createFileController();
  await advance(0);
  const request = clockRequests(socket).at(-1)!;
  await advance(20);
  answerClockRequest(socket, request, Date.now() - 10);
  const executeAtMs = Date.now() + 700;
  fixture.controller.acceptCommit({
    type: 'pro-playback-commit',
    transitionId: null,
    serverTimeMs: Date.now(),
    executeAtMs,
    playback: { ...fixture.current.playback, updatedAtMs: executeAtMs },
  });
  await advance(0);
  expect(fixture.commit).toHaveBeenCalledTimes(1);
  expect(audio.init).toHaveBeenCalledTimes(1);
  return { ...fixture, socket, executeAtMs };
}

describe('PRO file COMMIT clock lease across socket close', () => {
  it.each([false, true])(
    'retains admitted file start across native initialization (unexpected close %s)',
    async (close) => {
      const fixture = await beginFileCommit();
      try {
        const request = fixture.commit.mock.calls[0]![0];
        expect(request.scheduleDelayMs).toBe(700);
        expect(request.isCurrent?.()).toBe(true);
        expect(audio.outputs).toHaveLength(0);
        await advance(50);
        if (close) fixture.socket.close();
        // The original transport resumes from its initAudio await before deciding
        // whether to create and schedule the AudioBufferSourceNode.
        await advance(150);
        expect(audio.outputs).toHaveLength(1);
        expect(audio.outputs[0]!.when).toBeCloseTo(100.72, 6);
        expect(getState('playback.activity')).toBe('playing');
        await advance(500);
        expect(audio.outputs[0]!.stopsAt).toBe(Infinity);
      } finally {
        fixture.controller.resetPlaylistRuntime();
        fixture.unregister();
      }
    },
  );

  it('does not cancel an AudioBufferSourceNode already scheduled before unexpected close', async () => {
    audio.initDelayMs = 0;
    const fixture = await beginFileCommit();
    try {
      expect(audio.outputs).toHaveLength(1);
      await advance(50);
      fixture.socket.close();
      await advance(650);
      expect(audio.outputs).toHaveLength(1);
      expect(audio.outputs[0]!.when).toBeCloseTo(100.72, 6);
      expect(audio.outputs[0]!.stopsAt).toBe(Infinity);
      expect(getState('playback.activity')).toBe('playing');
    } finally {
      fixture.controller.resetPlaylistRuntime();
      fixture.unregister();
    }
  });

  it.each(['disconnect', 'replacement', 'new-revision', 'room-reset'] as const)(
    'still cancels native initialization after %s',
    async (action) => {
      const fixture = await beginFileCommit();
      try {
        const request = fixture.commit.mock.calls[0]![0];
        expect(request.isCurrent?.()).toBe(true);
        expect(audio.outputs).toHaveLength(0);
        await advance(50);
        if (action === 'disconnect') {
          proRoomServerBridge.disconnect();
        } else if (action === 'replacement') {
          await openBridge(proRoomServerBridge, 2);
        } else if (action === 'new-revision') {
          fixture.controller.acceptCommit({
            type: 'pro-playback-commit',
            transitionId: null,
            serverTimeMs: Date.now(),
            executeAtMs: Date.now(),
            playback: {
              ...fixture.current.playback,
              revision: 2,
              state: 'paused',
              updatedAtMs: Date.now(),
            },
          });
        } else {
          fixture.controller.resetPlaylistRuntime();
        }
        expect(request.isCurrent?.()).toBe(false);
        await advance(650);
        expect(audio.outputs).toHaveLength(0);
      } finally {
        fixture.controller.resetPlaylistRuntime();
        fixture.unregister();
      }
    },
  );
});
