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
import { t } from '../../i18n/index.ts';
import { syncRoomEffectsUI } from '../../audio/effects.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { getCurrentAudioBuffer, setCurrentAudioBuffer } from '../../player/_state.ts';
import type { LargeAudioTrack } from '../../player/file-playback-resource.ts';
import {
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackIdle,
  setPlaybackTrackMeta,
} from '../../player/ownership.ts';
import { DEMO_TRACKS } from '../tracks.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  play: vi.fn(
    async (
      _offset: number,
      _scheduleDelay = 0,
      _deadline?: number,
      _shouldApply?: () => boolean,
      _recovery?: { timing?: string; onRecoveredStarted?: () => void | Promise<void> },
    ) => true,
  ),
  pause: vi.fn(),
  stopAllMedia: vi.fn(),
  getTrackPosition: vi.fn(() => 12),
  getLocalFilePendingStartDeadlineMs: vi.fn<() => number | undefined>(() => undefined),
  isLocalFileStartPending: vi.fn(() => false),
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
  getLocalFilePendingStartDeadlineMs: mocks.getLocalFilePendingStartDeadlineMs,
  isLocalFileStartPending: mocks.isLocalFileStartPending,
  isFilePipelineBusyForPlay: vi.fn(() => false),
  pause: mocks.pause,
  play: mocks.play,
  seekTo: vi.fn(),
  stopAllMedia: mocks.stopAllMedia,
}));

vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: mocks.getHostNow,
  isClockCalibrated: vi.fn(() => true),
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

vi.mock('../../audio/effects.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audio/effects.ts')>();
  return {
    applySettingsAsync: vi.fn(),
    syncRoomEffectsUI: vi.fn(actual.syncRoomEffectsUI),
  };
});

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
  url = '';
  open(_method: string, url: string): void {
    this.url = url;
  }
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

function installLargeResident() {
  const queueItemId = '91111111-1111-4111-8111-111111111111';
  const blob = new Blob(['large-song']);
  const item = {
    queueItemId,
    type: 'file' as const,
    name: 'long-song.mp3',
    videoId: null,
    playlistId: null,
  };
  const dispose = vi.fn();
  const resource: LargeAudioTrack = {
    kind: 'large-audio',
    duration: 3_600,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 172_800_000,
    bufferedPcmBytes: 0,
    prepare: vi.fn(async () => {}),
    createPlayback: vi.fn(() => {
      throw new Error('Playback is mocked by the demo harness');
    }),
    dispose,
  };
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', true);
  setState('playlist.items', [item]);
  setState('playlist.currentQueueItemId', queueItemId);
  setState('files.current', {
    queueItemId,
    indexHint: 0,
    name: item.name,
    sessionId: 77,
    blob,
    mime: 'audio/mpeg',
    size: blob.size,
  });
  setCurrentAudioBuffer(resource);
  setPlaybackFilePlaying();
  return { resource, dispose };
}

describe('demo recovery pins (DEMO-1 / DEMO-4)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.pause.mockReset();
    mocks.getTrackPosition.mockReturnValue(12);
    mocks.getLocalFilePendingStartDeadlineMs.mockReturnValue(undefined);
    mocks.isLocalFileStartPending.mockReturnValue(false);
    mocks.play.mockImplementation(async () => {
      setPlaybackFilePlaying();
      return true;
    });
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
    bus.emit('demo:authority-reset');
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

  it('refuses demo:enter emitted by a guest in a standard room and shows the host-only toast', async () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);
    setState('setup.sessionStarted', true);

    bus.emit('demo:enter');
    await flush();

    expect(getState('demo.active')).toBe(false);
    expect(getState('demo.loading')).toBe(false);
    expect(FakeXHR.pending).toHaveLength(0);
    expect(mocks.stopAllMedia).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(t('demo.host_only_exit'));
  });

  it('proxies demo:enter to the host when a guest has room.configure capability', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('setup.sessionStarted', true);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['room.configure']);

    bus.emit('demo:enter');
    await flush();

    expect(getState('demo.active')).toBe(false);
    expect(mocks.safeSend).toHaveBeenCalledWith(hostConn, { type: MSG.REQUEST_DEMO_ENTER });
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('proxies demo:request-exit to the host when a guest has room.configure capability', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('setup.sessionStarted', true);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['room.configure']);

    bus.emit('demo:request-exit');
    await flush();

    expect(mocks.safeSend).toHaveBeenCalledWith(hostConn, { type: MSG.REQUEST_DEMO_EXIT });
    expect(mocks.showToast).toHaveBeenCalledWith(t('demo.try_later_toast'));
  });

  it('blocks an operator without room.configure from proxying demo:enter and demo:request-exit', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('setup.sessionStarted', true);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', [
      'media.add',
      'playback.control',
      'members.manage',
    ]);

    bus.emit('demo:enter');
    await flush();

    expect(getState('demo.active')).toBe(false);
    expect(mocks.safeSend).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(t('demo.host_only_exit'));

    mocks.showToast.mockClear();
    bus.emit('demo:request-exit');
    await flush();

    expect(mocks.safeSend).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(t('demo.host_only_exit'));
  });

  it('accepts REQUEST_DEMO_ENTER and REQUEST_DEMO_EXIT on the host from a verified owner peer', async () => {
    const peerConn = { open: true, peer: 'peer-owner' } as DataConnection;
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('network.sessionCode', '123456');
    const activeConns = new Map<string, DataConnection>();
    activeConns.set('peer-owner', peerConn);
    setState('network.activeHostConnByPeerId', activeConns);
    setState('network.connectedPeers', [
      {
        id: 'peer-owner',
        conn: peerConn,
        isOp: true,
        roomCapabilities: ['room.configure'],
      } as any,
    ]);

    await handleData({ type: MSG.REQUEST_DEMO_ENTER }, peerConn);
    await flush();

    expect(getState('demo.active')).toBe(true);
    expect(mocks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.DEMO_ENTER, index: 0 }),
    );

    mocks.broadcast.mockClear();
    await handleData({ type: MSG.REQUEST_DEMO_EXIT }, peerConn);
    await flush(500);

    expect(getState('demo.active')).toBe(false);
    expect(mocks.broadcast).toHaveBeenCalledWith({ type: MSG.DEMO_EXIT });
  });

  it('drops REQUEST_DEMO_ENTER on the host from an unauthorized peer', async () => {
    const peerConn = { open: true, peer: 'peer-guest' } as DataConnection;
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('network.sessionCode', '123456');
    const activeConns = new Map<string, DataConnection>();
    activeConns.set('peer-guest', peerConn);
    setState('network.activeHostConnByPeerId', activeConns);
    setState('network.connectedPeers', [
      {
        id: 'peer-guest',
        conn: peerConn,
        isOp: false,
        roomCapabilities: [],
      } as any,
    ]);

    await handleData({ type: MSG.REQUEST_DEMO_ENTER }, peerConn);
    await flush();

    expect(getState('demo.active')).toBe(false);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('drops REQUEST_DEMO_ENTER and REQUEST_DEMO_EXIT on the host from an operator peer lacking room.configure', async () => {
    const peerConn = { open: true, peer: 'peer-operator' } as DataConnection;
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('network.sessionCode', '123456');
    const activeConns = new Map<string, DataConnection>();
    activeConns.set('peer-operator', peerConn);
    setState('network.activeHostConnByPeerId', activeConns);
    setState('network.connectedPeers', [
      {
        id: 'peer-operator',
        conn: peerConn,
        isOp: true,
        roomCapabilities: ['media.add', 'playback.control', 'members.manage'],
      } as any,
    ]);

    await handleData({ type: MSG.REQUEST_DEMO_ENTER }, peerConn);
    await flush();

    expect(getState('demo.active')).toBe(false);
    expect(mocks.broadcast).not.toHaveBeenCalled();

    await handleData({ type: MSG.REQUEST_DEMO_EXIT }, peerConn);
    await flush();

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
    expect(syncRoomEffectsUI).not.toHaveBeenCalled();
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

  it('preserves a bounded decoder across demo playback and releases it after the restored track is replaced', async () => {
    const { resource, dispose } = installLargeResident();
    bus.emit('demo:enter');
    await flush();
    expect(dispose).not.toHaveBeenCalled();
    FakeXHR.pending[0]?.resolveOk();
    await flush(50);
    expect(getCurrentAudioBuffer()).not.toBe(resource);
    expect(dispose).not.toHaveBeenCalled();

    bus.emit('demo:request-exit');
    await flush(50);
    expect(getCurrentAudioBuffer()).toBe(resource);
    expect(getState('playback.activity')).toBe('paused');
    expect(dispose).not.toHaveBeenCalled();

    setCurrentAudioBuffer({ duration: 30 } as AudioBuffer);
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['authority-reset', 'selected-successor'] as const)(
    'releases a captured bounded decoder when demo exit discards it after %s',
    async (reason) => {
      const { resource, dispose } = installLargeResident();
      bus.emit('demo:enter');
      await flush();
      FakeXHR.pending[0]?.resolveOk();
      await flush(50);
      expect(dispose).not.toHaveBeenCalled();

      if (reason === 'selected-successor') {
        setState('playlist.currentQueueItemId', null);
        bus.emit('demo:request-exit');
      } else {
        bus.emit('demo:authority-reset');
      }
      await flush(50);
      expect(getCurrentAudioBuffer()).not.toBe(resource);
      expect(dispose).toHaveBeenCalledExactlyOnceWith();
      bus.emit('demo:authority-reset');
      setCurrentAudioBuffer(null);
      expect(dispose).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it('restores the captured bounded decoder after demo loading fails', async () => {
    const { resource, dispose } = installLargeResident();
    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.failNetwork();
    await flush(50);
    expect(getState('demo.active')).toBe(false);
    expect(getCurrentAudioBuffer()).toBe(resource);
    expect(dispose).not.toHaveBeenCalled();
    setCurrentAudioBuffer(null);
    expect(dispose).toHaveBeenCalledExactlyOnceWith();
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

  it.each(['load-failure', 'authority-reset'] as const)(
    'releases demo visualizer presentation after %s',
    async (exit) => {
      const released = vi.fn(() => {
        expect(getState('demo.active')).toBe(false);
        expect(document.body.classList.contains('demo-mobile')).toBe(false);
      });
      bus.on('visualizer:refresh-presentation', released);
      setState('network.appRole', 'host');
      setState('setup.sessionStarted', true);

      bus.emit('demo:enter');

      expect(getState('demo.active')).toBe(true);

      await flush();
      if (exit === 'load-failure') FakeXHR.pending[0]?.failNetwork();
      else bus.emit('demo:authority-reset');
      await flush(50);

      expect(released).toHaveBeenCalledOnce();
    },
  );

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
    expect(syncRoomEffectsUI).not.toHaveBeenCalled();
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

  it.each(['entry-failure', 'host-disconnect'] as const)(
    'projects restored reverb and EQ into settings after %s',
    async (reason) => {
      const hostConn = { open: true, peer: 'host-1' } as DataConnection;
      setState('network.appRole', reason === 'host-disconnect' ? 'guest' : 'host');
      setState('setup.sessionStarted', true);
      if (reason === 'host-disconnect') {
        setState('network.hostConn', hostConn);
        markQueueAuthorityReady(hostConn);
      }
      setState('audio.reverbMix', 0.1);
      setState('audio.reverbDecay', 2.5);
      setState('audio.reverbPreDelay', 0.03);
      setState('audio.reverbLowCut', 11);
      setState('audio.reverbHighCut', 22);
      setState('audio.eqValues', [1, 2, 3, 2, 1]);

      if (reason === 'host-disconnect') {
        await handleData(
          {
            type: MSG.DEMO_ENTER,
            index: 0,
            reverbOn: false,
            bassBoostOn: false,
            trebleBoostOn: false,
            surroundOn: false,
          },
          hostConn,
        );
        await flush();
        FakeXHR.pending[0]?.resolveOk();
        await flush(50);
      } else {
        bus.emit('demo:enter');
        await flush();
      }
      expect(getState('demo.active')).toBe(true);
      setState('audio.reverbMix', 0.35);
      setState('audio.reverbDecay', 5);
      setState('audio.reverbPreDelay', 0.08);
      setState('audio.reverbLowCut', 33);
      setState('audio.reverbHighCut', 44);
      setState('audio.eqValues', [5, 3, 0, 4, 6]);
      const reverbParam = vi.fn();
      const reverbPreset = vi.fn();
      const eqBand = vi.fn();
      const eqPreset = vi.fn();
      bus.on('ui:sync-reverb-param', reverbParam);
      bus.on('ui:sync-reverb-preset', reverbPreset);
      bus.on('ui:sync-eq-band', eqBand);
      bus.on('ui:sync-eq-preset', eqPreset);

      if (reason === 'host-disconnect') setState('network.hostConn', null);
      else FakeXHR.pending[0]?.failNetwork();
      await flush(50);

      expect(getState('demo.active')).toBe(false);
      expect(getState('audio.reverbMix')).toBe(0.1);
      expect(getState('audio.eqValues')).toEqual([1, 2, 3, 2, 1]);
      expect(reverbParam.mock.calls).toEqual([
        ['mix', 10],
        ['decay', 2.5],
        ['predelay', 0.03],
        ['lowcut', 11],
        ['highcut', 22],
      ]);
      expect(reverbPreset).toHaveBeenCalledExactlyOnceWith('advanced');
      expect(eqBand.mock.calls).toEqual([
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 2],
        [4, 1],
      ]);
      expect(eqPreset).toHaveBeenCalledExactlyOnceWith('advanced');
    },
  );

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

  it.each([false, true])(
    'preserves newest guest track when an older load fails (already active: %s)',
    async (alreadyActive) => {
      const hostConn = { open: true, peer: 'host-1' } as DataConnection;
      setState('network.hostConn', hostConn);
      setState('network.appRole', 'guest');
      markQueueAuthorityReady(hostConn);
      const enter = (index: number) =>
        handleData(
          {
            type: MSG.DEMO_ENTER,
            index,
            reverbOn: false,
            bassBoostOn: false,
            trebleBoostOn: false,
            surroundOn: false,
          },
          hostConn,
        );
      await enter(0);
      await flush();
      if (alreadyActive) {
        FakeXHR.pending[0].resolveOk();
        await flush(50);
        await enter(1);
        await flush();
      }
      const failingIndex = alreadyActive ? 1 : 0;
      const nextIndex = failingIndex + 1;
      await enter(nextIndex);
      await handleData({ type: MSG.DEMO_PLAY, index: nextIndex, time: 0, hostPlayAt: 0 }, hostConn);
      FakeXHR.pending.find((xhr) => xhr.url === DEMO_TRACKS[failingIndex].url)!.failNetwork();
      await flush(50);
      expect(getState('demo.active')).toBe(true);
      const latest = FakeXHR.pending.find((xhr) => xhr.url === DEMO_TRACKS[nextIndex].url);
      expect(latest).toBeDefined();
      latest!.resolveOk();
      await flush(50);
      expect(getState('demo.currentTrackIndex')).toBe(nextIndex);
      expect(mocks.play).toHaveBeenCalled();
      bus.emit('demo:authority-reset');
      await flush();
    },
  );

  it.each(['EncodingError', 'AudioContextNotRunningError'] as const)(
    'retries a failed cached preload appropriately for %s',
    async (name) => {
      setState('network.appRole', 'host');
      setState('setup.sessionStarted', true);
      bus.emit('demo:enter');
      await flush();
      FakeXHR.pending[0].resolveOk();
      await flush(50);
      FakeXHR.pending.find((xhr) => xhr.url === DEMO_TRACKS[1].url)!.resolveOk();
      await flush();
      mocks.loadDemoFile.mockRejectedValueOnce(
        new DOMException('native decoder/output failure', name),
      );
      setPlaybackIdle();
      bus.emit('player:ended');
      await flush(50);
      expect(getCurrentAudioBuffer()).toBeNull();
      const attempts = mocks.loadDemoFile.mock.calls.length;
      bus.emit('demo:toggle-play');
      await flush(50);
      if (name === 'EncodingError') {
        expect(mocks.loadDemoFile).toHaveBeenCalledTimes(attempts);
        expect(FakeXHR.pending.filter((xhr) => xhr.url === DEMO_TRACKS[1].url)).toHaveLength(2);
      } else {
        expect(mocks.loadDemoFile).toHaveBeenCalledTimes(attempts + 1);
        expect(FakeXHR.pending.filter((xhr) => xhr.url === DEMO_TRACKS[1].url)).toHaveLength(1);
      }
      bus.emit('demo:authority-reset');
      await flush();
    },
  );

  it('applies the latest paused position after guest decode resets its position', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);
    const transport = await vi.importActual<typeof import('../../player/transport.ts')>(
      '../../player/transport.ts',
    );
    mocks.pause.mockImplementation(transport.pause);
    mocks.loadDemoFile.mockImplementationOnce(async () => {
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      setState('player.pausedAt', 0);
      setPlaybackFilePaused();
    });
    await handleData(
      {
        type: MSG.DEMO_ENTER,
        index: 0,
        reverbOn: false,
        bassBoostOn: false,
        trebleBoostOn: false,
        surroundOn: false,
      },
      hostConn,
    );
    await flush();
    await handleData({ type: MSG.DEMO_PLAY, index: 0, time: 0, hostPlayAt: 0 }, hostConn);
    await handleData({ type: MSG.DEMO_PAUSE, time: 70 }, hostConn);
    FakeXHR.pending[0].resolveOk();
    await flush(50);
    expect(getState('player.pausedAt')).toBe(70);
    expect(mocks.play).not.toHaveBeenCalled();
    bus.emit('demo:authority-reset');
    await flush();
  });

  it.each([false, true])(
    'bounds a guest fetch retry and preserves pending play (second failure: %s)',
    async (failsAgain) => {
      const hostConn = { open: true, peer: 'host-1' } as DataConnection;
      setState('network.hostConn', hostConn);
      setState('network.appRole', 'guest');
      markQueueAuthorityReady(hostConn);
      await handleData(
        {
          type: MSG.DEMO_ENTER,
          index: 0,
          reverbOn: false,
          bassBoostOn: false,
          trebleBoostOn: false,
          surroundOn: false,
        },
        hostConn,
      );
      await handleData({ type: MSG.DEMO_PLAY, index: 0, time: 0, hostPlayAt: 0 }, hostConn);
      await flush();
      FakeXHR.pending[0].failNetwork();
      await flush(50);
      expect(FakeXHR.pending.filter((xhr) => xhr.url === DEMO_TRACKS[0].url)).toHaveLength(2);
      if (failsAgain) FakeXHR.pending[1].failNetwork();
      else FakeXHR.pending[1].resolveOk();
      await flush(50);
      expect(getState('demo.active')).toBe(!failsAgain);
      expect(FakeXHR.pending.filter((xhr) => xhr.url === DEMO_TRACKS[0].url)).toHaveLength(2);
      expect(mocks.play).toHaveBeenCalledTimes(failsAgain ? 0 : 1);
    },
  );

  it('does not retry an aborted guest fetch after exit', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);
    await handleData(
      {
        type: MSG.DEMO_ENTER,
        index: 0,
        reverbOn: false,
        bassBoostOn: false,
        trebleBoostOn: false,
        surroundOn: false,
      },
      hostConn,
    );
    await flush();
    await handleData({ type: MSG.DEMO_EXIT }, hostConn);
    await flush(50);
    expect(getState('demo.active')).toBe(false);
    expect(FakeXHR.pending).toHaveLength(1);
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it('publishes host playback once only after an owned output recovery succeeds', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    mocks.play.mockResolvedValueOnce(false);
    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0].resolveOk();
    await flush(50);
    expect(
      mocks.broadcast.mock.calls.filter(([frame]) => frame.type === MSG.DEMO_PLAY),
    ).toHaveLength(0);
    const recovery = mocks.play.mock.calls[0][4]!;
    expect(recovery.timing).toBe('canonical-rebase');
    expect(mocks.play.mock.calls[0][3]!()).toBe(true);
    setPlaybackFilePlaying();
    await recovery.onRecoveredStarted!();
    await recovery.onRecoveredStarted!();
    expect(mocks.broadcast.mock.calls.filter(([frame]) => frame.type === MSG.DEMO_PLAY)).toEqual([
      [{ type: MSG.DEMO_PLAY, index: 0, time: 12, hostStartAt: 10_000, hostPlayAt: 10_350 }],
    ]);
  });

  it.each(['pause', 'exit', 'replacement-buffer', 'connection'] as const)(
    'does not publish delayed host recovery after %s',
    async (replacement) => {
      setState('network.appRole', 'host');
      setState('setup.sessionStarted', true);
      mocks.play.mockResolvedValueOnce(false);
      bus.emit('demo:enter');
      await flush();
      FakeXHR.pending[0].resolveOk();
      await flush(50);
      const call = mocks.play.mock.calls[0];
      if (replacement === 'pause') {
        setPlaybackFilePlaying();
        bus.emit('demo:toggle-play');
      }
      if (replacement === 'exit') bus.emit('demo:request-exit');
      if (replacement === 'replacement-buffer')
        setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      if (replacement === 'connection')
        setState('network.hostConn', { open: true, peer: 'new-host' } as DataConnection);
      expect(call[3]!()).toBe(false);
      setPlaybackFilePlaying();
      await call[4]!.onRecoveredStarted!();
      expect(
        mocks.broadcast.mock.calls.filter(([frame]) => frame.type === MSG.DEMO_PLAY),
      ).toHaveLength(0);
    },
  );

  it.each([false, true])(
    'shares a 200ms start only when demo guests are connected (%s)',
    async (hasGuest) => {
      vi.setSystemTime(10_000);
      setState('network.appRole', 'host');
      setState('setup.sessionStarted', true);
      if (hasGuest) {
        setState('network.connectedPeers', [{ conn: { open: true } } as any]);
        mocks.getLocalFilePendingStartDeadlineMs.mockImplementation(() => performance.now() + 200);
      }
      bus.emit('demo:enter');
      await flush();
      expect(mocks.play).not.toHaveBeenCalled();
      FakeXHR.pending[0].resolveOk();
      await flush(50);

      expect(mocks.play.mock.calls[0]?.[1]).toBe(hasGuest ? 0.2 : 0);
      const frame = mocks.broadcast.mock.calls.find(
        ([message]) => message.type === MSG.DEMO_PLAY,
      )?.[0];
      expect(frame).toMatchObject({
        hostStartAt: hasGuest ? 10_200 : 10_000,
        hostPlayAt: hasGuest ? 10_550 : 10_350,
      });
    },
  );

  it('retires the previous source before advancing while the next download is pending', async () => {
    const index = 1;
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0].resolveOk();
    await flush(50);
    expect(getState('playback.activity')).toBe('playing');
    mocks.play.mockClear();
    mocks.broadcast.mockClear();
    mocks.pause.mockClear();
    bus.emit('demo:next-track');

    expect(getState('demo.currentTrackIndex')).toBe(index);
    expect(getState('demo.loading')).toBe(true);
    expect(getState('playback.activity')).toBe('paused');
    expect(mocks.pause).toHaveBeenCalledWith(0, expect.anything());
    expect(mocks.play).not.toHaveBeenCalled();
    expect(mocks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.DEMO_ENTER, index }),
    );
    const conn = { open: true, peer: 'late-guest' } as DataConnection;
    bus.emit('network:peer-connected', conn);
    expect(mocks.safeSend).not.toHaveBeenCalledWith(
      conn,
      expect.objectContaining({ type: MSG.DEMO_PLAY }),
    );
    expect(mocks.safeSend).toHaveBeenCalledWith(
      conn,
      expect.objectContaining({ type: MSG.DEMO_PAUSE }),
    );
    FakeXHR.pending.find((request) => request.url === DEMO_TRACKS[index].url)!.resolveOk();
    await flush(50);
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.DEMO_PLAY, index }),
    );
  });

  it('keeps a faster decoded guest silent until the host publishes its shared start', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);
    await handleData(
      {
        type: MSG.DEMO_ENTER,
        index: 0,
        reverbOn: false,
        bassBoostOn: false,
        trebleBoostOn: false,
        surroundOn: false,
      },
      hostConn,
    );
    await flush();
    FakeXHR.pending[0].resolveOk();
    await flush(50);
    expect(getCurrentAudioBuffer()).not.toBeNull();
    expect(getState('demo.loading')).toBe(false);
    expect(getState('playback.activity')).not.toBe('playing');
    expect(mocks.play).not.toHaveBeenCalled();
    await handleData(
      {
        type: MSG.DEMO_PLAY,
        index: 0,
        time: 0,
        hostStartAt: 10_200,
        hostPlayAt: 10_550,
      },
      hostConn,
    );
    expect(mocks.play).toHaveBeenCalledWith(0, 0.2, expect.any(Number), expect.any(Function));
    expect(mocks.play).toHaveBeenCalledOnce();
  });

  it('keeps manual synchronization offsets across demo entry, track changes and exit', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    setState('sync.localOffset', 9.999);
    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0].resolveOk();
    await flush(50);
    expect(getState('sync.localOffset')).toBe(9.999);
    setState('sync.localOffset', -7.5);
    bus.emit('demo:next-track');
    expect(getState('sync.localOffset')).toBe(-7.5);
    bus.emit('demo:request-exit');
    await flush(500);
    expect(getState('sync.localOffset')).toBe(-7.5);
  });

  it('rejects guest next-track commands', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);
    setState('demo.active', true);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    bus.emit('demo:next-track');
    expect(FakeXHR.pending).toHaveLength(0);
    expect(mocks.play).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('rejects host next-track commands when demo is inactive or already loading', () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    bus.emit('demo:next-track');
    setState('demo.active', true);
    setState('demo.loading', true);
    bus.emit('demo:next-track');
    expect(FakeXHR.pending).toHaveLength(0);
    expect(mocks.play).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
