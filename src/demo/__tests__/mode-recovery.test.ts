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
import {
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackIdle,
  setPlaybackSystemAudioPlaying,
  setPlaybackTrackMeta,
} from '../../player/ownership.ts';
import { DEMO_TRACKS } from '../tracks.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  play: vi.fn(),
  pause: vi.fn(),
  stopAllMedia: vi.fn(),
  applyBoundedPausedCheckpoint: vi.fn(),
  requestBoundedOwnerSwitchStop: vi.fn(
    (): { settled: Promise<boolean>; isCurrent: () => boolean } | null => null,
  ),
  getTrackPosition: vi.fn(() => 12),
  getHostNow: vi.fn(() => 10_000),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  loadDemoFile: vi.fn(),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
  boundedSnapshot: {
    active: false,
    role: 'idle' as 'idle' | 'host' | 'guest',
    generation: 1,
    current: null as {
      queueItemId: string;
      legacySessionId: number;
      state: 'ready';
      phase: 'playing' | 'paused' | 'stopped';
      positionSeconds: number;
      durationSeconds: number;
      pendingControl?: string | null;
    } | null,
  },
  boundedPosition: null as number | null,
}));

vi.mock('../../player/transport.ts', () => ({
  applyLegacyBoundedV1HostPausedCheckpoint: mocks.applyBoundedPausedCheckpoint,
  fmtTime: vi.fn((seconds: number) => `fmt:${Math.floor(seconds)}`),
  getTrackPosition: mocks.getTrackPosition,
  pause: mocks.pause,
  play: mocks.play,
  requestLegacyBoundedV1OwnerSwitchStop: mocks.requestBoundedOwnerSwitchStop,
  seekTo: vi.fn(),
  stopAllMedia: mocks.stopAllMedia,
}));

vi.mock('../../player/legacy-bounded-file-v1-product.ts', () => ({
  legacyBoundedFileV1Product: {
    snapshot: vi.fn(() => mocks.boundedSnapshot),
    positionSeconds: vi.fn(() => mocks.boundedPosition),
  },
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
    mocks.boundedSnapshot.active = false;
    mocks.boundedSnapshot.role = 'idle';
    mocks.boundedSnapshot.generation = 1;
    mocks.boundedSnapshot.current = null;
    mocks.boundedPosition = null;
    mocks.applyBoundedPausedCheckpoint.mockImplementation(
      async (queueItemId: string, legacySessionId: number, positionSeconds: number) => {
        const current = mocks.boundedSnapshot.current;
        if (
          !current ||
          current.queueItemId !== queueItemId ||
          current.legacySessionId !== legacySessionId
        ) {
          return false;
        }
        mocks.boundedSnapshot.current = {
          ...current,
          phase: 'paused',
          positionSeconds,
        };
        mocks.boundedPosition = positionSeconds;
        return true;
      },
    );
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
    mocks.stopAllMedia.mockImplementation(() => {
      setState('player.pausedAt', 0);
      setPlaybackIdle();
    });

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

  it('waits for exact bounded owner stop before decoding demo audio', async () => {
    const queueItemId = '21111111-1111-4111-8111-111111111110';
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [
      {
        queueItemId,
        type: 'file',
        name: 'waiting.flac',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackFilePaused();
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 10,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 12,
      durationSeconds: 90,
      pendingControl: null,
    };
    mocks.boundedPosition = 12;
    let releaseRetirement!: (retired: boolean) => void;
    mocks.requestBoundedOwnerSwitchStop.mockReturnValueOnce({
      settled: new Promise<boolean>((resolve) => {
        releaseRetirement = resolve;
      }),
      isCurrent: () => true,
    });

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(20);

    expect(mocks.requestBoundedOwnerSwitchStop).toHaveBeenCalledOnce();
    expect(mocks.loadDemoFile).not.toHaveBeenCalled();
    releaseRetirement(true);
    await flush(50);

    expect(mocks.loadDemoFile).toHaveBeenCalledOnce();
    expect(getState('demo.active')).toBe(true);
    expect(getState('demo.loading')).toBe(false);
    bus.emit('demo:request-exit');
    await flush(20);
  });

  it('does not revive demo decoding after its owner leaves during bounded stop', async () => {
    const queueItemId = '21111111-1111-4111-8111-111111111111';
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [
      {
        queueItemId,
        type: 'file',
        name: 'leaving.flac',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackFilePaused();
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 11,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 14,
      durationSeconds: 100,
      pendingControl: null,
    };
    mocks.boundedPosition = 14;
    let releaseRetirement!: (retired: boolean) => void;
    mocks.requestBoundedOwnerSwitchStop.mockReturnValueOnce({
      settled: new Promise<boolean>((resolve) => {
        releaseRetirement = resolve;
      }),
      isCurrent: () => true,
    });

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(20);
    expect(mocks.loadDemoFile).not.toHaveBeenCalled();

    bus.emit('demo:request-exit');
    releaseRetirement(true);
    await flush(50);

    expect(mocks.loadDemoFile).not.toHaveBeenCalled();
    expect(getState('demo.active')).toBe(false);
    expect(getState('demo.loading')).toBe(false);
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
    setState('player.pausedAt', 5);
    mocks.getTrackPosition.mockReturnValue(71.5);
    setPlaybackFilePlaying();

    bus.emit('demo:enter');
    await flush();
    expect(FakeXHR.pending.length).toBeGreaterThan(0);
    FakeXHR.pending[0].resolveOk();
    await flush(50);

    expect(getState('demo.active')).toBe(true);
    // loadDemoFile overwrote the pair half:
    expect(getState('transfer.meta')?.name).not.toBe('song.mp3');

    mocks.broadcast.mockClear();
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
    expect(getState('player.pausedAt')).toBe(71.5);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 71.5,
      queueItemId,
      reason: 'seek',
    });
  });

  it('does not restore or publish a resident file over a selected successor', async () => {
    const predecessorId = '11111111-1111-4111-8111-111111111119';
    const successorId = '21111111-1111-4111-8111-111111111119';
    const predecessorBlob = new Blob(['predecessor']);
    const predecessor = {
      queueItemId: predecessorId,
      type: 'file' as const,
      name: 'predecessor.mp3',
      title: 'Predecessor',
      videoId: null,
      playlistId: null,
    };
    const successor = {
      queueItemId: successorId,
      type: 'file' as const,
      name: 'successor.mp3',
      title: 'Successor',
      videoId: null,
      playlistId: null,
    };
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [predecessor, successor]);
    setState('playlist.currentQueueItemId', predecessorId);
    setState('files.current', {
      queueItemId: predecessorId,
      indexHint: 0,
      name: predecessor.name,
      sessionId: 8,
      blob: predecessorBlob,
      mime: 'audio/mpeg',
      size: predecessorBlob.size,
    });
    setState('transfer.meta', {
      queueItemId: predecessorId,
      indexHint: 0,
      name: predecessor.name,
      sessionId: 8,
    });
    setCurrentAudioBuffer({ duration: 180 } as AudioBuffer);
    setPlaybackTrackMeta(predecessor);
    setPlaybackFilePlaying();
    mocks.getTrackPosition.mockReturnValue(63);

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    setState('playlist.currentQueueItemId', successorId);
    setPlaybackTrackMeta(successor);
    mocks.broadcast.mockClear();
    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('playlist.currentQueueItemId')).toBe(successorId);
    expect(getState('player.currentTrackMeta')).toEqual(successor);
    expect(getState('playback.activity')).toBe('idle');
    expect(mocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        queueItemId: predecessorId,
      }),
    );
  });

  it('does not restore a resident host file after authority is lost behind the exit curtain', async () => {
    const queueItemId = '11111111-1111-4111-8111-111111111120';
    const blob = new Blob(['resident-authority']);
    const meta = {
      queueItemId,
      type: 'file' as const,
      name: 'resident-authority.mp3',
      title: 'Resident authority',
      videoId: null,
      playlistId: null,
    };
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setState('files.current', {
      queueItemId,
      indexHint: 0,
      name: meta.name,
      sessionId: 9,
      blob,
      mime: 'audio/mpeg',
      size: blob.size,
    });
    setState('transfer.meta', {
      queueItemId,
      indexHint: 0,
      name: meta.name,
      sessionId: 9,
    });
    setCurrentAudioBuffer({ duration: 180 } as AudioBuffer);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePlaying();
    mocks.getTrackPosition.mockReturnValue(66);

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    document.body.innerHTML = `
      <div id="demo-overlay" class="active"></div>
      <div id="demo-curtain" style="opacity: 0"></div>
    `;
    const curtain = document.getElementById('demo-curtain') as HTMLElement & {
      animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;
    };
    const exitAnimation = {
      cancel: vi.fn(),
      onfinish: null as (() => void) | null,
      oncancel: null as (() => void) | null,
    } as unknown as Animation;
    Object.defineProperty(curtain, 'animate', {
      configurable: true,
      value: vi.fn(() => exitAnimation),
    });

    mocks.broadcast.mockClear();
    bus.emit('demo:request-exit');
    await flush(20);
    expect(exitAnimation.onfinish).toBeTypeOf('function');

    setState('network.appRole', 'guest');
    exitAnimation.onfinish?.call(
      exitAnimation,
      new Event('finish') as AnimationPlaybackEvent,
    );
    await flush(20);

    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.currentTrackMeta')?.queueItemId).not.toBe(queueItemId);
    expect(mocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        time: 66,
        queueItemId,
      }),
    );
  });

  it('restores an exact AudioBuffer-free bounded source after demo exit', async () => {
    const preBlob = new Blob(['bounded-song-bytes']);
    const queueItemId = '31111111-1111-4111-8111-111111111111';
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [
      {
        queueItemId,
        type: 'file',
        name: 'bounded.flac',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', queueItemId);
    setState('transfer.meta', {
      name: 'bounded.flac',
      queueItemId,
      indexHint: 0,
      sessionId: 17,
    });
    setState('files.current', {
      queueItemId,
      indexHint: 0,
      name: 'bounded.flac',
      sessionId: 17,
      blob: preBlob,
      mime: 'audio/flac',
      size: preBlob.size,
    });
    setState('player.pausedAt', 41.25);
    setCurrentAudioBuffer(null);
    setPlaybackFilePaused();
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 17,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 41.25,
      durationSeconds: 204.5,
    };
    mocks.boundedPosition = 41.25;
    mocks.getTrackPosition.mockReturnValue(41.25);
    const durationUpdate = vi.fn();
    bus.on('ui:duration-update', durationUpdate);
    document.body.innerHTML = `
      <input id="seek-slider" type="range" value="0" max="0" />
      <span id="time-curr"></span>
      <span id="time-dur"></span>
    `;
    const { initSeekBar } = await import('../../ui/seekbar.ts');
    initSeekBar();

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);
    expect(getCurrentAudioBuffer()?.duration).toBe(120);

    // The real owner switch has drained the renderer and retained only the
    // exact encoded source at its terminal STOP checkpoint.
    mocks.boundedSnapshot.current = {
      ...mocks.boundedSnapshot.current!,
      phase: 'stopped',
      positionSeconds: 0,
    };
    mocks.boundedPosition = 0;
    setState('player.pausedAt', 0);
    mocks.broadcast.mockClear();
    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('demo.active')).toBe(false);
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getState('files.current')?.blob).toBe(preBlob);
    expect(getState('files.current')?.queueItemId).toBe(queueItemId);
    expect(getState('transfer.meta')).toMatchObject({
      queueItemId,
      sessionId: 17,
    });
    expect(getState('player.pausedAt')).toBe(41.25);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(mocks.applyBoundedPausedCheckpoint).toHaveBeenCalledWith(
      queueItemId,
      17,
      41.25,
    );
    expect(mocks.boundedSnapshot.current).toMatchObject({
      queueItemId,
      legacySessionId: 17,
      phase: 'paused',
      positionSeconds: 41.25,
    });
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 41.25,
      queueItemId,
      reason: 'seek',
    });
    expect(durationUpdate).toHaveBeenCalledWith(204.5);
    const seekSlider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(seekSlider.value).toBe('41.25');
    expect(seekSlider.max).toBe('204.5');
    expect(document.getElementById('time-curr')?.innerText).toBe('fmt:41');
    expect(document.getElementById('time-dur')?.innerText).toBe('fmt:204');
  });

  it('joins the initial owner STOP when exit happens during the demo fetch', async () => {
    const queueItemId = '31111111-1111-4111-8111-111111111118';
    const meta = {
      queueItemId,
      type: 'file' as const,
      name: 'pending-stop.flac',
      title: 'Pending stop',
      videoId: null,
      playlistId: null,
    };
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePaused();
    setState('player.pausedAt', 37);
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.generation = 6;
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 18,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 37,
      durationSeconds: 160,
      pendingControl: null,
    };
    mocks.boundedPosition = 37;
    document.body.innerHTML = `
      <input id="seek-slider" type="range" value="0" max="0" />
      <span id="time-curr"></span>
      <span id="time-dur"></span>
    `;
    const { initSeekBar } = await import('../../ui/seekbar.ts');
    initSeekBar();

    let settleStop!: () => void;
    let stopIsCurrent = true;
    const stopHandle = {
      settled: new Promise<boolean>((resolve) => {
        settleStop = () => {
          mocks.boundedSnapshot.current = {
            ...mocks.boundedSnapshot.current!,
            phase: 'stopped',
            positionSeconds: 0,
            pendingControl: null,
          };
          mocks.boundedPosition = 0;
          resolve(true);
        };
      }),
      isCurrent: () => stopIsCurrent,
    };
    mocks.requestBoundedOwnerSwitchStop.mockReturnValueOnce(stopHandle);

    bus.emit('demo:enter');
    await flush();
    await flush(20);
    expect(getState('demo.loading')).toBe(true);
    expect(FakeXHR.pending).toHaveLength(1);

    mocks.applyBoundedPausedCheckpoint.mockClear();
    mocks.broadcast.mockClear();
    bus.emit('demo:request-exit');
    await flush(20);

    expect(mocks.stopAllMedia).toHaveBeenLastCalledWith({
      cancelInFlight: true,
      preserveLegacyBoundedOwner: true,
    });
    expect(mocks.applyBoundedPausedCheckpoint).not.toHaveBeenCalled();
    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('0');

    settleStop();
    await flush(50);

    expect(mocks.applyBoundedPausedCheckpoint).toHaveBeenCalledWith(
      queueItemId,
      18,
      37,
    );
    expect(mocks.boundedSnapshot.current).toMatchObject({
      phase: 'paused',
      positionSeconds: 37,
    });
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 37,
      queueItemId,
      reason: 'seek',
    });
    expect(mocks.loadDemoFile).not.toHaveBeenCalled();
    stopIsCurrent = false;
  });

  it('hands the restored bounded checkpoint through an immediate demo re-entry', async () => {
    const queueItemId = '31111111-1111-4111-8111-111111111113';
    const meta = {
      queueItemId,
      type: 'file' as const,
      name: 'reentry.flac',
      title: 'Re-entry',
      videoId: null,
      playlistId: null,
    };
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePaused();
    setState('player.pausedAt', 39);
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.generation = 12;
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 23,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 39,
      durationSeconds: 165,
      pendingControl: null,
    };
    mocks.boundedPosition = 39;

    let settleFirstStop!: () => void;
    let firstStopCurrent = true;
    const firstStop = {
      settled: new Promise<boolean>((resolve) => {
        settleFirstStop = () => {
          mocks.boundedSnapshot.current = {
            ...mocks.boundedSnapshot.current!,
            phase: 'stopped',
            positionSeconds: 0,
            pendingControl: null,
          };
          mocks.boundedPosition = 0;
          resolve(true);
        };
      }),
      isCurrent: () => firstStopCurrent,
    };
    let secondStopCurrent = true;
    mocks.requestBoundedOwnerSwitchStop
      .mockReturnValueOnce(firstStop)
      .mockImplementationOnce(() => {
        mocks.boundedSnapshot.current = {
          ...mocks.boundedSnapshot.current!,
          phase: 'stopped',
          positionSeconds: 0,
          pendingControl: null,
        };
        mocks.boundedPosition = 0;
        return {
          settled: Promise.resolve(true),
          isCurrent: () => secondStopCurrent,
        };
      });

    bus.emit('demo:enter');
    await flush(20);
    bus.emit('demo:request-exit');
    bus.emit('demo:enter');
    await flush(20);

    expect(getState('demo.active')).toBe(false);
    expect(getState('demo.loading')).toBe(false);
    expect(FakeXHR.pending).toHaveLength(1);

    settleFirstStop();
    await flush(50);

    expect(getState('demo.active')).toBe(true);
    expect(getState('demo.loading')).toBe(true);
    expect(mocks.requestBoundedOwnerSwitchStop).toHaveBeenCalledTimes(2);
    FakeXHR.pending.at(-1)?.resolveOk();
    await flush(50);
    expect(getState('demo.loading')).toBe(false);

    mocks.applyBoundedPausedCheckpoint.mockClear();
    mocks.broadcast.mockClear();
    bus.emit('demo:request-exit');
    await flush(50);

    expect(mocks.applyBoundedPausedCheckpoint).toHaveBeenCalledWith(
      queueItemId,
      23,
      39,
    );
    expect(mocks.boundedSnapshot.current).toMatchObject({
      phase: 'paused',
      positionSeconds: 39,
    });
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 39,
      queueItemId,
      reason: 'seek',
    });
    firstStopCurrent = false;
    secondStopCurrent = false;
  });

  it('keeps the neutral exit baseline when the initial owner STOP fails', async () => {
    const queueItemId = '31111111-1111-4111-8111-111111111117';
    const meta = {
      queueItemId,
      type: 'file' as const,
      name: 'failed-stop.flac',
      title: 'Failed stop',
      videoId: null,
      playlistId: null,
    };
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePlaying();
    setState('player.pausedAt', 29);
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.generation = 9;
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 17,
      state: 'ready',
      phase: 'playing',
      positionSeconds: 29,
      durationSeconds: 140,
      pendingControl: null,
    };
    mocks.boundedPosition = 29;

    let settleStop!: () => void;
    let stopIsCurrent = true;
    mocks.requestBoundedOwnerSwitchStop.mockReturnValueOnce({
      settled: new Promise<boolean>((resolve) => {
        settleStop = () => resolve(false);
      }),
      isCurrent: () => stopIsCurrent,
    });

    bus.emit('demo:enter');
    await flush(20);
    mocks.broadcast.mockClear();
    bus.emit('demo:request-exit');
    await flush(20);

    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.pausedAt')).toBe(0);
    settleStop();
    await flush(50);

    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.pausedAt')).toBe(0);
    expect(mocks.applyBoundedPausedCheckpoint).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        time: 29,
        queueItemId,
      }),
    );

    mocks.requestBoundedOwnerSwitchStop.mockClear();
    setPlaybackFilePaused();
    bus.emit('demo:enter');
    await flush(20);
    expect(mocks.requestBoundedOwnerSwitchStop).toHaveBeenCalledOnce();
    bus.emit('demo:request-exit');
    await flush(20);
    stopIsCurrent = false;
  });

  it.each(['room', 'authority', 'successor'] as const)(
    'suppresses a delayed owner STOP restoration after %s changes',
    async (change) => {
      const suffix = change === 'room' ? '114' : change === 'authority' ? '115' : '116';
      const queueItemId = `31111111-1111-4111-8111-111111111${suffix}`;
      const successorId = '41111111-1111-4111-8111-111111111116';
      const meta = {
        queueItemId,
        type: 'file' as const,
        name: `${change}.flac`,
        title: change,
        videoId: null,
        playlistId: null,
      };
      const successor = {
        queueItemId: successorId,
        type: 'file' as const,
        name: 'successor.flac',
        title: 'Successor',
        videoId: null,
        playlistId: null,
      };
      setState('network.appRole', 'host');
      setState('setup.sessionStarted', true);
      setState('playlist.items', [meta, successor]);
      setState('playlist.currentQueueItemId', queueItemId);
      setPlaybackTrackMeta(meta);
      setPlaybackFilePaused();
      setState('player.pausedAt', 32);
      mocks.boundedSnapshot.active = true;
      mocks.boundedSnapshot.role = 'host';
      mocks.boundedSnapshot.generation = 10;
      mocks.boundedSnapshot.current = {
        queueItemId,
        legacySessionId: 16,
        state: 'ready',
        phase: 'paused',
        positionSeconds: 32,
        durationSeconds: 150,
        pendingControl: null,
      };
      mocks.boundedPosition = 32;

      let settleStop!: () => void;
      let stopIsCurrent = true;
      mocks.requestBoundedOwnerSwitchStop.mockReturnValueOnce({
        settled: new Promise<boolean>((resolve) => {
          settleStop = () => {
            mocks.boundedSnapshot.current = {
              ...mocks.boundedSnapshot.current!,
              phase: 'stopped',
              positionSeconds: 0,
              pendingControl: null,
            };
            mocks.boundedPosition = 0;
            resolve(true);
          };
        }),
        isCurrent: () => stopIsCurrent,
      });

      bus.emit('demo:enter');
      await flush(20);
      mocks.broadcast.mockClear();
      bus.emit('demo:request-exit');
      await flush(20);

      if (change === 'room') {
        const room = getState('room.context');
        setState('room.context', { ...room, epoch: room.epoch + 1 });
      } else if (change === 'authority') {
        setState('network.appRole', 'guest');
      } else {
        setState('playlist.currentQueueItemId', successorId);
        setPlaybackTrackMeta(successor);
        setPlaybackIdle();
      }

      settleStop();
      await flush(50);

      expect(mocks.applyBoundedPausedCheckpoint).not.toHaveBeenCalled();
      expect(mocks.broadcast).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.PAUSE,
          time: 32,
          queueItemId,
        }),
      );
      if (change === 'successor') {
        expect(getState('playlist.currentQueueItemId')).toBe(successorId);
        expect(getState('player.currentTrackMeta')).toEqual(successor);
      } else {
        expect(getState('player.pausedAt')).toBe(0);
        if (change === 'authority') {
          expect(getState('playback.mode')).toBeNull();
          expect(getState('playback.activity')).toBe('idle');
          expect(getState('player.currentTrackMeta')?.queueItemId).not.toBe(queueItemId);
        }
      }
      stopIsCurrent = false;
    },
  );

  it('keeps host UI on the physical STOP checkpoint when demo compensation fails', async () => {
    const queueItemId = '31111111-1111-4111-8111-111111111119';
    const meta = {
      queueItemId,
      type: 'file' as const,
      name: 'failed-restore.flac',
      title: 'Failed restore',
      videoId: null,
      playlistId: null,
    };
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePaused();
    setState('player.pausedAt', 52);
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 19,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 52,
      durationSeconds: 180,
    };
    mocks.boundedPosition = 52;

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    mocks.boundedSnapshot.current = {
      ...mocks.boundedSnapshot.current,
      phase: 'stopped',
      positionSeconds: 0,
    };
    mocks.boundedPosition = 0;
    setState('player.pausedAt', 0);
    mocks.applyBoundedPausedCheckpoint.mockResolvedValueOnce(false);
    mocks.broadcast.mockClear();

    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(mocks.boundedSnapshot.current).toMatchObject({
      phase: 'stopped',
      positionSeconds: 0,
    });
    expect(mocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        time: 52,
        queueItemId,
      }),
    );
  });

  it('does not let a late bounded restore overwrite a newer system-audio owner', async () => {
    const queueItemId = '31111111-1111-4111-8111-111111111120';
    const meta = {
      queueItemId,
      type: 'file' as const,
      name: 'late-restore.flac',
      title: 'Late restore',
      videoId: null,
      playlistId: null,
    };
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePaused();
    setState('player.pausedAt', 58);
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.generation = 7;
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 20,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 58,
      durationSeconds: 190,
      pendingControl: null,
    };
    mocks.boundedPosition = 58;

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    mocks.boundedSnapshot.current = {
      ...mocks.boundedSnapshot.current,
      phase: 'stopped',
      positionSeconds: 0,
    };
    mocks.boundedPosition = 0;
    setState('player.pausedAt', 0);

    let settleRestore!: () => void;
    mocks.applyBoundedPausedCheckpoint.mockImplementationOnce(
      (_queueItemId: string, _legacySessionId: number, positionSeconds: number) =>
        new Promise<boolean>((resolve) => {
          settleRestore = () => {
            mocks.boundedSnapshot.current = {
              ...mocks.boundedSnapshot.current!,
              phase: 'paused',
              positionSeconds,
              pendingControl: null,
            };
            mocks.boundedPosition = positionSeconds;
            resolve(true);
          };
        }),
    );
    mocks.broadcast.mockClear();
    bus.emit('demo:request-exit');
    await flush(10);
    expect(mocks.applyBoundedPausedCheckpoint).toHaveBeenCalledOnce();

    setPlaybackSystemAudioPlaying();
    settleRestore();
    await flush(50);

    expect(getState('playback.mode')).toBe('system-audio');
    expect(getState('playback.activity')).toBe('playing');
    expect(mocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        time: 58,
        queueItemId,
      }),
    );
  });

  it('keeps a bounded guest at physical STOP until the host publishes PAUSE', async () => {
    const hostConn = { open: true, peer: 'host-bounded' } as DataConnection;
    const queueItemId = '31111111-1111-4111-8111-111111111121';
    const meta = {
      queueItemId,
      type: 'file' as const,
      name: 'guest-bounded.flac',
      title: 'Guest bounded',
      videoId: null,
      playlistId: null,
    };
    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePaused();
    setState('player.pausedAt', 44);
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'guest';
    mocks.boundedSnapshot.generation = 8;
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 21,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 44,
      durationSeconds: 170,
      pendingControl: null,
    };
    mocks.boundedPosition = 44;

    const flags = {
      reverbOn: false,
      bassBoostOn: false,
      trebleBoostOn: false,
      surroundOn: false,
    };
    await handleData({ type: MSG.DEMO_ENTER, index: 0, ...flags }, hostConn);
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    mocks.boundedSnapshot.current = {
      ...mocks.boundedSnapshot.current,
      phase: 'stopped',
      positionSeconds: 0,
    };
    mocks.boundedPosition = 0;
    setState('player.pausedAt', 0);
    mocks.broadcast.mockClear();
    mocks.applyBoundedPausedCheckpoint.mockClear();

    await handleData({ type: MSG.DEMO_EXIT }, hostConn);
    await flush(50);

    expect(getState('demo.active')).toBe(false);
    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
    expect(mocks.applyBoundedPausedCheckpoint).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        time: 44,
        queueItemId,
      }),
    );
  });

  it('does not restore a bounded guest after its host connection is replaced', async () => {
    const hostConnA = { open: true, peer: 'host-a' } as DataConnection;
    const hostConnB = { open: true, peer: 'host-b' } as DataConnection;
    const queueItemId = '31111111-1111-4111-8111-111111111122';
    const meta = {
      queueItemId,
      type: 'file' as const,
      name: 'guest-reconnect.flac',
      title: 'Guest reconnect',
      videoId: null,
      playlistId: null,
    };
    setState('network.hostConn', hostConnA);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConnA);
    setState('playlist.items', [meta]);
    setState('playlist.currentQueueItemId', queueItemId);
    setPlaybackTrackMeta(meta);
    setPlaybackFilePaused();
    setState('player.pausedAt', 46);
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'guest';
    mocks.boundedSnapshot.generation = 11;
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 22,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 46,
      durationSeconds: 175,
      pendingControl: null,
    };
    mocks.boundedPosition = 46;

    let settleStop!: () => void;
    let stopIsCurrent = true;
    mocks.requestBoundedOwnerSwitchStop.mockReturnValueOnce({
      settled: new Promise<boolean>((resolve) => {
        settleStop = () => {
          mocks.boundedSnapshot.current = {
            ...mocks.boundedSnapshot.current!,
            phase: 'stopped',
            positionSeconds: 0,
            pendingControl: null,
          };
          mocks.boundedPosition = 0;
          resolve(true);
        };
      }),
      isCurrent: () => stopIsCurrent,
    });

    const flags = {
      reverbOn: false,
      bassBoostOn: false,
      trebleBoostOn: false,
      surroundOn: false,
    };
    await handleData({ type: MSG.DEMO_ENTER, index: 0, ...flags }, hostConnA);
    await flush(20);
    mocks.broadcast.mockClear();
    await handleData({ type: MSG.DEMO_EXIT }, hostConnA);
    await flush(20);

    setState('network.hostConn', hostConnB);
    settleStop();
    await flush(50);

    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(getState('player.currentTrackMeta')?.queueItemId).not.toBe(queueItemId);
    expect(mocks.applyBoundedPausedCheckpoint).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        time: 46,
        queueItemId,
      }),
    );
    stopIsCurrent = false;
  });

  it('fails closed instead of restoring a stale bounded incarnation', async () => {
    const preBlob = new Blob(['stale-bounded-song']);
    const queueItemId = '41111111-1111-4111-8111-111111111111';
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [
      {
        queueItemId,
        type: 'file',
        name: 'stale.flac',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', queueItemId);
    setState('transfer.meta', {
      name: 'stale.flac',
      queueItemId,
      indexHint: 0,
      sessionId: 21,
    });
    setState('files.current', {
      queueItemId,
      indexHint: 0,
      name: 'stale.flac',
      sessionId: 21,
      blob: preBlob,
      mime: 'audio/flac',
      size: preBlob.size,
    });
    setState('player.pausedAt', 19);
    setCurrentAudioBuffer(null);
    setPlaybackFilePaused();
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 21,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 19,
      durationSeconds: 99,
    };
    mocks.boundedPosition = 19;

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);
    mocks.boundedSnapshot.current = null;
    mocks.boundedPosition = null;

    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('demo.active')).toBe(false);
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('files.current')).toBeNull();
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('preserves a ready bounded successor instead of wiping its UI after demo exit', async () => {
    const originalBlob = new Blob(['original-bounded-song']);
    const successorBlob = new Blob(['successor-bounded-song']);
    const queueItemId = '51111111-1111-4111-8111-111111111111';
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [
      {
        queueItemId,
        type: 'file',
        name: 'successor.flac',
        title: 'Successor',
        videoId: null,
        playlistId: null,
      },
    ]);
    setState('playlist.currentQueueItemId', queueItemId);
    setState('transfer.meta', {
      name: 'successor.flac',
      queueItemId,
      indexHint: 0,
      sessionId: 21,
    });
    setState('files.current', {
      queueItemId,
      indexHint: 0,
      name: 'successor.flac',
      sessionId: 21,
      blob: originalBlob,
      mime: 'audio/flac',
      size: originalBlob.size,
    });
    setCurrentAudioBuffer(null);
    setPlaybackFilePaused();
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 21,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 19,
      durationSeconds: 99,
    };
    mocks.boundedPosition = 19;

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    mocks.boundedSnapshot.current = {
      queueItemId,
      legacySessionId: 22,
      state: 'ready',
      phase: 'stopped',
      positionSeconds: 0,
      durationSeconds: 150,
    };
    mocks.boundedPosition = 0;
    // This is the outgoing demo timeline, not the stopped successor's
    // product checkpoint. It must never leak into the successor projection.
    setState('player.pausedAt', 88);
    setState('transfer.meta', {
      name: 'successor.flac',
      queueItemId,
      indexHint: 0,
      sessionId: 22,
    });
    setState('files.current', {
      queueItemId,
      indexHint: 0,
      name: 'successor.flac',
      sessionId: 22,
      blob: successorBlob,
      mime: 'audio/flac',
      size: successorBlob.size,
    });

    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
    expect(getState('files.current')).toMatchObject({
      queueItemId,
      sessionId: 22,
      blob: successorBlob,
    });
    expect(getState('transfer.meta')).toMatchObject({
      queueItemId,
      sessionId: 22,
    });
    expect(getState('player.currentTrackMeta')).toMatchObject({
      queueItemId,
      title: 'Successor',
    });
    expect(getState('player.pausedAt')).toBe(0);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('does not restore a retained old bounded source over a selected preparing successor', async () => {
    const originalQueueItemId = '51111111-1111-4111-8111-111111111111';
    const successorQueueItemId = '51111111-1111-4111-8111-111111111112';
    const original = {
      queueItemId: originalQueueItemId,
      type: 'file' as const,
      name: 'original.flac',
      title: 'Original',
      videoId: null,
      playlistId: null,
    };
    const successor = {
      queueItemId: successorQueueItemId,
      type: 'file' as const,
      name: 'successor.flac',
      title: 'Successor',
      videoId: null,
      playlistId: null,
    };
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('playlist.items', [original, successor]);
    setState('playlist.currentQueueItemId', originalQueueItemId);
    setPlaybackTrackMeta(original);
    setPlaybackFilePaused();
    mocks.boundedSnapshot.active = true;
    mocks.boundedSnapshot.role = 'host';
    mocks.boundedSnapshot.current = {
      queueItemId: originalQueueItemId,
      legacySessionId: 31,
      state: 'ready',
      phase: 'paused',
      positionSeconds: 19,
      durationSeconds: 99,
    };
    mocks.boundedPosition = 19;

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    // The successor owns selection/UI, but its bounded source has not reached
    // ready yet. The retained product current is still the captured predecessor.
    setState('playlist.currentQueueItemId', successorQueueItemId);
    setPlaybackTrackMeta(successor);

    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('playlist.currentQueueItemId')).toBe(successorQueueItemId);
    expect(getState('player.currentTrackMeta')).toEqual(successor);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
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
