/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { DEMO_TRACK } from '../../demo/tracks.ts';
import { handleData } from '../../network/protocol.ts';
import {
  getCurrentLoadEpoch,
  getPendingPlayTime,
  newLoadEpoch,
  setCurrentAudioBuffer,
  setPendingPlayTime,
} from '../_state.ts';
import { broadcastFileDebounced } from '../../storage/transfer.ts';
import type {
  ConnectedPeer,
  DataConnection,
  FileMeta,
  PlaylistItem,
  QueueItemId,
  ResidentFile,
} from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastSystemNotice: vi.fn(),
  decodeAudioData: vi.fn(),
  isFilePipelineBusyForPlay: vi.fn(() => false),
  sendRecoveryRequest: vi.fn(),
  safeSend: vi.fn(() => true),
  sendToHost: vi.fn(),
  stopAllMedia: vi.fn(),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(),
}));

vi.mock('../../audio/context.ts', () => ({
  ensureRunning: vi.fn(),
  getAudioContext: vi.fn(() => ({
    state: 'running',
    decodeAudioData: mocks.decodeAudioData,
  })),
}));

vi.mock('../../audio/system-capture.ts', () => ({
  isSystemAudioActive: vi.fn(() => false),
}));

vi.mock('../../storage/storage.ts', () => ({
  cleanupStoredFile: vi.fn(),
  discardResidentStoredFileAdmission: vi.fn(() => false),
  postCommand: vi.fn(),
  promoteStoredFileAdmission: vi.fn(() => false),
  retainStoredFileAdmission: vi.fn(() => false),
}));

vi.mock('../../storage/transfer.ts', () => ({
  broadcastFileDebounced: vi.fn(),
}));

vi.mock('../../share/remote-share.ts', () => ({
  shareRemoteFileIfNeeded: vi.fn(),
}));

vi.mock('../../storage/preload.ts', () => ({
  schedulePreload: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  safeSend: mocks.safeSend,
  sendToHost: mocks.sendToHost,
}));

vi.mock('../../storage/recovery.ts', () => ({
  sendRecoveryRequest: mocks.sendRecoveryRequest,
}));

vi.mock('../../chat/protocol.ts', () => ({
  broadcastSystemNotice: mocks.broadcastSystemNotice,
}));

vi.mock('../../ui/toast.ts', () => ({
  showLoader: mocks.showLoader,
  showToast: mocks.showToast,
}));

vi.mock('../transport.ts', () => ({
  isFilePipelineBusyForPlay: mocks.isFilePipelineBusyForPlay,
  play: vi.fn(),
  stopAllMedia: mocks.stopAllMedia,
  stopPlayerNode: vi.fn(),
}));

vi.mock('../lifecycle.ts', () => ({
  transition: mocks.transition,
}));

vi.mock('../video.ts', () => ({
  setEngineMode: vi.fn(),
}));

function makeConnection(peer: string, send = vi.fn()): DataConnection {
  return { peer, open: true, send } as DataConnection;
}

function expectCorrelatedRequest(
  send: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
): void {
  expect(send).toHaveBeenCalledWith({
    ...expected,
    requestId: expect.any(Number),
  });
  const matchingCall = send.mock.calls.find(([message]) =>
    Object.entries(expected).every(
      ([key, value]) => (message as Record<string, unknown> | undefined)?.[key] === value,
    ),
  );
  const requestId = (matchingCall?.[0] as { requestId?: unknown } | undefined)?.requestId;
  expect(requestId).toEqual(expect.any(Number));
  expect(requestId as number).toBeGreaterThan(0);
}

function makeConnectedPeer(id: string, isOp: boolean): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: makeConnection(id),
    isOp,
    preloadedQueueItemIds: new Set<QueueItemId>(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: Date.now(),
  };
}

let nextQueueItemIdValue = 1;
function nextQueueItemId(): QueueItemId {
  const suffix = String(nextQueueItemIdValue++).padStart(12, '0');
  return `00000000-0000-4000-8000-${suffix}`;
}

function makeTrack(name: string): PlaylistItem {
  return {
    queueItemId: nextQueueItemId(),
    type: 'file',
    name,
    videoId: null,
    playlistId: null,
  };
}

function makeFileTrack(file: File): PlaylistItem {
  return {
    queueItemId: nextQueueItemId(),
    type: 'file',
    name: file.name,
    title: file.name,
    file,
    videoId: null,
    playlistId: null,
  };
}

function setCurrentIndex(index: number): QueueItemId | null {
  const queueItemId = getState('playlist.items')[index]?.queueItemId ?? null;
  setState('playlist.currentQueueItemId', queueItemId);
  return queueItemId;
}

function currentQueueItemId(): QueueItemId {
  const queueItemId = getState('playlist.currentQueueItemId');
  if (!queueItemId) throw new Error('test queue item is not selected');
  return queueItemId;
}

function fileMeta(item: PlaylistItem, file: Blob, sessionId: number): FileMeta {
  const mime = file.type || 'audio/mpeg';
  return {
    queueItemId: item.queueItemId,
    indexHint: getState('playlist.items').findIndex(
      (candidate) => candidate.queueItemId === item.queueItemId,
    ),
    name: item.name,
    type: mime,
    mime,
    size: file.size,
    total: 1,
    sessionId,
  };
}

function stagePreload(item: PlaylistItem, file: File, sessionId = 7): ResidentFile {
  const meta = fileMeta(item, file, sessionId);
  const ready: ResidentFile = { ...meta, blob: file };
  setState('preload.nextQueueItemId', item.queueItemId);
  setState('preload.activeTarget', meta);
  setState('preload.ready', ready);
  return ready;
}

function stageMainTransfer(item: PlaylistItem, file: Blob, sessionId: number): void {
  setState('transfer.localSessionId', sessionId);
  setState('transfer.meta', fileMeta(item, file, sessionId));
}

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('guest decode failure reports', () => {
  beforeEach(async () => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.decodeAudioData.mockResolvedValue({ duration: 120 });

    const { initDecodeHandlers } = await import('../decode.ts');
    initDecodeHandlers();
    setState('playlist.items', [makeTrack('song.mp3')]);
    setCurrentIndex(0);
  });

  it('keeps the only non-operator report local instead of advancing the room', async () => {
    const guest = makeConnectedPeer('guest-a', false);
    setState('network.connectedPeers', [guest]);

    await handleData(
      { type: MSG.GUEST_DECODE_FAILED, queueItemId: currentQueueItemId() },
      guest.conn!,
    );

    expect(mocks.broadcastSystemNotice).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(
      'A device failed to decode this track. Playback is continuing for everyone else.',
    );
    expect(getState('playback.failedTrackKeys').size).toBe(0);
  });

  it('forwards held non-operator decode failure notices to connected operators only', async () => {
    const guest = makeConnectedPeer('guest-a', false);
    const op = makeConnectedPeer('guest-op', true);
    setState('network.connectedPeers', [guest, op]);

    await handleData(
      { type: MSG.GUEST_DECODE_FAILED, queueItemId: currentQueueItemId() },
      guest.conn!,
    );

    expect(mocks.safeSend).toHaveBeenCalledWith(op.conn, {
      type: MSG.OPERATOR_TOAST,
      text: 'A device failed to decode this track. Playback is continuing for everyone else.',
      i18nKey: 'toast.remote_decode_device_wait',
    });
    expect(mocks.safeSend).not.toHaveBeenCalledWith(guest.conn, expect.anything());
  });

  it('does not let one non-operator skip when another non-operator is connected', async () => {
    const guestA = makeConnectedPeer('guest-a', false);
    const guestB = makeConnectedPeer('guest-b', false);
    setState('network.connectedPeers', [guestA, guestB]);

    await handleData(
      { type: MSG.GUEST_DECODE_FAILED, queueItemId: currentQueueItemId() },
      guestA.conn!,
    );

    expect(mocks.broadcastSystemNotice).not.toHaveBeenCalled();
    expect(getState('playback.failedTrackKeys').size).toBe(0);
  });

  it('advances after two connected non-operator reports for the same track', async () => {
    const guestA = makeConnectedPeer('guest-a', false);
    const guestB = makeConnectedPeer('guest-b', false);
    setState('network.connectedPeers', [guestA, guestB]);

    await handleData(
      { type: MSG.GUEST_DECODE_FAILED, queueItemId: currentQueueItemId() },
      guestA.conn!,
    );
    await handleData(
      { type: MSG.GUEST_DECODE_FAILED, queueItemId: currentQueueItemId() },
      guestB.conn!,
    );

    expect(mocks.broadcastSystemNotice).toHaveBeenCalledOnce();
  });

  it('still lets an operator report advance immediately', async () => {
    const op = makeConnectedPeer('guest-op', true);
    setState('network.connectedPeers', [op]);
    setState('network.activeHostConnByPeerId', new Map([[op.id, op.conn!]]));

    await handleData(
      { type: MSG.GUEST_DECODE_FAILED, queueItemId: currentQueueItemId() },
      op.conn!,
    );

    expect(mocks.broadcastSystemNotice).toHaveBeenCalledOnce();
  });

  it('shows a local wait notice when guest decoding gives up', async () => {
    mocks.decodeAudioData.mockRejectedValue(new Error('decode failed'));
    setState('network.hostConn', makeConnection('host'));
    setState('player.decodeFailureCount', 1);
    const item = getState('playlist.items')[0]!;
    const file = new File([new Uint8Array([1, 2, 3])], 'song.mp3');
    stageMainTransfer(item, file, 7);

    const { finalizeGuestFile } = await import('../decode.ts');
    await finalizeGuestFile(file, item.queueItemId, 7);

    expect(mocks.showToast).toHaveBeenCalledWith(
      "This device couldn't decode the track.\nPlease wait for the next track.",
    );
    expect(mocks.sendToHost).toHaveBeenCalledWith({
      type: MSG.GUEST_DECODE_FAILED,
      queueItemId: item.queueItemId,
    });
    expect(mocks.sendRecoveryRequest).not.toHaveBeenCalled();
  });
});

describe('guest file finalization sync', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:guest-file'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    mocks.decodeAudioData.mockResolvedValue({ duration: 120 });
  });

  it('treats a user file matching a demo filename as ordinary audio without time wrapping', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T00:00:05.000Z'));

    const hostConn = makeConnection('host-1');
    setState('network.hostConn', hostConn);
    setState('playlist.items', [makeTrack(DEMO_TRACK.fileName)]);
    setCurrentIndex(0);
    const item = getState('playlist.items')[0]!;
    const file = new File([new Uint8Array([1, 2, 3])], DEMO_TRACK.fileName, {
      type: DEMO_TRACK.mime,
    });
    stageMainTransfer(item, file, 7);
    setPendingPlayTime(118, Date.now() - 5_000);

    const syncRequest = vi.fn();
    bus.on('sync:request-immediate-ping', syncRequest);

    const { finalizeGuestFile } = await import('../decode.ts');
    const { play } = await import('../transport.ts');
    await finalizeGuestFile(file, item.queueItemId, 7);

    expect(play).toHaveBeenCalledWith(123);
    expect(getPendingPlayTime()).toBeUndefined();
    expect(syncRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    expect(syncRequest).toHaveBeenCalledOnce();
  });

  it('a superseded finalize (new transfer session mid-decode) is inert in the catch — no wrong-track report (pin j reject twin)', async () => {
    setState('network.hostConn', makeConnection('host'));
    setState('playlist.items', [makeTrack('A.mp3')]);
    setCurrentIndex(0);
    const item = getState('playlist.items')[0]!;
    const file = new File([new Uint8Array([1, 2, 3])], 'A.mp3');
    stageMainTransfer(item, file, 1);
    setState('player.decodeFailureCount', 0);
    setState('transfer.receivedCount', 7);

    // FILE_PREPARE starts a replacement transfer during decode without bumping
    // activeLoadSessionId. The transfer-session checkpoint must make the stale
    // catch inert so it cannot change successor state or report the wrong track.
    mocks.decodeAudioData.mockImplementation(async () => {
      setState('transfer.localSessionId', 2);
      throw new Error('decode failed');
    });

    const { finalizeGuestFile } = await import('../decode.ts');
    await finalizeGuestFile(file, item.queueItemId, 1);

    expect(mocks.sendToHost).not.toHaveBeenCalled(); // no GUEST_DECODE_FAILED wrong-track report
    expect(mocks.transition).not.toHaveBeenCalled(); // no DECODE_ERROR stomp on the successor's FSM
    expect(mocks.sendRecoveryRequest).not.toHaveBeenCalled();
    expect(getState('player.decodeFailureCount')).toBe(0); // counter untouched
    expect(getState('transfer.receivedCount')).toBe(7); // successor transfer state untouched
    expect(mocks.showLoader).toHaveBeenLastCalledWith(false); // finally still runs
  });
});

describe('host preload activation result (SA-05)', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preload'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('returns false on decode failure and routes the host into failed-mark cleanup', async () => {
    mocks.decodeAudioData.mockRejectedValue(new Error('unsupported codec'));
    const file = new File([new Uint8Array([1, 2, 3])], 'broken.mp3', {
      type: 'audio/mpeg',
      lastModified: 123,
    });
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    stagePreload(item, file);

    const { loadPreloadedTrack } = await import('../decode.ts');
    const activated = await loadPreloadedTrack(item.queueItemId);

    expect(activated).toBe(false);
    // Host must not fall into the guest-only recovery request (no-op on host)
    expect(mocks.sendToHost).not.toHaveBeenCalled();
    // Single broken track → all-failed terminal reset, mirrored to guests
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 0,
      queueItemId: null,
      endOfPlaylist: true,
      reason: 'end-of-playlist',
    });
    expect(getState('playlist.currentQueueItemId')).toBeNull();
  });

  it('returns true when activation succeeds', async () => {
    mocks.decodeAudioData.mockResolvedValue({ duration: 120 });
    const file = new File([new Uint8Array([1, 2, 3])], 'ok.mp3', {
      type: 'audio/mpeg',
      lastModified: 123,
    });
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    stagePreload(item, file);

    const { loadPreloadedTrack } = await import('../decode.ts');
    const activated = await loadPreloadedTrack(item.queueItemId);

    expect(activated).toBe(true);
    expect(getState('preload.ready')).toBeNull();
    expect(getState('files.current')?.blob).toBe(file);
  });

  it('returns false when no preloaded blob exists', async () => {
    const item = makeTrack('missing.mp3');
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    const { loadPreloadedTrack } = await import('../decode.ts');
    expect(await loadPreloadedTrack(item.queueItemId)).toBe(false);
  });

  it('rejects a same-name Blob whose metadata belongs to another index', async () => {
    const staleBlob = new File([new Uint8Array([1, 2, 3])], 'same.mp3', {
      type: 'audio/mpeg',
    });
    const exactHostSend = vi.fn();
    setState('network.hostConn', makeConnection('host', exactHostSend));
    const first = makeTrack('same.mp3');
    const second = makeTrack('same.mp3');
    setState('playlist.items', [first, second]);
    stagePreload(first, staleBlob);
    setCurrentIndex(1);

    const { loadPreloadedTrack } = await import('../decode.ts');
    await expect(loadPreloadedTrack(second.queueItemId)).resolves.toBe(false);

    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
    expectCorrelatedRequest(exactHostSend, {
      type: MSG.REQUEST_CURRENT_FILE,
      queueItemId: second.queueItemId,
      name: 'same.mp3',
      reason: 'preload_resident_missing',
    });
    expect(getState('preload.ready')?.queueItemId).toBe(first.queueItemId);
  });

  it('rejects a same-index Blob that is not the host playlist File object', async () => {
    const cachedA = new File([new Uint8Array([1])], 'same.mp3', { type: 'audio/mpeg' });
    const playlistB = new File([new Uint8Array([2])], 'same.mp3', { type: 'audio/mpeg' });
    const item = makeFileTrack(playlistB);
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    stagePreload(item, cachedA);

    const { loadPreloadedTrack } = await import('../decode.ts');
    await expect(loadPreloadedTrack(item.queueItemId)).resolves.toBe(false);

    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
    expect(getState('preload.ready')).toBeNull();
  });

  it('rejects coercible or missing preload session identity before decode', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'strict.mp3', {
      type: 'audio/mpeg',
    });
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    const ready = stagePreload(item, file);
    setState('preload.ready', {
      ...ready,
      sessionId: '7' as unknown as number,
    });

    const { loadPreloadedTrack } = await import('../decode.ts');
    await expect(loadPreloadedTrack(item.queueItemId)).resolves.toBe(false);

    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
  });

  it('discards a same-Blob activation when its live session changes during decode', async () => {
    let resolveDecode: (value: AudioBuffer) => void = () => undefined;
    mocks.decodeAudioData.mockReturnValueOnce(
      new Promise<AudioBuffer>((resolve) => {
        resolveDecode = resolve;
      }),
    );
    const file = new File([new Uint8Array([1, 2, 3])], 'session.mp3', {
      type: 'audio/mpeg',
    });
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    const ready = stagePreload(item, file);

    const { loadPreloadedTrack } = await import('../decode.ts');
    const pending = loadPreloadedTrack(item.queueItemId);
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledOnce());

    setState('preload.ready', { ...ready, sessionId: 8 });
    setState('preload.activeTarget', { ...ready, sessionId: 8 });
    resolveDecode({ duration: 120 } as AudioBuffer);

    await expect(pending).resolves.toBe(false);
    expect(getState('files.current')).toBeNull();
  });
});

describe('guest preload activation failure recovery', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:guest-preload'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  function stageGuestPreload(file: File): {
    item: PlaylistItem;
    exactHostSend: ReturnType<typeof vi.fn>;
  } {
    const exactHostSend = vi.fn();
    setState('network.hostConn', makeConnection('host', exactHostSend));
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    stagePreload(item, file);
    setState('transfer.meta', fileMeta(item, file, 7));
    return { item, exactHostSend };
  }

  it('requests the current file again after the first live guest preload decode failure', async () => {
    mocks.decodeAudioData.mockRejectedValue(new Error('partial blob'));
    const file = new File([new Uint8Array([1, 2, 3])], 'retry-me.mp3', {
      type: 'audio/mpeg',
      lastModified: 123,
    });
    const { item, exactHostSend } = stageGuestPreload(file);

    const { loadPreloadedTrack } = await import('../decode.ts');
    const activated = await loadPreloadedTrack(item.queueItemId);

    expect(activated).toBe(false);
    expect(mocks.transition).toHaveBeenCalledWith({ type: 'DECODE_ERROR' });
    expect(getState('player.decodeFailureCount')).toBe(1);
    expectCorrelatedRequest(exactHostSend, {
      type: MSG.REQUEST_CURRENT_FILE,
      queueItemId: item.queueItemId,
      name: 'retry-me.mp3',
      reason: 'preload_activation_failed',
    });
  });

  it('bounds repeated live guest preload decode failures instead of re-requesting forever', async () => {
    mocks.decodeAudioData.mockRejectedValue(new Error('persistent codec failure'));
    const file = new File([new Uint8Array([1, 2, 3])], 'broken-remote.mp3', {
      type: 'audio/mpeg',
      lastModified: 123,
    });
    const { item, exactHostSend } = stageGuestPreload(file);
    setState('player.decodeFailureCount', 1);

    const { loadPreloadedTrack } = await import('../decode.ts');
    const activated = await loadPreloadedTrack(item.queueItemId);

    expect(activated).toBe(false);
    expect(getState('player.decodeFailureCount')).toBe(2);
    expect(getState('playback.failedTrackKeys').size).toBe(1);
    expect(exactHostSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );
    expect(mocks.sendToHost).toHaveBeenCalledWith({
      type: MSG.GUEST_DECODE_FAILED,
      queueItemId: item.queueItemId,
    });
  });
});

describe('admission-bound resident handoff', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.decodeAudioData.mockResolvedValue({ duration: 1 } as AudioBuffer);
  });

  it('does not publish a received preload when exact promotion fails', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'bound-preload.mp3');
    const { bindEncodedReceiveReservationToBlob, reserveEncodedReceiveMemoryWithinBudget } =
      await import('../decode-admission.ts');
    const receive = reserveEncodedReceiveMemoryWithinBudget(file.size);
    receive.markFinalized();
    bindEncodedReceiveReservationToBlob(file, receive.id);
    try {
      const item = makeFileTrack(file);
      setState('playlist.items', [item]);
      setCurrentIndex(0);
      stagePreload(item, file);

      const { loadPreloadedTrack } = await import('../decode.ts');
      await expect(loadPreloadedTrack(item.queueItemId)).resolves.toBe(false);
      expect(getState('files.current')).toBeNull();
    } finally {
      receive.release();
    }
  });

  it('does not publish a received main file when resident retain fails', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'bound-main.mp3');
    const { bindEncodedReceiveReservationToBlob, reserveEncodedReceiveMemoryWithinBudget } =
      await import('../decode-admission.ts');
    const receive = reserveEncodedReceiveMemoryWithinBudget(file.size);
    receive.markFinalized();
    bindEncodedReceiveReservationToBlob(file, receive.id);
    try {
      setState('network.hostConn', makeConnection('host'));
      const item = makeFileTrack(file);
      setState('playlist.items', [item]);
      setCurrentIndex(0);
      stageMainTransfer(item, file, 7);

      const { finalizeGuestFile } = await import('../decode.ts');
      await finalizeGuestFile(file, item.queueItemId, 7);
      expect(getState('files.current')).toBeNull();
      expect(mocks.transition).toHaveBeenCalledWith({ type: 'DECODE_ERROR' });
    } finally {
      receive.release();
    }
  });
});

describe('host decode failure cleanup', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.decodeAudioData.mockRejectedValue(new Error('unsupported codec'));
  });

  it('returns to an empty player title state when the only track cannot decode', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'broken.mp3', {
      type: 'audio/mpeg',
      lastModified: 123,
    });
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    setState('player.currentTrackMeta', item);

    const { loadAndBroadcastFile } = await import('../decode.ts');
    const didLoad = await loadAndBroadcastFile(file, item.queueItemId, 1);

    expect(didLoad).toBe(false);
    expect(getState('player.currentTrackMeta')).toBeNull();
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 0,
      queueItemId: null,
      endOfPlaylist: true,
      reason: 'end-of-playlist',
    });
  });
});

describe('RAM admission integration', () => {
  let originalUserAgent: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.decodeAudioData.mockReset();
    setCurrentAudioBuffer(null);
    originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone) jsdom',
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:admission'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    if (originalUserAgent) {
      Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    } else {
      Reflect.deleteProperty(navigator, 'userAgent');
    }
  });

  it('rejects an unsafe local file before allocating its ArrayBuffer', async () => {
    // jsdom has no metadata decoder, so the fail-closed 64× expansion applies.
    const file = new File([new Uint8Array(4 * 1024 * 1024)], 'unknown-duration.mp3', {
      type: 'audio/mpeg',
    });
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer');
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);

    const { loadAndBroadcastFile } = await import('../decode.ts');
    await expect(loadAndBroadcastFile(file, item.queueItemId, 1)).resolves.toBe(false);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
  });

  it('applies the same pre-decode admission to a received remote Blob', async () => {
    const blob = new Blob([new Uint8Array(4 * 1024 * 1024)], { type: 'audio/mpeg' });
    const arrayBuffer = vi.spyOn(blob, 'arrayBuffer');
    setState('network.hostConn', makeConnection('host'));
    const item = makeTrack('remote.mp3');
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    stageMainTransfer(item, blob, 9);

    const { finalizeGuestFile } = await import('../decode.ts');
    await finalizeGuestFile(blob, item.queueItemId, 9);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
    expect(mocks.sendToHost).toHaveBeenCalledWith({
      type: MSG.GUEST_DECODE_FAILED,
      queueItemId: item.queueItemId,
    });
  });

  it('reports a preload activation memory rejection instead of re-requesting forever', async () => {
    const file = new File([new Uint8Array(4 * 1024 * 1024)], 'remote-preload.mp3', {
      type: 'audio/mpeg',
    });
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer');
    const exactHostSend = vi.fn();
    setState('network.hostConn', makeConnection('host', exactHostSend));
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    stagePreload(item, file);
    setState('transfer.meta', fileMeta(item, file, 7));

    const { loadPreloadedTrack } = await import('../decode.ts');
    await expect(loadPreloadedTrack(item.queueItemId)).resolves.toBe(false);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.sendToHost).toHaveBeenCalledWith({
      type: MSG.GUEST_DECODE_FAILED,
      queueItemId: item.queueItemId,
    });
    expect(exactHostSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.REQUEST_CURRENT_FILE }),
    );
  });
});

describe('native decoder deadline policy', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:slow-decode'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('broadcasts and R2-shares a user file whose name matches a bundled demo asset', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], DEMO_TRACK.fileName, {
      type: DEMO_TRACK.mime,
    });
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);
    setState('network.connectedPeers', [makeConnectedPeer('remote-guest', false)]);
    mocks.decodeAudioData.mockResolvedValue({ duration: 120 });

    const { loadAndBroadcastFile } = await import('../decode.ts');
    const { shareRemoteFileIfNeeded } = await import('../../share/remote-share.ts');
    await expect(loadAndBroadcastFile(file, item.queueItemId, 7)).resolves.toBe(true);

    expect(vi.mocked(broadcastFileDebounced)).toHaveBeenCalledWith(
      file,
      item.queueItemId,
      7,
      undefined,
    );
    expect(vi.mocked(shareRemoteFileIfNeeded)).toHaveBeenCalledWith(file, 7, undefined, {
      queueItemId: item.queueItemId,
    });
  });

  it('does not abandon a healthy native decode at the former 10-second deadline', async () => {
    vi.useFakeTimers();
    const file = new File([new Uint8Array([1, 2, 3])], 'slow-lossless.flac', {
      type: 'audio/flac',
    });
    const item = makeFileTrack(file);
    setState('playlist.items', [item]);
    setCurrentIndex(0);

    let resolveDecode!: (buffer: AudioBuffer) => void;
    const nativeDecode = new Promise<AudioBuffer>((resolve) => {
      resolveDecode = resolve;
    });
    mocks.decodeAudioData.mockReturnValue(nativeDecode);

    const { loadAndBroadcastFile } = await import('../decode.ts');
    let settled = false;
    const result = loadAndBroadcastFile(file, item.queueItemId, 1).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.decodeAudioData).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    resolveDecode({ duration: 120 } as AudioBuffer);
    await expect(result).resolves.toBe(true);
  });
});

// Superseded host loads are inert on both success and failure. Neither path may
// publish, fail, auto-advance, or restore a track after playlist teardown.
describe('superseded host load is inert (rapid-click / remove-track supersession)', () => {
  function deferredDecode(): {
    promise: Promise<{ duration: number }>;
    resolve: (v: { duration: number }) => void;
    reject: (e: unknown) => void;
  } {
    let resolve!: (v: { duration: number }) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<{ duration: number }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    // A pre-decode ownership abort intentionally leaves one-shot decoder
    // implementations unconsumed, so reset the queue between cases.
    mocks.decodeAudioData.mockReset();
  });

  it('a load resolving after an epoch bump publishes nothing and leaves the play button alone', async () => {
    const fileA = new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: 'audio/mpeg' });
    const itemA = makeFileTrack(fileA);
    setState('playlist.items', [itemA]);
    setCurrentIndex(0);
    setState('network.connectedPeers', [makeConnectedPeer('guest-a', false)]);

    const decodeA = deferredDecode();
    mocks.decodeAudioData.mockImplementationOnce(() => decodeA.promise);

    const btnEvents: boolean[] = [];
    bus.on('ui:play-btn-state', (on) => btnEvents.push(on));

    const { loadAndBroadcastFile } = await import('../decode.ts');
    const p = loadAndBroadcastFile(fileA, itemA.queueItemId, 1, getCurrentLoadEpoch());

    // Playlist-empty teardown shape: epoch bump with NO successor load.
    newLoadEpoch();
    setState('playlist.currentQueueItemId', null);

    decodeA.resolve({ duration: 120 });
    expect(await p).toBe(false);

    expect(mocks.decodeAudioData).not.toHaveBeenCalled();
    expect(getState('files.current')).toBeNull(); // no resurrection publish
    expect(vi.mocked(broadcastFileDebounced)).not.toHaveBeenCalled(); // no FILE_START(-1) to guests
    expect(btnEvents).not.toContain(true); // soft-disable survives the finally
  });

  it('a superseded load failing late does not clobber the successor or auto-advance the room', async () => {
    vi.useFakeTimers();
    const fileA = new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: 'audio/mpeg' });
    const fileB = new File([new Uint8Array([4, 5, 6])], 'b.mp3', { type: 'audio/mpeg' });
    const fileC = new File([new Uint8Array([7, 8, 9])], 'c.mp3', { type: 'audio/mpeg' });
    const itemA = makeFileTrack(fileA);
    const itemB = makeFileTrack(fileB);
    const itemC = makeFileTrack(fileC);
    setState('playlist.items', [itemA, itemB, itemC]);
    setCurrentIndex(0);

    const decodeA = deferredDecode();
    mocks.decodeAudioData
      .mockImplementationOnce(() => decodeA.promise) // A wedges in its decode
      .mockResolvedValueOnce({ duration: 120 }); // B decodes cleanly

    const { loadAndBroadcastFile } = await import('../decode.ts');
    const pA = loadAndBroadcastFile(fileA, itemA.queueItemId, 1, getCurrentLoadEpoch());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.decodeAudioData).toHaveBeenCalledTimes(1);

    // User clicks B while A is still decoding (playTrack shape: new epoch,
    // new index, new load).
    const epochB = newLoadEpoch();
    setCurrentIndex(1);
    const pB = loadAndBroadcastFile(fileB, itemB.queueItemId, 2, epochB);
    expect(await pB).toBe(true);
    expect(getState('files.current')?.blob).toBe(fileB);

    mocks.transition.mockClear();
    decodeA.reject(new Error('unsupported codec'));
    expect(await pA).toBe(false);

    // The stale failure must be fully inert:
    expect(getState('files.current')?.blob).toBe(fileB); // B's published blob survives
    expect(mocks.broadcastSystemNotice).not.toHaveBeenCalled(); // no room-wide skip notice
    expect(mocks.transition).not.toHaveBeenCalled(); // no DECODE_ERROR stomp on B's FSM

    // ...and no decode-fail-advance hijack: 700ms later the room is still on B.
    await vi.advanceTimersByTimeAsync(700);
    expect(getState('playlist.currentQueueItemId')).toBe(itemB.queueItemId);
  });

  it('starts a superseding decode immediately when both native leases fit together', async () => {
    const makeProjectedFile = (name: string): File => {
      const file = new File([new Uint8Array([1])], name, { type: 'audio/mpeg' });
      // Unknown-duration desktop admission projects each 4 MiB file to a
      // 264 MiB decode footprint. Two fit the 768 MiB standard budget, while
      // counting A's global lease twice would falsely project 792 MiB.
      Object.defineProperty(file, 'size', { configurable: true, value: 4 * 1024 * 1024 });
      vi.spyOn(file, 'arrayBuffer').mockResolvedValue(new Uint8Array([1]).buffer);
      return file;
    };
    const fileA = makeProjectedFile('joint-a.mp3');
    const fileB = makeProjectedFile('joint-b.mp3');
    const itemA = makeFileTrack(fileA);
    const itemB = makeFileTrack(fileB);
    setState('playlist.items', [itemA, itemB]);
    setCurrentIndex(0);

    const decodeA = deferredDecode();
    mocks.decodeAudioData
      .mockImplementationOnce(() => decodeA.promise)
      .mockResolvedValueOnce({ duration: 120 });
    const { loadAndBroadcastFile } = await import('../decode.ts');
    const pA = loadAndBroadcastFile(fileA, itemA.queueItemId, 1, getCurrentLoadEpoch());
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledOnce());

    const epochB = newLoadEpoch();
    setCurrentIndex(1);
    const pB = loadAndBroadcastFile(fileB, itemB.queueItemId, 2, epochB);

    // B must enter native decode while superseded A is still settling. A
    // double-counted reservation would leave B waiting here for A's release.
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledTimes(2));
    await expect(pB).resolves.toBe(true);

    decodeA.resolve({ duration: 120 });
    await expect(pA).resolves.toBe(false);
    expect(getState('files.current')?.blob).toBe(fileB);
  });

  it('waits for a superseded native decode reservation instead of failing the next track', async () => {
    const makeProjectedFile = (name: string): File => {
      const file = new File([new Uint8Array([1])], name, { type: 'audio/mpeg' });
      // A 6 MiB unknown-duration input projects to 384 MiB PCM plus 12 MiB
      // encoded working copies. Each fits the standard tier alone; two do not.
      Object.defineProperty(file, 'size', { configurable: true, value: 6 * 1024 * 1024 });
      vi.spyOn(file, 'arrayBuffer').mockResolvedValue(new Uint8Array([1]).buffer);
      return file;
    };
    const fileA = makeProjectedFile('reserved-a.mp3');
    const fileB = makeProjectedFile('reserved-b.mp3');
    const itemA = makeFileTrack(fileA);
    const itemB = makeFileTrack(fileB);
    setState('playlist.items', [itemA, itemB]);
    setCurrentIndex(0);

    const decodeA = deferredDecode();
    mocks.decodeAudioData
      .mockImplementationOnce(() => decodeA.promise)
      .mockResolvedValueOnce({ duration: 120 });
    const { loadAndBroadcastFile } = await import('../decode.ts');
    const pA = loadAndBroadcastFile(fileA, itemA.queueItemId, 1, getCurrentLoadEpoch());
    await vi.waitFor(() => expect(mocks.decodeAudioData).toHaveBeenCalledOnce());

    const epochB = newLoadEpoch();
    setCurrentIndex(1);
    const pB = loadAndBroadcastFile(fileB, itemB.queueItemId, 2, epochB);
    let bSettled = false;
    void pB.then(
      () => {
        bSettled = true;
      },
      () => {
        bSettled = true;
      },
    );
    await Promise.resolve();

    expect(fileB.arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.decodeAudioData).toHaveBeenCalledOnce();
    expect(bSettled).toBe(false);

    // Supersession does not cancel decodeAudioData. Only native settlement
    // releases A's reservation; B then re-runs admission and decodes normally.
    decodeA.resolve({ duration: 120 });
    await expect(pA).resolves.toBe(false);
    await expect(pB).resolves.toBe(true);
    expect(fileB.arrayBuffer).toHaveBeenCalledOnce();
    expect(mocks.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(getState('files.current')?.blob).toBe(fileB);
    expect(mocks.broadcastSystemNotice).not.toHaveBeenCalled();
  });
});

// clearPreviousTrackState must preserve an engaged download lifecycle while
// still idling file playback when no pipeline is busy.
describe('clearPreviousTrackState lifecycle guard (DV-1)', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
  });

  it('does not idle playback while the file pipeline is mid-engagement', async () => {
    const { clearPreviousTrackState } = await import('../decode.ts');
    mocks.isFilePipelineBusyForPlay.mockReturnValue(true);
    setState('playback.mode', 'file');
    setState('playback.activity', 'pending');

    clearPreviousTrackState('file-prepare');

    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('pending');
  });

  it('still idles active file playback when the pipeline is not busy', async () => {
    const { clearPreviousTrackState } = await import('../decode.ts');
    mocks.isFilePipelineBusyForPlay.mockReturnValue(false);
    setState('playback.mode', 'file');
    setState('playback.activity', 'pending');

    clearPreviousTrackState('file-prepare');

    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });
});
