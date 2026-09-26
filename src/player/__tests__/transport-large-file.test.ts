/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { IS_WINDOWS } from '../../core/platform.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { getSyncPongPlaybackState, initSync } from '../../network/sync.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { registerPing, resetClockState } from '../../network/shared-clock.ts';
import { createProPlaybackAuthorityToken } from '../../pro-room/playback-authority-hooks.ts';
import {
  getCurrentAudioBuffer,
  getPlayerNode,
  setCurrentAudioBuffer,
  setPlayerNode,
} from '../_state.ts';
import type { DataConnection } from '../../types/index.ts';
import type { LargeAudioTrack } from '../file-playback-resource.ts';
import { withAudioDecoderStartup } from '../large-audio/startup-error.ts';
import { BoundedPlayback, type PcmChunk } from '../large-audio/bounded-playback.ts';
import { setPlaybackFilePlaying, setPlaybackLifecycleState } from '../ownership.ts';

const mocks = vi.hoisted(() => ({
  currentTime: 100,
  monotonicMs: 1_000,
  start: vi.fn(),
  broadcast: vi.fn(),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  sendToHost: vi.fn(),
  announceSystemMessageLocally: vi.fn(),
  broadcastSystemMessage: vi.fn(),
  playTrack: vi.fn(),
}));

vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => mocks.currentTime,
  getAudioContext: () => ({
    state: 'running',
    get currentTime() {
      return mocks.currentTime;
    },
    createBufferSource: () => ({
      buffer: null,
      connect() {},
      disconnect() {},
      start: mocks.start,
      stop() {},
      onended: null,
    }),
  }),
  ensureRunning: vi.fn(),
  getPendingForegroundAudioContextClockHealthCheck: () => null,
}));
vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
  getFilePlaybackDestination: () => ({}),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  sendToHost: mocks.sendToHost,
}));
vi.mock('../../chat/protocol.ts', () => ({
  announceSystemMessageLocally: mocks.announceSystemMessageLocally,
  broadcastSystemMessage: mocks.broadcastSystemMessage,
}));
vi.mock('../../ui/toast.ts', () => ({
  showLoader: mocks.showLoader,
  showToast: mocks.showToast,
}));
vi.mock('../playlist-loader.ts', () => ({
  loadPlaylistModule: async () => ({ playTrack: mocks.playTrack }),
}));

import {
  adjustSync,
  applyProPlaybackFileCommit,
  getTrackPosition,
  isLocalFileStartPending,
  pause,
  play,
  seekTo,
  startHostFileAndBroadcastPlay,
  stopAllMedia,
} from '../transport.ts';

const QUEUE_ITEM_ID = '97111111-1111-4111-8111-111111111111';

function controlledTrack() {
  const pending: Array<{
    position: number;
    signal?: AbortSignal;
    resolve(): void;
    reject(error: unknown): void;
  }> = [];
  const outputs: Array<Parameters<LargeAudioTrack['createPlayback']>[0]> = [];
  const track: LargeAudioTrack = {
    kind: 'large-audio',
    duration: 3_600,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 172_800_000,
    bufferedPcmBytes: 4_096,
    prepare: vi.fn(
      (position, signal) =>
        new Promise<void>((resolve, reject) => {
          const abort = () => reject(new DOMException('superseded', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          pending.push({
            position,
            signal,
            resolve: () => {
              signal?.removeEventListener('abort', abort);
              resolve();
            },
            reject: (error) => {
              signal?.removeEventListener('abort', abort);
              reject(error);
            },
          });
        }),
    ),
    createPlayback: vi.fn((options) => {
      outputs.push(options);
      return { ended: false, stop: vi.fn(), disconnect: vi.fn() };
    }),
    dispose: vi.fn(),
  };
  return { track, pending, outputs };
}

function hostSeek(time: number) {
  return startHostFileAndBroadcastPlay({
    time,
    queueItemId: QUEUE_ITEM_ID,
    context: 'large-track regression seek',
  });
}

async function advance(ms = 0): Promise<void> {
  mocks.currentTime += ms / 1_000;
  mocks.monotonicMs += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
  vi.spyOn(performance, 'now').mockImplementation(() => mocks.monotonicMs);
  resetState();
  resetClockState();
  bus.clear();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  vi.clearAllMocks();
  mocks.currentTime = 100;
  mocks.monotonicMs = 1_000;
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'host-1',
    epoch: 7,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setState('playlist.items', [
    { queueItemId: QUEUE_ITEM_ID, type: 'file', videoId: '', playlistId: '', name: 'large.mp3' },
  ]);
  const blob = new Blob(['large file']);
  setState('files.current', {
    queueItemId: QUEUE_ITEM_ID,
    indexHint: 0,
    name: 'large.mp3',
    sessionId: 1,
    blob,
    mime: 'audio/mpeg',
    size: blob.size,
  });
  setState('sync.localOffset', IS_WINDOWS ? -0.02 : 0);
  setPlaybackLifecycleState(PLAYBACK_STATE.READY);
});

afterEach(() => {
  stopAllMedia({ cancelInFlight: true, clearBuffer: true });
  clearAllManagedTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bounded file transport preparation', () => {
  it.each([
    { role: 'host', phase: 'initial' },
    { role: 'host', phase: 'later' },
    { role: 'guest', phase: 'initial' },
    { role: 'guest', phase: 'later' },
    { role: 'pro', phase: 'initial' },
    { role: 'pro', phase: 'later' },
  ] as const)(
    'keeps $role playback retryable after a native output failure on the $phase chunk',
    async ({ role, phase }) => {
      if (role === 'pro') {
        setState('room.context', { ...getState('room.context'), kind: 'pro', role: 'member' });
      } else if (role === 'guest') {
        setState('network.appRole', 'guest');
        setState('room.context', { ...getState('room.context'), role: 'member' });
        setState('network.hostConn', {
          peer: 'host-1',
          open: true,
          send: vi.fn<DataConnection['send']>(),
          close: vi.fn<DataConnection['close']>(),
          on: () => {},
        });
      }
      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const chunk = (timestamp: number): PcmChunk => ({
        timestamp,
        buffer: {
          duration: 1,
          length: 48_000,
          sampleRate: 48_000,
          numberOfChannels: 2,
        } as AudioBuffer,
      });
      const { track, pending } = controlledTrack();
      vi.mocked(track.createPlayback).mockImplementationOnce(
        (options) =>
          new BoundedPlayback({
            ...options,
            duration: track.duration,
            firstChunk: chunk(options.offset),
            iterator: (async function* () {
              await readGate;
              yield chunk(options.offset + 1);
            })(),
            onreleased: vi.fn(),
          }),
      );
      setCurrentAudioBuffer(track);
      if (phase === 'initial')
        mocks.start.mockImplementationOnce(() => {
          throw new Error('audio output temporarily unavailable');
        });
      try {
        const start = play(20);
        await advance();
        pending[0]!.resolve();
        await expect(start).resolves.toBe(phase === 'later');
        if (phase === 'later') {
          mocks.start.mockImplementationOnce(() => {
            throw new Error('audio output temporarily unavailable');
          });
          releaseRead();
          await advance();
          expect(getState('playback.activity')).toBe('paused');
        }
        expect(getCurrentAudioBuffer()).toBe(track);
        expect(getState('playback.failedTrackKeys').size).toBe(0);
        expect(mocks.announceSystemMessageLocally).not.toHaveBeenCalled();
        expect(mocks.broadcastSystemMessage).not.toHaveBeenCalled();
        expect(mocks.playTrack).not.toHaveBeenCalled();
        expect(mocks.sendToHost).not.toHaveBeenCalled();
        vi.mocked(track.prepare).mockResolvedValueOnce();
        await expect(play(30)).resolves.toBe(true);
        expect(track.dispose).not.toHaveBeenCalled();
      } finally {
        releaseRead();
      }
    },
  );

  it('keeps wrapped synchronous decoder startup failures retryable', async () => {
    setState('room.context', { ...getState('room.context'), kind: 'pro', role: 'member' });
    const { track, pending, outputs } = controlledTrack();
    const startupError = await withAudioDecoderStartup(() =>
      Promise.reject(new Error('worker unavailable')),
    ).catch((error: unknown) => error);
    vi.mocked(track.createPlayback).mockImplementationOnce((options) => {
      options.onerror(startupError);
      return { ended: true, stop: vi.fn(), disconnect: vi.fn() };
    });
    setCurrentAudioBuffer(track);
    const start = play(20);
    await advance();
    pending[0]!.resolve();
    await expect(start).resolves.toBe(false);
    expect(getCurrentAudioBuffer()).toBe(track);
    expect(getState('playback.failedTrackKeys').size).toBe(0);
    expect(mocks.announceSystemMessageLocally).not.toHaveBeenCalled();
    vi.mocked(track.prepare).mockResolvedValueOnce();
    await expect(play(30)).resolves.toBe(true);
    expect(outputs).toHaveLength(1);
    expect(track.dispose).not.toHaveBeenCalled();
  });

  it('rejects the device track when its first prepared PCM reports an immediate decoder failure', async () => {
    setState('room.context', { ...getState('room.context'), kind: 'pro', role: 'member' });
    const { track, pending } = controlledTrack();
    vi.mocked(track.createPlayback).mockImplementationOnce((options) => {
      options.onerror(new Error('invalid first PCM chunk'));
      return { ended: true, stop: vi.fn(), disconnect: vi.fn() };
    });
    setCurrentAudioBuffer(track);
    const start = play(20);
    await advance();
    pending[0]!.resolve();
    await expect(start).resolves.toBe(false);
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getPlayerNode()).toBeNull();
    expect(track.dispose).toHaveBeenCalledOnce();
    expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${QUEUE_ITEM_ID}`]));
    expect(mocks.announceSystemMessageLocally).toHaveBeenCalledOnce();
  });

  it.each(['playing', 'seeking'] as const)(
    'does not decode the same failed %s segment again on ordinary guest synchronization',
    async (phase) => {
      const host: DataConnection = {
        peer: 'host-1',
        open: true,
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      };
      initSync();
      setState('network.appRole', 'guest');
      setState('room.context', { ...getState('room.context'), role: 'member' });
      setState('network.hostConn', host);
      markQueueAuthorityReady(host);
      const { track, pending, outputs } = controlledTrack();
      setCurrentAudioBuffer(track);
      const start = play(20);
      await advance();
      pending[0]!.resolve();
      await start;
      const error = new Error('invalid PCM midway through the file');
      if (phase === 'playing') outputs[0]!.onerror(error);
      else {
        vi.mocked(track.prepare).mockRejectedValueOnce(error);
        await expect(play(400)).resolves.toBe(false);
      }
      expect(getState('playback.activity')).toBe('paused');

      for (const pingId of [1701, 1702, 1703]) {
        registerPing(pingId);
        await advance(10);
        const pong = handleData(
          {
            type: MSG.SYNC_PONG,
            pingId,
            hostTime: Date.now(),
            position: 20.01,
            mode: 'file',
            activity: 'playing',
            queueItemId: QUEUE_ITEM_ID,
          },
          host,
        );
        await advance();
        expect(track.prepare).toHaveBeenCalledTimes(phase === 'playing' ? 1 : 2);
        await pong;
      }
      expect(getCurrentAudioBuffer()).toBeNull();
      expect(track.dispose).toHaveBeenCalledOnce();
      expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${QUEUE_ITEM_ID}`]));
      expect(mocks.sendToHost).toHaveBeenCalledExactlyOnceWith({
        type: MSG.GUEST_DECODE_FAILED,
        queueItemId: QUEUE_ITEM_ID,
      });
      expect(mocks.announceSystemMessageLocally).toHaveBeenCalledExactlyOnceWith(
        'chat.device_track_unavailable_system_message',
      );
      expect(mocks.broadcast).not.toHaveBeenCalled();

      const next = '97111111-1111-4111-8111-111111111112';
      setState('playlist.currentQueueItemId', next);
      setState('files.current', { ...getState('files.current')!, queueItemId: next });
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      await expect(play(30)).resolves.toBe(true);
      expect(mocks.start).toHaveBeenCalledExactlyOnceWith(0, 30);
      expect(getState('playback.failedTrackKeys').has(`queue:${next}`)).toBe(false);
    },
  );

  it.each(['playing', 'seeking'] as const)(
    'keeps a terminal PRO %s failure local across later authority commits',
    async (phase) => {
      setState('room.context', { ...getState('room.context'), kind: 'pro', role: 'member' });
      const { track, pending, outputs } = controlledTrack();
      setCurrentAudioBuffer(track);
      const commit = (revision: number, positionSeconds: number) =>
        applyProPlaybackFileCommit({
          authority: createProPlaybackAuthorityToken({
            roomId: '123456',
            roomEpoch: 7,
            basePlaybackRevision: revision - 1,
            transitionId: `failure-${revision}`,
          }),
          committedPlaybackRevision: revision,
          queueItemId: QUEUE_ITEM_ID,
          state: 'playing',
          positionSeconds,
          scheduleDelayMs: 0,
          timingMode: 'scheduled-control',
          isCurrent: () => true,
        });
      const start = commit(2, 20);
      await advance();
      pending[0]!.resolve();
      await expect(start).resolves.toBe(true);
      const error = new Error('invalid PCM midway through the file');
      if (phase === 'playing') outputs[0]!.onerror(error);
      else {
        vi.mocked(track.prepare).mockRejectedValueOnce(error);
        await expect(commit(3, 400)).resolves.toBe(false);
      }
      for (const revision of [4, 5, 6]) await expect(commit(revision, 400)).resolves.toBe(false);
      expect(track.prepare).toHaveBeenCalledTimes(phase === 'playing' ? 1 : 2);
      expect(getCurrentAudioBuffer()).toBeNull();
      expect(track.dispose).toHaveBeenCalledOnce();
      expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${QUEUE_ITEM_ID}`]));
      expect(mocks.announceSystemMessageLocally).toHaveBeenCalledExactlyOnceWith(
        'chat.device_track_unavailable_system_message',
      );
      expect(mocks.sendToHost).not.toHaveBeenCalled();
      expect(mocks.broadcast).not.toHaveBeenCalled();
      expect(mocks.playTrack).not.toHaveBeenCalled();
    },
  );

  it.each(['playing', 'seeking'] as const)(
    'keeps decoder startup failures retryable while %s',
    async (phase) => {
      setState('room.context', { ...getState('room.context'), kind: 'pro', role: 'member' });
      const { track, pending, outputs } = controlledTrack();
      setCurrentAudioBuffer(track);
      const start = play(20);
      await advance();
      pending[0]!.resolve();
      await start;
      const error = await withAudioDecoderStartup(() =>
        Promise.reject(new Error('worker unavailable')),
      ).catch((cause: unknown) => cause);
      if (phase === 'playing') outputs[0]!.onerror(error);
      else {
        vi.mocked(track.prepare).mockRejectedValueOnce(error);
        await expect(play(400)).resolves.toBe(false);
      }
      expect(getCurrentAudioBuffer()).toBe(track);
      expect(getState('playback.failedTrackKeys').size).toBe(0);
      expect(mocks.announceSystemMessageLocally).not.toHaveBeenCalled();
      vi.mocked(track.prepare).mockResolvedValueOnce();
      await expect(play(30)).resolves.toBe(true);
      expect(outputs).toHaveLength(2);
      expect(track.dispose).not.toHaveBeenCalled();
    },
  );

  it('ignores a late output error from a superseded room incarnation', async () => {
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    const start = play(20);
    await advance();
    pending[0]!.resolve();
    await start;
    const source = getPlayerNode();
    setState('room.context', { ...getState('room.context'), epoch: 8 });
    outputs[0]!.onerror(new Error('obsolete output failed'));
    expect(getPlayerNode()).toBe(source);
    expect(getCurrentAudioBuffer()).toBe(track);
    expect(getState('playback.activity')).toBe('playing');
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(mocks.announceSystemMessageLocally).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('uses the existing next-track policy when the host decoder fails after starting', async () => {
    const next = '97111111-1111-4111-8111-111111111112';
    setState('playlist.items', [
      ...getState('playlist.items'),
      { queueItemId: next, type: 'file', videoId: '', playlistId: '', name: 'next.mp3' },
    ]);
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    const start = hostSeek(20);
    await advance();
    pending[0]!.resolve();
    await start;
    outputs[0]!.onerror(new Error('corrupt later frame'));
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getState('playback.failedTrackKeys')).toEqual(new Set([`queue:${QUEUE_ITEM_ID}`]));
    expect(mocks.broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: MSG.PAUSE, queueItemId: QUEUE_ITEM_ID }),
    );
    await advance(600);
    expect(mocks.playTrack).toHaveBeenCalledExactlyOnceWith(next);
    expect(mocks.broadcastSystemMessage).toHaveBeenCalledExactlyOnceWith(
      'chat.decode_skip_system_message',
    );
  });

  it('cancels the previous near-end deadline while a new host seek is being prepared', async () => {
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    const first = hostSeek(3_599.9);
    await advance();
    pending[0]!.resolve();
    await first;
    expect(getManagedTimer('standard-file-canonical-end')).not.toBeNull();
    const ended = vi.fn();
    bus.on('player:ended', ended);
    const second = hostSeek(600);
    expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'paused' });
    await advance();
    expect(getManagedTimer('standard-file-canonical-end')).toBeNull();
    expect(getPlayerNode()).toBeNull();
    expect(isLocalFileStartPending()).toBe(true);
    expect(getTrackPosition()).toBeCloseTo(600);
    expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'paused' });
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 600,
      queueItemId: QUEUE_ITEM_ID,
      reason: 'seek',
    });
    await advance(500);
    expect(ended).not.toHaveBeenCalled();
    pending[1]!.resolve();
    await expect(second).resolves.toBe(true);
    expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'playing' });
    expect(outputs.at(-1)?.offset).toBeCloseTo(600);
    expect(outputs.at(-1)?.when).toBeCloseTo(mocks.currentTime);
    expect(mocks.broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: MSG.PLAY,
        time: 600,
        queueItemId: QUEUE_ITEM_ID,
      }),
    );
  });

  it('cancels older preparation and commits only the final rapid host seek', async () => {
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    setPlaybackFilePlaying();
    seekTo(100);
    await advance();
    expect(getState('playback.activity')).toBe('playing');
    seekTo(500);
    seekTo(900);
    await advance();
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(pending.map((entry) => entry.position)).toEqual([100, 900]);
    expect(outputs).toHaveLength(0);
    pending[1]!.resolve();
    await advance();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.offset).toBeCloseTo(900);
    expect(mocks.broadcast.mock.calls.filter(([message]) => message.type === MSG.PLAY)).toEqual([
      [expect.objectContaining({ time: 900 })],
    ]);
  });

  it.each(['pause', 'youtube', 'system-audio'] as const)(
    'prevents prepared output from starting after %s takes ownership',
    async (successor) => {
      const { track, pending, outputs } = controlledTrack();
      setCurrentAudioBuffer(track);
      setPlaybackFilePlaying();
      const start = hostSeek(100);
      await advance();
      if (successor === 'pause') pause(100, { showToast: false });
      else setState('playback.mode', successor);
      await advance(100);
      expect(pending[0]!.signal?.aborted).toBe(true);
      pending[0]!.resolve();
      await expect(start).resolves.toBe(false);
      expect(outputs).toHaveLength(0);
      expect(mocks.broadcast.mock.calls.some(([message]) => message.type === MSG.PLAY)).toBe(false);
      expect(isLocalFileStartPending()).toBe(false);
    },
  );

  it('settles a failed host preparation at the requested paused position without publishing PLAY', async () => {
    setState('playlist.items', [
      ...getState('playlist.items'),
      {
        queueItemId: '97111111-1111-4111-8111-111111111112',
        type: 'file',
        videoId: '',
        playlistId: '',
        name: 'next.mp3',
      },
    ]);
    const { track, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    setPlaybackFilePlaying();
    vi.mocked(track.prepare).mockRejectedValueOnce(new Error('corrupt requested segment'));
    await expect(hostSeek(700)).resolves.toBe(false);
    expect(getState('playback.activity')).toBe('paused');
    expect(getTrackPosition()).toBeCloseTo(700);
    expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'paused' });
    expect(outputs).toHaveLength(0);
    expect(mocks.broadcast.mock.calls.some(([message]) => message.type === MSG.PLAY)).toBe(false);
    expect(isLocalFileStartPending()).toBe(false);
  });

  it.each(['standard', 'pro', 'demo'] as const)(
    'keeps healthy %s output playing when preparing a manual-sync adjustment fails',
    async (mode) => {
      if (mode === 'pro') {
        setState('room.context', { ...getState('room.context'), kind: 'pro', role: 'member' });
      } else if (mode === 'demo') {
        setState('demo.active', true);
        setState('demo.currentTrackIndex', 0);
      }
      const { track, pending, outputs } = controlledTrack();
      setCurrentAudioBuffer(track);
      const start = play(20);
      await advance();
      pending[0]!.resolve();
      await start;
      const originalSource = getPlayerNode();
      vi.mocked(track.prepare).mockRejectedValueOnce(new Error('replacement preparation failed'));

      adjustSync(0.1);
      await advance(200);

      expect(getPlayerNode()).toBe(originalSource);
      expect(getState('playback.activity')).toBe('playing');
      expect(getTrackPosition()).toBeCloseTo(20.2);
      expect(getSyncPongPlaybackState()).toEqual({ mode: 'file', activity: 'playing' });
      expect(outputs).toHaveLength(1);
      expect(mocks.broadcast).not.toHaveBeenCalled();
      expect(mocks.showToast).toHaveBeenCalledOnce();
      expect(isLocalFileStartPending()).toBe(false);
    },
  );

  it('still pauses obsolete output when an authoritative PRO seek cannot prepare its new position', async () => {
    setState('room.context', { ...getState('room.context'), kind: 'pro', role: 'member' });
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    const first = play(20);
    await advance();
    pending[0]!.resolve();
    await first;
    vi.mocked(track.prepare).mockRejectedValueOnce(new Error('authoritative preparation failed'));

    await expect(
      applyProPlaybackFileCommit({
        authority: createProPlaybackAuthorityToken({
          roomId: '123456',
          roomEpoch: 7,
          basePlaybackRevision: 1,
          transitionId: 'large-authority-seek',
        }),
        committedPlaybackRevision: 2,
        queueItemId: QUEUE_ITEM_ID,
        state: 'playing',
        positionSeconds: 700,
        scheduleDelayMs: 0,
        timingMode: 'scheduled-control',
        isCurrent: () => true,
      }),
    ).resolves.toBe(false);
    expect(getPlayerNode()).toBeNull();
    expect(getState('playback.activity')).toBe('paused');
    expect(outputs).toHaveLength(1);
    expect(isLocalFileStartPending()).toBe(false);
  });

  it('does not pause or warn for a manual adjustment whose room occurrence was superseded', async () => {
    const { track, pending } = controlledTrack();
    setCurrentAudioBuffer(track);
    const first = play(20);
    await advance();
    pending[0]!.resolve();
    await first;
    const originalSource = getPlayerNode();
    adjustSync(0.1);
    await advance(200);
    expect(pending).toHaveLength(2);
    setState('room.context', { ...getState('room.context'), epoch: 8 });
    pending[1]!.reject(new Error('obsolete preparation failed'));
    await advance();
    expect(getPlayerNode()).toBe(originalSource);
    expect(getState('playback.activity')).toBe('playing');
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(isLocalFileStartPending()).toBe(false);
  });

  it.each(['standard', 'pro'] as const)(
    'catches up to the absolute %s start deadline after decoding preparation',
    async (kind) => {
      setState('room.context', { ...getState('room.context'), kind, role: 'member' });
      const { track, pending, outputs } = controlledTrack();
      setCurrentAudioBuffer(track);
      const start = play(40, 0.2, performance.now() + 200);
      await advance();
      expect(isLocalFileStartPending()).toBe(true);
      await advance(650);
      pending[0]!.resolve();
      await expect(start).resolves.toBe(true);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.offset).toBeCloseTo(40.45, 6);
      expect(outputs[0]!.when).toBeCloseTo(mocks.currentTime);
      expect(isLocalFileStartPending()).toBe(false);
    },
  );

  it('returns to the native path after replacing a bounded resource with a small track', async () => {
    const { track, pending, outputs } = controlledTrack();
    setCurrentAudioBuffer(track);
    const start = hostSeek(20);
    await advance();
    pending[0]!.resolve();
    await start;
    expect(outputs).toHaveLength(1);
    stopAllMedia({ cancelInFlight: true, clearBuffer: true });
    expect(track.dispose).toHaveBeenCalledExactlyOnceWith();
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    await expect(play(12)).resolves.toBe(true);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(0, 12);
    expect(track.prepare).toHaveBeenCalledOnce();
    expect(isLocalFileStartPending()).toBe(false);
  });
});
