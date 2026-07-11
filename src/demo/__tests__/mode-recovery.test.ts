/**
 * @vitest-environment jsdom
 *
 * Recovery contracts:
 * - The demo snapshot must round-trip transfer.meta — loadDemoFile
 *   overwrites it with the demo track's meta, and without restore the host's
 *   recovery blob-matcher fails post-demo (guests FILE_WAIT forever).
 * - A host track command arriving while a guest's demo load is in flight must
 *   be queued and re-dispatched after the load so it cannot be lost to the
 *   demo.loading guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { getCurrentAudioBuffer, setCurrentAudioBuffer } from '../../player/_state.ts';
import { setPlaybackFilePaused, setPlaybackIdle } from '../../player/ownership.ts';
import { DEMO_TRACKS } from '../tracks.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  play: vi.fn(),
  pause: vi.fn(),
  stopAllMedia: vi.fn(),
  getTrackPosition: vi.fn(() => 12),
  getHostNow: vi.fn(() => 10_000),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  loadDemoFile: vi.fn(),
}));

vi.mock('../../player/transport.ts', () => ({
  getTrackPosition: mocks.getTrackPosition,
  pause: mocks.pause,
  play: mocks.play,
  stopAllMedia: mocks.stopAllMedia,
}));

vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: mocks.getHostNow,
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  safeSend: mocks.safeSend,
}));

vi.mock('../../player/decode.ts', () => ({
  loadDemoFile: mocks.loadDemoFile,
}));

vi.mock('../../audio/effects.ts', () => ({
  applySettingsAsync: vi.fn(),
}));

vi.mock('../../ui/dialog.ts', () => ({
  showDialog: vi.fn(),
}));

vi.mock('../../ui/setup-shared.ts', () => ({
  hideSetupOverlay: vi.fn(),
}));

vi.mock('../../ui/toast.ts', () => ({
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../ui/dom.ts', () => ({
  updateOverlayOpenClass: vi.fn(),
}));

vi.mock('../../ui/theme-chrome.ts', () => ({
  syncAppThemeChrome: vi.fn(),
  syncDemoThemeChrome: vi.fn(),
}));

/** Manually resolvable XHR stand-in for fetchDemoBlob. */
class FakeXHR {
  static pending: FakeXHR[] = [];
  status = 200;
  response: Blob = new Blob(['demo-bytes']);
  responseType = '';
  timeout = 0;
  onprogress: ((e: unknown) => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    FakeXHR.pending.push(this);
  }
  abort(): void {
    this.onabort?.();
  }
  resolveOk(): void {
    this.onload?.();
  }
}

async function flush(ms = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('demo recovery pins (DEMO-1 / DEMO-4)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    FakeXHR.pending = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    // jsdom has no matchMedia; without this initDemoMode falls back to a
    // window resize listener and the demo layout-refresh resize dispatches
    // re-enter setDemoDomActive recursively.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    // Simulate the real loadDemoFile side effects the snapshot must defend
    // against: buffer publish + transfer.meta overwrite (decode.ts).
    mocks.loadDemoFile.mockImplementation(async (_file: File, meta: { name?: string }) => {
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      setState('transfer.meta', { name: meta?.name || 'demo.m4a', index: 0 });
    });
    // Real stopAllMedia releases playback to idle — the restore policy
    // depends on it.
    mocks.stopAllMedia.mockImplementation(() => setPlaybackIdle());

    const { initDemoMode } = await import('../mode.ts');
    initDemoMode();
  });

  afterEach(() => {
    setCurrentAudioBuffer(null);
    clearAllManagedTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('restores transfer.meta with the file blob on demo exit (DEMO-4 pair invariant)', async () => {
    const preBlob = new Blob(['real-song-bytes']);
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.currentTrackIndex', 1);
    setState('transfer.meta', { name: 'song.mp3', index: 1, sessionId: 7 });
    setState('files.currentFileBlob', preBlob);
    setCurrentAudioBuffer({ duration: 200 } as AudioBuffer);
    setPlaybackFilePaused();

    bus.emit('demo:enter');
    await flush();
    expect(FakeXHR.pending.length).toBeGreaterThan(0);
    FakeXHR.pending[0].resolveOk();
    await flush(50);

    expect(getState('demo.active')).toBe(true);
    // loadDemoFile overwrote the pair half:
    expect(getState('transfer.meta')?.name).not.toBe('song.mp3');

    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('demo.active')).toBe(false);
    expect(getState('files.currentFileBlob')).toBe(preBlob);
    expect(getState('transfer.meta')).toMatchObject({ name: 'song.mp3', index: 1, sessionId: 7 });
  });

  it('re-dispatches a host track advance that arrived during an in-flight guest load (DEMO-1)', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');

    const flags = { reverbOn: false, bassBoostOn: false, trebleBoostOn: false, surroundOn: false };

    // Host says: enter demo, track 0. Guest starts loading (XHR held open).
    await handleData({ type: MSG.DEMO_ENTER, index: 0, ...flags }, hostConn);
    await flush();
    expect(getState('demo.loading')).toBe(true);
    expect(FakeXHR.pending.length).toBe(1);

    // Host advances to track 1 while the guest is still loading track 0; both
    // messages must survive the demo.loading guard.
    await handleData({ type: MSG.DEMO_ENTER, index: 1, ...flags }, hostConn);
    await handleData({ type: MSG.DEMO_PLAY, index: 1, time: 0, hostPlayAt: 0 }, hostConn);

    // Track 0 load finishes → the queued index must re-dispatch a load of 1.
    FakeXHR.pending[0].resolveOk();
    await flush(50);
    const followUp = FakeXHR.pending.find((x, i) => i > 0 && x.onload !== null);
    expect(followUp).toBeDefined();
    followUp!.resolveOk();
    await flush(50);

    expect(getState('playlist.currentTrackIndex')).toBe(1);
    expect(getCurrentAudioBuffer()).not.toBeNull();
    // The pending DEMO_PLAY applied once the right track landed.
    expect(mocks.play).toHaveBeenCalled();
  });

  it('keeps DEMO_TRACKS non-trivial so the advance scenario stays meaningful', () => {
    expect(DEMO_TRACKS.length).toBeGreaterThan(1);
  });
});
