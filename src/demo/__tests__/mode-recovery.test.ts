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
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
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
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
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
  showLoader: mocks.showLoader,
  showToast: mocks.showToast,
  updateLoader: mocks.updateLoader,
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
  failNetwork(): void {
    this.onerror?.();
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
      setState('transfer.meta', { name: meta?.name || 'demo.m4a', indexHint: 0 });
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

  it('refuses to enter the standard-room demo inside a PRO room', async () => {
    setState('network.appRole', 'host');
    setState('network.sessionCode', '000001');
    setState('setup.sessionStarted', true);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });

    bus.emit('demo:enter');
    await flush();

    expect(getState('demo.active')).toBe(false);
    expect(getState('demo.loading')).toBe(false);
    expect(FakeXHR.pending).toHaveLength(0);
    expect(mocks.stopAllMedia).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('tears down an in-flight standard demo when the room becomes PRO', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);

    bus.emit('demo:enter');
    await flush();
    expect(getState('demo.active')).toBe(true);
    expect(getState('demo.loading')).toBe(true);
    expect(FakeXHR.pending).toHaveLength(1);

    mocks.stopAllMedia.mockClear();
    mocks.broadcast.mockClear();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    await flush();

    expect(getState('demo.active')).toBe(false);
    expect(getState('demo.loading')).toBe(false);
    expect(mocks.stopAllMedia).toHaveBeenCalledTimes(1);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('keeps a superseded decode success from mutating a re-entered demo generation', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);

    let resolveFirstDecode!: () => void;
    mocks.loadDemoFile
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstDecode = resolve;
          }),
      )
      .mockImplementationOnce(async (_file: File, meta: { name?: string }) => {
        setCurrentAudioBuffer({ duration: 222 } as AudioBuffer);
        setState('transfer.meta', { name: meta?.name || 'demo-b.m4a', indexHint: 0 });
      });

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(20);
    expect(mocks.loadDemoFile).toHaveBeenCalledTimes(1);

    // Exit A while decodeAudioData is still outstanding, then immediately
    // create B. The browser may settle A only after B is fully interactive.
    bus.emit('demo:request-exit');
    bus.emit('demo:enter');
    await flush(20);
    FakeXHR.pending.at(-1)?.resolveOk();
    await flush(50);

    expect(mocks.loadDemoFile).toHaveBeenCalledTimes(2);
    expect(getState('demo.active')).toBe(true);
    expect(getState('demo.loading')).toBe(false);
    expect(getCurrentAudioBuffer()?.duration).toBe(222);
    expect(mocks.play).toHaveBeenCalledTimes(1);

    const toastCountAfterB = mocks.showToast.mock.calls.length;
    const loaderHideCountAfterB = mocks.showLoader.mock.calls.filter(
      ([visible]) => !visible,
    ).length;
    const broadcastCountAfterB = mocks.broadcast.mock.calls.length;

    resolveFirstDecode();
    await flush(50);

    expect(getState('demo.active')).toBe(true);
    expect(getState('demo.loading')).toBe(false);
    expect(getCurrentAudioBuffer()?.duration).toBe(222);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledTimes(toastCountAfterB);
    expect(mocks.showLoader.mock.calls.filter(([visible]) => !visible)).toHaveLength(
      loaderHideCountAfterB,
    );
    expect(mocks.broadcast).toHaveBeenCalledTimes(broadcastCountAfterB);
    bus.emit('demo:request-exit');
    await flush(50);
  });

  it('keeps a superseded decode failure from exiting or alarming a re-entered demo', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);

    let rejectFirstDecode!: (error: Error) => void;
    mocks.loadDemoFile
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirstDecode = reject;
          }),
      )
      .mockImplementationOnce(async (_file: File, meta: { name?: string }) => {
        setCurrentAudioBuffer({ duration: 333 } as AudioBuffer);
        setState('transfer.meta', { name: meta?.name || 'demo-b.m4a', indexHint: 0 });
      });

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(20);
    expect(mocks.loadDemoFile).toHaveBeenCalledTimes(1);

    bus.emit('demo:request-exit');
    bus.emit('demo:enter');
    await flush(20);
    FakeXHR.pending.at(-1)?.resolveOk();
    await flush(50);

    expect(mocks.loadDemoFile).toHaveBeenCalledTimes(2);
    expect(getState('demo.active')).toBe(true);
    expect(getCurrentAudioBuffer()?.duration).toBe(333);
    expect(mocks.play).toHaveBeenCalledTimes(1);

    const toastCountAfterB = mocks.showToast.mock.calls.length;
    const loaderHideCountAfterB = mocks.showLoader.mock.calls.filter(
      ([visible]) => !visible,
    ).length;
    const broadcastCountAfterB = mocks.broadcast.mock.calls.length;

    rejectFirstDecode(new Error('late decode failure from generation A'));
    await flush(50);

    expect(getState('demo.active')).toBe(true);
    expect(getState('demo.loading')).toBe(false);
    expect(getCurrentAudioBuffer()?.duration).toBe(333);
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledTimes(toastCountAfterB);
    expect(mocks.showLoader.mock.calls.filter(([visible]) => !visible)).toHaveLength(
      loaderHideCountAfterB,
    );
    expect(mocks.broadcast).toHaveBeenCalledTimes(broadcastCountAfterB);
    bus.emit('demo:request-exit');
    await flush(50);
  });

  it('restores transfer.meta with the file blob on demo exit (DEMO-4 pair invariant)', async () => {
    const preBlob = new Blob(['real-song-bytes']);
    const queueItemId = '11111111-1111-4111-8111-111111111111';
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [
      {
        queueItemId,
        type: 'file',
        name: 'song.mp3',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', queueItemId);
    setState('transfer.meta', { name: 'song.mp3', queueItemId, indexHint: 0, sessionId: 7 });
    setState('files.current', {
      queueItemId,
      indexHint: 0,
      name: 'song.mp3',
      sessionId: 7,
      blob: preBlob,
      mime: 'audio/mpeg',
      size: preBlob.size,
    });
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
    expect(getState('files.current')?.blob).toBe(preBlob);
    expect(getState('files.current')?.queueItemId).toBe(queueItemId);
    expect(getState('transfer.meta')).toMatchObject({
      name: 'song.mp3',
      queueItemId,
      indexHint: 0,
      sessionId: 7,
    });
  });

  it('initializes demo effect controls from the live audio settings', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('audio.reverbMix', 0.35);
    setState('audio.virtualBass', 60);
    setState('audio.exciter', true);
    setState('audio.eqValues', [5, 3, 0, 4, 6]);
    setState('audio.stereoWidth', 1.2);

    bus.emit('demo:enter');

    // Entry is synchronous up to the demo-track fetch. These flags must match
    // before the user can paint a stale all-off controls frame.
    expect(getState('demo.reverbOn')).toBe(true);
    expect(getState('demo.bassBoostOn')).toBe(true);
    expect(getState('demo.trebleBoostOn')).toBe(true);
    expect(getState('demo.surroundOn')).toBe(true);

    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);
    bus.emit('demo:request-exit');
    await flush(50);
  });

  it('maps combined bass and treble boosts to the advanced V-shaped EQ', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('audio.eqValues', [0, 0, 0, 0, 0]);
    const eqUpdates: Array<[number, number]> = [];
    bus.on('audio:set-eq', (band, value) => eqUpdates.push([band, value]));

    bus.emit('demo:enter');
    await flush();
    bus.emit('demo:toggle-bass');
    bus.emit('demo:toggle-treble');

    expect(eqUpdates.slice(-5)).toEqual([
      [0, 5],
      [1, 3],
      [2, 0],
      [3, 4],
      [4, 6],
    ]);

    FakeXHR.pending[0]?.resolveOk();
    await flush(50);
    bus.emit('demo:request-exit');
    await flush(50);
  });

  it('commits role and effect settings on a normal demo exit', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('audio.channelMode', 0);
    setState('audio.reverbMix', 0);
    setState('audio.eqValues', [0, 0, 0, 0, 0]);
    setState('audio.stereoWidth', 1);
    setState('audio.virtualBass', 0);
    setState('audio.exciter', false);

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    setState('audio.channelMode', 1);
    setState('audio.reverbMix', 0.35);
    setState('audio.eqValues', [5, 3, 0, 4, 6]);
    setState('audio.stereoWidth', 1.2);
    setState('audio.virtualBass', 60);
    setState('audio.exciter', true);

    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('audio.channelMode')).toBe(1);
    expect(getState('audio.reverbMix')).toBe(0.35);
    expect(getState('audio.eqValues')).toEqual([5, 3, 0, 4, 6]);
    expect(getState('audio.stereoWidth')).toBe(1.2);
    expect(getState('audio.virtualBass')).toBe(60);
    expect(getState('audio.exciter')).toBe(true);
  });

  it('restores role and effect settings when demo entry fails', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('audio.channelMode', -1);
    setState('audio.reverbMix', 0.1);
    setState('audio.eqValues', [1, 2, 3, 2, 1]);
    setState('audio.stereoWidth', 1.05);
    setState('audio.virtualBass', 20);
    setState('audio.exciter', false);

    bus.emit('demo:enter');
    await flush();
    setState('audio.channelMode', 1);
    setState('audio.reverbMix', 0.35);
    setState('audio.eqValues', [5, 3, 0, 4, 6]);
    setState('audio.stereoWidth', 1.2);
    setState('audio.virtualBass', 60);
    setState('audio.exciter', true);
    FakeXHR.pending[0]?.failNetwork();
    await flush(50);

    expect(getState('demo.active')).toBe(false);
    expect(getState('audio.channelMode')).toBe(-1);
    expect(getState('audio.reverbMix')).toBe(0.1);
    expect(getState('audio.eqValues')).toEqual([1, 2, 3, 2, 1]);
    expect(getState('audio.stereoWidth')).toBe(1.05);
    expect(getState('audio.virtualBass')).toBe(20);
    expect(getState('audio.exciter')).toBe(false);
  });

  it('re-dispatches a host track advance that arrived during an in-flight guest load (DEMO-1)', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);

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

    expect(getState('demo.currentTrackIndex')).toBe(1);
    expect(getCurrentAudioBuffer()).not.toBeNull();
    // The pending DEMO_PLAY applied once the right track landed.
    expect(mocks.play).toHaveBeenCalled();
  });

  it('tears down demo authority without restoring old-room media afterward', async () => {
    const oldQueueItemId = '11111111-1111-4111-8111-111111111111';
    const newQueueItemId = '22222222-2222-4222-8222-222222222222';
    const oldBlob = new Blob(['old-room']);
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [
      {
        queueItemId: oldQueueItemId,
        type: 'file',
        name: 'old.mp3',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', oldQueueItemId);
    setState('files.current', {
      queueItemId: oldQueueItemId,
      indexHint: 0,
      name: 'old.mp3',
      sessionId: 9,
      blob: oldBlob,
      mime: 'audio/mpeg',
      size: oldBlob.size,
    });
    setCurrentAudioBuffer({ duration: 200 } as AudioBuffer);
    setPlaybackFilePaused();

    bus.emit('demo:enter');
    await flush(50);
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);
    expect(getState('demo.active')).toBe(true);

    setState('network.appRole', 'guest');
    bus.emit('demo:authority-reset');
    setState('playlist.items', [
      {
        queueItemId: newQueueItemId,
        type: 'file',
        name: 'new.mp3',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', newQueueItemId);
    setState('files.current', null);
    setState('transfer.meta', null);
    setCurrentAudioBuffer(null);
    await flush(500);

    expect(getState('demo.active')).toBe(false);
    expect(getState('playlist.currentQueueItemId')).toBe(newQueueItemId);
    expect(getState('files.current')).toBeNull();
    expect(getState('transfer.meta')).toBeNull();
    expect(getCurrentAudioBuffer()).toBeNull();
  });

  it('keeps DEMO_TRACKS non-trivial so the advance scenario stays meaningful', () => {
    expect(DEMO_TRACKS.length).toBeGreaterThan(1);
  });
});
