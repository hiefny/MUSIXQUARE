/** @vitest-environment jsdom */
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_SIZE,
  LOAD_SOURCE,
  MSG,
  PLAYBACK_STATE,
  PRELOAD_RECEIVE_DEADLINE_MS,
  TRANSFER_STATE,
} from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { finalizeGuestFile, loadPreloadedTrack } from '../../player/decode.ts';
import { initPlayback } from '../../player/playback.ts';
import { resetFileDeliveryPolicies } from '../../share/file-delivery-policy.ts';
import type { ConnectedPeer, DataConnection, PlaylistItem } from '../../types/index.ts';
import {
  cancelPreloadTransfer,
  initPreload,
  resetPreloadReceiveAuthority,
  schedulePreload,
} from '../preload.ts';
import { initRecovery, resetRecoveryAuthority } from '../recovery.ts';
import {
  readStoredFile,
  resetAllStoredFiles,
  storedFileAdmissionStatsForTests,
} from '../storage.ts';
import { initTransfer, resetIncomingTransferAuthority } from '../transfer.ts';
import { cancelOutgoingFileTransfers } from '../transfer-send.ts';

/**
 * One stream per tuple after ICE recovery (RO-18, host-to-guest bulk lanes;
 * C5-12, owner decision P4-D10 A). A local guest is preloading the next track
 * when its original route drops; the host advances to that track during the
 * outage, and the guest's stall request asks for it on the main file lane.
 * The main lane wins the exact tuple (connection, queueItemId, sessionId): the
 * paused preload yields instead of restarting from chunk 0, or stops as soon as
 * the main lane takes the tuple if it had already resumed, and owes the guest
 * the deferred PRELOAD_ABORT for its prefix. Until 9.0.8 both lanes carried the
 * whole file after recovery.
 */

// Native decode alone is stubbed. The guest's choice stays observable: the main
// lane ends in finalizeGuestFile, an awaited preload in loadPreloadedTrack.
vi.mock('../../player/decode.ts', async (original) => ({
  ...(await original<typeof import('../../player/decode.ts')>()),
  finalizeGuestFile: vi.fn(async () => {}),
  loadPreloadedTrack: vi.fn(async () => true),
}));

const CURRENT = '30000000-0000-4000-8000-000000000001';
const NEXT = '30000000-0000-4000-8000-000000000002';
const NAME = 'next.mp3';
const GUEST_PEER = 'mx-guest-bulk';
// Host /debug console lines for this guest (`?mxqrLog=info`). Paused and
// Resuming are frozen device evidence; Yielding is the C5-12 line.
const PAUSED = `[Preload] Paused preload for ${GUEST_PEER} while its connection is interrupted`;
const RESUMING = `[Preload] Resuming preload for ${GUEST_PEER} after its connection recovered`;
const YIELDING = `[Preload] Yielding preload for ${GUEST_PEER} to its file transfer after its connection recovered`;
const PAYLOAD = Uint8Array.from({ length: CHUNK_SIZE * 3 }, (_, i) => (i * 31 + 7) % 251);

// One timeline, in ms after the first PRELOAD_START. The route drops right after
// the first preload chunk. The host advances at PLAY_AT; PLAY_PRELOADED reaches
// the guest on the control route, and its 10 s preload stall waiter asks for
// the file. Bulk frames sent during the outage arrive once the route recovers.
const PLAY_AT = 500;
const REQUEST_AT = PLAY_AT + 10_000;
const RECOVER_AT = REQUEST_AT + 1_500;

type Frame = Record<string, unknown>;
interface Sent {
  readonly at: number;
  readonly frame: Frame;
}
type RequestArrival = 'during-outage' | 'after-recovery';

const PLAY: Sent = {
  at: PLAY_AT,
  frame: { type: MSG.PLAY_PRELOADED, queueItemId: NEXT, name: NAME, mime: 'audio/mpeg' },
};

function hostItem(queueItemId: string, file: File): PlaylistItem {
  return { queueItemId, file, name: file.name, type: 'file', videoId: null, playlistId: null };
}

function guestItem(queueItemId: string, name: string): PlaylistItem {
  return { queueItemId, name, type: 'file', videoId: null, playlistId: null };
}

function resetAll(): void {
  cancelPreloadTransfer();
  cancelOutgoingFileTransfers();
  resetRecoveryAuthority();
  resetAllStoredFiles();
  resetPreloadReceiveAuthority();
  resetIncomingTransferAuthority();
  resetFileDeliveryPolicies();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.mocked(finalizeGuestFile).mockClear();
  vi.mocked(loadPreloadedTrack).mockClear();
}

function initRoom(): void {
  initTransfer();
  initPreload();
  initPlayback();
  initRecovery();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAll();
  initRoom();
});

afterEach(async () => {
  resetAll();
  await vi.advanceTimersByTimeAsync(100);
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The host, driven through the real preload, file-send and recovery modules. */
async function runHost(requestArrives: RequestArrival) {
  const sent: Sent[] = [];
  // Every preload lane line the host logs for this guest, with its level.
  const evidence: unknown[][] = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes(`preload for ${GUEST_PEER}`))
        evidence.push([level, ...args]);
    });
  }
  const channel = { readyState: 'open', bufferedAmount: 0 };
  const pc: { connectionState: RTCPeerConnectionState; iceConnectionState: RTCIceConnectionState } =
    { connectionState: 'connected', iceConnectionState: 'connected' };
  const t0 = Date.now();
  const conn = {
    open: true,
    peer: GUEST_PEER,
    dataChannel: channel,
    peerConnection: pc,
    reportsIceRecovery: true,
    send: vi.fn((message: unknown) => {
      const frame = message as Frame;
      sent.push({ at: Date.now() - t0, frame });
      if (frame.chunk instanceof Uint8Array) channel.bufferedAmount += frame.chunk.byteLength;
      if (sent.length === 2) {
        channel.bufferedAmount = 1024 * 1024;
        pc.connectionState = 'disconnected';
        pc.iceConnectionState = 'disconnected';
      }
    }),
  } as unknown as DataConnection;
  // A live route drains one chunk per 25 ms; an interrupted one holds its backlog.
  const drain = setInterval(() => {
    if (pc.connectionState === 'connected') {
      channel.bufferedAmount = Math.max(0, channel.bufferedAmount - CHUNK_SIZE);
    }
  }, 25);
  const peer: ConnectedPeer = {
    id: conn.peer,
    conn,
    slot: 1,
    label: 'Guest',
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
  const file = new File([PAYLOAD], NAME, { type: 'audio/mpeg' });
  setState('network.appRole', 'host');
  setState('network.connectedPeers', [peer]);
  setState('network.activeHostConnByPeerId', new Map([[peer.id, conn]]));
  setState('playlist.items', [
    hostItem(CURRENT, new File(['old'], 'current.mp3')),
    hostItem(NEXT, file),
  ]);
  setState('playlist.currentQueueItemId', CURRENT);

  schedulePreload(0);
  await vi.advanceTimersByTimeAsync(PLAY_AT);
  const ready = getState('preload.ready')!;
  const sid = ready.sessionId;

  // The host's advance promotes the exact preload resident to files.current.
  setState('files.current', ready);
  setState('playlist.currentQueueItemId', NEXT);
  setState('transfer.currentSessionId', sid);
  setState('preload.nextQueueItemId', null);
  setState('preload.activeTarget', null);
  setState('preload.ready', null);
  cancelPreloadTransfer(NEXT, true);

  // The frame the guest's stall waiter sends (checked on the guest side below).
  const request: Frame = {
    type: MSG.REQUEST_DATA_RECOVERY,
    nextChunk: 0,
    fileName: NAME,
    requestId: 1,
    queueItemId: NEXT,
    sessionId: sid,
  };
  // The recovery handler settles only when its unicast does.
  let served: Promise<void> | undefined;
  await vi.advanceTimersByTimeAsync(REQUEST_AT - PLAY_AT);
  // An isolated control route can carry the request while the original is down.
  if (requestArrives === 'during-outage') served = handleData(request, conn);
  await vi.advanceTimersByTimeAsync(RECOVER_AT - REQUEST_AT);

  // host.ts order: announce the recovery, then reclassify the route.
  channel.bufferedAmount = 0;
  pc.connectionState = 'connected';
  pc.iceConnectionState = 'connected';
  bus.emit('network:peer-ice-recovered', conn);
  setState(
    'network.connectedPeers',
    getState('network.connectedPeers').map((candidate) =>
      candidate.conn === conn ? { ...candidate, connectionType: 'unknown' as const } : candidate,
    ),
  );
  if (requestArrives === 'after-recovery') {
    // Held behind the outage, the request lands one message after recovery.
    await vi.advanceTimersByTimeAsync(30);
    served = handleData(request, conn);
  }
  await vi.advanceTimersByTimeAsync(2_000);
  await served;
  clearInterval(drain);
  vi.mocked(log.debug).mockRestore();
  vi.mocked(log.info).mockRestore();
  vi.mocked(log.warn).mockRestore();
  vi.mocked(log.error).mockRestore();
  return { sent, sid, request, evidence };
}

/** Bulk frames held by the outage arrive once the route recovers. */
function afterOutage(sent: readonly Sent[]): Sent[] {
  return sent.slice(2).map(({ at, frame }) => ({ at: Math.max(at, RECOVER_AT), frame }));
}

function tag({ frame }: Sent): string {
  const index = frame.chunkIndex === undefined ? '' : ` #${String(frame.chunkIndex)}`;
  return `${String(frame.type)}${index}${frame.restart === true ? ' restart' : ''}`;
}

function lane(sent: readonly Sent[], prefix: 'preload-' | 'file-'): string[] {
  return sent.filter(({ frame }) => String(frame.type).startsWith(prefix)).map(tag);
}

/** A real guest; `deliver` replays frames from its host at their timeline offsets. */
function becomeGuest() {
  const outgoing: Frame[] = [];
  const host = {
    open: true,
    peer: 'mx-host-bulk',
    dataChannel: { readyState: 'open', bufferedAmount: 0 },
    send: vi.fn((message: unknown) => outgoing.push(message as Frame)),
  } as unknown as DataConnection;
  setState('playlist.items', [guestItem(CURRENT, 'current.mp3'), guestItem(NEXT, NAME)]);
  setState('playlist.currentQueueItemId', CURRENT);
  setState('network.appRole', 'guest');
  setState('network.hostConn', host);
  setState('network.connectionType', 'local');
  markQueueAuthorityReady(host);
  resetInboundRateLimit(host.peer);
  const t0 = Date.now();
  const advanceTo = (at: number) =>
    vi.advanceTimersByTimeAsync(Math.max(0, at - (Date.now() - t0)));
  const deliver = async (events: readonly Sent[]): Promise<void> => {
    for (const { at, frame } of events) {
      await advanceTo(at);
      await handleData(frame, host);
    }
  };
  return { outgoing, advanceTo, deliver };
}

/** Prefix, outage and stall request, common to every guest row. */
async function guestAwaitingPromotedPreload(sent: readonly Sent[], request: Frame) {
  const guest = becomeGuest();
  await guest.deliver([...sent.slice(0, 2), PLAY]);
  expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
  await guest.advanceTo(REQUEST_AT - 1);
  expect(guest.outgoing).toEqual([]);
  await guest.advanceTo(REQUEST_AT);
  expect(guest.outgoing, 'the stall waiter sends the request the host was given').toEqual([
    { ...request, requestId: expect.any(Number) },
  ]);
  return guest;
}

async function storedBytesEqual(isPreload: boolean, sid: number): Promise<boolean> {
  const stored = await readStoredFile(NEXT, NAME, isPreload, sid);
  if (!stored) return false;
  return Buffer.from(await stored.arrayBuffer()).equals(Buffer.from(PAYLOAD));
}

describe('one stream per tuple after ICE recovery (C5-12, P4-D10 A)', () => {
  it.each([
    {
      arrival: 'during-outage',
      // The main lane already holds the tuple at recovery: no resume at all.
      preloadLane: [MSG.PRELOAD_START, `${MSG.PRELOAD_CHUNK} #0`, MSG.PRELOAD_ABORT],
      lines: [PAUSED, YIELDING],
    },
    {
      arrival: 'after-recovery',
      // The resumed lane stops at its next chunk once the main lane takes the tuple.
      preloadLane: [
        MSG.PRELOAD_START,
        `${MSG.PRELOAD_CHUNK} #0`,
        `${MSG.PRELOAD_START} restart`,
        `${MSG.PRELOAD_CHUNK} #0`,
        `${MSG.PRELOAD_CHUNK} #1`,
        MSG.PRELOAD_ABORT,
      ],
      lines: [PAUSED, RESUMING, YIELDING],
    },
  ] as const)(
    'the preload yields to the main lane when the request arrives $arrival',
    async ({ arrival, preloadLane, lines }) => {
      const { sent, sid, evidence } = await runHost(arrival);

      // Every frame carries the same tuple on the guest's single connection.
      for (const { frame } of sent) {
        expect(frame).toMatchObject({ queueItemId: NEXT, sessionId: sid });
      }
      expect(lane(sent, 'preload-')).toEqual(preloadLane);
      expect(lane(sent, 'file-')).toEqual([
        MSG.FILE_START,
        `${MSG.FILE_CHUNK} #0`,
        `${MSG.FILE_CHUNK} #1`,
        `${MSG.FILE_CHUNK} #2`,
        MSG.FILE_END,
      ]);
      const mainStart = sent.find(({ frame }) => frame.type === MSG.FILE_START)!;
      expect(mainStart.frame).toMatchObject({ startChunk: 0, total: 3, size: PAYLOAD.length });

      // After recovery the whole payload crosses the connection once, on the
      // main lane; the preload never reaches its END.
      const resent = afterOutage(sent);
      const chunks = (type: string) => resent.filter(({ frame }) => frame.type === type);
      expect(chunks(MSG.FILE_CHUNK)).toHaveLength(3);
      expect(chunks(MSG.PRELOAD_CHUNK).length).toBeLessThan(3);
      expect(chunks(MSG.PRELOAD_END)).toEqual([]);

      // Deferred-abort rule: one PRELOAD_ABORT, never sent into the outage, and
      // only after the main lane announced the tuple.
      const aborts = sent.filter(({ frame }) => frame.type === MSG.PRELOAD_ABORT);
      expect(aborts).toHaveLength(1);
      expect(aborts[0]!.at).toBeGreaterThanOrEqual(RECOVER_AT);
      expect(sent.indexOf(mainStart)).toBeLessThan(sent.indexOf(aborts[0]!));
      if (arrival === 'during-outage') {
        expect(mainStart.at).toBe(REQUEST_AT);
        expect(aborts[0]!.at).toBe(RECOVER_AT);
      } else {
        const restart = sent.find(({ frame }) => frame.restart === true)!;
        expect(restart.at).toBe(RECOVER_AT);
        expect(restart.frame).toMatchObject({ skipped: false, total: 3, size: PAYLOAD.length });
        expect(sent.indexOf(restart)).toBeLessThan(sent.indexOf(mainStart));
      }

      // Host console (`?mxqrLog=info`): Resuming only where a resume happens,
      // and one Yielding line, each at info with the guest's PeerID alone.
      expect(evidence).toEqual(lines.map((line) => ['info', line]));
    },
  );
});

describe('the guest under one stream per tuple', () => {
  it.each(['during-outage', 'after-recovery'] as const)(
    'plays the surviving main lane with no second resident copy when the request arrives %s',
    async (arrival) => {
      const { sent, sid, request } = await runHost(arrival);
      resetAll();
      initRoom();
      const guest = await guestAwaitingPromotedPreload(sent, request);

      // A local guest accepts the main FILE_START while AWAITING_PRELOAD.
      const resumed = afterOutage(sent);
      const mainStart = resumed.findIndex(({ frame }) => frame.type === MSG.FILE_START);
      await guest.deliver(resumed.slice(0, mainStart + 1));
      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
      expect(getState('playback.loadSource')).toBe(LOAD_SOURCE.FRESH);
      expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
      await guest.deliver(resumed.slice(mainStart + 1));
      await vi.advanceTimersByTimeAsync(1_000);

      // Playback takes the main lane; the yielded preload is released, never activated.
      expect(vi.mocked(loadPreloadedTrack)).not.toHaveBeenCalled();
      expect(vi.mocked(finalizeGuestFile)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(finalizeGuestFile)).toHaveBeenCalledWith(expect.any(File), NEXT, sid);
      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);
      expect(await storedBytesEqual(false, sid)).toBe(true);
      expect(getState('preload.sessionState').get(sid)).toMatchObject({
        skipped: true,
        finalized: false,
      });
      expect(getState('preload.ready')).toBeNull();
      expect(getState('preload.activeTarget')).toBeNull();
      expect(await readStoredFile(NEXT, NAME, true, sid)).toBeNull();
      // Only the main lane's receive lease remains: no second copy is reserved.
      expect(storedFileAdmissionStatsForTests()).toEqual([
        expect.objectContaining({ queueItemId: NEXT, isPreload: false, sessionId: sid }),
      ]);
      // The main lane's completion is the guest's one ACK.
      expect(guest.outgoing.slice(1)).toEqual([
        { type: MSG.PRELOAD_ACK, queueItemId: NEXT, sessionId: sid },
      ]);
    },
  );

  // PRELOAD_ABORT travels on the control route and the bulk frames on the bulk
  // route, so the abort can overtake every bulk frame sent after recovery.
  it.each(['during-outage', 'after-recovery'] as const)(
    'a PRELOAD_ABORT that overtakes the bulk frames leaves the main lane intact when the request arrives %s',
    async (arrival) => {
      const { sent, sid, request } = await runHost(arrival);
      const resumed = afterOutage(sent);
      const abort = resumed.find(({ frame }) => frame.type === MSG.PRELOAD_ABORT);
      expect(abort, 'the host sends the deferred PRELOAD_ABORT').toBeDefined();
      resetAll();
      initRoom();
      const guest = await guestAwaitingPromotedPreload(sent, request);

      await guest.deliver([
        { at: RECOVER_AT, frame: abort!.frame },
        ...resumed.filter((event) => event !== abort),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(vi.mocked(loadPreloadedTrack)).not.toHaveBeenCalled();
      expect(vi.mocked(finalizeGuestFile)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(finalizeGuestFile)).toHaveBeenCalledWith(expect.any(File), NEXT, sid);
      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);
      expect(await storedBytesEqual(false, sid)).toBe(true);
      expect(getState('preload.ready')).toBeNull();
      expect(await readStoredFile(NEXT, NAME, true, sid)).toBeNull();
      expect(guest.outgoing.slice(1)).toEqual([
        { type: MSG.PRELOAD_ACK, queueItemId: NEXT, sessionId: sid },
      ]);

      const preloadLeases = () => storedFileAdmissionStatsForTests().filter((a) => a.isPreload);
      if (arrival === 'during-outage') {
        expect(getState('preload.sessionState').get(sid)).toMatchObject({ skipped: true });
        expect(preloadLeases()).toEqual([]);
      } else {
        // The restart START came after the abort, so the guest admitted the
        // restart as an explicit retry and holds its partial prefix. Nothing
        // finishes it; the existing progress watchdog releases it once the main
        // lane stops advancing (two progress deadlines), never activating it.
        expect(getState('preload.sessionState').get(sid)).toMatchObject({
          skipped: false,
          finalized: false,
          progress: 2,
        });
        expect(preloadLeases()).toEqual([
          expect.objectContaining({ queueItemId: NEXT, sessionId: sid, phase: 'assembling' }),
        ]);
        await vi.advanceTimersByTimeAsync(2 * PRELOAD_RECEIVE_DEADLINE_MS.progress);
        expect(getState('preload.sessionState').get(sid)).toMatchObject({ skipped: true });
        expect(preloadLeases()).toEqual([]);
        expect(vi.mocked(loadPreloadedTrack)).not.toHaveBeenCalled();
      }
    },
  );
});
