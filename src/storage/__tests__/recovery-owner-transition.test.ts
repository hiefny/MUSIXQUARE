// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG, TRANSFER_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { CloudflareDataConnection } from '../../network/transport/cloudflare-signaling.ts';
import { initPlayback } from '../../player/playback.ts';
import { stopAllMediaAsync } from '../../player/transport.ts';
import { finalizeGuestFile } from '../../player/decode.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
} from '../../storage/preload.ts';
import { readStoredFile, resetAllStoredFiles } from '../../storage/storage.ts';
import { initTransfer, resetIncomingTransferAuthority } from '../../storage/transfer.ts';
import {
  initRecovery,
  resetRecoveryAuthority,
  sendRecoveryRequest,
} from '../../storage/recovery.ts';
import { cancelOutgoingFileTransfers } from '../../storage/transfer-send.ts';
import { getCurrentFileRequestOwnerForTests } from '../../network/file-request-authority.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import {
  awaitTrustedSystemAudioReceptionBoundary,
  cleanupGuestSystemAudio,
  registerSystemAudioGuestListeners,
} from '../../network/system-audio-guest.ts';
import { createSystemAudioStartFrame } from '../../network/system-audio-start.ts';
import {
  claimPlaybackOwner,
  createSystemAudioTrackMeta,
  createYouTubeTrackMetaForTests,
  getPlaybackOwnership,
  releasePlaybackOwner,
  setPlaybackFilePaused,
} from '../../player/ownership.ts';

// Native decode is the only output stub. Real transport channel selection,
// binary encoding/decoding, protocol guards, receive and RAM storage run.
vi.mock('../../player/decode.ts', async (original) => ({
  ...(await original<typeof import('../../player/decode.ts')>()),
  finalizeGuestFile: vi.fn(async () => {}),
}));

const A = '90000000-0000-4000-8000-000000000001';
class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  sent: Array<string | ArrayBuffer> = [];
  constructor(readonly label: string) {
    super();
  }
  onSend?: (frame: string | ArrayBuffer) => void;
  send(frame: string | ArrayBuffer) {
    this.sent.push(frame);
    this.onSend?.(frame);
  }
  close() {
    this.readyState = 'closed';
  }
  deliver(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}
function connection(id: string) {
  const transport = new CloudflareDataConnection(id);
  const pc = Object.assign(new EventTarget(), {
    connectionState: 'connected',
    iceConnectionState: 'connected',
  });
  const bulk = new Channel('musixquare-data'),
    control = new Channel('musixquare-control');
  transport.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
  transport.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  return { transport, conn: transport as unknown as DataConnection, bulk, control };
}
function item(queueItemId: string, file?: File) {
  return {
    queueItemId,
    name: 'same.mp3',
    type: 'file' as const,
    file,
    videoId: null,
    playlistId: null,
  };
}
function reset() {
  cleanupGuestSystemAudio();
  cancelPreloadTransfer();
  cancelOutgoingFileTransfers();
  resetRecoveryAuthority();
  bus.clear();
  clearAllManagedTimers();
  resetState();
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  resetIncomingTransferAuthority();
  resetFileDeliveryPolicies();
  resetInboundRateLimit('host');
  resetInboundRateLimit('guest');
  vi.mocked(finalizeGuestFile).mockClear();
  initTransfer();
  initPreload();
  initPlayback();
  initRecovery();
  registerSystemAudioGuestListeners();
}
beforeEach(() => {
  vi.useFakeTimers();
  reset();
});
afterEach(async () => {
  reset();
  await vi.advanceTimersByTimeAsync(100);
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
});

const file = new File([new Uint8Array(CHUNK_SIZE * 3 + 7).fill(43)], 'resume.mp3', {
  type: 'audio/mpeg',
});
const sid = 6;
async function host() {
  reset();
  setState('playlist.items', [{ ...item(A, file), name: file.name }]);
  setState('playlist.currentQueueItemId', A);
  setState('network.appRole', 'host');
  setState('transfer.currentSessionId', sid);
  setState('files.current', {
    blob: file,
    indexHint: 0,
    queueItemId: A,
    sessionId: sid,
    name: file.name,
    size: file.size,
    mime: file.type,
  });
  const endpoint = connection('guest');
  await vi.advanceTimersByTimeAsync(0);
  const peer = {
    id: 'guest',
    conn: endpoint.conn,
    status: 'connected',
    connectionType: 'local',
    isDataTarget: true,
    slot: 1,
    label: 'guest',
    isOp: false,
    joinOrder: 1,
    lastHeartbeat: 0,
  } as ConnectedPeer;
  setState('network.connectedPeers', [peer]);
  setState('network.activeHostConnByPeerId', new Map([['guest', endpoint.conn]]));
  return endpoint;
}
async function guest() {
  reset();
  setState('playlist.items', [{ ...item(A), name: file.name }]);
  setState('playlist.currentQueueItemId', A);
  const endpoint = connection('host');
  await vi.advanceTimersByTimeAsync(0);
  setState('network.appRole', 'guest');
  setState('network.connectionType', 'local');
  setState('network.hostConn', endpoint.conn);
  markQueueAuthorityReady(endpoint.conn);
  const deliveries: Promise<void>[] = [];
  endpoint.transport.on('data', (frame) => deliveries.push(handleData(frame, endpoint.conn)));
  const deliver = async (frame: string | ArrayBuffer, lane: 'control' | 'bulk') => {
    endpoint[lane].deliver(frame);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(deliveries);
  };
  const recoveries = () =>
    endpoint.control.sent
      .map((f) => JSON.parse(f as string))
      .filter((f) => f.type === MSG.REQUEST_DATA_RECOVERY);
  return { ...endpoint, deliver, recoveries };
}

// Capture a real host response; tests deliver its header/chunks with controlled
// timing while the protocol handlers, storage, timers and owner transitions run.
async function response() {
  const sender = await host();
  const pending = handleData(
    {
      type: MSG.REQUEST_DATA_RECOVERY,
      requestId: 1001,
      queueItemId: A,
      sessionId: sid,
      nextChunk: 0,
      fileName: file.name,
    },
    sender.conn,
  );
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(sender.control.sent.map((f) => JSON.parse(f as string).type)).toEqual([MSG.FILE_START]);
  const start = sender.control.sent[0]!;
  const chunks = [...sender.bulk.sent];
  await stopAllMediaAsync({ silent: true, cancelInFlight: true });
  const pause = sender.control.sent.find(
    (f) => typeof f === 'string' && JSON.parse(f).type === MSG.PAUSE,
  )!;
  expect(JSON.parse(pause as string)).toMatchObject({ reason: 'transition', queueItemId: A });
  return { start, chunks, pause };
}

it('retires pending recovery after authenticated PAUSE and system-audio START', async () => {
  const frames = await response();
  const receiver = await guest();
  await receiver.deliver(frames.start, 'control');
  await receiver.deliver(frames.chunks[0]!, 'bulk');
  await vi.advanceTimersByTimeAsync(13_001);
  expect(getState('recovery.pending')).toBe(true);
  await receiver.deliver(frames.pause, 'control');
  await receiver.deliver(JSON.stringify(createSystemAudioStartFrame('display')), 'control');
  await vi.advanceTimersByTimeAsync(2_001);
  expect(receiver.recoveries()).toHaveLength(0);
  expect(getState('recovery.pending')).toBe(false);
  expect(getState('playback.pendingRecoveryTarget')).toBeNull();
  expect(getState('player.currentTrackMeta')?.systemAudioPlaceholder).toBe(true);
  expect(await awaitTrustedSystemAudioReceptionBoundary('stereo')).toBe(true);
});

it('ignores a previously issued FILE_START response during system audio and accepts a fresh file return', async () => {
  const frames = await response();
  const receiver = await guest();
  await receiver.deliver(frames.start, 'control');
  await receiver.deliver(frames.chunks[0]!, 'bulk');
  await vi.advanceTimersByTimeAsync(15_001);
  expect(receiver.recoveries()).toHaveLength(1);
  await receiver.deliver(frames.pause, 'control');
  await receiver.deliver(JSON.stringify(createSystemAudioStartFrame('display')), 'control');
  const placeholder = getState('player.currentTrackMeta');
  const lifecycle = getState('playback.lifecycle');
  await receiver.deliver(frames.start, 'control');
  for (const frame of frames.chunks) await receiver.deliver(frame, 'bulk');
  expect(getState('player.currentTrackMeta')).toBe(placeholder);
  expect(getState('playback.lifecycle')).toBe(lifecycle);
  expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
  expect(finalizeGuestFile).not.toHaveBeenCalled();
  expect(await awaitTrustedSystemAudioReceptionBoundary('stereo')).toBe(true);

  await receiver.deliver(JSON.stringify({ type: MSG.SYSTEM_AUDIO_STOP }), 'control');
  expect(getPlaybackOwnership().isExternalOwner).toBe(false);
  await receiver.deliver(frames.start, 'control');
  for (const frame of frames.chunks) await receiver.deliver(frame, 'bulk');
  const restored = await readStoredFile(A, file.name, false, sid);
  expect(restored?.size).toBe(file.size);
  expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(
    new Uint8Array(await file.arrayBuffer()),
  );
  expect(finalizeGuestFile).toHaveBeenCalledOnce();
});

it('retires an accepted FILE_WAIT timer even when the same file returns before it fires', async () => {
  const frames = await response();
  const receiver = await guest();
  await receiver.deliver(frames.start, 'control');
  sendRecoveryRequest();
  await vi.advanceTimersByTimeAsync(2_001);
  const request = receiver.recoveries()[0];
  expect(request).toBeDefined();
  await receiver.deliver(
    JSON.stringify({ ...request, type: MSG.FILE_WAIT, message: 'File not ready' }),
    'control',
  );
  await receiver.deliver(JSON.stringify(createSystemAudioStartFrame('display')), 'control');
  expect(getCurrentFileRequestOwnerForTests()).toBeNull();
  await receiver.deliver(JSON.stringify({ type: MSG.SYSTEM_AUDIO_STOP }), 'control');
  await vi.advanceTimersByTimeAsync(10_001);
  expect(receiver.recoveries()).toHaveLength(1);
  expect(getCurrentFileRequestOwnerForTests()).toBeNull();
});

it.each(['youtube', 'system-audio'] as const)(
  'ignores newly requested file recovery during %s ownership',
  async (owner) => {
    const receiver = await guest();
    claimPlaybackOwner(owner, {
      currentTrackMeta:
        owner === 'youtube'
          ? createYouTubeTrackMetaForTests({ videoId: 'abcdefghijk' })
          : createSystemAudioTrackMeta('receiving'),
    });
    const metadata = getState('player.currentTrackMeta');
    sendRecoveryRequest();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(receiver.recoveries()).toHaveLength(0);
    expect(getState('recovery.pending')).toBe(false);
    expect(getState('player.currentTrackMeta')).toBe(metadata);
  },
);

it.each([0, 1])(
  'retires real unicast after %s chunks across file → system audio → same paused file',
  async (stopAfterChunks) => {
    const sender = await host();
    const transition = () => {
      claimPlaybackOwner('system-audio', {
        currentTrackMeta: createSystemAudioTrackMeta('sharing'),
      });
      releasePlaybackOwner('system-audio', { currentTrackMeta: null });
      setPlaybackFilePaused();
    };
    if (stopAfterChunks === 1) sender.bulk.onSend = transition;
    const request = {
      type: MSG.REQUEST_DATA_RECOVERY,
      requestId: 1001,
      queueItemId: A,
      sessionId: sid,
      nextChunk: 0,
      fileName: file.name,
    };
    const pending = handleData(request, sender.conn);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.control.sent.map((f) => JSON.parse(f as string).type)).toEqual([MSG.FILE_START]);
    if (stopAfterChunks === 0) transition();
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(sender.bulk.sent).toHaveLength(stopAfterChunks);
    expect(getState('files.current')?.blob).toBe(file);
    expect(getPlaybackOwnership().isExternalOwner).toBe(false);

    // The retired operation cannot resume, but a new recovery request may.
    sender.bulk.onSend = undefined;
    sender.bulk.sent.length = 0;
    const fresh = handleData({ ...request, requestId: 1002 }, sender.conn);
    await vi.advanceTimersByTimeAsync(500);
    await fresh;
    expect(sender.bulk.sent).toHaveLength(5); // four chunks plus END
  },
);

it('allows a paused local guest to recover its selected file', async () => {
  const frames = await response();
  const receiver = await guest();
  await receiver.deliver(frames.start, 'control');
  await receiver.deliver(frames.chunks[0]!, 'bulk');
  setPlaybackFilePaused();
  sendRecoveryRequest();
  await vi.advanceTimersByTimeAsync(2_001);
  expect(receiver.recoveries()).toHaveLength(1);
  expect(receiver.recoveries()[0]).toMatchObject({ queueItemId: A, sessionId: sid, nextChunk: 1 });
});
