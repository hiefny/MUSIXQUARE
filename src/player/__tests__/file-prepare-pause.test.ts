/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { CloudflareDataConnection } from '../../network/transport/cloudflare-signaling.ts';

import { initPlayback } from '../playback.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import {
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
  unicastPreload,
} from '../../storage/preload.ts';
import { resetAllStoredFiles } from '../../storage/storage.ts';

const CURRENT = '30000000-0000-4000-8000-000000000001';
const NEXT = '30000000-0000-4000-8000-000000000002';
const SID = 17;
type Sender = 'unicast' | 'broadcast';
let deliveries: Promise<void>[] = [];

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  sent: Array<string | ArrayBuffer> = [];

  constructor(readonly label: string) {
    super();
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  deliver(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function connection(id: string) {
  const transport = new CloudflareDataConnection(id);
  const pc = Object.assign(new EventTarget(), {
    connectionState: 'connected',
    iceConnectionState: 'connected',
  });
  const bulk = new Channel('musixquare-data');
  const control = new Channel('musixquare-control');
  transport.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
  transport.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  return { transport, conn: transport as unknown as DataConnection, bulk, control };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  deliveries = [];
  resetState();
  bus.clear();
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  resetFileDeliveryPolicies();
  initPreload();
  initPlayback();
});

afterEach(async () => {
  await Promise.all(deliveries);
  resetPreloadReceiveAuthority();
  resetAllStoredFiles();
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
});

async function setupWire(senderMode: Sender, legacyControlEnd: boolean) {
  // Four queued 64 KiB chunks fit the sender's bounded 256 KiB bulk tail.
  // A healthy slow receiver can need longer than 10 s to receive that tail.
  const file = new File([new Uint8Array(4 * CHUNK_SIZE).fill(7)], 'next.mp3', {
    type: 'audio/mpeg',
  });
  setState('playlist.items', [
    {
      queueItemId: CURRENT,
      name: 'current.mp3',
      type: 'file',
      videoId: null,
      playlistId: null,
    },
    { queueItemId: NEXT, name: file.name, type: 'file', file, videoId: null, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', CURRENT);
  if (senderMode === 'unicast') {
    const meta = {
      queueItemId: NEXT,
      name: file.name,
      mime: file.type,
      size: file.size,
      total: 4,
      sessionId: SID,
      indexHint: 1,
    };
    setState('preload.ready', { ...meta, blob: file });
    setState('preload.activeTarget', meta);
    setState('preload.nextQueueItemId', NEXT);
  }
  const sender = connection('guest');
  await vi.advanceTimersByTimeAsync(0);
  expect(sender.conn.open).toBe(true);
  const peer: ConnectedPeer = {
    id: 'guest',
    conn: sender.conn,
    status: 'connected',
    connectionType: 'local',
    isDataTarget: true,
    preloadedQueueItemIds: new Set(),
    slot: 1,
    label: 'guest',
    isOp: false,
    joinOrder: 1,
    lastHeartbeat: 0,
  };
  setState('network.connectedPeers', [peer]);
  setState('network.activeHostConnByPeerId', new Map([['guest', sender.conn]]));

  // Use actual senders, priority gates, binary codec and channel selection.
  if (senderMode === 'unicast') await unicastPreload(sender.conn, file, NEXT, SID);
  else {
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(sender.control.sent.map((frame) => JSON.parse(frame as string).type)).toEqual([
    MSG.PRELOAD_START,
  ]);
  expect(sender.bulk.sent).toHaveLength(5);
  const chunks = sender.bulk.sent.slice(0, 4);
  expect(chunks.every((frame) => frame instanceof ArrayBuffer)).toBe(true);
  const end = sender.bulk.sent[4] as string;
  expect(JSON.parse(end).type).toBe(MSG.PRELOAD_END);
  const start = sender.control.sent[0] as string;
  const sessionId = JSON.parse(start).sessionId as number;

  resetPreloadReceiveAuthority();
  resetAllStoredFiles();
  resetFileDeliveryPolicies();
  setState('files.current', null);
  setState('network.connectedPeers', []);
  setState('playlist.items', createPlaylistSnapshot().list);
  const receiver = connection('host');
  await vi.advanceTimersByTimeAsync(0);
  setState('network.appRole', 'guest');
  setState('network.connectionType', 'local');
  setState('network.hostConn', receiver.conn);
  markQueueAuthorityReady(receiver.conn);
  receiver.transport.on('data', (frame) => {
    deliveries.push(handleData(frame, receiver.conn));
  });
  receiver.control.deliver(start);
  // Older clients send END on control. RTC only orders within each channel,
  // so its END can arrive before every chunk on a slower bulk channel.
  if (legacyControlEnd) receiver.control.deliver(end);
  await vi.advanceTimersByTimeAsync(0);
  return { receiver, file, sessionId, start, chunks, end };
}

type Wire = Awaited<ReturnType<typeof setupWire>>;

async function deliver(wire: Wire, chunk: string | ArrayBuffer): Promise<void> {
  wire.receiver.bulk.deliver(chunk);
  await vi.advanceTimersByTimeAsync(0);
}

// Native audio decoding and output are controllable boundaries. Everything from
// real dual-channel wire through RAM admission, queue, preload/decode and play
// transport remains production code.
import { initPlaylist } from '../playlist.ts';
import { getCurrentAudioBuffer, setCurrentAudioBuffer } from '../_state.ts';
import { stopAllMedia } from '../transport.ts';

import { createPlaylistSnapshot } from '../queue-model.ts';
const h = vi.hoisted(() => ({
  large: false,
  decode: vi.fn(),
  openLarge: vi.fn(),
  starts: vi.fn(),
  outputs: [] as any[],
  pending: [] as Array<(v: any) => void>,
}));
vi.mock('../../audio/context.ts', () => ({
  getAudioContext: () => ({
    state: 'running',
    sampleRate: 48000,
    currentTime: 100,
    decodeAudioData: h.decode,
    createBufferSource: () => ({
      buffer: null,
      connect() {},
      disconnect() {},
      stop() {},
      start: h.starts,
      onended: null,
    }),
  }),
  ensureRunning: async () => {},
  getCurrentTime: () => 100,
  getPendingForegroundAudioContextClockHealthCheck: () => null,
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: async () => {},
  getFilePlaybackDestination: () => ({}),
}));
vi.mock('../large-file-policy.ts', () => ({ shouldUseLargeFileEngine: () => h.large }));
vi.mock('../large-audio/index.ts', () => ({ openLargeAudioTrack: h.openLarge }));
const small = () => ({ duration: 120, sampleRate: 48000, length: 5760000, numberOfChannels: 2 });
const large = () => ({
  ...small(),
  kind: 'large-audio',
  bufferedPcmBytes: 4096,
  prepare: async () => {},
  dispose: vi.fn(),
  createPlayback: (opts: any) => {
    h.outputs.push(opts);
    return { ended: false, stop: vi.fn(), disconnect: vi.fn() };
  },
});
beforeEach(() => {
  resetInboundRateLimit('host');
  h.large = false;
  h.outputs = [];
  h.pending = [];
  setCurrentAudioBuffer(null);
  h.decode.mockImplementation(() => new Promise((resolve) => h.pending.push(resolve)));
  h.openLarge.mockImplementation(() => new Promise((resolve) => h.pending.push(resolve)));
  initPlaylist();
  registerSystemAudioGuestListeners();
});
afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
});
async function pump() {
  await vi.advanceTimersByTimeAsync(0);
}
async function selectWire(wire: Wire) {
  await handleData(
    { type: MSG.PLAY_PRELOADED, queueItemId: NEXT, name: wire.file.name },
    wire.receiver.conn,
  );
  await handleData(
    { type: MSG.PLAY, queueItemId: NEXT, name: wire.file.name, time: 12 },
    wire.receiver.conn,
  );
  for (const chunk of wire.chunks) await deliver(wire, chunk);
  await deliver(wire, wire.end);
  await pump();
  expect(h.pending).toHaveLength(1);
}
async function completeDecode() {
  h.pending.shift()!(h.large ? large() : small());
  await pump();
}
function hasOutput() {
  return h.large ? h.outputs.length > 0 : h.starts.mock.calls.length > 0;
}
const cases = [
  'normal',
  'pause',
  'pause-resume',
  'paused-seek',
  'playing-seek',
  'remove-selected',
  'remove-outgoing',
  'reorder',
  'system-audio',
  'unauthorized-pause',
  'stale-pause',
] as const;
describe.each(['small', 'large'] as const)(
  '%s decoded preload with actual channel bytes',
  (engine) => {
    it.each(cases)('%s during asynchronous decode', async (scenario) => {
      h.large = engine === 'large';
      const wire = await setupWire('unicast', false);
      await selectWire(wire);
      expect(getState('playlist.currentQueueItemId')).toBe(NEXT);
      if (scenario === 'pause' || scenario === 'pause-resume' || scenario === 'paused-seek') {
        await handleData(
          { type: MSG.PAUSE, queueItemId: NEXT, time: 18, reason: 'pause' },
          wire.receiver.conn,
        );
      }
      if (scenario === 'pause-resume' || scenario === 'playing-seek') {
        await handleData({ type: MSG.PLAY, queueItemId: NEXT, time: 42 }, wire.receiver.conn);
      }
      if (scenario === 'paused-seek')
        await handleData(
          { type: MSG.PAUSE, queueItemId: NEXT, time: 55, reason: 'seek' },
          wire.receiver.conn,
        );
      if (
        scenario === 'remove-selected' ||
        scenario === 'remove-outgoing' ||
        scenario === 'reorder'
      ) {
        const snapshot = createPlaylistSnapshot();
        const list =
          scenario === 'reorder'
            ? [...snapshot.list].reverse()
            : snapshot.list.filter(
                (i) => i.queueItemId !== (scenario === 'remove-selected' ? NEXT : CURRENT),
              );
        await handleData(
          {
            ...snapshot,
            type: MSG.PLAYLIST_UPDATE,
            list,
            revision: snapshot.revision + 1,
            currentQueueItemId: scenario === 'remove-selected' ? CURRENT : NEXT,
          },
          wire.receiver.conn,
        );
      }
      if (scenario === 'system-audio')
        await handleData({ type: MSG.SYSTEM_AUDIO_START }, wire.receiver.conn);
      if (scenario === 'unauthorized-pause')
        await handleData({ type: MSG.PAUSE, queueItemId: NEXT, time: 1, reason: 'pause' }, {
          peer: 'evil',
          open: true,
          send: vi.fn(),
        } as any);
      if (scenario === 'stale-pause')
        await handleData(
          { type: MSG.PAUSE, queueItemId: CURRENT, time: 1, reason: 'pause' },
          wire.receiver.conn,
        );
      await completeDecode();
      const stopped = ['pause', 'paused-seek', 'remove-selected', 'system-audio'].includes(
        scenario,
      );
      expect.soft(hasOutput()).toBe(!stopped);
      if (scenario === 'pause' || scenario === 'paused-seek') {
        expect.soft(getState('player.pausedAt')).toBe(scenario === 'pause' ? 18 : 55);
        expect.soft(getCurrentAudioBuffer()).not.toBeNull();
        expect.soft(getState('playback.activity')).not.toBe('playing');
      }
      if (!stopped) expect.soft(getState('playback.activity')).toBe('playing');
      if (scenario === 'remove-selected' || scenario === 'system-audio')
        expect.soft(getCurrentAudioBuffer()).toBeNull();
      if (scenario === 'pause-resume' || scenario === 'playing-seek') {
        const offset = h.large ? h.outputs.at(-1)?.offset : h.starts.mock.calls.at(-1)?.[1];
        expect.soft(offset).toBeCloseTo(42, 1);
      }
    });
  },
);

import { initTransfer, resetIncomingTransferAuthority } from '../../storage/transfer.ts';
import {
  broadcastFile,
  cancelOutgoingFileTransfers,
  sendFilePrepareByDelivery,
} from '../../storage/transfer-send.ts';
import * as peer from '../../network/peer.ts';
async function setupDirectWire(bootstrapPaused = false) {
  resetIncomingTransferAuthority();
  initTransfer();
  const file = new File([new Uint8Array(CHUNK_SIZE + 3).fill(17)], 'next.mp3', {
    type: 'audio/mpeg',
  });
  setState('playlist.items', [
    { queueItemId: CURRENT, name: 'current.mp3', type: 'file', videoId: null, playlistId: null },
    { queueItemId: NEXT, name: file.name, type: 'file', file, videoId: null, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', NEXT);
  setState('files.current', {
    queueItemId: NEXT,
    name: file.name,
    blob: file,
    size: file.size,
    mime: file.type,
    sessionId: SID,
    indexHint: 1,
  });
  setState('transfer.currentSessionId', SID);
  const sender = connection('guest');
  await pump();
  const cp = {
    id: 'guest',
    conn: sender.conn,
    status: 'connected',
    connectionType: 'local',
    isDataTarget: true,
    preloadedQueueItemIds: new Set(),
    slot: 1,
    label: 'guest',
    isOp: false,
    joinOrder: 1,
    lastHeartbeat: 0,
  } as ConnectedPeer;
  setState('network.connectedPeers', [cp]);
  setState('network.activeHostConnByPeerId', new Map([['guest', sender.conn]]));
  if (bootstrapPaused) {
    setCurrentAudioBuffer(small() as any);
    setPlaybackFilePaused();
    setState('player.pausedAt', 18);
    bus.emit('network:peer-connected', sender.conn);
  }
  sendFilePrepareByDelivery(
    {
      type: MSG.FILE_PREPARE,
      queueItemId: NEXT,
      name: file.name,
      size: file.size,
      mime: file.type,
      sessionId: SID,
    },
    SID,
  );
  const sending = broadcastFile(file, NEXT, SID);
  await vi.advanceTimersByTimeAsync(50);
  await sending;
  expect(sender.control.sent.map((f) => JSON.parse(f as string).type)).toEqual(
    bootstrapPaused
      ? [MSG.PAUSE, MSG.FILE_PREPARE, MSG.FILE_START]
      : [MSG.FILE_PREPARE, MSG.FILE_START],
  );
  expect(sender.bulk.sent).toHaveLength(3);
  const snapshot = createPlaylistSnapshot();
  cancelOutgoingFileTransfers();
  resetIncomingTransferAuthority();
  resetAllStoredFiles();
  resetFileDeliveryPolicies();
  setCurrentAudioBuffer(null);
  setPlaybackIdle();
  setState('files.current', null);
  setState('transfer.meta', null);
  setState('transfer.currentSessionId', 0);
  setState('transfer.localSessionId', 0);
  setState('network.connectedPeers', []);
  setState('playlist.items', snapshot.list);
  setState('playlist.currentQueueItemId', CURRENT);
  const receiver = connection('host');
  await pump();
  setState('network.appRole', 'guest');
  setState('network.hostConn', receiver.conn);
  setState('network.connectionType', 'local');
  markQueueAuthorityReady(receiver.conn);
  receiver.transport.on('data', (frame) => deliveries.push(handleData(frame, receiver.conn)));
  return {
    receiver,
    file,
    bootstrap: bootstrapPaused ? sender.control.sent[0] : undefined,
    prepare: sender.control.sent[bootstrapPaused ? 1 : 0]!,
    start: sender.control.sent[bootstrapPaused ? 2 : 1]!,
    bulk: sender.bulk.sent,
  };
}
it.each([
  'normal-prepare',
  'route-pending-pause',
  'route-pending-seek',
  'route-pending-pause-resume',
  'route-pending-stale-pause',
  'route-pending-unauthorized-pause',
] as const)('direct local file %s', async (scenario) => {
  const wire = await setupDirectWire();
  let resolveRoute!: (r: 'local' | 'remote') => void;
  const route = vi.spyOn(peer, 'waitForGuestConnectionType');
  try {
    if (scenario !== 'normal-prepare') {
      setState('network.connectionType', 'unknown');
      route.mockImplementationOnce(() => new Promise((resolve) => (resolveRoute = resolve)));
    }
    wire.receiver.control.deliver(wire.prepare);
    await pump();
    wire.receiver.control.deliver(wire.start);
    await pump();
    await handleData({ type: MSG.PLAY, queueItemId: NEXT, time: 12 }, wire.receiver.conn);
    const pauseConn =
      scenario === 'route-pending-unauthorized-pause'
        ? ({ peer: 'evil', open: true, send: vi.fn() } as any)
        : wire.receiver.conn;
    const pauseQid = scenario === 'route-pending-stale-pause' ? CURRENT : NEXT;
    await handleData(
      {
        type: MSG.PAUSE,
        queueItemId: pauseQid,
        time: scenario === 'route-pending-seek' ? 55 : 18,
        reason: scenario === 'route-pending-seek' ? 'seek' : 'pause',
      },
      pauseConn,
    );
    if (scenario === 'route-pending-pause-resume')
      await handleData({ type: MSG.PLAY, queueItemId: NEXT, time: 42 }, wire.receiver.conn);
    if (scenario !== 'normal-prepare') {
      setState('network.connectionType', 'local');
      resolveRoute('local');
      await pump();
    }
    for (const chunk of wire.bulk) {
      wire.receiver.bulk.deliver(chunk);
      await pump();
    }
    expect(h.pending).toHaveLength(1);
    await completeDecode();
    const resumed = [
      'route-pending-pause-resume',
      'route-pending-stale-pause',
      'route-pending-unauthorized-pause',
    ].includes(scenario);
    expect.soft(hasOutput()).toBe(resumed);
    if (!resumed)
      expect.soft(getState('player.pausedAt')).toBe(scenario === 'route-pending-seek' ? 55 : 18);
    expect.soft(getCurrentAudioBuffer()).not.toBeNull();
  } finally {
    route.mockRestore();
  }
});

import { initSync } from '../../network/sync.ts';
import { registerPing, resetClockState } from '../../network/shared-clock.ts';
import { togglePlay, getTrackPosition } from '../transport.ts';
import { setPlaybackFilePaused, setPlaybackIdle } from '../ownership.ts';
it.each([false, true])(
  'operator resume through real wire retains checkpoint after route await=%s',
  async (suspended) => {
    const wire = await setupDirectWire();
    let resolveRoute!: (r: 'local' | 'remote') => void;
    const route = vi.spyOn(peer, 'waitForGuestConnectionType');
    try {
      if (suspended) {
        setState('network.connectionType', 'unknown');
        route.mockImplementationOnce(() => new Promise((resolve) => (resolveRoute = resolve)));
      }
      wire.receiver.control.deliver(wire.prepare);
      await pump();
      wire.receiver.control.deliver(wire.start);
      await pump();
      await handleData({ type: MSG.PLAY, queueItemId: NEXT, time: 12 }, wire.receiver.conn);
      await handleData(
        { type: MSG.PAUSE, queueItemId: NEXT, time: 18, reason: 'pause' },
        wire.receiver.conn,
      );
      expect(getState('player.pausedAt')).toBe(18);
      if (suspended) {
        setState('network.connectionType', 'local');
        resolveRoute('local');
        await pump();
      }
      for (const frame of wire.bulk) {
        wire.receiver.bulk.deliver(frame);
        await pump();
      }
      expect(h.pending).toHaveLength(1);
      await completeDecode();
      expect(hasOutput()).toBe(false);
      // Three authenticated canonical paused snapshots, after completion, do not
      // repair this position: sync.ts intentionally skips non-playing file pongs.
      resetClockState();
      initSync();
      for (let id = 601; id <= 603; id++) {
        registerPing(id);
        await vi.advanceTimersByTimeAsync(50);
        await handleData(
          {
            type: MSG.SYNC_PONG,
            pingId: id,
            hostTime: Date.now(),
            position: 18,
            mode: 'file',
            activity: 'paused',
            queueItemId: NEXT,
          },
          wire.receiver.conn,
        );
      }
      expect.soft(getTrackPosition()).toBe(18);
      // Non-operators remain silent. Grant standard OP as a real room would and
      // invoke the same exported function wired to the player controls button.
      setState('network.isOperator', true);
      togglePlay();
      await pump();
      const request = wire.receiver.control.sent
        .map((f) => (typeof f === 'string' ? JSON.parse(f) : null))
        .find((m) => m?.type === MSG.REQUEST_PLAY);
      expect(request).toBeDefined();
      expect.soft(request.time).toBe(18);
      // Switch the one-process harness back to host; transport and permission
      // dispatch are real, and the received request is exactly what OP emitted.
      const opConn = connection('operator');
      await pump();
      const operator = {
        id: opConn.conn.peer,
        conn: opConn.conn,
        status: 'connected',
        connectionType: 'local',
        isDataTarget: true,
        isOp: true,
        preloadedQueueItemIds: new Set(),
        slot: 1,
        label: 'op',
        joinOrder: 1,
        lastHeartbeat: 0,
      } as ConnectedPeer;
      setState('network.hostConn', null);
      setState('network.appRole', 'host');
      setState('network.sessionCode', '123456');
      setState('setup.sessionStarted', true);
      setState('network.connectedPeers', [operator]);
      setState('network.activeHostConnByPeerId', new Map([[opConn.conn.peer, opConn.conn]]));
      setPlaybackFilePaused();
      setState('player.pausedAt', 18);
      await handleData(request, opConn.conn);
      await pump();
      const canonical = opConn.control.sent
        .map((f) => (typeof f === 'string' ? JSON.parse(f) : null))
        .find((m) => m?.type === MSG.PLAY);
      expect(canonical).toBeDefined();
      expect.soft(canonical.time).toBe(18);
      expect.soft(h.starts.mock.calls.at(-1)?.[1]).toBeCloseTo(18, 1);
    } finally {
      route.mockRestore();
      resetClockState();
    }
  },
);

it('real paused late-join bootstrap retains checkpoint through subsequently sent file preparation', async () => {
  const wire = await setupDirectWire(true);
  setState('playlist.currentQueueItemId', NEXT); // authoritative queue bootstrap
  expect(JSON.parse(wire.bootstrap as string)).toMatchObject({
    type: MSG.PAUSE,
    time: 18,
    queueItemId: NEXT,
    reason: 'pause',
  });
  wire.receiver.control.deliver(wire.bootstrap!);
  await pump();
  expect(getState('player.pausedAt')).toBe(18);
  wire.receiver.control.deliver(wire.prepare);
  await pump();
  wire.receiver.control.deliver(wire.start);
  await pump();
  for (const frame of wire.bulk) {
    wire.receiver.bulk.deliver(frame);
    await pump();
  }
  expect(h.pending).toHaveLength(1);
  await completeDecode();
  expect(hasOutput()).toBe(false);
  expect.soft(getState('player.pausedAt')).toBe(18);
  expect.soft(getTrackPosition()).toBe(18);
});

import {
  registerSystemAudioGuestListeners,
  cleanupGuestSystemAudio,
} from '../../network/system-audio-guest.ts';
import * as r2 from '../../share/r2-client.ts';
import { cancelRemoteShareWait } from '../../share/remote-share.ts';
afterEach(() => cleanupGuestSystemAudio());
it.each(['small', 'large'] as const)(
  'remote safety fallback then late local direct preserves paused checkpoint (%s)',
  async (engine) => {
    h.large = engine === 'large';
    const wire = await setupDirectWire();
    const configured = vi.spyOn(r2, 'isRemoteShareConfigured').mockReturnValue(true);
    let resolveRoute!: (r: 'local' | 'remote') => void;
    const route = vi
      .spyOn(peer, 'waitForGuestConnectionType')
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRoute = resolve)));
    try {
      setState('network.connectionType', 'unknown');
      wire.receiver.control.deliver(wire.prepare);
      await pump();
      await handleData({ type: MSG.PLAY, queueItemId: NEXT, time: 12 }, wire.receiver.conn);
      await handleData(
        { type: MSG.PAUSE, queueItemId: NEXT, time: 18, reason: 'pause' },
        wire.receiver.conn,
      );
      resolveRoute('remote');
      await pump();
      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
      expect(getState('player.pausedAt')).toBe(18);
      // The remote safety decision is not a persistent R2 delivery assignment;
      // a later authenticated local start can promote this exact wait.
      setState('network.connectionType', 'local');
      wire.receiver.control.deliver(wire.start);
      await pump();
      for (const frame of wire.bulk) {
        wire.receiver.bulk.deliver(frame);
        await pump();
      }
      expect(h.pending).toHaveLength(1);
      await completeDecode();
      expect(hasOutput()).toBe(false);
      expect(getState('player.pausedAt')).toBe(18);
      expect(getState('files.current')?.queueItemId).toBe(NEXT);
    } finally {
      configured.mockRestore();
      route.mockRestore();
      cancelRemoteShareWait('qa-cleanup');
    }
  },
);

it.each(['small', 'large'] as const)(
  'preserves host pause when FILE_PREPARE promotes a completed preload (%s)',
  async (engine) => {
    h.large = engine === 'large';
    const wire = await setupWire('unicast', false);
    for (const frame of [...wire.chunks, wire.end]) await deliver(wire, frame);
    expect(getState('preload.ready')?.queueItemId).toBe(NEXT);
    setState('playlist.currentQueueItemId', NEXT);
    await handleData(
      { type: MSG.PAUSE, queueItemId: NEXT, time: 28, reason: 'pause' },
      wire.receiver.conn,
    );
    initTransfer();
    await handleData(
      {
        type: MSG.FILE_PREPARE,
        queueItemId: NEXT,
        sessionId: wire.sessionId,
        name: wire.file.name,
        size: wire.file.size,
        mime: wire.file.type,
      },
      wire.receiver.conn,
    );
    await pump();
    expect(h.pending).toHaveLength(1);
    await completeDecode();
    expect(getState('player.pausedAt')).toBe(28);
    expect(hasOutput()).toBe(false);
    expect(getState('files.current')?.queueItemId).toBe(NEXT);
  },
);

it('preserves the latest pause through same-session PREPARE recovery with a live receive prefix', async () => {
  const wire = await setupDirectWire();
  wire.receiver.control.deliver(wire.prepare);
  await pump();
  wire.receiver.control.deliver(wire.start);
  await pump();
  wire.receiver.bulk.deliver(wire.bulk[0]!);
  await pump();
  expect(getState('transfer.receivedCount')).toBe(1);
  await handleData(
    { type: MSG.PAUSE, queueItemId: NEXT, time: 23, reason: 'pause' },
    wire.receiver.conn,
  );
  wire.receiver.control.deliver(wire.prepare);
  await pump();
  expect(getState('transfer.receivedCount')).toBe(1);
  expect(getState('player.pausedAt')).toBe(23);
  for (const frame of wire.bulk.slice(1)) {
    wire.receiver.bulk.deliver(frame);
    await pump();
  }
  expect(h.pending).toHaveLength(1);
  await completeDecode();
  expect(getState('player.pausedAt')).toBe(23);
  expect(hasOutput()).toBe(false);
});

it.each([
  'new-session',
  'new-queue',
  'new-connection',
  'new-room',
  'cancelled-load',
  'untrusted-position',
  'local-position-change',
  'end-of-playlist',
] as const)('does not carry a prior pause through %s', async (boundary) => {
  const wire = await setupDirectWire();
  const prepare = JSON.parse(wire.prepare as string);
  setState('playlist.currentQueueItemId', NEXT);
  if (boundary === 'new-session') {
    await handleData(prepare, wire.receiver.conn);
  }
  if (boundary === 'untrusted-position') setState('player.pausedAt', 18);
  else
    await handleData(
      { type: MSG.PAUSE, queueItemId: NEXT, time: 18, reason: 'pause' },
      wire.receiver.conn,
    );
  let active = wire.receiver.conn;
  if (boundary === 'new-session') prepare.sessionId += 1;
  if (boundary === 'new-queue') {
    prepare.queueItemId = CURRENT;
    prepare.name = 'current.mp3';
  }
  if (boundary === 'new-connection') {
    active = connection('replacement-host').conn;
    await pump();
    setState('network.hostConn', active);
    markQueueAuthorityReady(active);
  }
  if (boundary === 'new-room') setState('network.sessionCode', '654321');
  if (boundary === 'cancelled-load') stopAllMedia({ cancelInFlight: true });
  if (boundary === 'local-position-change') setState('player.pausedAt', 44);
  if (boundary === 'end-of-playlist') {
    await handleData(
      { type: MSG.PAUSE, queueItemId: null, time: 0, endOfPlaylist: true, reason: 'stop' },
      wire.receiver.conn,
    );
    setState('playlist.currentQueueItemId', NEXT);
  }
  await handleData(prepare, active);
  expect(getState('player.pausedAt')).toBe(0);
  expect(getState('playback.pendingPlayTime')).toBeUndefined();
  expect(hasOutput()).toBe(false);
});

it.each(['unauthorized', 'stale-queue'] as const)(
  'does not replace an accepted pause with a later %s pause',
  async (kind) => {
    const wire = await setupDirectWire();
    setState('playlist.currentQueueItemId', NEXT);
    await handleData(
      { type: MSG.PAUSE, queueItemId: NEXT, time: 18, reason: 'pause' },
      wire.receiver.conn,
    );
    const conn = kind === 'unauthorized' ? connection('attacker').conn : wire.receiver.conn;
    await pump();
    await handleData(
      {
        type: MSG.PAUSE,
        queueItemId: kind === 'stale-queue' ? CURRENT : NEXT,
        time: 99,
        reason: 'seek',
      },
      conn,
    );
    wire.receiver.control.deliver(wire.prepare);
    await pump();
    expect(getState('player.pausedAt')).toBe(18);
  },
);
