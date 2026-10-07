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
import { cancelPreloadTransfer, initPreload, resetPreloadReceiveAuthority } from '../preload.ts';
import { readStoredFile, resetAllStoredFiles } from '../storage.ts';
import { initTransfer, resetIncomingTransferAuthority } from '../transfer.ts';
import { getTransferMemoryStats } from '../transfer-receive.ts';
import { ramContiguousCount } from '../ramstore.ts';
import { initRecovery, resetRecoveryAuthority } from '../recovery.ts';
import { broadcastFile, cancelOutgoingFileTransfers } from '../transfer-send.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

// Native decode is the only output stub. Real transport channel selection,
// binary encoding/decoding, protocol guards, receive and RAM storage run.
vi.mock('../../player/decode.ts', async (original) => ({
  ...(await original<typeof import('../../player/decode.ts')>()),
  finalizeGuestFile: vi.fn(async () => {}),
}));

const A = '90000000-0000-4000-8000-000000000001';
const B = '90000000-0000-4000-8000-000000000002';
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
  resetInboundRateLimit('replacement');
  resetInboundRateLimit('guest');
  vi.mocked(finalizeGuestFile).mockClear();
  initTransfer();
  initPreload();
  initPlayback();
  initRecovery();
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

const file = new File(
  [
    Uint8Array.from(
      { length: CHUNK_SIZE * 3 + 7 },
      (_, index) => (index * 17 + Math.floor(index / CHUNK_SIZE) * 29) % 256,
    ),
  ],
  'resume.mp3',
  { type: 'audio/mpeg' },
);
const sid = 6;
async function host() {
  reset();
  setState('playlist.items', [{ ...item(A, file), name: file.name }]);
  setState('playlist.currentQueueItemId', A);
  setState('network.appRole', 'host');
  setState('transfer.currentSessionId', sid);
  setState('files.current', {
    blob: file,
    queueItemId: A,
    indexHint: 0,
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
  setState('playlist.items', [
    { ...item(A), name: file.name },
    { ...item(B), name: file.name },
  ]);
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
async function trace() {
  // Let the real broadcast pump exclude an actual backed-up data channel.
  // It emits START/chunk0, then waits 30 seconds and never emits a suffix or END.
  const sender = await host();
  sender.bulk.onSend = () => {
    sender.bulk.bufferedAmount = 2 * 1024 * 1024;
  };
  const broadcast = broadcastFile(file, A, sid);
  await vi.advanceTimersByTimeAsync(31_000);
  await broadcast;
  expect(sender.control.sent.map((f) => JSON.parse(f as string).type)).toEqual([MSG.FILE_START]);
  expect(sender.bulk.sent).toHaveLength(1);
  const start = sender.control.sent[0]!,
    chunk0 = sender.bulk.sent[0]!;

  // Genuine receive watchdog/backoff emits the authenticated request at offset 1.
  const receiver = await guest();
  await receiver.deliver(start, 'control');
  await receiver.deliver(chunk0, 'bulk');
  await vi.advanceTimersByTimeAsync(15_001);
  expect(receiver.recoveries()).toHaveLength(1);
  const request = receiver.recoveries()[0];
  expect(request).toMatchObject({ queueItemId: A, sessionId: sid, nextChunk: 1 });

  // Feed that exact request through the real host protocol and recovery handler.
  // The backing connection is now writable; response resumes from chunk 1.
  const recoverySender = await host();
  const pending = handleData(request, recoverySender.conn);
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(recoverySender.control.sent.map((f) => JSON.parse(f as string).type)).toEqual([
    MSG.FILE_RESUME,
  ]);
  expect(recoverySender.bulk.sent).toHaveLength(4); // chunks 1,2,3, END
  return {
    start,
    chunk0,
    resume: recoverySender.control.sent[0]!,
    suffix: recoverySender.bulk.sent,
  };
}

async function expectComplete(
  receiver: Awaited<ReturnType<typeof guest>>,
  expectedRequests: number,
) {
  const stored = await readStoredFile(A, file.name, false, sid);
  expect(stored?.size).toBe(file.size);
  expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(
    new Uint8Array(await file.arrayBuffer()),
  );
  expect(finalizeGuestFile).toHaveBeenCalledOnce();
  // A false incomplete END schedules recovery after two seconds.
  await vi.advanceTimersByTimeAsync(2_001);
  expect(receiver.recoveries()).toHaveLength(expectedRequests);
  expect(getTransferMemoryStats().reorderChunks).toBe(0);
}

// Control contains RESUME; bulk contains chunks 1/2/3 then END. Every
// interleaving here preserves FIFO on each actual encoded transport lane.
it.each(
  [0, 1, 2, 3, 4].flatMap((overtaking) =>
    [false, true].map((duplicate) => ({ overtaking, duplicate })),
  ),
)(
  'completes without extra recovery: $overtaking bulk frames before RESUME, duplicate=$duplicate',
  async ({ overtaking, duplicate }) => {
    const { start, chunk0, resume, suffix } = await trace();
    const receiver = await guest();
    await receiver.deliver(start, 'control');
    await receiver.deliver(chunk0, 'bulk');
    await vi.advanceTimersByTimeAsync(15_001);
    expect(receiver.recoveries()).toHaveLength(1);
    for (const frame of suffix.slice(0, overtaking)) await receiver.deliver(frame, 'bulk');
    const before = getState('transfer.receivedCount');
    // Queue reordering changes indices but not this exact transfer owner.
    setState('playlist.items', [item(B), { ...item(A), name: file.name }]);
    await receiver.deliver(resume, 'control');
    if (duplicate) await receiver.deliver(resume, 'control');
    expect(getState('transfer.receivedCount')).toBe(before);
    expect(getState('playlist.currentQueueItemId')).toBe(A);
    for (const frame of suffix.slice(overtaking)) await receiver.deliver(frame, 'bulk');
    await expectComplete(receiver, 1);
  },
);

it.each([0, 1])(
  'retains a sparse suffix when the committed prefix has %s chunks',
  async (prefix) => {
    const { start, chunk0, resume, suffix } = await trace();
    const receiver = await guest();
    await receiver.deliver(start, 'control');
    if (prefix) await receiver.deliver(chunk0, 'bulk');
    // Model a gap at the receive boundary. This is deliberately not an ordered
    // single-pump trace: overlapping/replacement streams can expose sparse input.
    // Chunk 2 is held in the real reorder buffer until chunks 0/1 fill that gap.
    await receiver.deliver(suffix[1]!, 'bulk');
    expect(getTransferMemoryStats().reorderChunks).toBe(1);
    await receiver.deliver(resume, 'control');
    expect(getState('transfer.receivedCount')).toBe(prefix);
    expect(getTransferMemoryStats().reorderChunks).toBe(1);
    if (!prefix) await receiver.deliver(chunk0, 'bulk');
    await receiver.deliver(suffix[0]!, 'bulk');
    expect(getState('transfer.receivedCount')).toBe(3);
    await receiver.deliver(suffix[2]!, 'bulk');
    await receiver.deliver(suffix[3]!, 'bulk');
    // With no prefix, the claimed offset 1 correctly schedules recovery from
    // 0 even though the modeled missing chunks arrive before its backoff ends.
    await expectComplete(receiver, prefix ? 0 : 1);
    if (!prefix) expect(receiver.recoveries()[0]).toMatchObject({ nextChunk: 0 });
  },
);

it('does not invent bytes when the advertised resume offset is ahead of the store', async () => {
  const { start, chunk0, resume, suffix } = await trace();
  const receiver = await guest();
  await receiver.deliver(start, 'control');
  await receiver.deliver(chunk0, 'bulk');
  await receiver.deliver(
    JSON.stringify({ ...JSON.parse(resume as string), startChunk: 3 }),
    'control',
  );
  expect(getState('transfer.receivedCount')).toBe(1);
  expect(getTransferMemoryStats().nextExpectedChunk).toBe(1);
  await vi.advanceTimersByTimeAsync(2_001);
  expect(receiver.recoveries()).toHaveLength(1);
  expect(receiver.recoveries()[0]).toMatchObject({ queueItemId: A, sessionId: sid, nextChunk: 1 });
  await receiver.deliver(resume, 'control');
  for (const frame of suffix) await receiver.deliver(frame, 'bulk');
  await expectComplete(receiver, 1);
});

it.each(['connection', 'older session', 'other queue occurrence', 'removed queue'] as const)(
  'ignores a late RESUME with an invalid %s without changing partial progress',
  async (invalid) => {
    const { start, chunk0, resume, suffix } = await trace();
    const receiver = await guest();
    await receiver.deliver(start, 'control');
    await receiver.deliver(chunk0, 'bulk');
    await receiver.deliver(suffix[0]!, 'bulk');
    const frame = JSON.parse(resume as string);
    if (invalid === 'older session') frame.sessionId--;
    if (invalid === 'other queue occurrence') frame.queueItemId = B;
    if (invalid === 'removed queue') setState('playlist.items', [item(B)]);
    if (invalid === 'connection') {
      const untrusted = connection('not-host');
      await vi.advanceTimersByTimeAsync(0);
      await handleData(frame, untrusted.conn);
    } else {
      await receiver.deliver(JSON.stringify(frame), 'control');
    }
    expect(getState('transfer.receivedCount')).toBe(2);
    expect(getState('transfer.meta')?.queueItemId).toBe(A);
    expect(getTransferMemoryStats().nextExpectedChunk).toBe(2);
    if (invalid === 'removed queue')
      setState('playlist.items', [{ ...item(A), name: file.name }, item(B)]);
    for (const frame of suffix.slice(1)) await receiver.deliver(frame, 'bulk');
    await expectComplete(receiver, 0);
  },
);

it('restarts at zero for a new session despite the same filename and size', async () => {
  const { start, chunk0, resume, suffix } = await trace();
  const receiver = await guest();
  await receiver.deliver(start, 'control');
  await receiver.deliver(chunk0, 'bulk');
  await receiver.deliver(suffix[1]!, 'bulk');
  expect(getTransferMemoryStats().reorderChunks).toBe(1);
  await receiver.deliver(
    JSON.stringify({ ...JSON.parse(resume as string), sessionId: sid + 1 }),
    'control',
  );
  expect(getState('transfer.receivedCount')).toBe(0);
  expect(getState('transfer.localSessionId')).toBe(sid + 1);
  expect(getTransferMemoryStats()).toMatchObject({ nextExpectedChunk: 0, reorderChunks: 0 });
  expect(ramContiguousCount(A, false, sid + 1)).toBe(0);
  await vi.advanceTimersByTimeAsync(2_001);
  expect(receiver.recoveries()).toHaveLength(1);
  expect(receiver.recoveries()[0]).toMatchObject({
    queueItemId: A,
    sessionId: sid + 1,
    nextChunk: 0,
  });
  expect(finalizeGuestFile).not.toHaveBeenCalled();
});
