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
  setPlaybackTrackMeta,
} from '../../player/ownership.ts';
import { DEMO_TRACKS } from '../tracks.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  play: vi.fn(async (_offset: number, _scheduleDelay = 0) => true),
  pause: vi.fn(),
  stopAllMedia: vi.fn(),
  getTrackPosition: vi.fn(() => 12),
  getHostNow: vi.fn(() => 10_000),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  loadDemoFile: vi.fn(),
  prepareMediaSession: vi.fn(() => Promise.resolve()),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../player/transport.ts', () => ({
  fmtTime: vi.fn((seconds: number) => `fmt:${Math.floor(seconds)}`),
  getTrackPosition: mocks.getTrackPosition,
  isFilePipelineBusyForPlay: vi.fn(() => false),
  pause: mocks.pause,
  play: mocks.play,
  seekTo: vi.fn(),
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

vi.mock('../../player/media-session-loader.ts', () => ({
  prepareMediaSession: mocks.prepareMediaSession,
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
    delete document.body.dataset.demoBound;
    document.body.innerHTML = `
      <button class="active" data-demo-step="1" aria-pressed="true"></button>
      <button data-demo-step="2" aria-pressed="false"></button>
      <button data-demo-step="3" aria-pressed="false"></button>
    `;
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

  it('keeps demo step styling and pressed state aligned after a step click', () => {
    const steps = [...document.querySelectorAll<HTMLElement>('[data-demo-step]')];

    steps[1]?.click();

    expect(steps.map((step) => step.classList.contains('active'))).toEqual([false, true, false]);
    expect(steps.map((step) => step.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ]);
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
    expect(mocks.prepareMediaSession).toHaveBeenCalledOnce();
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

  it('clears synthetic demo track metadata when no prior media can be restored', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);

    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('playback.mode')).toBeNull();

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    expect(getState('player.currentTrackMeta')).toMatchObject({
      title: DEMO_TRACKS[0]?.title,
      artist: DEMO_TRACKS[0]?.artist,
    });

    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('demo.active')).toBe(false);
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('preserves successor metadata published over an idle demo snapshot', async () => {
    const successor = {
      queueItemId: '21111111-1111-4111-8111-111111111118',
      type: 'file' as const,
      name: 'successor.mp3',
      title: 'Successor',
      artist: 'Next artist',
      videoId: null,
      playlistId: null,
    };
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);

    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);

    setPlaybackTrackMeta(successor);
    bus.emit('demo:request-exit');
    await flush(50);

    expect(getState('demo.active')).toBe(false);
    expect(getState('player.currentTrackMeta')).toBe(successor);
    expect(getState('playback.activity')).toBe('idle');
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
    exitAnimation.onfinish?.call(exitAnimation, new Event('finish') as AnimationPlaybackEvent);
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

  it('does not reopen the demo overlay when entry fails before its curtain covers the page', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    document.body.innerHTML = `
      <div id="demo-overlay" aria-hidden="true"></div>
      <div id="demo-curtain" style="opacity: 0"></div>
    `;
    const curtain = document.getElementById('demo-curtain')!;
    const entryAnimation = {
      cancel: vi.fn(),
      onfinish: null,
      oncancel: null,
    } as unknown as Animation;
    Object.defineProperty(curtain, 'animate', {
      configurable: true,
      value: vi.fn(() => entryAnimation),
    });

    bus.emit('demo:enter');
    await flush();
    const staleFinish = entryAnimation.onfinish;
    expect(staleFinish).toBeTypeOf('function');
    FakeXHR.pending[0]?.failNetwork();
    await flush(20);
    expect(getState('demo.active')).toBe(false);

    staleFinish?.call(entryAnimation, new Event('finish') as AnimationPlaybackEvent);
    await flush(50);

    expect(document.getElementById('demo-overlay')?.classList.contains('active')).toBe(false);
    expect(document.getElementById('demo-overlay')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.body.classList.contains('mode-demo')).toBe(false);
    expect(document.body.classList.contains('demo-chrome-hiding')).toBe(false);
    expect(curtain.style.opacity).toBe('0');
    expect(entryAnimation.cancel).toHaveBeenCalled();
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

  it('requests a temporary spectrum mode and restores the captured visualizer mode', async () => {
    document.body.className = 'viz-circular';
    const visualizerModes: Array<'circular' | 'spectrum'> = [];
    bus.on('visualizer:set-type', (mode) => visualizerModes.push(mode));
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);

    bus.emit('demo:enter');

    expect(visualizerModes.at(-1)).toBe('spectrum');

    await flush();
    FakeXHR.pending[0]?.failNetwork();
    await flush(50);

    expect(visualizerModes.at(-1)).toBe('circular');
  });

  it('maps combined bass and treble boosts to the advanced V-shaped EQ', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('audio.eqValues', [0, 0, 0, 0, 0]);
    const eqUpdates: Array<[number, number, boolean | undefined]> = [];
    const effectUpdates: Array<[string, string, number, boolean | undefined]> = [];
    bus.on('audio:set-eq', (band, value, isPreview) => eqUpdates.push([band, value, isPreview]));
    bus.on('audio:update-effect', (type, param, value, isPreview) =>
      effectUpdates.push([type, param, value, isPreview]),
    );

    bus.emit('demo:enter');
    await flush();
    bus.emit('demo:toggle-bass');
    bus.emit('demo:toggle-treble');

    expect(eqUpdates.slice(-5)).toEqual([
      [0, 5, true],
      [1, 3, true],
      [2, 0, true],
      [3, 4, true],
      [4, 6, false],
    ]);
    expect(effectUpdates.slice(-2)).toEqual([
      ['vbass', 'mix', 60, true],
      ['exciter', 'mix', 1, true],
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

  it('keeps the newest host effect flags when they arrive during an in-flight guest load', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);
    const flags = { reverbOn: false, bassBoostOn: false, trebleBoostOn: false, surroundOn: false };
    await handleData({ type: MSG.DEMO_ENTER, index: 0, ...flags }, hostConn);
    await flush();
    expect(getState('demo.loading')).toBe(true);
    await handleData({ type: MSG.DEMO_ENTER, index: 0, ...flags, reverbOn: true }, hostConn);
    FakeXHR.pending[0].resolveOk();
    await flush(50);
    expect(getState('demo.loading')).toBe(false);
    expect(getState('demo.reverbOn')).toBe(true);
    bus.emit('demo:authority-reset');
    await flush(300);
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
    expect(getState('player.currentTrackMeta')).toBeNull();
  });

  it('keeps DEMO_TRACKS non-trivial so the advance scenario stays meaningful', () => {
    expect(DEMO_TRACKS.length).toBeGreaterThan(1);
  });
});
