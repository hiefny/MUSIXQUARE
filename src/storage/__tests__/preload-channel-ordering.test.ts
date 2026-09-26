/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { CloudflareDataConnection } from '../../network/transport/cloudflare-signaling.ts';
import { loadPreloadedTrack } from '../../player/decode.ts';
import { initPlayback } from '../../player/playback.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import {
  getPreloadMemoryStats,
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
  unicastPreload,
} from '../preload.ts';
import {
  readStoredFile,
  resetAllStoredFiles,
  storedFileAdmissionStatsForTests,
} from '../storage.ts';

// These are transport/assembly tests, not native audio decoder tests. Keep
// the real playback waiter and resident lookup; observe its final decode handoff.
vi.mock('../../player/decode.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../player/decode.ts')>()),
  loadPreloadedTrack: vi.fn(async () => {}),
}));

const CURRENT = '30000000-0000-4000-8000-000000000001';
const NEXT = '30000000-0000-4000-8000-000000000002';
const SID = 17;
type Sender = 'unicast' | 'broadcast';
let deliveries: Promise<void>[] = [];

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  sent: Array<string | ArrayBuffer> = [];

  constructor(readonly label: string) {
    super();
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  deliver(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function connection(id: string) {
  const transport = new CloudflareDataConnection(id);
  const pc = Object.assign(new EventTarget(), {
    connectionState: 'connected',
    iceConnectionState: 'connected',
  });
  const bulk = new Channel('musixquare-data');
  const control = new Channel('musixquare-control');
  transport.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
  transport.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  return { transport, conn: transport as unknown as DataConnection, bulk, control };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  deliveries = [];
  resetState();
  bus.clear();
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  resetFileDeliveryPolicies();
  initPreload();
  initPlayback();
});

afterEach(async () => {
  await Promise.all(deliveries);
  resetPreloadReceiveAuthority();
  resetAllStoredFiles();
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
});

async function setupWire(senderMode: Sender, legacyControlEnd: boolean) {
  // Four queued 64 KiB chunks fit the sender's bounded 256 KiB bulk tail.
  // A healthy slow receiver can need longer than 10 s to receive that tail.
  const file = new File([new Uint8Array(4 * CHUNK_SIZE).fill(7)], 'next.mp3', {
    type: 'audio/mpeg',
  });
  setState('playlist.items', [
    {
      queueItemId: CURRENT,
      name: 'current.mp3',
      type: 'file',
      videoId: null,
      playlistId: null,
    },
    { queueItemId: NEXT, name: file.name, type: 'file', file, videoId: null, playlistId: null },
  ]);
  setState('playlist.currentQueueItemId', CURRENT);
  if (senderMode === 'unicast') {
    const meta = {
      queueItemId: NEXT,
      name: file.name,
      mime: file.type,
      size: file.size,
      total: 4,
      sessionId: SID,
      indexHint: 1,
    };
    setState('preload.ready', { ...meta, blob: file });
    setState('preload.activeTarget', meta);
    setState('preload.nextQueueItemId', NEXT);
  }
  const sender = connection('guest');
  await vi.advanceTimersByTimeAsync(0);
  expect(sender.conn.open).toBe(true);
  const peer: ConnectedPeer = {
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
  };
  setState('network.connectedPeers', [peer]);
  setState('network.activeHostConnByPeerId', new Map([['guest', sender.conn]]));

  // Use actual senders, priority gates, binary codec and channel selection.
  if (senderMode === 'unicast') await unicastPreload(sender.conn, file, NEXT, SID);
  else {
    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(sender.control.sent.map((frame) => JSON.parse(frame as string).type)).toEqual([
    MSG.PRELOAD_START,
  ]);
  expect(sender.bulk.sent).toHaveLength(5);
  const chunks = sender.bulk.sent.slice(0, 4);
  expect(chunks.every((frame) => frame instanceof ArrayBuffer)).toBe(true);
  const end = sender.bulk.sent[4] as string;
  expect(JSON.parse(end).type).toBe(MSG.PRELOAD_END);
  const start = sender.control.sent[0] as string;
  const sessionId = JSON.parse(start).sessionId as number;

  resetPreloadReceiveAuthority();
  resetAllStoredFiles();
  resetFileDeliveryPolicies();
  setState('files.current', null);
  setState('network.connectedPeers', []);
  const receiver = connection('host');
  await vi.advanceTimersByTimeAsync(0);
  setState('network.appRole', 'guest');
  setState('network.connectionType', 'local');
  setState('network.hostConn', receiver.conn);
  markQueueAuthorityReady(receiver.conn);
  receiver.transport.on('data', (frame) => {
    deliveries.push(handleData(frame, receiver.conn));
  });
  receiver.control.deliver(start);
  // Older clients send END on control. RTC only orders within each channel,
  // so its END can arrive before every chunk on a slower bulk channel.
  if (legacyControlEnd) receiver.control.deliver(end);
  await vi.advanceTimersByTimeAsync(0);
  return { receiver, file, sessionId, start, chunks, end };
}

type Wire = Awaited<ReturnType<typeof setupWire>>;

async function deliver(wire: Wire, chunk: string | ArrayBuffer): Promise<void> {
  wire.receiver.bulk.deliver(chunk);
  await vi.advanceTimersByTimeAsync(0);
}

async function finishHealthyTail(wire: Wire, legacyControlEnd: boolean): Promise<void> {
  for (const chunk of wire.chunks) {
    await vi.advanceTimersByTimeAsync(4_000);
    await deliver(wire, chunk);
  }
  if (!legacyControlEnd) await deliver(wire, wire.end);
}

describe.each(['unicast', 'broadcast'] as const)('%s preload channel ordering', (senderMode) => {
  it.each([false, true])(
    'assembles a healthy 16 s bulk tail with legacy control END=%s',
    async (legacyControlEnd) => {
      const wire = await setupWire(senderMode, legacyControlEnd);
      await finishHealthyTail(wire, legacyControlEnd);
      expect(getState('preload.sessionState').get(wire.sessionId)).toMatchObject({
        skipped: false,
        finalized: true,
        progress: 4,
      });
      const result = await readStoredFile(NEXT, wire.file.name, true, wire.sessionId);
      expect(result?.size).toBe(wire.file.size);
      expect(new Uint8Array(await result!.arrayBuffer())).toEqual(
        new Uint8Array(await wire.file.arrayBuffer()),
      );
      const resident = getState('preload.ready');
      expect(resident?.queueItemId).toBe(NEXT);

      // Late duplicate END cannot tear down a completed resident or ACK twice.
      wire.receiver.control.deliver(wire.end);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(getState('preload.ready')).toBe(resident);
      const replies = wire.receiver.control.sent.map((frame) => JSON.parse(frame as string));
      expect(replies.filter((frame) => frame.type === MSG.PRELOAD_ACK)).toHaveLength(1);
    },
  );

  it('hands an awaited current track to decode without restarting its healthy download', async () => {
    const wire = await setupWire(senderMode, true);
    await handleData(
      { type: MSG.PLAY_PRELOADED, queueItemId: NEXT, name: wire.file.name },
      wire.receiver.conn,
    );
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
    expect(loadPreloadedTrack).not.toHaveBeenCalled();
    await finishHealthyTail(wire, true);
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);
    expect(loadPreloadedTrack).toHaveBeenCalledOnce();
    expect(vi.mocked(loadPreloadedTrack).mock.calls[0]?.[0]).toBe(NEXT);
    expect(getState('preload.ready')?.blob.size).toBe(wire.file.size);
    await vi.advanceTimersByTimeAsync(35_000);
    const replies = wire.receiver.control.sent.map((frame) => JSON.parse(frame as string));
    expect(replies.some((frame) => frame.type === MSG.REQUEST_DATA_RECOVERY)).toBe(false);
  });
});

describe('legacy early END stall limits', () => {
  it('releases a receive with no first chunk despite repeated START and END', async () => {
    const wire = await setupWire('unicast', true);
    for (let count = 0; count < 3; count++) {
      await vi.advanceTimersByTimeAsync(9_000);
      wire.receiver.control.deliver(wire.start);
      wire.receiver.control.deliver(wire.end);
      await vi.advanceTimersByTimeAsync(0);
      expect(getState('preload.sessionState').get(wire.sessionId)?.skipped).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(2_999);
    expect(storedFileAdmissionStatsForTests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('preload.sessionState').get(wire.sessionId)?.skipped).toBe(true);
    expect(storedFileAdmissionStatsForTests()).toHaveLength(0);
    for (const chunk of wire.chunks) await deliver(wire, chunk);
    expect(await readStoredFile(NEXT, wire.file.name, true, wire.sessionId)).toBeNull();
  });

  it('expires 15 s after real progress despite duplicate END, chunks and a buffered gap', async () => {
    const wire = await setupWire('unicast', true);
    await vi.advanceTimersByTimeAsync(4_000);
    await deliver(wire, wire.chunks[0]!);
    for (let count = 0; count < 2; count++) {
      await vi.advanceTimersByTimeAsync(5_000);
      wire.receiver.control.deliver(wire.end);
      await deliver(wire, wire.chunks[0]!);
      await deliver(wire, wire.chunks[3]!);
      expect(getState('preload.sessionState').get(wire.sessionId)).toMatchObject({
        skipped: false,
        progress: 1,
      });
    }
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getState('preload.sessionState').get(wire.sessionId)?.skipped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(getState('preload.sessionState').get(wire.sessionId)?.skipped).toBe(true);
    expect(getPreloadMemoryStats().reorderBytes).toBe(0);
    expect(storedFileAdmissionStatsForTests()).toHaveLength(0);
  });

  it('still releases early-END storage immediately on explicit host abort', async () => {
    const wire = await setupWire('broadcast', true);
    await deliver(wire, wire.chunks[0]!);
    await handleData(
      { type: MSG.PRELOAD_ABORT, queueItemId: NEXT, sessionId: wire.sessionId },
      wire.receiver.conn,
    );
    expect(getState('preload.sessionState').get(wire.sessionId)?.skipped).toBe(true);
    expect(storedFileAdmissionStatsForTests()).toHaveLength(0);
    await finishHealthyTail(wire, true);
    expect(getState('preload.ready')).toBeNull();
    expect(getPreloadMemoryStats().reorderBytes).toBe(0);
  });
});
