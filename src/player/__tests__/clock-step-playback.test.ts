/** @vitest-environment jsdom */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { IS_WINDOWS } from '../../core/platform.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { registerPing, processSyncPong, resetClockState } from '../../network/shared-clock.ts';
import { initSync } from '../../network/sync.ts';
import { initPlayback } from '../../player/playback.ts';
import { finalizeGuestFile } from '../../player/decode.ts';
import {
  getPendingPlayTime,
  setCurrentAudioBuffer,
  setPlayerNode,
  setPendingPlayTime,
} from '../../player/_state.ts';
import { setPlaybackLifecycleState } from '../../player/ownership.ts';
import { getTrackPosition, isLocalFileStartPending, stopAllMedia } from '../../player/transport.ts';
import type { DataConnection } from '../../types/index.ts';

interface Output {
  when: number;
  offset: number;
  stopped: boolean;
}
const m = vi.hoisted(() => ({
  audioNow: 100,
  mono: 1000,
  outputs: [] as Output[],
  decode: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => m.audioNow,
  getAudioContext: () => ({
    state: 'running',
    sampleRate: 48000,
    get currentTime() {
      return m.audioNow;
    },
    decodeAudioData: m.decode,
    createBufferSource: () => {
      let output: Output;
      return {
        buffer: null,
        connect() {},
        disconnect() {},
        onended: null,
        start(when: number, offset: number) {
          output = { when: Math.max(m.audioNow, when), offset, stopped: false };
          m.outputs.push(output);
        },
        stop() {
          if (output) output.stopped = true;
        },
      };
    },
  }),
  ensureRunning: vi.fn(),
  getPendingForegroundAudioContextClockHealthCheck: () => null,
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
  getFilePlaybackDestination: () => ({}),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: m.broadcast,
  sendToHost: vi.fn(),
  safeSend: vi.fn(() => true),
  isRemoteGuest: () => false,
}));
vi.mock('../../ui/toast.ts', () => ({ showLoader: vi.fn(), showToast: vi.fn() }));

const Q = '97111111-1111-4111-8111-111111111111';
const platform = IS_WINDOWS ? 0.02 : 0;
let host: DataConnection;
let decisions: unknown[];
const buffer = {
  duration: 120,
  sampleRate: 48000,
  length: 5760000,
  numberOfChannels: 1,
} as AudioBuffer;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.spyOn(performance, 'now').mockImplementation(() => m.mono);
  resetState();
  resetClockState();
  bus.clear();
  clearAllManagedTimers();
  resetInboundRateLimit('host-step');
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  setPendingPlayTime(undefined);
  m.audioNow = 100;
  m.mono = 1000;
  m.outputs = [];
  m.decode.mockReset();
  m.broadcast.mockReset();
  decisions = [];
  host = {
    open: true,
    peer: 'host-step',
    send: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('network.hostConn', host);
  setState('network.connectionType', 'local');
  markQueueAuthorityReady(host);
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'member',
    coordinatorId: 'host-step',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: [],
  });
  setState('playlist.items', [
    { queueItemId: Q, type: 'file', name: 'step.mp3', videoId: '', playlistId: '' },
  ]);
  setState('playlist.currentQueueItemId', Q);
  setState('files.current', {
    queueItemId: Q,
    indexHint: 0,
    name: 'step.mp3',
    sessionId: 1,
    blob: new Blob([new Uint8Array([1, 2, 3])]),
    mime: 'audio/mpeg',
    size: 3,
  });
  setCurrentAudioBuffer(buffer);
  setPlaybackLifecycleState(PLAYBACK_STATE.READY);
  initPlayback();
  initSync();
  bus.on('sync:diagnostic-standard-decision', (event) => decisions.push(event));
});
afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function advance(ms: number) {
  m.audioNow += ms / 1000;
  m.mono += ms;
  await vi.advanceTimersByTimeAsync(ms);
}
async function calibrate() {
  for (let i = 1; i <= 3; i++) {
    registerPing(i);
    const sent = Date.now();
    await advance(4);
    processSyncPong(i, sent + 2);
  }
}
async function pong(id: number, hostNow: number, position: number) {
  registerPing(id);
  await advance(8);
  await handleData(
    {
      type: MSG.SYNC_PONG,
      pingId: id,
      hostTime: hostNow + 4,
      position: position + 0.004,
      mode: 'file',
      activity: 'playing',
      queueItemId: Q,
    },
    host,
  );
}
function outputPosition() {
  const output = m.outputs.findLast((x) => !x.stopped && x.when <= m.audioNow);
  return output ? output.offset + m.audioNow - output.when : null;
}

it.each([0, -1000, 1000, -5000, 5000])(
  'public PONG maintains aligned output after guest wall step %i',
  async (step) => {
    await calibrate();
    const startWall = Date.now();
    await handleData(
      { type: MSG.PLAY, queueItemId: Q, time: 10, hostStartAt: startWall + 200 },
      host,
    );
    await advance(1500);
    const canonicalBefore = 11.3;
    const hostBefore = Date.now();
    vi.setSystemTime(Date.now() + step);
    await pong(100, hostBefore, canonicalBefore);
    expect(getTrackPosition()).toBeCloseTo(canonicalBefore + 0.008, 3);
    expect(outputPosition()! - platform).toBeCloseTo(canonicalBefore + 0.008, 3);
  },
);

it.each([-1000, 1000])(
  'a local step %i keeps aligned output across later samples and cold resync',
  async (step) => {
    await calibrate();
    const origin = Date.now();
    await handleData({ type: MSG.PLAY, queueItemId: Q, time: 10, hostStartAt: origin + 200 }, host);
    await advance(1500);
    vi.setSystemTime(Date.now() + step);
    for (let id = 100; id < 120; id++) {
      const hostNow = Date.now() - step;
      const canonical = 10 + (hostNow - origin - 200) / 1000;
      await pong(id, hostNow, canonical);
      const error = getTrackPosition() - (canonical + 0.008);
      expect(error).toBeCloseTo(0, 3);
      await advance(992);
    }
    bus.emit('sync:force-resync');
    const canonical = 10 + (Date.now() - step - origin - 200) / 1000;
    await pong(500, Date.now() - step, canonical);
    expect(getTrackPosition()).toBeCloseTo(canonical + 0.008, 3);
  },
);

it.each([0, -5000, 5000])(
  'public PLAY then decoder completion maintains timeline after wall step %i',
  async (step) => {
    await calibrate();
    setCurrentAudioBuffer(null);
    setState('files.current', null);
    setPlaybackLifecycleState(PLAYBACK_STATE.DECODING);
    setState('transfer.localSessionId', 7);
    setState('transfer.meta', {
      queueItemId: Q,
      indexHint: 0,
      name: 'step.mp3',
      type: 'audio/mpeg',
      mime: 'audio/mpeg',
      size: 3,
      total: 1,
      sessionId: 7,
    });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    // jsdom lacks Blob.arrayBuffer; slices used by the actual admission probe need the same browser API shim.
    const nativeSlice = blob.slice.bind(blob);
    Object.defineProperty(blob, 'slice', {
      value: (...args: Parameters<Blob['slice']>) => {
        const slice = nativeSlice(...args);
        Object.defineProperty(slice, 'arrayBuffer', {
          value: async () => new Uint8Array([1, 2, 3]).buffer,
        });
        return slice;
      },
    });
    const startWall = Date.now();
    await handleData(
      { type: MSG.PLAY, queueItemId: Q, time: 0, hostStartAt: startWall + 200 },
      host,
    );
    expect(getPendingPlayTime()).toBe(0);
    let decodeReached = false;
    m.decode.mockImplementationOnce(async () => {
      decodeReached = true;
      await advance(600);
      vi.setSystemTime(Date.now() + step);
      return buffer;
    });
    await finalizeGuestFile(blob, Q, 7);
    expect(decodeReached).toBe(true);
    expect(m.outputs.length).toBeGreaterThan(0);
    // The first native schedule is already correct; a later PONG must not
    // hide a premature five-second catch-up or a stale future deadline.
    expect(isLocalFileStartPending()).toBe(false);
    expect(getTrackPosition()).toBeCloseTo(0.4, 3);
    expect(outputPosition()! - platform).toBeCloseTo(0.4, 3);
    await pong(100, startWall + 600, 0.4);
    expect(isLocalFileStartPending()).toBe(false);
    expect(getTrackPosition()).toBeCloseTo(0.408, 3);
  },
);

it('public offset edit during shared lead then pause cancels every delayed source', async () => {
  await calibrate();
  bus.emit('sync:set-manual-offset', -9999);
  await handleData(
    { type: MSG.PLAY, queueItemId: Q, time: 0, hostStartAt: Date.now() + 200 },
    host,
  );
  await advance(75);
  bus.emit('sync:set-manual-offset', 9999);
  await advance(0);
  expect(getTrackPosition()).toBe(0);
  await handleData({ type: MSG.PAUSE, queueItemId: Q, time: 0 }, host);
  await advance(12000);
  expect(m.outputs.every((x) => x.stopped)).toBe(true);
  expect(outputPosition()).toBeNull();
  expect(m.broadcast).not.toHaveBeenCalled();
});
