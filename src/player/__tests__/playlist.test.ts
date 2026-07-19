/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import {
  consumePendingAutoSyncOnReady,
  getPendingAutoSyncOnReadyForTests as getPendingAutoSyncOnReady,
  setPendingAutoSyncOnReady,
  stopYouTubeMode,
} from '../../youtube/player.ts';
import * as youtubeIframe from '../../youtube/iframe.ts';
import { setYouTubePlayer } from '../../youtube/_state.ts';
import { setPlaybackTrackMeta, setPlaybackYouTubePlaying } from '../ownership.ts';
import {
  applyPlaylistQueueModeState,
  capturePlaylistQueueModeState,
  setRepeatMode,
  setShuffle,
  getShuffleNextPlayableQueueItemId,
  advanceToShuffleNextQueueItemId,
  advanceToShufflePreviousQueueItemId,
  clearPreloadState,
  initPlaylist,
  playNextTrack,
  playPrevTrack,
  playTrack,
  reconcileShuffleOrderForCurrentPlaylist,
} from '../playlist.ts';
import { broadcastFileDebounced } from '../../storage/transfer.ts';
import {
  getCurrentAudioBuffer,
  getCurrentLoadEpoch,
  newLoadEpoch,
  setCurrentAudioBuffer,
} from '../_state.ts';
import { initDecodeHandlers } from '../decode.ts';
import type {
  ConnectedPeer,
  DataConnection,
  PlaylistItem,
  PlaylistWireItem,
  QueueItemId,
  ResidentFile,
} from '../../types/index.ts';
import { findQueueItemIndex } from '../queue-model.ts';
import { t } from '../../i18n/index.ts';
import * as transport from '../transport.ts';
import { transition } from '../lifecycle.ts';
import {
  registerProRoomLegacyMediaHooks,
  restoreProRoomLegacyPlayback,
  type ProRoomLegacyMediaHooks,
} from '../../pro-room/legacy-media-hooks.ts';

const decodeMocks = vi.hoisted(() => ({
  loadPreloadedTrack: vi.fn<(queueItemId: QueueItemId, epoch?: number) => Promise<boolean>>(),
  loadAndBroadcastFile: vi.fn(),
}));

vi.mock('../decode.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../decode.ts')>();
  return {
    ...actual,
    loadPreloadedTrack: decodeMocks.loadPreloadedTrack,
    loadAndBroadcastFile: decodeMocks.loadAndBroadcastFile,
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  decodeMocks.loadPreloadedTrack.mockReset();
  decodeMocks.loadPreloadedTrack.mockResolvedValue(false);
  decodeMocks.loadAndBroadcastFile.mockReset();
  resetState();
  bus.clear();
  setPendingAutoSyncOnReady(false);
  registerProRoomLegacyMediaHooks(null);
  setYouTubePlayer(null);
});

afterEach(() => {
  setYouTubePlayer(null);
  registerProRoomLegacyMediaHooks(null);
  clearAllManagedTimers();
  vi.useRealTimers();
});

function proMediaHooks(overrides: Partial<ProRoomLegacyMediaHooks> = {}): ProRoomLegacyMediaHooks {
  return {
    addFiles: () => false,
    addYouTube: () => false,
    updateTrackMetadata: () => false,
    removeTracks: () => false,
    reorderTrack: () => false,
    resolveFile: () => null,
    ...overrides,
  };
}

function enterProRoom(
  capabilities: Array<'asset.upload' | 'queue.mutate' | 'playback.control'>,
  role: 'member' | 'coordinator' = 'member',
): void {
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role,
    coordinatorId: 'coordinator-1',
    epoch: 1,
    snapshotRevision: 1,
    capabilities,
  });
}

function makeConnection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

function makeConnectedPeer(id: string, isOp: boolean): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: null,
    isOp,
    preloadedQueueItemIds: new Set<QueueItemId>(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: 0,
  };
}

function mountToastMessage(): HTMLElement {
  document.body.innerHTML = '<div id="toast"><span id="toast-msg"></span></div>';
  return document.getElementById('toast-msg') as HTMLElement;
}

let nextQueueItemIdValue = 1;
function nextQueueItemId(): QueueItemId {
  const suffix = String(nextQueueItemIdValue++).padStart(12, '0');
  return `10000000-0000-4000-8000-${suffix}`;
}

function fileItem(name: string, file?: File): PlaylistItem {
  return {
    queueItemId: nextQueueItemId(),
    type: 'file',
    name,
    ...(file ? { file } : {}),
    videoId: null,
    playlistId: null,
  };
}

function wireItem(item: PlaylistItem): PlaylistWireItem {
  return {
    queueItemId: item.queueItemId,
    type: item.type,
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.artist === undefined ? {} : { artist: item.artist }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
    videoId: item.videoId,
    playlistId: item.playlistId,
  };
}

function youtubeItem(
  name: string,
  videoId: string,
  playlistId: string | null = null,
): PlaylistItem {
  return {
    queueItemId: nextQueueItemId(),
    type: 'youtube',
    name,
    videoId,
    playlistId,
  };
}

function selectIndex(index: number): QueueItemId | null {
  const queueItemId = getState('playlist.items')[index]?.queueItemId ?? null;
  setState('playlist.currentQueueItemId', queueItemId);
  return queueItemId;
}

function currentIndex(): number {
  return findQueueItemIndex(getState('playlist.currentQueueItemId'));
}

function residentFor(item: PlaylistItem, blob: Blob, sessionId = 7): ResidentFile {
  return {
    queueItemId: item.queueItemId,
    indexHint: findQueueItemIndex(item.queueItemId),
    name: item.name,
    sessionId,
    blob,
    mime: blob.type || 'audio/mpeg',
    size: blob.size,
  };
}

describe('setRepeatMode', () => {
  it('sets repeat mode 0 (off)', () => {
    setRepeatMode(0, false);
    expect(getState('playlist.repeatMode')).toBe(0);
  });

  it('sets repeat mode 1 (all)', () => {
    setRepeatMode(1, false);
    expect(getState('playlist.repeatMode')).toBe(1);
  });

  it('sets repeat mode 2 (one)', () => {
    setRepeatMode(2, false);
    expect(getState('playlist.repeatMode')).toBe(2);
  });
});

describe('setShuffle', () => {
  it('enables shuffle', () => {
    setShuffle(true, false);
    expect(getState('playlist.isShuffle')).toBe(true);
  });

  it('disables shuffle', () => {
    setShuffle(false, false);
    expect(getState('playlist.isShuffle')).toBe(false);
  });
});

describe('playlist navigation context', () => {
  it('does not force a Play-tab switch when advancing to the next track', () => {
    const first = fileItem('first.mp3');
    const second = fileItem('second.mp3');
    setState('playlist.items', [first, second]);
    setState('playlist.currentQueueItemId', first.queueItemId);
    const switchTab = vi.fn();
    bus.on('ui:switch-tab', switchTab);

    playNextTrack();

    expect(switchTab).not.toHaveBeenCalled();
  });
});

describe('local file admission', () => {
  it('rejects unsupported files that bypass the native picker hint', async () => {
    initPlaylist();
    const toastMessage = mountToastMessage();

    bus.emit('app:files-selected', [
      new File(['p'], 'document.pdf', { type: 'application/pdf' }),
      new File(['i'], 'cover.png', { type: 'image/png' }),
    ]);

    await vi.waitFor(() => expect(getState('playlist.items')).toHaveLength(0));
    expect(toastMessage.innerText).toBe(t('toast.no_supported_audio_files'));
  });

  it('adds only audio candidates from a mixed selection', async () => {
    setState('network.appRole', 'host');
    setState('network.myDeviceLabel', 'Studio Host');
    initPlaylist();
    const toastMessage = mountToastMessage();
    const systemMessages: string[] = [];
    bus.on('chat:system-message', (text) => systemMessages.push(text));
    const declaredAudio = new File(['a'], 'track.unknown', { type: 'audio/opus' });
    const extensionFallback = new File(['b'], 'archive.caf', {
      type: 'application/octet-stream',
    });

    bus.emit('app:files-selected', [
      declaredAudio,
      new File(['p'], 'document.pdf', { type: 'application/pdf' }),
      extensionFallback,
    ]);

    await vi.waitFor(() => {
      expect(getState('playlist.items').map((item) => item.file)).toEqual([
        declaredAudio,
        extensionFallback,
      ]);
    });
    expect(toastMessage.innerText).toBe(
      `${t('toast.added_tracks', { count: 2 })}\n${t('toast.unsupported_files_excluded', {
        count: 1,
      })}`,
    );
    expect(systemMessages).toEqual([t('chat.tracks_added', { name: 'Studio Host', count: 2 })]);
  });

  it('delegates filtered PRO uploads without mutating the legacy queue', async () => {
    const addFiles = vi.fn(() => true);
    registerProRoomLegacyMediaHooks(proMediaHooks({ addFiles }));
    enterProRoom(['asset.upload', 'queue.mutate']);
    setState('network.hostConn', makeConnection('coordinator-1'));
    initPlaylist();

    const audio = new File(['a'], 'track.flac', { type: 'audio/flac' });
    bus.emit('app:files-selected', [audio, new File(['x'], 'cover.png', { type: 'image/png' })]);

    await vi.waitFor(() => expect(addFiles).toHaveBeenCalledWith([audio], 1));
    expect(getState('playlist.items')).toEqual([]);
  });
});

describe('PRO playlist mutation bridge', () => {
  it('delegates removal and reorder without applying local legacy revisions', () => {
    const removeTracks = vi.fn(() => true);
    const reorderTrack = vi.fn(() => true);
    registerProRoomLegacyMediaHooks(proMediaHooks({ removeTracks, reorderTrack }));
    enterProRoom(['queue.mutate']);
    setState('network.hostConn', makeConnection('coordinator-1'));
    const a = fileItem('a.flac');
    const b = fileItem('b.flac');
    setState('playlist.items', [a, b]);
    setState('playlist.revision', 7);
    initPlaylist();

    bus.emit('playlist:remove-tracks', [a.queueItemId]);
    bus.emit('playlist:reorder-track', b.queueItemId, a.queueItemId, 7);

    expect(removeTracks).toHaveBeenCalledWith([a.queueItemId]);
    expect(reorderTrack).toHaveBeenCalledWith(b.queueItemId, a.queueItemId, 7);
    expect(getState('playlist.items')).toEqual([a, b]);
    expect(getState('playlist.revision')).toBe(7);
  });

  it('retries a selected unloaded PRO row only after its verified File is published', async () => {
    const unloaded = fileItem('private.flac');
    const downloaded = new File(['audio'], 'private.flac', { type: 'audio/flac' });
    setState('playlist.items', [unloaded]);
    decodeMocks.loadAndBroadcastFile.mockResolvedValue(false);
    const resolveFile = vi.fn(async () => {
      setState('playlist.items', [{ ...unloaded, file: downloaded }]);
      return downloaded;
    });
    registerProRoomLegacyMediaHooks(proMediaHooks({ resolveFile }));

    await playTrack(unloaded.queueItemId);

    expect(resolveFile).toHaveBeenCalledWith(unloaded.queueItemId);
    expect(decodeMocks.loadAndBroadcastFile).toHaveBeenCalledWith(
      downloaded,
      unloaded.queueItemId,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ queueItemId: unloaded.queueItemId, mime: 'audio/flac' }),
    );
  });

  it('promotes an in-flight PRO preload promise without starting a second resolution', async () => {
    const currentFile = new File(['current'], 'current.flac', { type: 'audio/flac' });
    const current = fileItem(currentFile.name, currentFile);
    const next = fileItem('next.flac');
    const downloaded = new File(['next'], next.name, { type: 'audio/flac' });
    setState('playlist.items', [current, next]);
    setState('playlist.currentQueueItemId', current.queueItemId);
    setState('files.current', {
      queueItemId: current.queueItemId,
      indexHint: 0,
      name: currentFile.name,
      sessionId: 16,
      blob: currentFile,
      mime: currentFile.type,
      size: currentFile.size,
    });
    setCurrentAudioBuffer({ duration: 60 } as AudioBuffer);
    setState('preload.nextQueueItemId', next.queueItemId);
    setState('preload.isPreloading', true);
    setState('preload.activeTarget', {
      queueItemId: next.queueItemId,
      indexHint: 1,
      name: next.name,
      sessionId: 17,
      mime: 'audio/flac',
      size: downloaded.size,
    });
    enterProRoom(['playback.control'], 'coordinator');

    let finish!: (file: File) => void;
    const inFlight = new Promise<File>((resolve) => {
      finish = resolve;
    });
    let residentAtResolution: ResidentFile | null | undefined;
    let bufferAtResolution: AudioBuffer | null | undefined;
    const resolveFile = vi.fn(() => {
      residentAtResolution = getState('files.current');
      bufferAtResolution = getCurrentAudioBuffer();
      return inFlight.then((file) => {
        setState('playlist.items', [current, { ...next, file }]);
        return file;
      });
    });
    registerProRoomLegacyMediaHooks(
      proMediaHooks({
        resolveFile,
        handlesPersistentFile: (queueItemId) => queueItemId === next.queueItemId,
      }),
    );
    decodeMocks.loadPreloadedTrack.mockResolvedValue(false);

    const play = playTrack(next.queueItemId);
    await vi.waitFor(() => expect(resolveFile).toHaveBeenCalledOnce());
    finish(downloaded);
    await play;

    expect(resolveFile).toHaveBeenCalledOnce();
    expect(residentAtResolution).toBeNull();
    expect(bufferAtResolution).toBeNull();
    expect(decodeMocks.loadPreloadedTrack).toHaveBeenCalledOnce();
    expect(decodeMocks.loadPreloadedTrack).toHaveBeenCalledWith(
      next.queueItemId,
      expect.any(Number),
    );
    expect(getState('preload.ready')).toMatchObject({
      queueItemId: next.queueItemId,
      sessionId: 17,
      blob: downloaded,
    });
  });

  it('enters the existing file busy lifecycle before awaiting a persistent download', async () => {
    const unloaded = fileItem('slow.flac');
    setState('playlist.items', [unloaded]);
    setPlaybackYouTubePlaying();
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    let settleDownload!: (file: File | null) => void;
    const pendingDownload = new Promise<File | null>((resolve) => {
      settleDownload = resolve;
    });
    const resolveFile = vi.fn(() => pendingDownload);
    registerProRoomLegacyMediaHooks(proMediaHooks({ resolveFile }));

    const playPromise = playTrack(unloaded.queueItemId);
    await vi.waitFor(() => expect(resolveFile).toHaveBeenCalledWith(unloaded.queueItemId));

    expect(getState('playlist.currentQueueItemId')).toBe(unloaded.queueItemId);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('pending');
    expect(getCurrentAudioBuffer()).toBeNull();

    settleDownload(null);
    await playPromise;
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.FAILED);
  });

  it('does not let a superseded persistent fetch clear the newer file selection', async () => {
    const second = fileItem('second.flac');
    const third = fileItem('third.flac');
    setState('playlist.items', [second, third]);
    let settleSecond!: (file: File | null) => void;
    let settleThird!: (file: File | null) => void;
    const secondDownload = new Promise<File | null>((resolve) => {
      settleSecond = resolve;
    });
    const thirdDownload = new Promise<File | null>((resolve) => {
      settleThird = resolve;
    });
    registerProRoomLegacyMediaHooks(
      proMediaHooks({
        resolveFile: (queueItemId) =>
          queueItemId === second.queueItemId ? secondDownload : thirdDownload,
      }),
    );

    const secondPlay = playTrack(second.queueItemId);
    await vi.waitFor(() => expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING));
    const thirdPlay = playTrack(third.queueItemId);
    await vi.waitFor(() => expect(getState('playlist.currentQueueItemId')).toBe(third.queueItemId));

    settleSecond(null);
    await secondPlay;
    expect(getState('playlist.currentQueueItemId')).toBe(third.queueItemId);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);

    settleThird(null);
    await thirdPlay;
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.FAILED);
  });

  it('releases the file spinner when YouTube supersedes a persistent fetch', async () => {
    const video = youtubeItem('First video', 'VIDEO_ID_01');
    const unloaded = fileItem('second.flac');
    setState('playlist.items', [video, unloaded]);
    setPlaybackYouTubePlaying();
    let settleDownload!: (file: File | null) => void;
    const pendingDownload = new Promise<File | null>((resolve) => {
      settleDownload = resolve;
    });
    registerProRoomLegacyMediaHooks(proMediaHooks({ resolveFile: () => pendingDownload }));

    const filePlay = playTrack(unloaded.queueItemId);
    await vi.waitFor(() => expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING));

    await playTrack(video.queueItemId);
    expect(getState('playlist.currentQueueItemId')).toBe(video.queueItemId);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);

    settleDownload(null);
    await filePlay;
    expect(getState('playlist.currentQueueItemId')).toBe(video.queueItemId);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  });

  it('cancels a pending PRO resolver during an authoritative in-flight teardown', () => {
    const cancelFileResolution = vi.fn();
    registerProRoomLegacyMediaHooks(proMediaHooks({ cancelFileResolution }));
    transition({
      type: 'FILE_PREPARE',
      variant: 'fresh',
      queueItemId: nextQueueItemId(),
      name: 'pending.flac',
    });

    transport.stopAllMedia({ silent: true, cancelInFlight: true });

    expect(cancelFileResolution).toHaveBeenCalledOnce();
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  });

  it('releases the download spinner into FAILED when the selected persistent fetch fails', async () => {
    const unloaded = fileItem('offline.flac');
    const downloaded = new File(['audio'], unloaded.name, { type: 'audio/flac' });
    setState('playlist.items', [unloaded]);
    const resolveFile = vi
      .fn<() => Promise<File | null>>()
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockImplementationOnce(async () => {
        setState('playlist.items', [{ ...unloaded, file: downloaded }]);
        return downloaded;
      });
    registerProRoomLegacyMediaHooks(proMediaHooks({ resolveFile }));
    decodeMocks.loadAndBroadcastFile.mockResolvedValue(false);

    await playTrack(unloaded.queueItemId);

    expect(getState('playlist.currentQueueItemId')).toBe(unloaded.queueItemId);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.FAILED);
    expect(getState('playback.activity')).toBe('pending');

    transport.togglePlay();
    await vi.waitFor(() => expect(resolveFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(decodeMocks.loadAndBroadcastFile).toHaveBeenCalledWith(
        downloaded,
        unloaded.queueItemId,
        expect.any(Number),
        expect.any(Number),
        expect.objectContaining({ queueItemId: unloaded.queueItemId }),
      );
    });
  });

  it('restores an unloaded persistent file as decoded and paused at its checkpoint', async () => {
    const unloaded = fileItem('sleeping.flac');
    const downloaded = new File(['audio'], 'sleeping.flac', { type: 'audio/flac' });
    setState('playlist.items', [unloaded]);
    enterProRoom(['playback.control'], 'coordinator');
    const resolveFile = vi.fn(async () => {
      setState('playlist.items', [{ ...unloaded, file: downloaded }]);
      return downloaded;
    });
    registerProRoomLegacyMediaHooks(proMediaHooks({ resolveFile }));
    decodeMocks.loadAndBroadcastFile.mockImplementation(async (_file, queueItemId, sessionId) => {
      setCurrentAudioBuffer({ duration: 180 } as AudioBuffer);
      setState('files.current', {
        queueItemId,
        indexHint: 0,
        name: downloaded.name,
        sessionId,
        blob: downloaded,
        mime: downloaded.type,
        size: downloaded.size,
      });
      setState('playback.lifecycle', PLAYBACK_STATE.READY);
      setState('playback.mode', 'file');
      setState('playback.activity', 'pending');
      return true;
    });
    initPlaylist();

    await expect(
      restoreProRoomLegacyPlayback({
        queueItemId: unloaded.queueItemId,
        positionSeconds: 42.25,
        state: 'paused',
      }),
    ).resolves.toBe(true);

    expect(resolveFile).toHaveBeenCalledOnce();
    expect(getState('player.pausedAt')).toBe(42.25);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.PAUSED);
    expect(getState('playback.activity')).toBe('paused');
  });

  it('restores a decoded persistent file through the precise play path at its checkpoint', async () => {
    const file = new File(['audio'], 'resume.flac', { type: 'audio/flac' });
    const item = fileItem(file.name, file);
    setState('playlist.items', [item]);
    enterProRoom(['playback.control'], 'coordinator');
    decodeMocks.loadAndBroadcastFile.mockImplementation(async (_file, queueItemId, sessionId) => {
      setCurrentAudioBuffer({ duration: 180 } as AudioBuffer);
      setState('files.current', {
        queueItemId,
        indexHint: 0,
        name: file.name,
        sessionId,
        blob: file,
        mime: file.type,
        size: file.size,
      });
      setState('playback.lifecycle', PLAYBACK_STATE.READY);
      setState('playback.mode', 'file');
      setState('playback.activity', 'pending');
      return true;
    });
    const playSpy = vi.spyOn(transport, 'play').mockImplementation(async (position) => {
      setState('player.pausedAt', position);
      setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
    });
    initPlaylist();

    await expect(
      restoreProRoomLegacyPlayback({
        queueItemId: item.queueItemId,
        positionSeconds: 61.5,
        state: 'playing',
      }),
    ).resolves.toBe(true);

    expect(playSpy).toHaveBeenCalledWith(61.5);
    expect(getState('playback.activity')).toBe('playing');
  });
});

describe('shuffle row order helpers', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    setState('playlist.items', [fileItem('a.mp3'), fileItem('b.mp3'), fileItem('c.mp3')]);
  });

  it('finds the next playable row without falling back to a fresh random pick', () => {
    selectIndex(1);
    setRepeatMode(0, false);
    setShuffle(true, false);

    const itemC = getState('playlist.items')[2]!;
    expect(
      getShuffleNextPlayableQueueItemId((queueItemId) => queueItemId !== itemC.queueItemId),
    ).toBeNull();

    setRepeatMode(1, false);
    expect(
      getShuffleNextPlayableQueueItemId((queueItemId) => queueItemId !== itemC.queueItemId),
    ).toBe(getState('playlist.items')[0]?.queueItemId);
  });

  it('wraps previous row navigation through the same shuffle order', () => {
    selectIndex(0);
    setRepeatMode(1, false);
    setShuffle(true, false);

    expect(advanceToShufflePreviousQueueItemId()).toBe(getState('playlist.items')[2]?.queueItemId);
  });

  it('advances next row and reshuffles at repeat-all pass end', () => {
    selectIndex(2);
    setRepeatMode(1, false);
    setShuffle(true, false);

    expect(advanceToShuffleNextQueueItemId()).toBe(getState('playlist.items')[0]?.queueItemId);
  });

  it('restores the exact persisted shuffle permutation and repeat mode', () => {
    const items = getState('playlist.items');
    selectIndex(0);
    const persistedOrder = [items[2]!.queueItemId, items[0]!.queueItemId, items[1]!.queueItemId];

    expect(
      applyPlaylistQueueModeState({
        repeatMode: 1,
        shuffleEnabled: true,
        shuffleOrder: persistedOrder,
      }),
    ).toBe(true);

    expect(capturePlaylistQueueModeState()).toEqual({
      repeatMode: 1,
      shuffleEnabled: true,
      shuffleOrder: persistedOrder,
    });
    expect(advanceToShuffleNextQueueItemId()).toBe(items[1]!.queueItemId);
  });

  it('preserves surviving shuffle order across removal and rejects stale permutations', () => {
    const items = getState('playlist.items');
    const persistedOrder = [items[2]!.queueItemId, items[0]!.queueItemId, items[1]!.queueItemId];
    expect(
      applyPlaylistQueueModeState({
        repeatMode: 2,
        shuffleEnabled: true,
        shuffleOrder: persistedOrder,
      }),
    ).toBe(true);

    setState('playlist.items', [items[0]!, items[2]!]);
    reconcileShuffleOrderForCurrentPlaylist();
    expect(capturePlaylistQueueModeState().shuffleOrder).toEqual([
      items[2]!.queueItemId,
      items[0]!.queueItemId,
    ]);
    expect(
      applyPlaylistQueueModeState({
        repeatMode: 1,
        shuffleEnabled: true,
        shuffleOrder: persistedOrder,
      }),
    ).toBe(false);
  });
});

describe('playNext/playPrev mode-branch parity', () => {
  function setupModeBranch(owner: 'file' | 'youtube', currentIndex: number): void {
    resetState();
    bus.clear();
    setPendingAutoSyncOnReady(false);
    setState('player.isFirstTrackLoad', false);
    const items =
      owner === 'youtube'
        ? [
            youtubeItem('A', 'VIDEO_AAAAA'),
            youtubeItem('B', 'VIDEO_BBBBB'),
            youtubeItem('C', 'VIDEO_CCCCC'),
          ]
        : [fileItem('a.mp3'), fileItem('b.mp3'), fileItem('c.mp3')];
    setState('playlist.items', items);
    selectIndex(currentIndex);
    setRepeatMode(1, false);
    setShuffle(true, false);

    if (owner === 'youtube') {
      setPlaybackYouTubePlaying();
      bus.on('youtube:try-next-internal', (done: (success: boolean) => void) => done(false));
      bus.on('youtube:try-prev-internal', (done: (success: boolean) => void) => done(false));
      bus.on('youtube:load', () => {});
    }
  }

  it('shuffle Next chooses the same next row in local and YouTube fallback branches', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    setupModeBranch('file', 1);
    playNextTrack();
    const localNext = currentIndex();

    setupModeBranch('youtube', 1);
    playNextTrack();
    const youtubeNext = currentIndex();

    expect(localNext).toBe(2);
    expect(youtubeNext).toBe(localNext);
  });

  it('shuffle Prev wraps the same previous row in local and YouTube fallback branches', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    setupModeBranch('file', 0);
    playPrevTrack();
    const localPrev = currentIndex();

    setupModeBranch('youtube', 0);
    playPrevTrack();
    const youtubePrev = currentIndex();

    expect(localPrev).toBe(2);
    expect(youtubePrev).toBe(localPrev);
  });
});

describe('clearPreloadState', () => {
  it('clears the next queue occurrence', () => {
    setRepeatMode(0, false);
    clearPreloadState();
    expect(getState('preload.nextQueueItemId')).toBeNull();
  });
});

describe('playTrack YouTube auto-rendezvous', () => {
  it('keeps an ordinary first YouTube selection paused for the manual play tap', async () => {
    const video = youtubeItem('First Video', 'FIRST_VIDEO_01');
    setState('playlist.items', [video]);
    const load = vi.fn();
    bus.on('youtube:load', load);

    await playTrack(video.queueItemId);

    expect(load).toHaveBeenCalledWith('FIRST_VIDEO_01', null, video.queueItemId, false, 0);
    expect(getPendingAutoSyncOnReady()).toBe(false);
    expect(getState('player.isFirstTrackLoad')).toBe(false);
  });

  it('arms paused-load zero-start for an explicit first YouTube play intent', async () => {
    const video = youtubeItem('First Video', 'FIRST_VIDEO_01');
    setState('playlist.items', [video]);
    const load = vi.fn();
    bus.on('youtube:load', load);

    await playTrack(video.queueItemId, undefined, { explicitPlaybackIntent: true });

    expect(load).toHaveBeenCalledWith('FIRST_VIDEO_01', null, video.queueItemId, false, 0);
    expect(consumePendingAutoSyncOnReady()).toMatchObject({
      isTrackTransition: false,
      zeroStart: true,
      targetTime: 0,
      subIndex: 0,
      videoId: 'FIRST_VIDEO_01',
      skipSeek: true,
    });
    expect(getState('player.isFirstTrackLoad')).toBe(false);
  });

  it('stops the outgoing YouTube occurrence before selecting a persistent PRO file', async () => {
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', true), conn }]);
    setState('player.isFirstTrackLoad', false);

    const oldVideo = youtubeItem('Old Video', 'OLD_VIDEO_01');
    const file = new File(['persistent'], 'persistent.flac', { type: 'audio/flac' });
    const persistentFile = fileItem(file.name, file);
    setState('playlist.items', [oldVideo, persistentFile]);
    selectIndex(0);
    setPlaybackTrackMeta(oldVideo);
    setPlaybackYouTubePlaying();
    registerProRoomLegacyMediaHooks(
      proMediaHooks({
        handlesPersistentFile: (queueItemId) => queueItemId === persistentFile.queueItemId,
      }),
    );

    const order: string[] = [];
    bus.on('youtube:stop-mode', (options) => {
      order.push(`stop:${getState('playlist.currentQueueItemId')}`);
      stopYouTubeMode(options);
    });
    decodeMocks.loadAndBroadcastFile.mockImplementation(
      async (_file, queueItemId, _sessionId, _loadEpoch, prepareMsg) => {
        order.push(`prepare:${queueItemId}`);
        expect(prepareMsg).toEqual(
          expect.objectContaining({
            type: MSG.FILE_PREPARE,
            queueItemId: persistentFile.queueItemId,
          }),
        );
        return false;
      },
    );

    await playTrack(persistentFile.queueItemId);

    expect(order).toEqual([
      `stop:${oldVideo.queueItemId}`,
      `prepare:${persistentFile.queueItemId}`,
    ]);
    expect(send).toHaveBeenCalledWith({
      type: MSG.YOUTUBE_STOP,
      queueItemId: oldVideo.queueItemId,
    });
    expect(send).not.toHaveBeenCalledWith({
      type: MSG.YOUTUBE_STOP,
      queueItemId: persistentFile.queueItemId,
    });
    expect(getState('playlist.currentQueueItemId')).toBe(persistentFile.queueItemId);
  });

  it('keeps pending auto-sync armed after fresh non-YouTube -> YouTube load cleanup', async () => {
    setState('player.isFirstTrackLoad', false);
    const local = fileItem('local.mp3');
    const video = youtubeItem('Video', 'VIDEO_ID_01');
    setState('playlist.items', [local, video]);
    selectIndex(0);

    bus.on('youtube:stop-mode', () => setPendingAutoSyncOnReady(false));
    bus.on('player:stop-all-media', () => {
      bus.emit('youtube:stop-mode', { silent: false });
    });
    bus.on('youtube:load', () => {
      bus.emit('player:stop-all-media');
    });

    await playTrack(video.queueItemId);

    expect(getPendingAutoSyncOnReady()).toBe(true);
    expect(consumePendingAutoSyncOnReady()).toMatchObject({
      isTrackTransition: false,
      targetTime: 0,
      subIndex: 0,
      videoId: 'VIDEO_ID_01',
      skipSeek: true,
    });
  });

  it('marks YouTube-to-YouTube loads as track transitions', async () => {
    setPlaybackYouTubePlaying();
    setState('player.isFirstTrackLoad', false);
    const oldVideo = youtubeItem('Old Video', 'OLD_VIDEO_01');
    const newVideo = youtubeItem('New Video', 'NEW_VIDEO_01');
    setState('playlist.items', [oldVideo, newVideo]);
    selectIndex(0);

    bus.on('youtube:load', () => {});

    await playTrack(newVideo.queueItemId);

    expect(consumePendingAutoSyncOnReady()).toMatchObject({
      isTrackTransition: true,
      targetTime: 0,
      subIndex: 0,
      videoId: 'NEW_VIDEO_01',
      skipSeek: true,
    });
  });

  it('restarts the current YouTube occurrence without reloading its iframe', async () => {
    setPlaybackYouTubePlaying();
    setState('player.isFirstTrackLoad', false);
    const video = youtubeItem('Current Video', 'CURRENT_VIDEO_01');
    setState('playlist.items', [video]);
    selectIndex(0);
    setState('youtube.currentSubIndex', 0);
    setYouTubePlayer({
      getVideoData: () => ({ video_id: 'CURRENT_VIDEO_01' }),
    } as never);
    const autoPlay = vi.fn();
    const load = vi.fn();
    const outbound = vi.fn();
    bus.on('youtube:auto-play', autoPlay);
    bus.on('youtube:load', load);
    bus.on('network:broadcast', outbound);

    await playTrack(video.queueItemId);

    expect(autoPlay).toHaveBeenCalledOnce();
    expect(autoPlay).toHaveBeenCalledWith({
      isTrackTransition: false,
      zeroStart: true,
      targetTime: 0,
      videoId: 'CURRENT_VIDEO_01',
      subIndex: 0,
      skipSeek: false,
    });
    expect(load).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(video.queueItemId);
  });

  it('directly hands off a new queue occurrence of the resident YouTube video', async () => {
    setPlaybackYouTubePlaying();
    setState('player.isFirstTrackLoad', false);
    const firstOccurrence = youtubeItem('First occurrence', 'SAME_VIDEO_1');
    const secondOccurrence = youtubeItem('Second occurrence', 'SAME_VIDEO_1');
    setState('playlist.items', [firstOccurrence, secondOccurrence]);
    selectIndex(0);

    bus.on('youtube:load', () => {});
    const prepareRestart = vi
      .spyOn(youtubeIframe, 'prepareSameVideoOccurrenceRestart')
      .mockReturnValue(true);
    const handoff = vi
      .spyOn(youtubeIframe, 'handoffSameVideoOccurrenceRestart')
      .mockReturnValue(true);

    await playTrack(secondOccurrence.queueItemId);

    expect(prepareRestart).toHaveBeenCalledOnce();
    expect(prepareRestart).toHaveBeenCalledWith(secondOccurrence.queueItemId, 'SAME_VIDEO_1');
    expect(handoff).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledWith(secondOccurrence.queueItemId, 'SAME_VIDEO_1');
    expect(getState('playlist.currentQueueItemId')).toBe(secondOccurrence.queueItemId);
    expect(consumePendingAutoSyncOnReady()).toMatchObject({
      isTrackTransition: true,
      zeroStart: true,
      videoId: 'SAME_VIDEO_1',
      targetTime: 0,
      skipSeek: false,
    });
  });

  it('forces a removed same-video occurrence successor back to zero after selection clears', async () => {
    setPlaybackYouTubePlaying();
    setState('player.isFirstTrackLoad', false);
    const successor = youtubeItem('Surviving occurrence', 'SAME_VIDEO_1');
    setState('playlist.items', [successor]);
    setState('playlist.currentQueueItemId', null);

    bus.on('youtube:load', () => {});
    const prepareRestart = vi
      .spyOn(youtubeIframe, 'prepareSameVideoOccurrenceRestart')
      .mockReturnValue(true);
    const handoff = vi
      .spyOn(youtubeIframe, 'handoffSameVideoOccurrenceRestart')
      .mockReturnValue(true);

    await playTrack(successor.queueItemId, undefined, { forceNewYouTubeOccurrence: true });

    expect(prepareRestart).toHaveBeenCalledWith(successor.queueItemId, 'SAME_VIDEO_1');
    expect(handoff).toHaveBeenCalledWith(successor.queueItemId, 'SAME_VIDEO_1');
    expect(consumePendingAutoSyncOnReady()).toMatchObject({
      zeroStart: true,
      videoId: 'SAME_VIDEO_1',
      targetTime: 0,
      skipSeek: false,
    });
  });

  it('broadcasts the requested YouTube playlist sub-index on playTrack', async () => {
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);
    setState('player.isFirstTrackLoad', false);
    const playlistItem = {
      ...youtubeItem('Playlist', 'entryVideo', 'playlist-1'),
      title: 'Playlist',
    };
    setState('playlist.items', [playlistItem]);
    selectIndex(0);
    setState('youtube.subItemsMap', {
      'playlist-1': {
        ids: ['firstVideo', 'secondVideo'],
        titles: ['First', 'Second'],
      },
    });

    bus.on('youtube:load', () => {});

    await playTrack(playlistItem.queueItemId, 1);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.YOUTUBE_PLAY,
        videoId: 'secondVideo',
        playlistId: 'playlist-1',
        queueItemId: playlistItem.queueItemId,
        subIndex: 1,
      }),
    );
  });

  it('drops a local-file broadcast parked in the debounce window when switching to YouTube', async () => {
    // A mode switch within the send debounce must cancel the pending local
    // transfer; otherwise guests can receive stale file traffic in YouTube mode.
    vi.useFakeTimers();
    const send = vi.fn();
    const conn = {
      peer: 'guest-1',
      open: true,
      send,
      peerConnection: { connectionState: 'connected' },
      dataChannel: { readyState: 'open', bufferedAmount: 0 },
    } as unknown as DataConnection;
    setState('network.connectedPeers', [
      { ...makeConnectedPeer('guest-1', false), conn, connectionType: 'local' },
    ]);
    setState('player.isFirstTrackLoad', false);
    const file = new File(['abc'], 'local.mp3', { type: 'audio/mpeg' });
    const local = fileItem('local.mp3', file);
    const video = youtubeItem('Video', 'VIDEO_ID_01');
    setState('playlist.items', [local, video]);
    selectIndex(0);
    bus.on('youtube:load', () => {});

    broadcastFileDebounced(file, local.queueItemId, 1, {
      type: MSG.FILE_PREPARE,
      name: 'local.mp3',
      queueItemId: local.queueItemId,
      sessionId: 1,
      mime: 'audio/mpeg',
    });

    await playTrack(video.queueItemId);
    await vi.advanceTimersByTimeAsync(301);

    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_PREPARE }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_START }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.YOUTUBE_PLAY }));
  });
});

describe('playTrack explicit file playback intent', () => {
  it('keeps an ordinary first file ready for the manual play tap', async () => {
    const file = new File(['audio'], 'first.flac', { type: 'audio/flac' });
    const item = fileItem(file.name, file);
    setState('playlist.items', [item]);
    decodeMocks.loadAndBroadcastFile.mockResolvedValue(true);

    await playTrack(item.queueItemId);

    expect(decodeMocks.loadAndBroadcastFile).toHaveBeenCalledWith(
      file,
      item.queueItemId,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ autoPlayDelayMs: 0 }),
    );
    expect(getManagedTimer('autoPlayTimer')).toBeNull();
    expect(getState('player.isFirstTrackLoad')).toBe(false);
  });

  it('routes an explicit first file through the synchronized delayed start', async () => {
    vi.useFakeTimers();
    const file = new File(['audio'], 'first.flac', { type: 'audio/flac' });
    const item = fileItem(file.name, file);
    setState('playlist.items', [item]);
    decodeMocks.loadAndBroadcastFile.mockResolvedValue(true);

    await playTrack(item.queueItemId, undefined, { explicitPlaybackIntent: true });

    expect(decodeMocks.loadAndBroadcastFile).toHaveBeenCalledWith(
      file,
      item.queueItemId,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ autoPlayDelayMs: 3000 }),
    );
    expect(getManagedTimer('autoPlayTimer')).not.toBeNull();
    expect(getState('player.isFirstTrackLoad')).toBe(false);
  });
});

describe('remove-track playlist-empty teardown supersedes in-flight loads', () => {
  // Removing the final track during its decode window must advance the load
  // epoch so that a late decode cannot republish or play the deleted track.
  // decode.test.ts covers the corresponding stale-decode checkpoint.
  it('bumps the load epoch when the last track is removed', () => {
    initPlaylist();
    const only = fileItem('only.mp3');
    setState('playlist.items', [only]);
    selectIndex(0);

    const before = getCurrentLoadEpoch();
    bus.emit('playlist:remove-tracks', [only.queueItemId]);

    expect(getState('playlist.items')).toHaveLength(0);
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getCurrentLoadEpoch()).toBe(before + 1);
  });

  it('does NOT bump the epoch when a non-current track is removed (live load must survive)', () => {
    initPlaylist();
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    setState('playlist.items', [a, b]);
    selectIndex(0);

    const before = getCurrentLoadEpoch();
    bus.emit('playlist:remove-tracks', [b.queueItemId]);

    expect(getState('playlist.items')).toHaveLength(1);
    expect(getState('playlist.currentQueueItemId')).toBe(a.queueItemId);
    expect(getCurrentLoadEpoch()).toBe(before);
  });
});

describe('atomic batch playlist removal', () => {
  it('normalizes duplicate and unknown IDs into one revision and one snapshot', () => {
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    const d = fileItem('d.mp3');
    const unknown = nextQueueItemId();
    setState('playlist.items', [a, b, c, d]);
    setState('playlist.currentQueueItemId', b.queueItemId);
    setState('playlist.revision', 12);
    initPlaylist();

    bus.emit('playlist:remove-tracks', [a.queueItemId, c.queueItemId, a.queueItemId, unknown]);

    expect(getState('playlist.items')).toEqual([b, d]);
    expect(getState('playlist.currentQueueItemId')).toBe(b.queueItemId);
    expect(getState('playlist.revision')).toBe(13);
    const snapshots = send.mock.calls
      .map(([message]) => message as { type?: string; revision?: number })
      .filter((message) => message.type === MSG.PLAYLIST_UPDATE);
    expect(snapshots).toEqual([expect.objectContaining({ revision: 13 })]);
  });

  it('skips every selected successor and then falls back to the nearest survivor', () => {
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    const d = fileItem('d.mp3');
    const e = fileItem('e.mp3');
    setState('playlist.items', [a, b, c, d, e]);
    setState('playlist.currentQueueItemId', b.queueItemId);
    initPlaylist();

    bus.emit('playlist:remove-tracks', [b.queueItemId, c.queueItemId, d.queueItemId]);
    expect(getState('playlist.items')).toEqual([a, e]);
    expect(getState('playlist.currentQueueItemId')).toBe(e.queueItemId);

    bus.emit('playlist:remove-tracks', [e.queueItemId]);
    expect(getState('playlist.items')).toEqual([a]);
    expect(getState('playlist.currentQueueItemId')).toBe(a.queueItemId);
  });

  it('cleans selected asynchronous owners and invalidates stale peer preload caches', () => {
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    const peer = makeConnectedPeer('guest-1', false);
    peer.preloadedQueueItemIds = new Set([a.queueItemId, b.queueItemId, c.queueItemId]);
    setState('network.connectedPeers', [peer]);
    setState('playlist.items', [a, b, c]);
    setState('playlist.currentQueueItemId', a.queueItemId);
    setState('preload.nextQueueItemId', b.queueItemId);
    setState('preload.activeTarget', {
      queueItemId: b.queueItemId,
      indexHint: 1,
      name: b.name,
      sessionId: 9,
    });
    setState('playback.pendingRecoveryTarget', {
      queueItemId: c.queueItemId,
      indexHint: 2,
      name: c.name,
    });
    setState('recovery.pending', true);
    initPlaylist();

    bus.emit('playlist:remove-tracks', [b.queueItemId, c.queueItemId]);

    expect(getState('preload.nextQueueItemId')).toBeNull();
    expect(getState('preload.activeTarget')).toBeNull();
    expect(getState('playback.pendingRecoveryTarget')).toBeNull();
    expect(getState('recovery.pending')).toBe(false);
    expect([...getState('network.connectedPeers')[0]!.preloadedQueueItemIds]).toEqual([]);
  });

  it('ignores batch removal attempts from a guest', () => {
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    setState('playlist.items', [a, b]);
    setState('playlist.currentQueueItemId', a.queueItemId);
    setState('network.hostConn', makeConnection('host'));
    initPlaylist();

    bus.emit('playlist:remove-tracks', [a.queueItemId, b.queueItemId]);

    expect(getState('playlist.items')).toEqual([a, b]);
    expect(getState('playlist.revision')).toBe(0);
  });

  it('tears down a multi-item queue once when every item is selected', () => {
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    setState('playlist.items', [a, b, c]);
    setState('playlist.currentQueueItemId', b.queueItemId);
    setState('playlist.revision', 4);
    initPlaylist();
    const beforeEpoch = getCurrentLoadEpoch();

    bus.emit('playlist:remove-tracks', [a.queueItemId, b.queueItemId, c.queueItemId]);

    expect(getState('playlist.items')).toEqual([]);
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('playlist.revision')).toBe(5);
    expect(getCurrentLoadEpoch()).toBe(beforeEpoch + 1);
  });

  it('chooses the first live successor after the removed set in shuffle order', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    const d = fileItem('d.mp3');
    setState('playlist.items', [a, b, c, d]);
    setState('playlist.currentQueueItemId', b.queueItemId);
    setShuffle(true, false);
    initPlaylist();

    bus.emit('playlist:remove-tracks', [b.queueItemId, c.queueItemId]);

    expect(getState('playlist.items')).toEqual([a, d]);
    expect(getState('playlist.currentQueueItemId')).toBe(d.queueItemId);
  });

  it('leaves YouTube mode once when a selected current video promotes a file', () => {
    const current = youtubeItem('Video', 'VIDEO_ID_01');
    const successor = fileItem('next.mp3');
    const extra = fileItem('extra.mp3');
    setState('playlist.items', [current, successor, extra]);
    setState('playlist.currentQueueItemId', current.queueItemId);
    initPlaylist();
    const stopYouTube = vi.fn();
    bus.on('youtube:stop-mode', stopYouTube);

    bus.emit('playlist:remove-tracks', [current.queueItemId, extra.queueItemId]);

    expect(getState('playlist.items')).toEqual([successor]);
    expect(getState('playlist.currentQueueItemId')).toBe(successor.queueItemId);
    expect(stopYouTube).toHaveBeenCalledTimes(1);
  });
});

describe('guest queue authority bootstrap', () => {
  function setupGuestConnection(peer: string): DataConnection {
    const conn = { peer, open: true, send: vi.fn() } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', conn);
    initPlaylist();
    return conn;
  }

  it('accepts an empty revision-zero baseline from a new connection and clears old media owners', async () => {
    const oldFile = new File(['old'], 'old.mp3', { type: 'audio/mpeg' });
    const old = fileItem('old.mp3', oldFile);
    const resident = residentFor(old, oldFile, 91);
    setState('playlist.items', [old]);
    setState('playlist.currentQueueItemId', old.queueItemId);
    setState('playlist.revision', 27);
    setState('transfer.localSessionId', 92);
    setState('transfer.currentSessionId', 92);
    setState('files.current', resident);
    setState('preload.nextQueueItemId', old.queueItemId);
    setState('preload.activeTarget', resident);
    setState('preload.ready', resident);
    setState('transfer.meta', {
      name: old.name,
      type: oldFile.type,
      queueItemId: old.queueItemId,
      indexHint: 0,
      size: oldFile.size,
      mime: oldFile.type,
      sessionId: resident.sessionId,
      total: 1,
    });
    setState('preload.sessionId', 92);
    setState(
      'preload.sessionState',
      new Map([
        [
          92,
          {
            skipped: false,
            progress: 1,
            total: 1,
            name: old.name,
            queueItemId: old.queueItemId,
            indexHint: 0,
            size: oldFile.size,
            mime: oldFile.type,
            nextExpectedChunk: 1,
            finalized: true,
          },
        ],
      ]),
    );
    setState('preload.ackSent', new Map([[old.queueItemId, 92]]));
    setState('recovery.pending', true);
    setState('recovery.retryCount', 3);
    setState('playback.pendingRecoveryTarget', {
      queueItemId: old.queueItemId,
      indexHint: 0,
      name: old.name,
    });
    const conn = setupGuestConnection('host-rebaseline-empty');

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        revision: 0,
        currentQueueItemId: null,
        bootstrap: true,
      },
      conn,
    );

    expect(getState('playlist.items')).toEqual([]);
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('playlist.revision')).toBe(0);
    expect(getState('files.current')).toBeNull();
    expect(getState('preload.ready')).toBeNull();
    expect(getState('preload.activeTarget')).toBeNull();
    expect(getState('transfer.meta')).toBeNull();
    expect(getState('transfer.localSessionId')).toBe(0);
    expect(getState('transfer.currentSessionId')).toBe(0);
    expect(getState('preload.sessionId')).toBe(0);
    expect(getState('preload.sessionState').size).toBe(0);
    expect(getState('preload.ackSent').size).toBe(0);
    expect(getState('recovery.pending')).toBe(false);
    expect(getState('recovery.retryCount')).toBe(0);
    expect(getState('playback.pendingRecoveryTarget')).toBeNull();
  });

  it('clears an identical-looking new authority, then preserves its duplicate replay', async () => {
    const file = new File(['same'], 'same.mp3', { type: 'audio/mpeg' });
    const item = fileItem('same.mp3', file);
    const resident = residentFor(item, file, 92);
    setState('playlist.items', [item]);
    setState('playlist.currentQueueItemId', item.queueItemId);
    setState('playlist.revision', 4);
    setState('files.current', resident);
    setState('preload.nextQueueItemId', item.queueItemId);
    setState('preload.activeTarget', resident);
    setState('preload.ready', resident);
    const conn = setupGuestConnection('host-identical');
    const frame = {
      type: MSG.PLAYLIST_UPDATE,
      list: [wireItem(item)],
      revision: 4,
      currentQueueItemId: item.queueItemId,
      bootstrap: true as const,
    };
    const warn = vi.spyOn(log, 'warn');

    await handleData(frame, conn);
    expect(getState('playlist.items')[0]).not.toBe(item);
    expect(getState('files.current')).toBeNull();
    expect(getState('preload.ready')).toBeNull();

    setState('files.current', resident);
    setState('preload.nextQueueItemId', item.queueItemId);
    setState('preload.activeTarget', resident);
    setState('preload.ready', resident);
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(item)],
        revision: 4,
        currentQueueItemId: item.queueItemId,
      },
      conn,
    );

    expect(getState('files.current')).toBe(resident);
    expect(getState('preload.ready')).toBe(resident);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops removed current media as soon as a non-empty successor snapshot arrives', async () => {
    const oldFile = new File(['old'], 'old.mp3', { type: 'audio/mpeg' });
    const old = fileItem('old.mp3', oldFile);
    const successor = fileItem('next.mp3');
    const conn = setupGuestConnection('host-current-removal');

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(old), wireItem(successor)],
        revision: 0,
        currentQueueItemId: old.queueItemId,
        bootstrap: true,
      },
      conn,
    );

    setState('files.current', residentFor(old, oldFile, 101));
    setCurrentAudioBuffer({} as AudioBuffer);
    setState('transfer.meta', {
      name: old.name,
      type: oldFile.type,
      queueItemId: old.queueItemId,
      indexHint: 0,
      size: oldFile.size,
      mime: oldFile.type,
      sessionId: 101,
      total: 1,
    });
    const successorPreload = {
      queueItemId: successor.queueItemId,
      indexHint: 1,
      name: successor.name,
      sessionId: 102,
    };
    setState('preload.nextQueueItemId', successor.queueItemId);
    setState('preload.activeTarget', successorPreload);
    setState('preload.isPreloading', true);

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(successor)],
        revision: 1,
        currentQueueItemId: successor.queueItemId,
      },
      conn,
    );

    expect(getState('playlist.currentQueueItemId')).toBe(successor.queueItemId);
    expect(getState('files.current')).toBeNull();
    expect(getState('transfer.meta')).toBeNull();
    expect(getCurrentAudioBuffer()).toBeNull();
    expect(getState('preload.nextQueueItemId')).toBe(successor.queueItemId);
    expect(getState('preload.activeTarget')).toEqual(successorPreload);
    expect(getState('preload.isPreloading')).toBe(true);
  });

  it('allows one rebaseline per connection and opens a fresh gate for a replacement connection', async () => {
    const item = fileItem('new.mp3');
    const conn = setupGuestConnection('host-one-shot');

    // A regular update cannot establish authority or consume the bootstrap gate.
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(item)],
        revision: 5,
        currentQueueItemId: item.queueItemId,
      },
      conn,
    );
    expect(getState('playlist.items')).toEqual([]);
    expect(getState('playlist.revision')).toBe(0);

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        revision: 0,
        currentQueueItemId: null,
        bootstrap: true,
      },
      conn,
    );
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(item)],
        revision: 5,
        currentQueueItemId: item.queueItemId,
      },
      conn,
    );
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        revision: 0,
        currentQueueItemId: null,
        bootstrap: true,
      },
      conn,
    );

    // The bootstrap marker itself is one-shot; even a higher revision cannot
    // turn it into a second rebaseline on this connection.
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        revision: 6,
        currentQueueItemId: null,
        bootstrap: true,
      },
      conn,
    );

    expect(getState('playlist.items')).toEqual([wireItem(item)]);
    expect(getState('playlist.currentQueueItemId')).toBe(item.queueItemId);
    expect(getState('playlist.revision')).toBe(5);

    const replacement = {
      peer: 'host-one-shot-replacement',
      open: true,
      send: vi.fn(),
    } as unknown as DataConnection;
    setState('network.hostConn', replacement);
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        revision: 0,
        currentQueueItemId: null,
        bootstrap: true,
      },
      replacement,
    );

    expect(getState('playlist.items')).toEqual([]);
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('playlist.revision')).toBe(0);
  });

  it('does not consume the bootstrap gate for a malformed baseline', async () => {
    const item = fileItem('valid-after-malformed.mp3');
    const conn = setupGuestConnection('host-malformed-first');
    const warn = vi.spyOn(log, 'warn');

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(item), wireItem(item)],
        revision: 1,
        currentQueueItemId: item.queueItemId,
        bootstrap: true,
      },
      conn,
    );
    expect(warn).toHaveBeenCalledWith(
      '[Protocol] Invalid payload for playlist-update',
      expect.any(Array),
    );

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(item)],
        revision: 0,
        currentQueueItemId: item.queueItemId,
        bootstrap: true,
      },
      conn,
    );
    expect(getState('playlist.items')).toEqual([wireItem(item)]);
    expect(getState('playlist.currentQueueItemId')).toBe(item.queueItemId);
    expect(getState('playlist.revision')).toBe(0);
  });

  it('warns for equal-revision conflicts and malformed snapshots, but only debugs stale ones', async () => {
    const current = fileItem('current.mp3');
    const conflict = fileItem('conflict.mp3');
    const conn = setupGuestConnection('host-classification');
    const warn = vi.spyOn(log, 'warn');
    const debug = vi.spyOn(log, 'debug');

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(current)],
        revision: 3,
        currentQueueItemId: current.queueItemId,
        bootstrap: true,
      },
      conn,
    );
    warn.mockClear();
    debug.mockClear();

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(conflict)],
        revision: 3,
        currentQueueItemId: conflict.queueItemId,
      },
      conn,
    );
    expect(warn).toHaveBeenCalledWith(
      '[Playlist] Rejected conflicting playlist snapshot at equal revision',
    );

    warn.mockClear();
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [wireItem(current), wireItem(current)],
        revision: 4,
        currentQueueItemId: current.queueItemId,
      },
      conn,
    );
    expect(warn).toHaveBeenCalledWith(
      '[Protocol] Invalid payload for playlist-update',
      expect.any(Array),
    );

    warn.mockClear();
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        revision: 2,
        currentQueueItemId: null,
      },
      conn,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('[Playlist] Ignored stale playlist snapshot');
    expect(getState('playlist.revision')).toBe(3);
  });
});

describe('late-join playlist bootstrap', () => {
  it('marks repeat and shuffle mode frames as bootstrap so guests do not toast', () => {
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    initPlaylist();
    setState('playlist.repeatMode', 2);
    setState('playlist.isShuffle', false);
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    setState('playlist.items', [a, b]);
    selectIndex(1);

    bus.emit('network:peer-bootstrap', conn);

    expect(send.mock.calls.slice(0, 3).map(([message]) => message.type)).toEqual([
      MSG.PLAYLIST_UPDATE,
      MSG.REPEAT_MODE,
      MSG.SHUFFLE_MODE,
    ]);
    expect(send).toHaveBeenCalledWith({ type: MSG.REPEAT_MODE, value: 2, _bootstrap: true });
    expect(send).toHaveBeenCalledWith({
      type: MSG.SHUFFLE_MODE,
      value: false,
      _bootstrap: true,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PLAYLIST_UPDATE,
        bootstrap: true,
        revision: 0,
        currentQueueItemId: b.queueItemId,
        list: [
          expect.objectContaining({ queueItemId: a.queueItemId }),
          expect.objectContaining({ queueItemId: b.queueItemId }),
        ],
      }),
    );
  });
});

describe('decode-fail advance respects end-of-playlist (mode parity)', () => {
  // Guest-reported and host decode failures share the same advance path, so
  // the guest report pins repeat-mode behavior at the end of the playlist.
  function setupOpReporter(): ReturnType<typeof vi.fn> {
    const send = vi.fn();
    const conn = { peer: 'guest-op', open: true, send } as unknown as DataConnection;
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-op', true), conn }]);
    initDecodeHandlers();
    setState('playlist.items', [fileItem('a.mp3'), fileItem('b.mp3'), fileItem('c.mp3')]);
    selectIndex(2);
    return send;
  }

  it('repeat OFF: last-track failure ends the playlist instead of wrapping to track 0', async () => {
    vi.useFakeTimers();
    const send = setupOpReporter();
    setRepeatMode(0, false);

    const opConn = getState('network.connectedPeers')[0].conn!;
    await handleData(
      {
        type: MSG.GUEST_DECODE_FAILED,
        queueItemId: getState('playlist.currentQueueItemId')!,
      },
      opConn,
    );
    await vi.advanceTimersByTimeAsync(700);

    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PAUSE, endOfPlaylist: true }),
    );
  });

  it('repeat ALL: last-track failure still wraps the advance to track 0', async () => {
    vi.useFakeTimers();
    setupOpReporter();
    setRepeatMode(1, false);

    const opConn = getState('network.connectedPeers')[0].conn!;
    await handleData(
      {
        type: MSG.GUEST_DECODE_FAILED,
        queueItemId: getState('playlist.currentQueueItemId')!,
      },
      opConn,
    );
    await vi.advanceTimersByTimeAsync(700);

    expect(currentIndex()).toBe(0);
  });
});

describe('repeat-one ended-advance after a mid-window removal (SA-12)', () => {
  it('broadcasts the stable current qid after a lower row is removed', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);
    initPlaylist();
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    setState('playlist.items', [a, b, c]);
    selectIndex(2);
    setRepeatMode(2, false);

    bus.emit('player:ended');
    // A non-current track removal during the 300ms window shifts the
    // current index down — the replay broadcast must follow it.
    bus.emit('playlist:remove-tracks', [a.queueItemId]);
    await vi.advanceTimersByTimeAsync(320);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAY, time: 0, queueItemId: c.queueItemId }),
    );
  });
});

describe('fast-replay autoPlayTimer stable identity (F-2404)', () => {
  it('broadcasts the same qid after a lower row is removed during the delay', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);
    initPlaylist();

    const file = new File([new Uint8Array([1, 2, 3])], 'c.mp3', { type: 'audio/mpeg' });
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3', file);
    setState('playlist.items', [a, b, c]);
    selectIndex(2);
    setState('player.isFirstTrackLoad', false);
    // A matching resident buffer selects the fast-replay path under test.
    setState('files.current', residentFor(c, file));
    setCurrentAudioBuffer({} as AudioBuffer);

    await playTrack(c.queueItemId);
    // Ignore the immediate preparation frame; the delayed PLAY carries the
    // fire-time index under test.
    send.mockClear();

    // A lower-index removal during the 3s replay window shifts the current
    // index down. Park the FSM busy so the fire-time play(0) defers (no audio
    // graph in node env) while the replay broadcast still fires.
    bus.emit('playlist:remove-tracks', [a.queueItemId]);
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    await vi.advanceTimersByTimeAsync(3000);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PLAY,
        time: 0,
        queueItemId: c.queueItemId,
        name: 'c.mp3',
      }),
    );
  });
});

describe('qid-stable removal and reorder regressions', () => {
  it('promotes the preloaded successor by qid after current-row removal without redownloading', async () => {
    const fileA = new File(['a'], 'a.mp3', { type: 'audio/mpeg' });
    const fileB = new File(['preloaded-b'], 'b.mp3', { type: 'audio/mpeg' });
    const a = fileItem('a.mp3', fileA);
    const b = fileItem('b.mp3', fileB);
    const readyB = residentFor(b, fileB, 42);

    setState('playlist.items', [a, b]);
    selectIndex(0);
    setState('files.current', residentFor(a, fileA, 41));
    setState('preload.nextQueueItemId', b.queueItemId);
    setState('preload.activeTarget', {
      queueItemId: b.queueItemId,
      indexHint: 1,
      name: b.name,
      sessionId: readyB.sessionId,
    });
    setState('preload.ready', readyB);

    decodeMocks.loadPreloadedTrack.mockImplementation(async (queueItemId) => {
      const ready = getState('preload.ready');
      if (!ready || ready.queueItemId !== queueItemId) return false;
      setState('files.current', ready);
      setState('preload.ready', null);
      setState('preload.activeTarget', null);
      setState('preload.nextQueueItemId', null);
      return true;
    });

    initPlaylist();
    bus.emit('playlist:remove-tracks', [a.queueItemId]);

    await vi.waitFor(() => {
      expect(decodeMocks.loadPreloadedTrack).toHaveBeenCalledWith(
        b.queueItemId,
        expect.any(Number),
      );
      expect(getState('files.current')).toBe(readyB);
    });

    expect(getState('playlist.items')).toEqual([b]);
    expect(getState('playlist.currentQueueItemId')).toBe(b.queueItemId);
    expect(getState('files.current')?.blob).toBe(fileB);
    expect(getState('files.current')?.sessionId).toBe(42);
    expect(decodeMocks.loadAndBroadcastFile).not.toHaveBeenCalled();
  });

  it('reorders another row without disturbing current, resident, or preload ownership', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);

    const fileB = new File(['resident-b'], 'b.mp3', { type: 'audio/mpeg' });
    const fileC = new File(['preloaded-c'], 'c.mp3', { type: 'audio/mpeg' });
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3', fileB);
    const c = fileItem('c.mp3', fileC);
    const residentB = residentFor(b, fileB, 51);
    const readyC = residentFor(c, fileC, 52);

    setState('playlist.items', [a, b, c]);
    setState('playlist.revision', 8);
    setState('playlist.currentQueueItemId', b.queueItemId);
    setState('files.current', residentB);
    setState('preload.nextQueueItemId', c.queueItemId);
    setState('preload.activeTarget', {
      queueItemId: c.queueItemId,
      indexHint: 2,
      name: c.name,
      sessionId: readyC.sessionId,
    });
    setState('preload.ready', readyC);

    initPlaylist();
    bus.emit('playlist:reorder-track', a.queueItemId, null, 8);
    await vi.advanceTimersByTimeAsync(500);

    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([
      b.queueItemId,
      c.queueItemId,
      a.queueItemId,
    ]);
    expect(getState('playlist.revision')).toBe(9);
    expect(getState('playlist.currentQueueItemId')).toBe(b.queueItemId);
    expect(getState('files.current')).toBe(residentB);
    expect(getState('preload.ready')).toBe(readyC);
    expect(getState('preload.nextQueueItemId')).toBe(c.queueItemId);
    expect(decodeMocks.loadPreloadedTrack).not.toHaveBeenCalled();
    expect(decodeMocks.loadAndBroadcastFile).not.toHaveBeenCalled();

    const snapshots = send.mock.calls
      .map(([message]) => message as { type?: string })
      .filter((message) => message.type === MSG.PLAYLIST_UPDATE);
    expect(snapshots).toHaveLength(1);
  });

  it('recomputes the sequential preload target after reorder without reusing the wrong row', async () => {
    vi.useFakeTimers();
    const fileA = new File(['a'], 'a.mp3', { type: 'audio/mpeg' });
    const fileB = new File(['b'], 'b.mp3', { type: 'audio/mpeg' });
    const fileC = new File(['c'], 'c.mp3', { type: 'audio/mpeg' });
    const a = fileItem('a.mp3', fileA);
    const b = fileItem('b.mp3', fileB);
    const c = fileItem('c.mp3', fileC);
    const readyB = residentFor(b, fileB, 61);

    setState('playlist.items', [a, b, c]);
    setState('playlist.revision', 3);
    setState('playlist.currentQueueItemId', a.queueItemId);
    setState('preload.nextQueueItemId', b.queueItemId);
    setState('preload.activeTarget', readyB);
    setState('preload.ready', readyB);

    initPlaylist();
    bus.emit('playlist:reorder-track', c.queueItemId, b.queueItemId, 3);
    await vi.advanceTimersByTimeAsync(500);

    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([
      a.queueItemId,
      c.queueItemId,
      b.queueItemId,
    ]);
    expect(getState('preload.nextQueueItemId')).toBe(c.queueItemId);
    expect(getState('preload.ready')?.queueItemId).toBe(c.queueItemId);
    expect(getState('preload.ready')?.blob).toBe(fileC);
    expect(getState('preload.ready')).not.toBe(readyB);
  });

  it('keeps shuffle previous-to-next roundtrip stable across reorder and deletion', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    const d = fileItem('d.mp3');
    setState('playlist.items', [a, b, c, d]);
    setState('playlist.currentQueueItemId', c.queueItemId);
    setRepeatMode(1, false);
    setShuffle(true, false);
    initPlaylist();

    expect(advanceToShufflePreviousQueueItemId()).toBe(b.queueItemId);
    setState('playlist.currentQueueItemId', b.queueItemId);

    const revision = getState('playlist.revision');
    bus.emit('playlist:reorder-track', a.queueItemId, null, revision);
    bus.emit('playlist:remove-tracks', [d.queueItemId]);

    expect(advanceToShuffleNextQueueItemId()).toBe(c.queueItemId);
  });

  it('ignores stale reorder revisions and broadcasts exactly one snapshot for a valid reorder', () => {
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    setState('playlist.items', [a, b, c]);
    setState('playlist.currentQueueItemId', b.queueItemId);
    setState('playlist.revision', 5);
    initPlaylist();

    bus.emit('playlist:reorder-track', c.queueItemId, a.queueItemId, 4);
    expect(getState('playlist.items')).toEqual([a, b, c]);
    expect(getState('playlist.revision')).toBe(5);
    expect(send).not.toHaveBeenCalled();

    bus.emit('playlist:reorder-track', c.queueItemId, a.queueItemId, 5);
    expect(getState('playlist.items')).toEqual([c, a, b]);
    expect(getState('playlist.revision')).toBe(6);
    expect(getState('playlist.currentQueueItemId')).toBe(b.queueItemId);

    const snapshots = send.mock.calls
      .map(([message]) => message as { type?: string; revision?: number })
      .filter((message) => message.type === MSG.PLAYLIST_UPDATE);
    expect(snapshots).toEqual([expect.objectContaining({ revision: 6 })]);
  });
});

describe('preloaded activation post-play ownership', () => {
  it('does not broadcast or schedule from an activation superseded while play awaits', async () => {
    const send = vi.fn();
    const conn = { peer: 'guest-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [{ ...makeConnectedPeer('guest-1', false), conn }]);

    const fileA = new File(['preloaded-a'], 'a.mp3', { type: 'audio/mpeg' });
    const fileB = new File(['b'], 'b.mp3', { type: 'audio/mpeg' });
    const a = fileItem('a.mp3', fileA);
    const b = fileItem('b.mp3', fileB);
    const readyA = residentFor(a, fileA, 61);
    setState('playlist.items', [a, b]);
    selectIndex(1);
    setState('preload.nextQueueItemId', a.queueItemId);
    setState('preload.activeTarget', readyA);
    setState('preload.ready', readyA);

    decodeMocks.loadPreloadedTrack.mockImplementation(async () => {
      setState('files.current', readyA);
      setState('preload.nextQueueItemId', null);
      setState('preload.activeTarget', null);
      setState('preload.ready', null);
      setState('playback.lifecycle', PLAYBACK_STATE.READY);
      setState('playback.mode', 'file');
      setState('playback.activity', 'pending');
      return true;
    });

    let releasePlay!: () => void;
    const playGate = new Promise<void>((resolve) => {
      releasePlay = resolve;
    });
    const playSpy = vi.spyOn(transport, 'play').mockReturnValueOnce(playGate);

    const activation = playTrack(a.queueItemId);
    await vi.waitFor(() => expect(playSpy).toHaveBeenCalledWith(0));

    // Model a newer playTrack invocation taking ownership while the old
    // transport is suspended inside AudioContext/engine initialization.
    newLoadEpoch();
    setState('playlist.currentQueueItemId', b.queueItemId);
    setState('playback.lifecycle', PLAYBACK_STATE.PLAYING);
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');

    releasePlay();
    await activation;

    expect(
      send.mock.calls.some(
        ([message]) =>
          (message as { type?: string; queueItemId?: QueueItemId }).type === MSG.PLAY &&
          (message as { queueItemId?: QueueItemId }).queueItemId === a.queueItemId,
      ),
    ).toBe(false);
    expect(getManagedTimer('preloadScheduleTimer')).toBeNull();
  });
});

describe('standard operator queue mutation requests', () => {
  function setupOperator(isOp = true): {
    conn: DataConnection;
    send: ReturnType<typeof vi.fn>;
  } {
    const send = vi.fn();
    const conn = { peer: 'operator-1', open: true, send } as unknown as DataConnection;
    setState('network.appRole', 'host');
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    setState('network.connectedPeers', [{ ...makeConnectedPeer(conn.peer, isOp), conn }]);
    initPlaylist();
    return { conn, send };
  }

  it('rebases stable-ID removal over an unrelated revision and deduplicates replay', async () => {
    const { conn, send } = setupOperator();
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    setState('playlist.items', [a, b, c]);
    setState('playlist.currentQueueItemId', a.queueItemId);
    setState('playlist.revision', 9);
    const request = {
      type: MSG.REQUEST_PLAYLIST_REMOVE,
      requestId: nextQueueItemId(),
      baseRevision: 7,
      queueItemIds: [b.queueItemId],
    } as const;

    await handleData(request, conn);
    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([
      a.queueItemId,
      c.queueItemId,
    ]);
    expect(getState('playlist.revision')).toBe(10);

    send.mockClear();
    await handleData(request, conn);
    expect(getState('playlist.revision')).toBe(10);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAYLIST_UPDATE, revision: 10 }),
    );
  });

  it('rebases reorder while both anchors live and rejects a removed anchor', async () => {
    const { conn, send } = setupOperator();
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    const c = fileItem('c.mp3');
    setState('playlist.items', [a, b, c]);
    setState('playlist.revision', 4);

    await handleData(
      {
        type: MSG.REQUEST_PLAYLIST_REORDER,
        requestId: nextQueueItemId(),
        baseRevision: 2,
        queueItemId: c.queueItemId,
        beforeQueueItemId: a.queueItemId,
      },
      conn,
    );
    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([
      c.queueItemId,
      a.queueItemId,
      b.queueItemId,
    ]);
    expect(getState('playlist.revision')).toBe(5);

    send.mockClear();
    await handleData(
      {
        type: MSG.REQUEST_PLAYLIST_REORDER,
        requestId: nextQueueItemId(),
        baseRevision: 5,
        queueItemId: c.queueItemId,
        beforeQueueItemId: a.queueItemId,
      },
      conn,
    );
    expect(getState('playlist.revision')).toBe(5);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.OPERATOR_QUEUE_MUTATION_RESULT,
        phase: 'settled',
        outcome: 'applied',
        revision: 5,
      }),
    );

    send.mockClear();
    await handleData(
      {
        type: MSG.REQUEST_PLAYLIST_REORDER,
        requestId: nextQueueItemId(),
        baseRevision: 5,
        queueItemId: b.queueItemId,
        beforeQueueItemId: nextQueueItemId(),
      },
      conn,
    );
    expect(getState('playlist.revision')).toBe(5);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.PLAYLIST_UPDATE, revision: 5 }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.OPERATOR_QUEUE_MUTATION_RESULT,
        phase: 'settled',
        outcome: 'rejected',
        code: 'invalid-target',
      }),
    );
  });

  it('rejects non-operators, malformed shapes, and replaced connections', async () => {
    const { conn } = setupOperator(false);
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    setState('playlist.items', [a, b]);
    setState('playlist.revision', 3);
    const base = {
      type: MSG.REQUEST_PLAYLIST_REMOVE,
      requestId: nextQueueItemId(),
      baseRevision: 3,
      queueItemIds: [b.queueItemId],
    } as const;

    await handleData(base, conn);
    await handleData({ ...base, requestId: nextQueueItemId(), unexpected: true }, conn);
    const stale = { ...conn, send: vi.fn() } as unknown as DataConnection;
    await handleData({ ...base, requestId: nextQueueItemId() }, stale);

    expect(getState('playlist.items')).toEqual([a, b]);
    expect(getState('playlist.revision')).toBe(3);
  });

  it('sends requests from a standard operator guest without committing locally', () => {
    const send = vi.fn();
    const hostConn = { peer: 'host', open: true, send } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.isOperator', true);
    const a = fileItem('a.mp3');
    const b = fileItem('b.mp3');
    setState('playlist.items', [a, b]);
    setState('playlist.revision', 6);
    initPlaylist();

    bus.emit('playlist:remove-tracks', [b.queueItemId]);
    bus.emit('playlist:reorder-track', b.queueItemId, a.queueItemId, 6);

    expect(getState('playlist.items')).toEqual([a, b]);
    expect(getState('playlist.revision')).toBe(6);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.REQUEST_PLAYLIST_REMOVE,
        baseRevision: 6,
        queueItemIds: [b.queueItemId],
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.REQUEST_PLAYLIST_REORDER,
        baseRevision: 6,
        queueItemId: b.queueItemId,
        beforeQueueItemId: a.queueItemId,
      }),
    );
  });

  it('appends only a fully received supported operator file on the host', () => {
    const { conn } = setupOperator();
    const file = new File(['audio'], 'operator.mp3', { type: 'audio/mpeg' });
    const acknowledge = vi.fn();

    bus.emit('standard-room:operator-file-received', file, acknowledge, conn);

    expect(getState('playlist.items')).toEqual([
      expect.objectContaining({ type: 'file', file, name: 'operator.mp3' }),
    ]);
    expect(getState('playlist.revision')).toBe(1);
    expect(acknowledge).toHaveBeenCalledWith(true);
  });
});

describe('request-setting authorization', () => {
  beforeEach(() => {
    initPlaylist();
  });

  it('lets demo non-operators use only the settings exposed by demo UI', async () => {
    const conn = makeConnection('guest-demo');
    setState('demo.active', true);

    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.VBASS, value: 60 }, conn);
    expect(getState('audio.virtualBass')).toBeCloseTo(0.6);

    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.EXCITER, value: 1 }, conn);
    expect(getState('audio.exciter')).toBe(true);

    await handleData(
      { type: MSG.REQUEST_SETTING, settingType: MSG.STEREO_WIDTH, value: 120 },
      conn,
    );
    expect(getState('audio.stereoWidth')).toBeCloseTo(1.2);

    const beforeDecay = getState('audio.reverbDecay');
    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.REVERB_DECAY, value: 8 }, conn);
    expect(getState('audio.reverbDecay')).toBe(beforeDecay);
  });

  it('still allows operators to apply full request-setting effects', async () => {
    const conn = makeConnection('guest-op');
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    setState('network.connectedPeers', [{ ...makeConnectedPeer(conn.peer, true), conn }]);

    await handleData({ type: MSG.REQUEST_SETTING, settingType: MSG.REVERB_DECAY, value: 8 }, conn);

    expect(getState('audio.reverbDecay')).toBe(8);
  });
});
