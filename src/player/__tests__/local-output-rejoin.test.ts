/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reconcilePro: vi.fn(
    async (_options?: {
      showLoading?: boolean;
      liveness?: { identity: object; isCurrent: () => boolean };
    }) => true,
  ),
  rendezvous: vi.fn(
    (): {
      status: 'started' | 'completed' | 'busy' | 'not-ready' | 'no-data';
      retryAfterMs?: number;
    } => ({
      status: 'started',
    }),
  ),
}));

vi.mock('../../pro-room/runtime.ts', () => ({
  requestActiveProRoomPlaybackReconciliation: mocks.reconcilePro,
}));
vi.mock('../../youtube/sync.ts', () => ({
  guestRendezvousSync: mocks.rendezvous,
}));

import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { setLocalYouTubePaused, isLocalYouTubePaused } from '../../youtube/_state.ts';
import { setLocalFilePaused, isLocalFilePaused } from '../_state.ts';
import { initLocalOutputRejoin } from '../local-output-rejoin.ts';
import {
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackYouTubePlaying,
} from '../ownership.ts';

function startSession(): void {
  setState('setup.sessionStarted', true);
}

function setStandardGuest(): void {
  setState('network.hostConn', { open: true } as never);
}

function setProRoom(): void {
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 1,
    snapshotRevision: 1,
    capabilities: [],
  });
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  mocks.reconcilePro.mockResolvedValue(true);
  mocks.rendezvous.mockReturnValue({ status: 'started' });
  setLocalFilePaused(false);
  setLocalYouTubePaused(false);
  initLocalOutputRejoin();
});

describe('participant-local output rejoin', () => {
  it('rejoins a standard file guest through a fresh SYNC_PONG, never pausedAt', async () => {
    startSession();
    setStandardGuest();
    setPlaybackFilePaused();
    setLocalFilePaused(true);
    setState('player.pausedAt', 12);
    const forceResync = vi.fn();
    bus.on('sync:force-resync', forceResync);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'file',
    });

    await vi.waitFor(() => expect(forceResync).toHaveBeenCalledOnce());
    expect(isLocalFilePaused()).toBe(false);
    expect(mocks.reconcilePro).not.toHaveBeenCalled();
  });

  it('does not automatically resume a room-paused standard file without local pause intent', async () => {
    startSession();
    setStandardGuest();
    setPlaybackFilePaused();
    const forceResync = vi.fn();
    bus.on('sync:force-resync', forceResync);

    bus.emit('playback:local-output-rejoin', {
      reason: 'audio-context-recovered',
      mode: 'file',
    });
    await Promise.resolve();

    expect(forceResync).not.toHaveBeenCalled();
  });

  it('never re-seeks a standard host that has no external authoritative timeline', async () => {
    startSession();
    setPlaybackFilePlaying();
    const forceResync = vi.fn();
    bus.on('sync:force-resync', forceResync);

    bus.emit('playback:local-output-rejoin', {
      reason: 'audio-context-recovered',
      mode: 'file',
    });
    await Promise.resolve();

    expect(forceResync).not.toHaveBeenCalled();
    expect(mocks.reconcilePro).not.toHaveBeenCalled();
    expect(mocks.rendezvous).not.toHaveBeenCalled();
  });

  it('uses the local YouTube rendezvous for a standard guest', async () => {
    startSession();
    setStandardGuest();
    setPlaybackYouTubePlaying();
    setLocalYouTubePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'youtube',
    });

    await vi.waitFor(() => expect(mocks.rendezvous).toHaveBeenCalledOnce());
    expect(mocks.rendezvous).toHaveBeenCalledWith({
      silent: true,
      suppressProgressToast: true,
      onComplete: expect.any(Function),
    });
    expect(isLocalYouTubePaused()).toBe(false);
  });

  it('lets an explicit YouTube PLAY query authority even when the local pause bit was lost', async () => {
    startSession();
    setStandardGuest();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'paused');

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'youtube',
    });

    await vi.waitFor(() => expect(mocks.rendezvous).toHaveBeenCalledOnce());
  });

  it('lets an explicit PRO PLAY reconcile even when the local pause bit was lost', async () => {
    startSession();
    setProRoom();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'paused');

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'youtube',
    });

    await vi.waitFor(() => expect(mocks.reconcilePro).toHaveBeenCalledOnce());
  });

  it('retries a busy YouTube rendezvous instead of treating it as success', async () => {
    vi.useFakeTimers();
    mocks.rendezvous
      .mockReturnValueOnce({ status: 'busy', retryAfterMs: 25 })
      .mockReturnValueOnce({ status: 'started' });
    startSession();
    setStandardGuest();
    setPlaybackYouTubePlaying();
    setLocalYouTubePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'youtube',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.rendezvous).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25);
    expect(mocks.rendezvous).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('drops a scheduled busy retry after the queue occurrence changes', async () => {
    vi.useFakeTimers();
    mocks.rendezvous.mockReturnValue({ status: 'busy', retryAfterMs: 25 });
    startSession();
    setStandardGuest();
    setPlaybackYouTubePlaying();
    setLocalYouTubePaused(true);
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'youtube',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.rendezvous).toHaveBeenCalledOnce();

    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
    await vi.advanceTimersByTimeAsync(25);

    expect(mocks.rendezvous).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('drops a scheduled busy retry after the room epoch changes', async () => {
    vi.useFakeTimers();
    mocks.rendezvous.mockReturnValue({ status: 'busy', retryAfterMs: 25 });
    startSession();
    setStandardGuest();
    setState('room.context', {
      kind: 'standard',
      roomId: '123456',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    setPlaybackYouTubePlaying();
    setLocalYouTubePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'youtube',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.rendezvous).toHaveBeenCalledOnce();

    setState('room.context', {
      kind: 'standard',
      roomId: '123456',
      role: 'member',
      coordinatorId: null,
      epoch: 2,
      snapshotRevision: 1,
      capabilities: [],
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(mocks.rendezvous).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not let a stale busy result schedule work into a restarted session', async () => {
    vi.useFakeTimers();
    mocks.rendezvous.mockReturnValue({ status: 'busy', retryAfterMs: 25 });
    startSession();
    setStandardGuest();
    setPlaybackYouTubePlaying();
    setLocalYouTubePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'youtube',
    });
    expect(mocks.rendezvous).toHaveBeenCalledOnce();
    setState('setup.sessionStarted', false);
    setState('setup.sessionStarted', true);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(mocks.rendezvous).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('retains local YouTube pause intent when rendezvous data is not ready', async () => {
    mocks.rendezvous.mockReturnValue({ status: 'no-data' });
    startSession();
    setStandardGuest();
    setPlaybackYouTubePlaying();
    setLocalYouTubePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'youtube',
    });

    await vi.waitFor(() => expect(mocks.rendezvous).toHaveBeenCalledOnce());
    expect(isLocalYouTubePaused()).toBe(true);
  });

  it('uses a silent participant-local PRO rendezvous without a room command', async () => {
    startSession();
    setProRoom();
    setPlaybackFilePaused();
    setLocalFilePaused(true);
    const forceResync = vi.fn();
    bus.on('sync:force-resync', forceResync);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'file',
    });

    await vi.waitFor(() => expect(mocks.reconcilePro).toHaveBeenCalledOnce());
    expect(mocks.reconcilePro).toHaveBeenCalledWith({
      showLoading: false,
      liveness: {
        identity: expect.any(Object),
        isCurrent: expect.any(Function),
      },
    });
    expect(mocks.reconcilePro.mock.calls[0]?.[0]?.liveness?.isCurrent()).toBe(true);
    expect(forceResync).not.toHaveBeenCalled();
    expect(isLocalFilePaused()).toBe(false);
  });

  it('drops A after the lazy PRO import when the queue occurrence has already become B', async () => {
    startSession();
    setProRoom();
    setPlaybackFilePaused();
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
    setLocalFilePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'file',
    });
    expect(isLocalFilePaused()).toBe(false);

    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
    setLocalFilePaused(true);
    await vi.dynamicImportSettled();

    expect(mocks.reconcilePro).not.toHaveBeenCalled();
    expect(isLocalFilePaused()).toBe(true);
  });

  it('does not let A false restore its pause gate or retry after queue B owns output', async () => {
    vi.useFakeTimers();
    let resolveA!: (value: boolean) => void;
    mocks.reconcilePro.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveA = resolve;
        }),
    );
    startSession();
    setProRoom();
    setPlaybackFilePaused();
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
    setLocalFilePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'file',
    });
    await vi.waitFor(() => expect(mocks.reconcilePro).toHaveBeenCalledOnce());
    const liveness = mocks.reconcilePro.mock.calls[0]?.[0]?.liveness;

    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
    setLocalFilePaused(false);
    expect(liveness?.isCurrent()).toBe(false);
    resolveA(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.reconcilePro).toHaveBeenCalledOnce();
    expect(isLocalFilePaused()).toBe(false);
    vi.useRealTimers();
  });

  it('treats a newer local PAUSE as B and does not retry late A in the same queue occurrence', async () => {
    vi.useFakeTimers();
    let resolveA!: (value: boolean) => void;
    mocks.reconcilePro.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveA = resolve;
        }),
    );
    startSession();
    setProRoom();
    setPlaybackFilePaused();
    setLocalFilePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'file',
    });
    await vi.waitFor(() => expect(mocks.reconcilePro).toHaveBeenCalledOnce());
    const liveness = mocks.reconcilePro.mock.calls[0]?.[0]?.liveness;

    setLocalFilePaused(true);
    expect(liveness?.isCurrent()).toBe(false);
    resolveA(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.reconcilePro).toHaveBeenCalledOnce();
    expect(isLocalFilePaused()).toBe(true);
    vi.useRealTimers();
  });

  it('does not let A rejection restore its pause gate or retry after queue B owns output', async () => {
    vi.useFakeTimers();
    let rejectA!: (reason: unknown) => void;
    mocks.reconcilePro.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    startSession();
    setProRoom();
    setPlaybackFilePaused();
    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000001');
    setLocalFilePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'file',
    });
    await vi.waitFor(() => expect(mocks.reconcilePro).toHaveBeenCalledOnce());

    setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
    setLocalFilePaused(false);
    rejectA(new Error('late A failure'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.reconcilePro).toHaveBeenCalledOnce();
    expect(isLocalFilePaused()).toBe(false);
    vi.useRealTimers();
  });

  it('keeps local pause intent when PRO authority is temporarily unavailable', async () => {
    mocks.reconcilePro.mockResolvedValue(false);
    startSession();
    setProRoom();
    setPlaybackFilePaused();
    setLocalFilePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'file',
    });

    await vi.waitFor(() => expect(mocks.reconcilePro).toHaveBeenCalledOnce());
    expect(isLocalFilePaused()).toBe(true);
  });

  it('retries a transient PRO reconciliation miss and rejoins without another OS event', async () => {
    vi.useFakeTimers();
    mocks.reconcilePro.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    startSession();
    setProRoom();
    setPlaybackFilePaused();
    setLocalFilePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'file',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.reconcilePro).toHaveBeenCalledTimes(1);
    expect(isLocalFilePaused()).toBe(true);

    await vi.advanceTimersByTimeAsync(250);

    expect(mocks.reconcilePro).toHaveBeenCalledTimes(2);
    expect(mocks.reconcilePro.mock.calls[1]?.[0]?.liveness?.identity).toBe(
      mocks.reconcilePro.mock.calls[0]?.[0]?.liveness?.identity,
    );
    expect(isLocalFilePaused()).toBe(false);
    vi.useRealTimers();
  });

  it('restores and retries the exact current A after a transient PRO rejection', async () => {
    vi.useFakeTimers();
    mocks.reconcilePro.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(true);
    startSession();
    setProRoom();
    setPlaybackFilePaused();
    setLocalFilePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'media-session-play',
      mode: 'file',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.reconcilePro).toHaveBeenCalledOnce();
    expect(isLocalFilePaused()).toBe(true);

    await vi.advanceTimersByTimeAsync(250);

    expect(mocks.reconcilePro).toHaveBeenCalledTimes(2);
    expect(isLocalFilePaused()).toBe(false);
    vi.useRealTimers();
  });

  it('drops a transient PRO retry after the room lease changes', async () => {
    vi.useFakeTimers();
    mocks.reconcilePro.mockResolvedValue(false);
    startSession();
    setProRoom();
    setPlaybackYouTubePlaying();
    setLocalYouTubePaused(true);

    bus.emit('playback:local-output-rejoin', {
      reason: 'audio-context-recovered',
      mode: 'youtube',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.reconcilePro).toHaveBeenCalledTimes(1);

    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 2,
      snapshotRevision: 2,
      capabilities: [],
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(mocks.reconcilePro).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('ignores startup/no-session events and coalesces duplicate active requests', async () => {
    setStandardGuest();
    setPlaybackFilePlaying();
    const forceResync = vi.fn();
    bus.on('sync:force-resync', forceResync);
    const request = {
      reason: 'audio-context-recovered' as const,
      mode: 'file' as const,
    };

    bus.emit('playback:local-output-rejoin', request);
    await Promise.resolve();
    expect(forceResync).not.toHaveBeenCalled();

    startSession();
    bus.emit('playback:local-output-rejoin', request);
    bus.emit('playback:local-output-rejoin', request);
    await vi.waitFor(() => expect(forceResync).toHaveBeenCalledOnce());
  });
});
