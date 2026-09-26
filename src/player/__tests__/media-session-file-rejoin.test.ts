/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { resetClockState } from '../../network/shared-clock.ts';
import { initSync } from '../../network/sync.ts';
import type { DataConnection } from '../../types/index.ts';
import { isLocalFilePaused, setCurrentAudioBuffer, setLocalFilePaused } from '../_state.ts';
import { initLocalOutputRejoin } from '../local-output-rejoin.ts';
import { initMediaSession } from '../media-session.ts';
import { setPlaybackFilePlaying } from '../ownership.ts';
import { play } from '../transport.ts';

// Keep the real PAUSE, Media Session, local rejoin, clock and wire handlers.
// Observe the final physical PLAY boundary without constructing Web Audio.
vi.mock('../transport.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../transport.ts')>()),
  play: vi.fn(async () => true),
}));

const QUEUE_ID = '14000000-0000-4000-8000-000000000001';
const actions = new Map<MediaSessionAction, MediaSessionActionHandler>();

function action(name: 'play' | 'pause'): void {
  actions.get(name)!({ action: name });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  clearAllManagedTimers();
  resetState();
  resetClockState();
  bus.clear();
  vi.clearAllMocks();
  setLocalFilePaused(false);
  setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
  actions.clear();
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null,
      playbackState: 'none',
      setActionHandler(name: MediaSessionAction, handler: MediaSessionActionHandler | null) {
        if (handler) actions.set(name, handler);
      },
    },
  });
  initSync();
  initLocalOutputRejoin();
  initMediaSession();
  setState('network.appRole', 'guest');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('playlist.currentQueueItemId', QUEUE_ID);
});

afterEach(() => {
  clearAllManagedTimers();
  resetClockState();
  setCurrentAudioBuffer(null);
  setLocalFilePaused(false);
  bus.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('file hardware PAUSE while local PLAY is waiting for host time', () => {
  it.each([false, true])('honors the latest action when cancelled=%s', async (cancelled) => {
    const send = vi.fn<(message: unknown) => void>();
    const host: DataConnection = {
      peer: 'qa14-host',
      open: true,
      send,
      close: vi.fn(),
      on: vi.fn(),
    };
    setState('network.hostConn', host);
    markQueueAuthorityReady(host);
    setPlaybackFilePlaying();

    action('pause');
    expect(getState('playback.activity')).toBe('paused');
    expect(isLocalFilePaused()).toBe(true);

    action('play');
    expect(isLocalFilePaused()).toBe(false);
    expect(getState('playback.activity')).toBe('paused');
    const pings = send.mock.calls
      .map(([message]) => message as { type: string; pingId: number })
      .filter((message) => message.type === MSG.SYNC_PING);
    expect(pings.length).toBeGreaterThan(0);

    // The response has not arrived yet. A second hardware PAUSE must still
    // cancel the desired resume even though the audio is already silent.
    if (cancelled) action('pause');
    vi.setSystemTime(10_050);
    await handleData(
      {
        type: MSG.SYNC_PONG,
        pingId: pings[0]!.pingId,
        hostTime: 10_050,
        position: 30,
        mode: 'file',
        activity: 'playing',
        queueItemId: QUEUE_ID,
      },
      host,
    );

    expect(isLocalFilePaused()).toBe(cancelled);
    if (cancelled) {
      expect(play).not.toHaveBeenCalled();
      expect(getState('playback.activity')).toBe('paused');
      // A later explicit PLAY still works; cancellation must not permanently
      // block this queue occurrence or the next local rejoin.
      action('play');
      await vi.advanceTimersByTimeAsync(0);
      const nextPing = send.mock.calls
        .map(([message]) => message as { type: string; pingId: number })
        .filter((message) => message.type === MSG.SYNC_PING)
        .at(-1)!;
      expect(nextPing.pingId).not.toBe(pings[0]!.pingId);
      vi.setSystemTime(10_100);
      await handleData(
        {
          type: MSG.SYNC_PONG,
          pingId: nextPing.pingId,
          hostTime: 10_100,
          position: 30.05,
          mode: 'file',
          activity: 'playing',
          queueItemId: QUEUE_ID,
        },
        host,
      );
      expect(isLocalFilePaused()).toBe(false);
      expect(play).toHaveBeenCalledOnce();
    } else {
      expect(play).toHaveBeenCalledOnce();
    }
  });
});
