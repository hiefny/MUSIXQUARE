import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import type { DataConnection, TrackMeta } from '../../types/index.ts';
import { handleData } from '../protocol.ts';
import { registerSystemAudioGuestListeners } from '../system-audio-guest.ts';
import { setPlaybackFilePlaying } from '../../player/ownership.ts';
import { stopAllMedia } from '../../player/transport.ts';

const timerMocks = vi.hoisted(() => {
  const timers = new Map<string, () => void>();
  return {
    timers,
    setManagedTimer: vi.fn((name: string, fn: () => void) => {
      timers.set(name, fn);
    }),
    clearManagedTimer: vi.fn((name: string) => {
      timers.delete(name);
    }),
  };
});

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: timerMocks.setManagedTimer,
  clearManagedTimer: timerMocks.clearManagedTimer,
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../audio/context.ts', () => ({
  getAudioContext: vi.fn(),
}));

vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
  getWidener: vi.fn(() => ({ input: { connect: vi.fn() } })),
}));

vi.mock('../../player/transport.ts', () => ({
  stopAllMedia: vi.fn(),
}));

vi.mock('../peer.ts', () => ({
  forceStereoSdp: vi.fn((sdp: string) => sdp),
}));

vi.mock('../windows-audio-decoder-primer.ts', () => ({
  cleanupWindowsAudioDecoderPrimer: vi.fn(),
  getAudioTrackStreamKey: vi.fn(() => 'stream-key'),
  primeWindowsAudioDecoder: vi.fn(() => null),
}));

describe('system audio guest receive watchdog', () => {
  const hostConn = { open: true, peer: 'host' } as DataConnection;
  const watchdogName = 'sys-audio-guest-receive-watchdog';

  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    timerMocks.timers.clear();
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    registerSystemAudioGuestListeners();
  });

  it('restores previous meta if SYSTEM_AUDIO_START never produces a stream', async () => {
    const previousMeta: TrackMeta = { type: 'youtube', name: 'previous-track' };
    setPlaybackFilePlaying();
    setState('player.currentTrackMeta', previousMeta);

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);

    expect(stopAllMedia).toHaveBeenCalledWith({ silent: true, cancelInFlight: true });
    expect(getState('player.currentTrackMeta')?.name).toBe('system-audio-receiving');
    expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).toBe(true);

    timerMocks.timers.get(watchdogName)?.();

    expect(getState('player.currentTrackMeta')).toEqual(previousMeta);
    expect(getState('systemAudio.isReceiving')).toBe(false);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('clears the watchdog once a stream is marked as receiving', async () => {
    setState('player.currentTrackMeta', { type: 'file', name: 'previous-track' });

    await handleData({ type: MSG.SYSTEM_AUDIO_START }, hostConn);
    const watchdog = timerMocks.timers.get(watchdogName);
    expect(watchdog).toBeTypeOf('function');

    setState('systemAudio.isReceiving', true);
    expect(timerMocks.timers.has(watchdogName)).toBe(false);

    watchdog?.();

    expect(getState('player.currentTrackMeta')?.name).toBe('system-audio-receiving');
    expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).toBe(true);
    expect(getState('systemAudio.isReceiving')).toBe(true);
  });
});
