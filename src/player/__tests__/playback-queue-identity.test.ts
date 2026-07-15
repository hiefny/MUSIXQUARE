/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { PLAYBACK_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import type {
  ConnectedPeer,
  DataConnection,
  PlaylistItem,
  ResidentFile,
} from '../../types/index.ts';
import { setCurrentAudioBuffer } from '../_state.ts';
import { clearFilePlaybackRuntime } from '../file-playback-runtime.ts';
import { setPlaybackFilePlaying } from '../ownership.ts';
import { publishManagedFilePlaybackSource } from './managed-file-playback-fixture.ts';

const QID_A = '00000000-0000-4000-8000-000000000001';
const QID_B = '00000000-0000-4000-8000-000000000002';
const QID_C = '00000000-0000-4000-8000-000000000003';

const mocks = vi.hoisted(() => ({
  play: vi.fn(),
  pause: vi.fn(),
  finalizeGuestFile: vi.fn(),
  loadPreloadedTrack: vi.fn(),
  readStoredFile: vi.fn(),
  cleanupStoredFile: vi.fn(),
  unicastFile: vi.fn(),
  unicastPreload: vi.fn(),
  sendToHost: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport.ts')>();
  return { ...actual, play: mocks.play, pause: mocks.pause };
});

vi.mock('../decode.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../decode.ts')>();
  return {
    ...actual,
    finalizeGuestFile: mocks.finalizeGuestFile,
    loadPreloadedTrack: mocks.loadPreloadedTrack,
  };
});

vi.mock('../../storage/storage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/storage.ts')>();
  return {
    ...actual,
    readStoredFile: mocks.readStoredFile,
    cleanupStoredFile: mocks.cleanupStoredFile,
  };
});

vi.mock('../../storage/transfer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/transfer.ts')>();
  return { ...actual, unicastFile: mocks.unicastFile };
});

vi.mock('../../storage/preload.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/preload.ts')>();
  return { ...actual, unicastPreload: mocks.unicastPreload };
});

vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  sendToHost: mocks.sendToHost,
  isRemoteGuest: vi.fn(() => false),
}));

const { initPlayback } = await import('../playback.ts');

function item(queueItemId: string, name: string): PlaylistItem {
  return { queueItemId, type: 'file', name, title: name, videoId: null, playlistId: null };
}

function resident(
  queueItemId: string,
  indexHint: number,
  name: string,
  sessionId: number,
): ResidentFile {
  const blob = new File(['audio'], name, { type: 'audio/mpeg' });
  return {
    queueItemId,
    indexHint,
    name,
    sessionId,
    blob,
    mime: blob.type,
    size: blob.size,
  };
}

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  resetInboundRateLimit('host-1');
  setCurrentAudioBuffer(null);
  vi.clearAllMocks();
  mocks.play.mockResolvedValue(undefined);
  mocks.finalizeGuestFile.mockResolvedValue(undefined);
  mocks.loadPreloadedTrack.mockResolvedValue(undefined);
  mocks.unicastFile.mockResolvedValue(undefined);
  mocks.unicastPreload.mockResolvedValue(undefined);
});

describe('PLAY/PAUSE queue identity guards', () => {
  const hostConn = { open: true, peer: 'host-1' } as DataConnection;

  it('accepts an exact managed source without requiring a legacy AudioBuffer', async () => {
    await publishManagedFilePlaybackSource(QID_B);
    try {
      setState('network.hostConn', hostConn);
      setState('playlist.items', [item(QID_A, 'a.flac'), item(QID_B, 'b.flac')]);
      setState('playlist.currentQueueItemId', QID_B);
      setState('files.current', resident(QID_B, 1, 'b.flac', 2));
      setState('playback.lifecycle', PLAYBACK_STATE.READY);
      initPlayback();

      await handleData({ type: 'play', time: 12, queueItemId: QID_B, name: 'b.flac' }, hostConn);

      expect(mocks.play).toHaveBeenCalled();
    } finally {
      await clearFilePlaybackRuntime();
    }
  });

  it('does not accept a managed source owned by another queue occurrence', async () => {
    await publishManagedFilePlaybackSource(QID_A);
    try {
      setState('network.hostConn', hostConn);
      setState('playlist.items', [item(QID_A, 'a.flac'), item(QID_B, 'b.flac')]);
      setState('playlist.currentQueueItemId', QID_B);
      setState('files.current', resident(QID_B, 1, 'b.flac', 2));
      setState('playback.lifecycle', PLAYBACK_STATE.READY);
      initPlayback();

      await handleData({ type: 'play', time: 12, queueItemId: QID_B, name: 'b.flac' }, hostConn);

      expect(mocks.play).not.toHaveBeenCalled();
    } finally {
      await clearFilePlaybackRuntime();
    }
  });

  it('does not replay a decoded buffer owned by another queue occurrence', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.items', [item(QID_A, 'a.mp3'), item(QID_B, 'b.mp3')]);
    setState('playlist.currentQueueItemId', QID_B);
    setState('files.current', resident(QID_A, 0, 'a.mp3', 1));
    setState('playback.lifecycle', PLAYBACK_STATE.READY);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    initPlayback();

    await handleData({ type: 'play', time: 12, queueItemId: QID_B, name: 'b.mp3' }, hostConn);

    expect(mocks.play).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(QID_B);
  });

  it('drops a delayed PAUSE for the previous queue occurrence', async () => {
    setState('network.hostConn', hostConn);
    setState('playlist.items', [item(QID_A, 'a.mp3'), item(QID_B, 'b.mp3')]);
    setState('playlist.currentQueueItemId', QID_B);
    setPlaybackFilePlaying();
    initPlayback();

    await handleData({ type: 'pause', time: 33, queueItemId: QID_A, reason: 'pause' }, hostConn);

    expect(mocks.pause).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(QID_B);
    expect(getState('player.pausedAt')).toBe(0);
  });
});

describe('V2 guest renderer projection', () => {
  it('projects only an exact queue occurrence after physical timeline commit', () => {
    const visualizer = vi.fn();
    const uiLoop = vi.fn();
    bus.on('visualizer:start', visualizer);
    bus.on('ui:loop-start', uiLoop);
    setState('playlist.items', [item(QID_A, 'a.flac'), item(QID_B, 'b.flac')]);
    initPlayback();

    bus.emit('player:v2-guest-timeline-rendered', QID_B, 'playing', 12.5);

    expect(getState('playlist.currentQueueItemId')).toBe(QID_B);
    expect(getState('player.currentTrackMeta')).toMatchObject({
      queueItemId: QID_B,
      name: 'b.flac',
      title: 'b.flac',
    });
    expect(getState('player.pausedAt')).toBe(12.5);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.PLAYING);
    expect(getState('playback.mode')).toBe('file');
    expect(visualizer).toHaveBeenCalledOnce();
    expect(uiLoop).toHaveBeenCalledOnce();

    bus.emit('player:v2-guest-timeline-rendered', QID_B, 'paused', 18);
    expect(getState('player.pausedAt')).toBe(18);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.PAUSED);

    bus.emit('player:v2-guest-timeline-rendered', null, 'stopped', 0);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('playback.mode')).toBeNull();
    expect(getState('player.pausedAt')).toBe(0);
    // Selection is playlist navigation state, not renderer ownership.
    expect(getState('playlist.currentQueueItemId')).toBe(QID_B);
  });

  it('ignores unknown queue IDs and malformed positions', () => {
    setState('playlist.items', [item(QID_A, 'a.flac')]);
    setState('playlist.currentQueueItemId', QID_A);
    initPlayback();

    bus.emit('player:v2-guest-timeline-rendered', QID_B, 'playing', 4);
    bus.emit('player:v2-guest-timeline-rendered', QID_A, 'playing', Number.NaN);

    expect(getState('playlist.currentQueueItemId')).toBe(QID_A);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
  });
});

describe('operator request queue identity guards', () => {
  it('drops delayed play, pause, seek, and skip requests for a previous occurrence', async () => {
    const opConn = { open: true, peer: 'op-1' } as DataConnection;
    const current = resident(QID_B, 1, 'b.mp3', 5);
    const peer: ConnectedPeer = {
      id: 'op-1',
      slot: 1,
      label: 'Operator',
      conn: opConn,
      isOp: true,
      preloadedQueueItemIds: new Set(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: 0,
    };
    setState('network.connectedPeers', [peer]);
    setState('playlist.items', [item(QID_A, 'a.mp3'), item(QID_B, 'b.mp3')]);
    setState('playlist.currentQueueItemId', QID_B);
    setState('files.current', current);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    setPlaybackFilePlaying();
    initPlayback();

    await handleData({ type: 'request-play', time: 4, queueItemId: QID_A }, opConn);
    await handleData({ type: 'request-pause', queueItemId: QID_A }, opConn);
    await handleData({ type: 'request-seek', time: 20, queueItemId: QID_A }, opConn);
    await handleData({ type: 'request-skip-time', sec: 10, queueItemId: QID_A }, opConn);

    expect(mocks.play).not.toHaveBeenCalled();
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(getState('playlist.currentQueueItemId')).toBe(QID_B);
  });
});

describe('storage completion identity', () => {
  const hostConn = { open: true, peer: 'host-1' } as DataConnection;

  function arrangeTransfer(): File {
    const file = new File(['audio'], 'b.mp3', { type: 'audio/mpeg' });
    setState('network.hostConn', hostConn);
    setState('playlist.items', [item(QID_A, 'a.mp3'), item(QID_B, 'b.mp3')]);
    setState('playlist.currentQueueItemId', QID_B);
    setState('transfer.localSessionId', 7);
    setState('transfer.meta', {
      name: 'b.mp3',
      type: 'file',
      queueItemId: QID_B,
      indexHint: 1,
      size: file.size,
      mime: file.type,
      sessionId: 7,
      total: 1,
    });
    setState('playback.lifecycle', PLAYBACK_STATE.DOWNLOADING);
    mocks.readStoredFile.mockResolvedValue(file);
    initPlayback();
    return file;
  }

  it('finalizes only the exact queue item and session from file-ready', async () => {
    const file = arrangeTransfer();

    bus.emit('storage:file-ready', 'b.mp3', 7, false, QID_B);

    await vi.waitFor(() => {
      expect(mocks.finalizeGuestFile).toHaveBeenCalledWith(file, QID_B, 7);
    });
    expect(mocks.readStoredFile).toHaveBeenCalledWith(QID_B, 'b.mp3', false, 7);
  });

  it('drops a file-ready completion for a superseded session', async () => {
    arrangeTransfer();

    bus.emit('storage:file-ready', 'b.mp3', 6, false, QID_B);
    await Promise.resolve();

    expect(mocks.readStoredFile).not.toHaveBeenCalled();
    expect(mocks.finalizeGuestFile).not.toHaveBeenCalled();
  });
});

describe('preload and late-join resident identity', () => {
  it('activates only a preload resident with the requested queue identity', async () => {
    const ready = resident(QID_B, 1, 'b.mp3', 9);
    setState('playlist.items', [item(QID_A, 'a.mp3'), item(QID_B, 'b.mp3')]);
    setState('playlist.currentQueueItemId', QID_B);
    setState('preload.ready', ready);
    initPlayback();

    bus.emit('storage:use-preloaded', QID_B, 'b.mp3', 9);

    await vi.waitFor(() => {
      expect(mocks.loadPreloadedTrack).toHaveBeenCalledWith(QID_B, expect.any(Number));
    });
  });

  it('unicasts current and preload residents with their own queue IDs', async () => {
    const conn = { open: true, peer: 'guest-1' } as DataConnection;
    const current = resident(QID_B, 1, 'b.mp3', 11);
    const ready = resident(QID_C, 2, 'c.mp3', 12);
    const peer: ConnectedPeer = {
      id: 'guest-1',
      slot: 1,
      label: 'Guest 1',
      conn,
      isOp: false,
      preloadedQueueItemIds: new Set(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: 0,
    };
    setState('playlist.items', [item(QID_A, 'a.mp3'), item(QID_B, 'b.mp3'), item(QID_C, 'c.mp3')]);
    setState('playlist.currentQueueItemId', QID_B);
    setState('files.current', current);
    setState('preload.ready', ready);
    setState('network.connectedPeers', [peer]);
    initPlayback();

    bus.emit('orchestrator:peer-joined', 'guest-1');

    await vi.waitFor(() => {
      expect(mocks.unicastFile).toHaveBeenCalled();
      expect(mocks.unicastPreload).toHaveBeenCalledWith(conn, ready.blob, QID_C, 12);
    });
    expect(mocks.unicastFile).toHaveBeenCalledWith(
      conn,
      current.blob,
      0,
      11,
      expect.objectContaining({ queueItemId: QID_B }),
    );
  });
});
