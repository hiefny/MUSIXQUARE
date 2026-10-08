/** @vitest-environment jsdom */
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { initGuestProtocolHandlers } from '../../network/guest.ts';
import { CloudflareDataConnection } from '../../network/transport/cloudflare-signaling.ts';
import { canSendFileTo } from '../../network/peer-state.ts';

import { initPlayback } from '../../player/playback.ts';
import { finalizeGuestFile } from '../../player/decode.ts';
import {
  resetFileDeliveryPolicies,
  resolvePeerFileDelivery,
} from '../../share/file-delivery-policy.ts';
import { cancelRemoteShareWait } from '../../share/remote-share.ts';

import {
  initRecovery,
  resetRecoveryAuthority,
  sendRecoveryRequest,
} from '../../storage/recovery.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
  unicastPreload,
} from '../../storage/preload.ts';
import { readStoredFile, resetAllStoredFiles } from '../../storage/storage.ts';
import { initTransfer, resetIncomingTransferAuthority } from '../../storage/transfer.ts';
import { ramContiguousCount } from '../../storage/ramstore.ts';
import {
  broadcastFile,
  cancelOutgoingFileTransfers,
  sendFilePrepareByDelivery,
} from '../../storage/transfer-send.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

// Native audio output alone is stubbed; sender, binary codec, protocol authority,
// guest device-list receiver, lifecycle, receive buffer and RAM store are real imports.
vi.mock('../../player/decode.ts', async (original) => ({
  ...(await original<typeof import('../../player/decode.ts')>()),
  finalizeGuestFile: vi.fn(async () => {}),
}));
const A = '90000000-0000-4000-8000-000000000071';
const B = '90000000-0000-4000-8000-000000000072';
const SID = 71;
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
function endpoint(id: string) {
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
    name: file?.name ?? 'normal.bin',
    type: 'file' as const,
    file,
    videoId: null,
    playlistId: null,
  };
}
function reset(initialize = true) {
  cancelPreloadTransfer();
  cancelOutgoingFileTransfers();
  cancelRemoteShareWait('qa-cleanup');
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
  if (initialize) {
    initTransfer();
    initPreload();
    initPlayback();
    initGuestProtocolHandlers();
    initRecovery();
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function capture(size: number, kind: 'main' | 'preload' = 'main', mime = 'audio/mpeg') {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 43 + 17) % 251);
  const file = new File([bytes], 'normal.bin', { type: mime });
  const qid = kind === 'main' ? A : B;
  setState('playlist.items', [
    item(A, kind === 'main' ? file : undefined),
    item(B, kind === 'preload' ? file : undefined),
  ]);
  setState('playlist.currentQueueItemId', A);
  const sender = endpoint('guest');
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
  const meta = {
    queueItemId: qid,
    indexHint: kind === 'main' ? 0 : 1,
    sessionId: SID,
    name: file.name,
    size,
    mime,
    total: Math.ceil(size / CHUNK_SIZE),
    blob: file,
  };
  if (kind === 'main') {
    setState('files.current', meta);
    setState('transfer.currentSessionId', SID);
    sendFilePrepareByDelivery(
      { type: MSG.FILE_PREPARE, queueItemId: qid, sessionId: SID, name: file.name, size, mime },
      SID,
    );
    const sending = broadcastFile(file, qid, SID);
    await vi.advanceTimersByTimeAsync(50);
    await sending;
  } else {
    setState('preload.ready', meta);
    setState('preload.activeTarget', meta);
    setState('preload.nextQueueItemId', B);
    const sending = unicastPreload(sender.conn, file, B, SID);
    await vi.advanceTimersByTimeAsync(50);
    await sending;
  }
  expect(sender.bulk.sent).toHaveLength(meta.total + 1);
  return { file, bytes, sender, peer, qid, kind, total: meta.total };
}
async function guest(trace: Awaited<ReturnType<typeof capture>>) {
  reset();
  setState('playlist.items', [item(A), item(B)]);
  setState('playlist.currentQueueItemId', A);
  const receiver = endpoint('host');
  await vi.advanceTimersByTimeAsync(0);
  setState('network.appRole', 'guest');
  setState('network.myId', 'guest');
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
  const deviceList = async (connectionType: 'local' | 'remote') => {
    // Valid standard projection, same authenticated host and exact guest id.
    trace.sender.conn.send({
      type: MSG.DEVICE_LIST_UPDATE,
      list: [
        {
          id: 'host',
          label: 'Host',
          status: 'connected',
          isHost: true,
          isOp: true,
          connectionType: 'local',
          joinOrder: 0,
        },
        {
          id: 'guest',
          label: 'Guest',
          status: 'connected',
          isHost: false,
          isOp: false,
          connectionType,
          joinOrder: 1,
        },
      ],
    });
    await deliver(trace.sender.control.sent.at(-1)!, 'control');
    expect(getState('network.connectionType')).toBe(connectionType);
  };
  return { receiver, deliver, deviceList };
}
async function assertBytes(trace: Awaited<ReturnType<typeof capture>>) {
  const stored = await readStoredFile(trace.qid, trace.file.name, trace.kind === 'preload', SID);
  expect(stored?.size).toBe(trace.file.size);
  // Compare every byte natively. Vitest's recursive TypedArray matcher walks
  // millions of indexed properties under coverage and can exhaust the test
  // deadline after a successful transfer.
  expect(Buffer.from(await stored!.arrayBuffer()).equals(Buffer.from(trace.bytes))).toBe(true);
}

// Exercise the real sender, codec and receiver with only channel delivery controlled.
for (const kind of ['main', 'preload'] as const) {
  for (const route of ['local', 'remote'] as const) {
    it(
      'normal sender ' + kind + ' after two chunks remains complete with ' + route + ' projection',
      async () => {
        const trace = await capture(2 * CHUNK_SIZE + 11, kind);
        const controls = [...trace.sender.control.sent];
        const reclassified = {
          ...trace.peer,
          connectionType: route,
          isDataTarget: route === 'local',
        };
        setState('network.connectedPeers', [reclassified]);
        expect(resolvePeerFileDelivery(reclassified, SID)).toBe('direct-local');
        expect(await canSendFileTo(trace.sender.conn, SID)).toBe(true);
        const g = await guest(trace);
        for (const frame of controls) await g.deliver(frame, 'control');
        for (const frame of trace.sender.bulk.sent.slice(0, 2)) await g.deliver(frame, 'bulk');
        expect(ramContiguousCount(trace.qid, kind === 'preload', SID)).toBe(2);
        await g.deviceList(route);
        for (const frame of trace.sender.bulk.sent.slice(2)) await g.deliver(frame, 'bulk');
        expect(ramContiguousCount(trace.qid, kind === 'preload', SID)).toBe(3);
        await assertBytes(trace);
      },
    );
  }
}

for (const chunks of [60, 64]) {
  for (const order of ['headers-first', 'bulk-first'] as const) {
    it(`admits ${chunks} normal preload chunks with ${order} channel order`, async () => {
      const trace = await capture(chunks * CHUNK_SIZE, 'preload');
      const headers = [...trace.sender.control.sent];
      const g = await guest(trace);
      if (order === 'headers-first') for (const frame of headers) await g.deliver(frame, 'control');
      for (const frame of trace.sender.bulk.sent) await g.deliver(frame, 'bulk');
      if (order === 'bulk-first') for (const frame of headers) await g.deliver(frame, 'control');
      await assertBytes(trace);
    });
  }
}

it('admits START beyond the early buffer cap and completes on the normal missing suffix', async () => {
  const trace = await capture(65 * CHUNK_SIZE, 'preload');
  const headers = [...trace.sender.control.sent];
  const g = await guest(trace);
  for (const frame of trace.sender.bulk.sent) await g.deliver(frame, 'bulk');
  for (const frame of headers) await g.deliver(frame, 'control');
  expect(getState('preload.sessionState').get(SID)).toMatchObject({
    nextExpectedChunk: 64,
    total: 65,
    finalized: false,
  });
  for (const frame of trace.sender.bulk.sent.slice(64)) await g.deliver(frame, 'bulk');
  await assertBytes(trace);
});

it('retains ordinary partial direct-file recovery after the same connection becomes remote', async () => {
  const trace = await capture(2 * CHUNK_SIZE + 11);
  const headers = [...trace.sender.control.sent];
  const g = await guest(trace);
  for (const frame of headers) await g.deliver(frame, 'control');
  for (const frame of trace.sender.bulk.sent.slice(0, 2)) await g.deliver(frame, 'bulk');
  await g.deviceList('remote');
  sendRecoveryRequest();
  await vi.advanceTimersByTimeAsync(2001);
  const controls = g.receiver.control.sent.map(
    (frame) => JSON.parse(frame as string) as Record<string, unknown>,
  );
  expect(controls).toContainEqual(
    expect.objectContaining({
      type: MSG.REQUEST_DATA_RECOVERY,
      queueItemId: A,
      sessionId: SID,
      nextChunk: 2,
    }),
  );
  for (const frame of trace.sender.bulk.sent.slice(2)) await g.deliver(frame, 'bulk');
  await assertBytes(trace);
});
