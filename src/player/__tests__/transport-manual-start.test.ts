/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { IS_WINDOWS } from '../../core/platform.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { registerPing, resetClockState } from '../../network/shared-clock.ts';
import { initSync } from '../../network/sync.ts';
import { createProPlaybackAuthorityToken } from '../../pro-room/playback-authority-hooks.ts';
import type { DataConnection } from '../../types/index.ts';
import {
  getCurrentAudioBuffer,
  getPlayerNode,
  setCurrentAudioBuffer,
  setPlayerNode,
} from '../_state.ts';
import { initPlayback } from '../playback.ts';
import { BoundedAudioTrack } from '../large-audio/bounded-track.ts';
import { setPlaybackLifecycleState, setPlaybackYouTubePlaying } from '../ownership.ts';
import type { LargeAudioTrack } from '../file-playback-resource.ts';
import {
  adjustSync,
  applyProPlaybackFileCommit,
  getLocalFilePendingStartDeadlineMs,
  getTrackPosition,
  pause,
  play,
  setLocalManualSyncOffset,
  startHostFileAndBroadcastPlay,
  stopAllMedia,
} from '../transport.ts';

interface Output {
  when: number;
  position: number;
  stopsAt: number;
}

const mocks = vi.hoisted(() => ({
  audioNow: 100,
  monotonicMs: 1_000,
  outputs: [] as Output[],
  broadcast: vi.fn(),
}));

vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => mocks.audioNow,
  getAudioContext: () => ({
    state: 'running',
    get currentTime() {
      return mocks.audioNow;
    },
    createBufferSource: () => {
      let output: Output | undefined;
      return {
        buffer: null as (AudioBuffer & { timelineStart?: number }) | null,
        connect() {},
        disconnect() {},
        start(when: number, offset: number) {
          output = {
            when: Math.max(mocks.audioNow, when),
            position: offset + (this.buffer?.timelineStart ?? 0),
            stopsAt: Infinity,
          };
          mocks.outputs.push(output);
        },
        stop(when = mocks.audioNow) {
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
  initAudio: vi.fn(),
  getFilePlaybackDestination: () => ({}),
}));
vi.mock('../../network/peer.ts', () => ({ broadcast: mocks.broadcast, sendToHost: vi.fn() }));
vi.mock('../../ui/toast.ts', () => ({ showLoader: vi.fn(), showToast: vi.fn() }));

const QUEUE_ITEM_ID = '97111111-1111-4111-8111-111111111111';
const platformOffset = IS_WINDOWS ? 0.02 : 0;
const roles = ['host', 'guest', 'pro', 'demo'] as const;
const backends = ['native', 'large'] as const;
type Role = (typeof roles)[number];
type Backend = (typeof backends)[number];
let host: DataConnection;

function setup(role: Role, backend: Backend, duration = 60): void {
  setState('network.appRole', role === 'guest' ? 'guest' : 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('room.context', {
    kind: role === 'pro' ? 'pro' : 'standard',
    roomId: '123456',
    role: role === 'host' || role === 'demo' ? 'coordinator' : 'member',
    coordinatorId: role === 'pro' ? null : 'host-1',
    epoch: 7,
    snapshotRevision: 1,
    capabilities: role === 'guest' ? [] : ['playback.control'],
  });
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setState('playlist.items', [
    { queueItemId: QUEUE_ITEM_ID, type: 'file', videoId: '', playlistId: '', name: 'a.wav' },
  ]);
  const blob = new Blob(['audio']);
  setState('files.current', {
    queueItemId: QUEUE_ITEM_ID,
    indexHint: 0,
    name: 'a.wav',
    sessionId: 1,
    blob,
    mime: 'audio/wav',
    size: blob.size,
  });
  host = { open: true, peer: 'host-1', send: vi.fn() } as unknown as DataConnection;
  if (role === 'guest') {
    setState('network.hostConn', host);
    markQueueAuthorityReady(host);
    setState('network.connectionType', 'local');
  }
  if (role === 'demo') {
    setState('demo.active', true);
    setState('demo.currentTrackIndex', 0);
    setState('files.current', null);
    setState('playlist.currentQueueItemId', null);
    setState('playlist.items', []);
  }
  if (backend === 'native') {
    setCurrentAudioBuffer({ duration, sampleRate: 48_000 } as AudioBuffer);
  } else {
    // Use the real bounded decoder scheduler. Only its decoded PCM and native
    // audio context are fakes; individual source deadlines remain observable.
    setCurrentAudioBuffer(
      new BoundedAudioTrack(
        duration,
        48_000,
        2,
        async function* (position) {
          for (let timestamp = Math.floor(position); timestamp < duration; timestamp += 1) {
            const span = Math.min(1, duration - timestamp);
            yield {
              timestamp,
              buffer: {
                duration: span,
                length: Math.round(span * 48_000),
                numberOfChannels: 2,
                timelineStart: timestamp,
              } as AudioBuffer & { timelineStart: number },
            };
          }
        },
        vi.fn(),
      ),
    );
  }
  setPlaybackLifecycleState(PLAYBACK_STATE.READY);
}

async function start(role: Role, position: number): Promise<boolean> {
  if (role === 'host') {
    return startHostFileAndBroadcastPlay({
      time: position,
      queueItemId: QUEUE_ITEM_ID,
      context: 'manual output regression',
    });
  }
  if (role === 'guest') {
    initPlayback();
    await handleData({ type: MSG.PLAY, queueItemId: QUEUE_ITEM_ID, time: position }, host);
    return getState('playback.activity') === 'playing';
  }
  if (role === 'pro') {
    return applyProPlaybackFileCommit({
      authority: createProPlaybackAuthorityToken({
        roomId: '123456',
        roomEpoch: 7,
        basePlaybackRevision: 1,
        transitionId: 'manual-start',
      }),
      committedPlaybackRevision: 2,
      timingMode: 'scheduled-control',
      queueItemId: QUEUE_ITEM_ID,
      state: 'playing',
      positionSeconds: position,
      scheduleDelayMs: 0,
    });
  }
  return play(position);
}

async function advance(ms: number): Promise<void> {
  // Advance both clocks together. Each increment lets the real bounded pump
  // supply its next window instead of pretending the event loop slept 12 s.
  for (let remaining = ms; remaining > 0;) {
    const step = Math.min(remaining, 100);
    mocks.audioNow += step / 1_000;
    mocks.monotonicMs += step;
    await vi.advanceTimersByTimeAsync(step);
    remaining -= step;
  }
  await vi.advanceTimersByTimeAsync(0);
}

function audiblePosition(): number | null {
  const output = mocks.outputs.findLast(
    (item) => item.when <= mocks.audioNow && item.stopsAt > mocks.audioNow,
  );
  return output ? output.position + mocks.audioNow - output.when : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
  vi.spyOn(performance, 'now').mockImplementation(() => mocks.monotonicMs);
  resetState();
  resetClockState();
  bus.clear();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  vi.clearAllMocks();
  mocks.audioNow = 100;
  mocks.monotonicMs = 1_000;
  mocks.outputs = [];
});

afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(roles)('%s file output at the zero boundary', (role) => {
  describe.each(backends)('%s engine', (backend) => {
    it.each([-9.999, -5, -0.25, 0, 9.999])(
      'preserves %s seconds in physical output after the room starts',
      async (offset) => {
        setup(role, backend);
        setLocalManualSyncOffset(offset);
        expect(await start(role, 0)).toBe(true);
        expect(getTrackPosition()).toBeCloseTo(0);
        if (offset < -platformOffset) {
          expect(audiblePosition()).toBeNull();
          await advance(100);
          expect(audiblePosition()).toBeNull();
          expect(getTrackPosition()).toBeCloseTo(0.1);
        }
        await advance(12_000);
        expect(audiblePosition()).not.toBeNull();
        expect(audiblePosition()! - getTrackPosition()).toBeCloseTo(offset + platformOffset, 4);
        expect(getState('sync.localOffset')).toBe(offset);
      },
    );

    it('retains the negative offset after a working mid-track seek repeats at zero', async () => {
      setup(role, backend);
      setLocalManualSyncOffset(-9.999);
      expect(await start(role, 20)).toBe(true);
      await advance(1_000);
      expect(audiblePosition()! - getTrackPosition()).toBeCloseTo(-9.999 + platformOffset, 4);
      pause(0, { showToast: false });
      expect(await start(role, 0)).toBe(true);
      expect(audiblePosition()).toBeNull();
      await advance(12_000);
      expect(audiblePosition()! - getTrackPosition()).toBeCloseTo(-9.999 + platformOffset, 4);
    });

    it('keeps the shared deadline separate from the participant hold during nudge rebuilds', async () => {
      setup(role, backend);
      setLocalManualSyncOffset(-5);
      await expect(play(0, 0.2, performance.now() + 200)).resolves.toBe(true);
      expect(getLocalFilePendingStartDeadlineMs()).toBeCloseTo(1_200);
      await advance(50);
      adjustSync(-4.999);
      await advance(60);
      expect(getLocalFilePendingStartDeadlineMs()).toBeCloseTo(1_200);
      expect(getTrackPosition()).toBe(0);
      await advance(390);
      expect(getLocalFilePendingStartDeadlineMs()).toBeUndefined();
      expect(getTrackPosition()).toBeCloseTo(0.3);
      expect(audiblePosition()).toBeNull();
      // A second output-only rebuild after the room began must not publish
      // the remaining private silence as another shared start deadline.
      adjustSync(0.5);
      await advance(12_000);
      expect(getTrackPosition()).toBeCloseTo(12.3);
      expect(audiblePosition()! - getTrackPosition()).toBeCloseTo(-9.499 + platformOffset, 4);
    });

    it.each(['pause', 'stop', 'youtube', 'next'] as const)(
      'revokes all scheduled samples when %s replaces a negative hold',
      async (action) => {
        setup(role, backend);
        setLocalManualSyncOffset(-9.999);
        expect(await start(role, 0)).toBe(true);
        await advance(300);
        const scheduled = [...mocks.outputs];
        if (action === 'pause') pause(undefined, { showToast: false });
        else {
          stopAllMedia({ cancelInFlight: true, clearBuffer: true });
          if (action === 'youtube') setPlaybackYouTubePlaying();
          if (action === 'next') {
            setup(role, backend);
            expect(await start(role, 20)).toBe(true);
          }
        }
        await advance(12_000);
        expect(scheduled.every((output) => output.stopsAt < output.when)).toBe(true);
        if (action === 'next') {
          expect(audiblePosition()! - getTrackPosition()).toBeCloseTo(-9.999 + platformOffset, 4);
        } else expect(audiblePosition()).toBeNull();
      },
    );
  });
});

describe.each(backends)('%s file offset integration', (backend) => {
  it('retains actual negative output through twelve valid Standard heartbeat corrections', async () => {
    setup('guest', backend);
    initSync();
    bus.emit('sync:set-manual-offset', -9_999);
    expect(await start('guest', 0)).toBe(true);
    for (let position = 1; position <= 12; position++) {
      await advance(1_000);
      registerPing(500 + position);
      await handleData(
        {
          type: MSG.SYNC_PONG,
          pingId: 500 + position,
          hostTime: Date.now(),
          position,
          mode: 'file',
          activity: 'playing',
          queueItemId: QUEUE_ITEM_ID,
        },
        host,
      );
      await advance(0);
    }
    expect(getTrackPosition()).toBeCloseTo(12);
    expect(audiblePosition()! - getTrackPosition()).toBeCloseTo(-9.999 + platformOffset, 4);
  });

  it.each(['host', 'demo'] as const)(
    'keeps the %s canonical end before a delayed local source on a short track',
    async (role) => {
      setup(role, backend, 0.5);
      setLocalManualSyncOffset(-9.999);
      const ended = vi.fn();
      bus.on('player:ended', ended);
      expect(await start(role, 0)).toBe(true);
      const obsoleteNode = getPlayerNode();
      const obsoleteOnEnded = obsoleteNode?.onended;
      await advance(400);
      expect(ended).not.toHaveBeenCalled();
      await advance(100);
      expect(ended).toHaveBeenCalledOnce();
      expect(audiblePosition()).toBeNull();
      await advance(12_000);
      if (obsoleteOnEnded) Reflect.apply(obsoleteOnEnded, obsoleteNode, [new Event('ended')]);
      expect(ended).toHaveBeenCalledOnce();
      expect(audiblePosition()).toBeNull();
    },
  );
});

describe('bounded PCM preparation across a negative hold', () => {
  it.each([1_500, 12_000])(
    'subtracts %sms of preparation from the residual hold',
    async (delayMs) => {
      setup('pro', 'large');
      setLocalManualSyncOffset(-9.999);
      const track = getCurrentAudioBuffer() as LargeAudioTrack;
      const prepare = track.prepare.bind(track);
      let release!: () => void;
      vi.spyOn(track, 'prepare').mockImplementationOnce(async (position, signal) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return prepare(position, signal);
      });
      const started = play(0, 0.2, performance.now() + 200);
      await advance(0);
      expect(release).toBeTypeOf('function');
      await advance(delayMs);
      release();
      await expect(started).resolves.toBe(true);
      await advance(12_000);
      expect(getTrackPosition()).toBeCloseTo(delayMs / 1_000 + 11.8);
      expect(audiblePosition()! - getTrackPosition()).toBeCloseTo(-9.999 + platformOffset, 4);
    },
  );
});
