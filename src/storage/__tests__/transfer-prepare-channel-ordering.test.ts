/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { CloudflareDataConnection } from '../../network/transport/cloudflare-signaling.ts';
import { initPlayback } from '../../player/playback.ts';
import { finalizeGuestFile } from '../../player/decode.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
  unicastPreload,
} from '../preload.ts';
import { readStoredFile, resetAllStoredFiles } from '../storage.ts';
import {
  cancelIncomingFileTransfer,
  initTransfer,
  resetIncomingTransferAuthority,
} from '../transfer.ts';
import { ramContiguousCount } from '../ramstore.ts';
import { initRecovery, resetRecoveryAuthority } from '../recovery.ts';
import {
  broadcastFile,
  broadcastFileDebounced,
  cancelOutgoingFileTransfers,
  sendFilePrepareByDelivery,
} from '../transfer-send.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

// Native decode is the only output stub. Real transport channel selection,
// binary encoding/decoding, protocol guards, recovery, receive and RAM storage run.
// Keep initPlayback: replacing its stop listener hides the SQ01 prefix loss.
vi.mock('../../player/decode.ts', async (original) => ({
  ...(await original<typeof import('../../player/decode.ts')>()),
  finalizeGuestFile: vi.fn(async () => {}),
}));

const A = '90000000-0000-4000-8000-000000000001';
const B = '90000000-0000-4000-8000-000000000002';
const recoveryRequested = vi.fn();
class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  sent: Array<string | ArrayBuffer> = [];
  constructor(readonly label: string) {
    super();
  }
  send(frame: string | ArrayBuffer) {
    this.sent.push(frame);
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
function reset(initialize = true) {
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
  vi.mocked(finalizeGuestFile).mockClear();
  recoveryRequested.mockClear();
  if (initialize) {
    initTransfer();
    initPreload();
    initPlayback();
    initRecovery();
    bus.on('storage:request-recovery', recoveryRequested);
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  reset();
});
afterEach(async () => {
  reset(false);
  await vi.advanceTimersByTimeAsync(0);
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
});

async function expectNoRecovery(receiver: ReturnType<typeof connection>) {
  // An incomplete END schedules its first recovery after 2 seconds. Observe
  // both the request event and the wire, including requests still in backoff.
  await vi.advanceTimersByTimeAsync(2100);
  expect(recoveryRequested).not.toHaveBeenCalled();
  expect(
    receiver.control.sent
      .map((f) => JSON.parse(f as string))
      .filter((f) => f.type === MSG.REQUEST_DATA_RECOVERY || f.type === MSG.REQUEST_CURRENT_FILE),
  ).toEqual([]);
}

async function expectStored(file: File, queueItemId = A, sessionId = 6) {
  const result = await readStoredFile(queueItemId, file.name, false, sessionId);
  expect(result?.size).toBe(file.size);
  expect(new Uint8Array(await result!.arrayBuffer())).toEqual(
    new Uint8Array(await file.arrayBuffer()),
  );
}

// Enumerate every possible merger preserving FIFO within both RTC channels.
function weaves(control: number, bulk: number, prefix = ''): string[] {
  if (!control && !bulk) return [prefix];
  return [
    ...(control ? weaves(control - 1, bulk, prefix + 'C') : []),
    ...(bulk ? weaves(control, bulk - 1, prefix + 'B') : []),
  ];
}
const orders = weaves(3, 6);
it.each(orders)(
  'assembles main and same-name preload with ordered-channel merger %s',
  async (order) => {
    const mainFile = new File([new Uint8Array(CHUNK_SIZE + 3).fill(17)], 'same.mp3', {
      type: 'audio/mpeg',
    });
    const preloadFile = new File([new Uint8Array(CHUNK_SIZE + 3).fill(29)], 'same.mp3', {
      type: 'audio/mpeg',
    });
    setState('playlist.items', [item(A, mainFile), item(B, preloadFile)]);
    setState('playlist.currentQueueItemId', A);
    const resident = (file: File, queueItemId: string, sessionId: number) => ({
      blob: file,
      queueItemId,
      indexHint: queueItemId === A ? 0 : 1,
      sessionId,
      name: file.name,
      size: file.size,
      mime: file.type,
      total: 2,
    });
    setState('files.current', resident(mainFile, A, 6));
    setState('transfer.currentSessionId', 6);
    const sender = connection('guest');
    await vi.advanceTimersByTimeAsync(0);
    const peer = {
      id: 'guest',
      conn: sender.conn,
      status: 'connected',
      connectionType: 'local',
      isDataTarget: true,
      preloadedQueueItemIds: new Set(),
      slot: 1,
      label: 'guest',
      isOp: false,
      joinOrder: 1,
      lastHeartbeat: 0,
    } as ConnectedPeer;
    setState('network.connectedPeers', [peer]);
    setState('network.activeHostConnByPeerId', new Map([['guest', sender.conn]]));
    sendFilePrepareByDelivery(
      {
        type: MSG.FILE_PREPARE,
        name: mainFile.name,
        mime: mainFile.type,
        size: mainFile.size,
        queueItemId: A,
        sessionId: 6,
      },
      6,
    );
    const sending = broadcastFile(mainFile, A, 6);
    await vi.advanceTimersByTimeAsync(50);
    await sending;
    const next = resident(preloadFile, B, 7);
    setState('preload.ready', next);
    setState('preload.activeTarget', next);
    setState('preload.nextQueueItemId', B);
    await unicastPreload(sender.conn, preloadFile, B, 7);
    expect(sender.control.sent.map((f) => JSON.parse(f as string).type)).toEqual([
      MSG.FILE_PREPARE,
      MSG.FILE_START,
      MSG.PRELOAD_START,
    ]);
    expect(sender.bulk.sent).toHaveLength(6);

    reset();
    setState('playlist.items', [item(A), item(B)]);
    setState('playlist.currentQueueItemId', A);
    const receiver = connection('host');
    await vi.advanceTimersByTimeAsync(0);
    setState('network.appRole', 'guest');
    setState('network.connectionType', 'local');
    setState('network.hostConn', receiver.conn);
    markQueueAuthorityReady(receiver.conn);
    const deliveries: Promise<void>[] = [];
    receiver.transport.on('data', (frame) => deliveries.push(handleData(frame, receiver.conn)));
    let ci = 0,
      bi = 0;
    for (let index = 0; index < order.length; index++) {
      if (index === 3) setState('playlist.items', [item(B), item(A)]);
      const lane = order[index]!;
      (lane === 'C' ? receiver.control : receiver.bulk).deliver(
        (lane === 'C' ? sender.control.sent[ci++] : sender.bulk.sent[bi++])!,
      );
      await vi.advanceTimersByTimeAsync(1);
    }
    await Promise.all(deliveries);
    await vi.advanceTimersByTimeAsync(1);
    const actualMain = await readStoredFile(A, mainFile.name, false, 6);
    const actualPreload = await readStoredFile(B, preloadFile.name, true, 7);
    expect(actualMain?.size).toBe(mainFile.size);
    expect(actualPreload?.size).toBe(preloadFile.size);
    expect(new Uint8Array(await actualMain!.arrayBuffer())).toEqual(
      new Uint8Array(await mainFile.arrayBuffer()),
    );
    expect(new Uint8Array(await actualPreload!.arrayBuffer())).toEqual(
      new Uint8Array(await preloadFile.arrayBuffer()),
    );
    expect(getState('playlist.currentQueueItemId')).toBe(A);
    expect(getState('preload.ready')).toMatchObject({ queueItemId: B, sessionId: 7, indexHint: 0 });
    expect(finalizeGuestFile).toHaveBeenCalledOnce();
    const acknowledgements = receiver.control.sent
      .map((f) => JSON.parse(f as string))
      .filter((f) => f.type === MSG.PRELOAD_ACK);
    expect(acknowledgements.map((f) => [f.queueItemId, f.sessionId]).sort()).toEqual([
      [A, 6],
      [B, 7],
    ]);
    await expectNoRecovery(receiver);
  },
);

async function captureMain(chunks = 2, pendingPlay = false) {
  const file = new File([new Uint8Array((chunks - 1) * CHUNK_SIZE + 3).fill(43)], 'minimal.mp3', {
    type: 'audio/mpeg',
  });
  setState('playlist.items', [{ ...item(A, file), name: file.name }]);
  setState('playlist.currentQueueItemId', A);
  setState('files.current', {
    blob: file,
    queueItemId: A,
    indexHint: 0,
    sessionId: 6,
    name: file.name,
    size: file.size,
    mime: file.type,
  });
  const sender = connection('guest');
  await vi.advanceTimersByTimeAsync(0);
  const peer = {
    id: 'guest',
    conn: sender.conn,
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
  setState('network.activeHostConnByPeerId', new Map([['guest', sender.conn]]));
  const prepareMsg = {
    type: MSG.FILE_PREPARE,
    queueItemId: A,
    sessionId: 6,
    name: file.name,
    mime: file.type,
    size: file.size,
  };
  // Same sender chain as playTrack -> loadAndBroadcastFile: publish selection,
  // then the debounce repeats PREPARE before sending START and bytes.
  sendFilePrepareByDelivery(prepareMsg, 6);
  if (pendingPlay)
    sender.conn.send({ type: MSG.PLAY, queueItemId: A, time: 12.5, name: file.name });
  broadcastFileDebounced(file, A, 6, prepareMsg);
  await vi.advanceTimersByTimeAsync(350);
  expect(sender.control.sent.map((f) => JSON.parse(f as string).type)).toEqual([
    MSG.FILE_PREPARE,
    ...(pendingPlay ? [MSG.PLAY] : []),
    MSG.FILE_PREPARE,
    MSG.FILE_START,
  ]);
  reset();
  setState('playlist.items', [
    { ...item(A), name: file.name },
    { ...item(B), name: file.name },
  ]);
  setState('playlist.currentQueueItemId', A);
  const receiver = connection('host');
  await vi.advanceTimersByTimeAsync(0);
  setState('network.appRole', 'guest');
  setState('network.connectionType', 'local');
  setState('network.hostConn', receiver.conn);
  markQueueAuthorityReady(receiver.conn);
  const deliveries: Promise<void>[] = [];
  receiver.transport.on('data', (frame) => deliveries.push(handleData(frame, receiver.conn)));
  const deliver = async (frame: string | ArrayBuffer, lane: 'control' | 'bulk') => {
    receiver[lane].deliver(frame);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(deliveries);
  };
  // The first selection PREPARE arrives normally. Only the repeated header
  // overtakes/is overtaken by bulk; each channel's FIFO remains intact.
  await deliver(sender.control.sent[0]!, 'control');
  if (pendingPlay) await deliver(sender.control.sent[1]!, 'control');
  return {
    file,
    sender,
    receiver,
    deliver,
    prepare: sender.control.sent.at(-2)!,
    start: sender.control.sent.at(-1)!,
  };
}

it.each(['prepare-first', 'both-chunks-first', 'headers-first'])(
  'minimal control completes without recovery: %s',
  async (mode) => {
    const { file, sender, receiver, deliver, prepare, start } = await captureMain();
    const [chunk0, chunk1, end] = sender.bulk.sent;
    if (mode === 'prepare-first') {
      await deliver(prepare!, 'control');
      await deliver(chunk0!, 'bulk');
      await deliver(start!, 'control');
      await deliver(chunk1!, 'bulk');
    } else if (mode === 'both-chunks-first') {
      await deliver(chunk0!, 'bulk');
      await deliver(chunk1!, 'bulk');
      await deliver(prepare!, 'control');
      await deliver(start!, 'control');
    } else {
      await deliver(prepare!, 'control');
      await deliver(start!, 'control');
      await deliver(chunk0!, 'bulk');
      await deliver(chunk1!, 'bulk');
    }
    await deliver(end!, 'bulk');
    await expectStored(file);
    expect(finalizeGuestFile).toHaveBeenCalledOnce();
    await expectNoRecovery(receiver);
  },
);

it.each([1, 2])(
  'retains early prefix %s across repeated PREPARE then START without recovery',
  async (prefix) => {
    const { file, sender, receiver, deliver, prepare, start } = await captureMain(3);
    const chunkFrames = sender.bulk.sent.slice(0, 3),
      end = sender.bulk.sent[3]!;
    for (const frame of chunkFrames.slice(0, prefix)) await deliver(frame, 'bulk');
    expect(ramContiguousCount(A, false, 6)).toBe(prefix);
    expect(getState('transfer.state')).toBe('RECEIVING');
    await deliver(prepare!, 'control');
    expect(ramContiguousCount(A, false, 6)).toBe(prefix);
    expect(getState('transfer.state')).toBe('RECEIVING');
    await deliver(start!, 'control');
    expect(ramContiguousCount(A, false, 6)).toBe(prefix);
    for (const frame of chunkFrames.slice(prefix)) await deliver(frame, 'bulk');
    await deliver(end, 'bulk');
    await expectStored(file);
    expect(finalizeGuestFile).toHaveBeenCalledOnce();
    await expectNoRecovery(receiver);
  },
);

function encodeControl(sender: ReturnType<typeof connection>, data: Record<string, unknown>) {
  // Boundary controls still pass through the real transport frame encoder.
  sender.conn.send(data);
  return sender.control.sent.at(-1)!;
}

it.each([
  ['name', 'replacement.mp3'],
  ['size', 2 * CHUNK_SIZE + 4],
  ['total', 4],
  ['mime', 'audio/ogg'],
] as const)('does not restore a partial receive when PREPARE changes %s', async (field, value) => {
  const { sender, deliver, prepare, start } = await captureMain(3);
  await deliver(sender.bulk.sent[0]!, 'bulk');
  const changed = { ...JSON.parse(prepare as string), [field]: value };
  await deliver(encodeControl(sender, changed), 'control');
  expect(getState('transfer.state')).toBe('IDLE');
  expect(ramContiguousCount(A, false, 6)).toBe(1);
  // A later START must not treat the interrupted owner as a live prefix.
  await deliver(start, 'control');
  expect(ramContiguousCount(A, false, 6)).toBe(0);
  expect(getState('transfer.receivedCount')).toBe(0);
  expect(finalizeGuestFile).not.toHaveBeenCalled();
});

it('does not revive an already stopped receive merely because its stored prefix still matches', async () => {
  const { sender, deliver, prepare, start } = await captureMain(3);
  await deliver(sender.bulk.sent[0]!, 'bulk');
  const receiveMeta = getState('transfer.meta');
  bus.emit('player:stop-all-media');
  expect(getState('transfer.state')).toBe('IDLE');
  expect(getState('transfer.receivedCount')).toBe(1);
  expect(ramContiguousCount(A, false, 6)).toBe(1);

  await deliver(prepare, 'control');
  expect(getState('transfer.meta')).toEqual(receiveMeta);
  expect(getState('transfer.state')).toBe('IDLE');
  expect(getState('transfer.receivedCount')).toBe(1);
  expect(ramContiguousCount(A, false, 6)).toBe(1);
  await deliver(start, 'control');
  expect(getState('transfer.receivedCount')).toBe(0);
  expect(ramContiguousCount(A, false, 6)).toBe(0);
  expect(finalizeGuestFile).not.toHaveBeenCalled();
});

it('accepts omitted optional PREPARE metadata and preserves pending PLAY through the real stop', async () => {
  const { file, sender, receiver, deliver, prepare, start } = await captureMain(3, true);
  await deliver(sender.bulk.sent[0]!, 'bulk');
  expect(getState('playback.pendingPlayTime')).toBe(12.5);
  const pendingSetAt = getState('playback.pendingPlayTimeSetAt');
  const seekReset = vi.fn();
  const stoppedStates: string[] = [];
  bus.on('ui:seek-reset', seekReset);
  bus.on('player:stop-all-media', () => stoppedStates.push(getState('transfer.state')));

  // Older senders can omit these advisory fields. Queue id, session and name
  // still identify the exact live receive; absent metadata is not a mismatch.
  const legacyPrepare = JSON.parse(prepare as string);
  delete legacyPrepare.size;
  delete legacyPrepare.total;
  await deliver(encodeControl(sender, legacyPrepare), 'control');
  expect(seekReset).toHaveBeenCalledOnce();
  expect(stoppedStates).toEqual(['IDLE']);
  expect(getState('transfer.state')).toBe('RECEIVING');
  expect(getState('playback.pendingPlayTime')).toBe(12.5);
  expect(getState('playback.pendingPlayTimeSetAt')).toBe(pendingSetAt);
  await deliver(start, 'control');
  expect(ramContiguousCount(A, false, 6)).toBe(1);
  for (const frame of sender.bulk.sent.slice(1)) await deliver(frame, 'bulk');
  await expectStored(file);
  expect(finalizeGuestFile).toHaveBeenCalledOnce();
  expect(getState('playback.pendingPlayTimeSetAt')).toBe(pendingSetAt);
  await expectNoRecovery(receiver);
});

it.each(['cancel', 'authority-reset'] as const)(
  'does not restore a receive after synchronous %s during the stop',
  async (mode) => {
    const { sender, deliver, prepare } = await captureMain(3);
    await deliver(sender.bulk.sent[0]!, 'bulk');
    bus.on('player:stop-all-media', () => {
      if (mode === 'cancel') cancelIncomingFileTransfer('test-stop-cancellation');
      else resetIncomingTransferAuthority();
    });
    await deliver(prepare, 'control');
    expect(getState('transfer.state')).toBe('IDLE');
    if (mode === 'cancel') expect(ramContiguousCount(A, false, 6)).toBe(0);
    else expect(getState('transfer.receivedCount')).toBe(0);
    expect(finalizeGuestFile).not.toHaveBeenCalled();
  },
);

it.each([
  ['new session', A],
  ['same-name replacement occurrence', B],
] as const)('does not inherit the old prefix for a %s', async (_label, queueItemId) => {
  const { sender, deliver, prepare, start } = await captureMain(3);
  await deliver(sender.bulk.sent[0]!, 'bulk');
  await deliver(
    encodeControl(sender, { ...JSON.parse(prepare as string), queueItemId, sessionId: 7 }),
    'control',
  );
  await deliver(
    encodeControl(sender, { ...JSON.parse(start as string), queueItemId, sessionId: 7 }),
    'control',
  );
  expect(getState('transfer.meta')).toMatchObject({ queueItemId, sessionId: 7 });
  expect(getState('transfer.receivedCount')).toBe(0);
  expect(ramContiguousCount(queueItemId, false, 7)).toBe(0);
  // Old bulk suffix can legitimately trail the next control selection.
  for (const frame of sender.bulk.sent.slice(1)) await deliver(frame, 'bulk');
  expect(getState('transfer.meta')).toMatchObject({ queueItemId, sessionId: 7 });
  expect(getState('transfer.receivedCount')).toBe(0);
  expect(finalizeGuestFile).not.toHaveBeenCalled();
});

it('rejects delayed PREPARE, START and bytes from a superseded host connection', async () => {
  const { sender, deliver, prepare, start } = await captureMain(3);
  await deliver(sender.bulk.sent[0]!, 'bulk');
  const currentMeta = getState('transfer.meta');
  const replacement = connection('host');
  await vi.advanceTimersByTimeAsync(0);
  setState('network.hostConn', replacement.conn);
  markQueueAuthorityReady(replacement.conn);
  // Same peer id and transfer metadata do not authenticate the retired object.
  await deliver(prepare, 'control');
  await deliver(start, 'control');
  for (const frame of sender.bulk.sent.slice(1)) await deliver(frame, 'bulk');
  expect(getState('transfer.meta')).toEqual(currentMeta);
  expect(getState('transfer.state')).toBe('RECEIVING');
  expect(getState('transfer.receivedCount')).toBe(1);
  expect(ramContiguousCount(A, false, 6)).toBe(1);
  expect(finalizeGuestFile).not.toHaveBeenCalled();
});
