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
import { LinkLiveness } from '../../network/transport/link-liveness.ts';
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
 *
 * A guest awaiting the preload takes the main FILE_START while its own route
 * is 'local' (transfer-receive.ts shouldAcceptLocalDirectFileStart), and from
 * 9.0.9 also while its route is still 'unknown' when the header names the
 * exact tuple its own recovery request asked for on that connection: the
 * host's route publication travels on the control route, and the bulk channel
 * that carries the header can overtake it. The host learns the recovered route
 * only by re-detecting it (host.ts). The paused preload therefore always
 * restarts from chunk 0 at recovery, and the main lane wins the exact tuple
 * (connection, queueItemId, sessionId) only when its stream starts after the
 * host has re-detected the guest as local and told it so, with no recovery
 * announcement since: the restart then stops at its next check and owes the
 * guest the deferred PRELOAD_ABORT for its prefix. Otherwise (the host
 * re-detects 'remote', has not re-detected yet, announced another recovery
 * after 'local', or the main header was already queued) the preload keeps
 * going as in 9.0.8: a guest that dropped the main header still plays the
 * track, and one that took it plays the main lane while the restart also
 * reaches its END, as a local guest did in 9.0.8. Until 9.0.8 both lanes
 * always carried the whole file.
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
// After recovery the host re-detects the guest's route and publishes it (device
// list, then orchestrator:peer-type-detected); a request held behind the outage
// lands one message later.
const REDETECTED_AT = RECOVER_AT + 10;
// A second recovery announcement on the same, still connected connection (a
// selected-pair change, for example a hand-over to an LTE or relay pair): the
// host resets the route to unknown again and re-detects it.
const REANNOUNCED_AT = RECOVER_AT + 12;
const REDETECTED_AGAIN_AT = RECOVER_AT + 20;
const LATE_REQUEST_AT = RECOVER_AT + 30;
// The owner-view path (OwnerView): the original route's ICE restart is in
// flight and reads connecting when a selected-pair change reports recovery,
// and the host may re-detect and publish a route before the owner hears
// connected at RECOVER_AT.
const CONNECTING_AT = RECOVER_AT - 1_000;
const CONNECTING_REDETECTED_AT = CONNECTING_AT + 10;

type Frame = Record<string, unknown>;
interface Sent {
  readonly at: number;
  readonly frame: Frame;
}
type RequestArrival = 'during-outage' | 'after-recovery';
/** The host's re-detected route for the guest after recovery; 'pending' never resolves here. */
type HostRoute = 'local' | 'remote' | 'pending';

/**
 * The owner-view path (Phase 4 C5-8). Without it the connection has no
 * link-liveness owner and transport health reads the peer connection's own
 * state (the PeerJS path). With it a real LinkLiveness, as every Cloudflare
 * connection exposes it, hears each original-route transition, and its
 * `recovered` port is the connection's 'ice-recovered' on connected. Before
 * that, the restarted route reads connecting when a selected-pair change
 * reports recovery (the connection's other 'ice-recovered').
 */
interface OwnerView {
  /** The route the host re-detects and publishes after that report, before connected. */
  readonly publishedWhileConnecting: HostRoute;
}

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

/**
 * The host, driven through the real preload, file-send and recovery modules.
 * `reannounced` adds a second recovery announcement after the first route was
 * published, with the route that re-detection then publishes. `view` reads
 * the connection through its link-liveness owner (OwnerView).
 */
async function runHost(
  requestArrives: RequestArrival,
  route: HostRoute = 'local',
  reannounced?: HostRoute,
  view?: OwnerView,
) {
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
  const original = pc as unknown as RTCPeerConnection;
  let liveness: LinkLiveness | null = null;
  // One original-route transition, heard by the owner on the view path.
  const routeChanged = (state: RTCPeerConnectionState, ice: RTCIceConnectionState): void => {
    pc.connectionState = state;
    pc.iceConnectionState = ice;
    liveness?.routeChanged(original);
  };
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
        routeChanged('disconnected', 'disconnected');
      }
    }),
  } as unknown as DataConnection;
  const reclassify = (connectionType: ConnectedPeer['connectionType']) =>
    setState(
      'network.connectedPeers',
      getState('network.connectedPeers').map((candidate) =>
        candidate.conn === conn ? { ...candidate, connectionType } : candidate,
      ),
    );
  // host.ts on the connection's 'ice-recovered': announce the recovery, then
  // reclassify the route as unknown until its re-detection publishes the result.
  const announce = (): void => {
    bus.emit('network:peer-ice-recovered', conn);
    reclassify('unknown');
  };
  if (view) {
    const owner: LinkLiveness = new LinkLiveness('ice-recovery-bulk-lanes-grace', {
      route: () => original,
      open: () => conn.open,
      snapshot: () => ({ original, side: undefined, channelsOpen: true, sideChannelDown: false }),
      ping: () => undefined,
      close: () => {
        owner.stop();
        conn.open = false;
      },
      changed: () => undefined,
      sideMayRestart: () => undefined,
      recovered: announce,
    });
    owner.binding = 'negotiation_ice_recovery_bulk_lanes_01';
    Object.assign(conn, { linkLiveness: owner });
    liveness = owner;
  }
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
  const advanceTo = (at: number) =>
    vi.advanceTimersByTimeAsync(Math.max(0, at - (Date.now() - t0)));
  if (view) {
    // The owner still holds the interruption: the report announces a recovery
    // that resumes nothing (transport health reads the phase as recovering).
    await advanceTo(CONNECTING_AT);
    routeChanged('connecting', 'checking');
    announce();
    if (view.publishedWhileConnecting !== 'pending') {
      await advanceTo(CONNECTING_REDETECTED_AT);
      reclassify(view.publishedWhileConnecting);
      bus.emit('orchestrator:peer-type-detected', GUEST_PEER, false);
    }
  }
  await advanceTo(RECOVER_AT);

  channel.bufferedAmount = 0;
  routeChanged('connected', 'connected');
  // On the owner-view path the owner's recovered port has announced it.
  if (!liveness) announce();
  if (route !== 'pending') {
    await advanceTo(REDETECTED_AT);
    reclassify(route);
    bus.emit('orchestrator:peer-type-detected', GUEST_PEER, false);
  }
  if (reannounced) {
    // The connection stays connected; host.ts announces again, then resets.
    // On the owner-view path this is a selected-pair change on a live route.
    await advanceTo(REANNOUNCED_AT);
    announce();
    if (reannounced !== 'pending') {
      await advanceTo(REDETECTED_AGAIN_AT);
      reclassify(reannounced);
      bus.emit('orchestrator:peer-type-detected', GUEST_PEER, false);
    }
  }
  if (requestArrives === 'after-recovery') {
    // Held behind the outage, the request lands one message after recovery.
    await advanceTo(LATE_REQUEST_AT);
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

type HostRun = Awaited<ReturnType<typeof runHost>>;

const MAIN_LANE = [
  MSG.FILE_START,
  `${MSG.FILE_CHUNK} #0`,
  `${MSG.FILE_CHUNK} #1`,
  `${MSG.FILE_CHUNK} #2`,
  MSG.FILE_END,
];

/**
 * The restart yields to a main-lane stream that started after the host's last
 * publication of 'local' (at `publishedAt`): it stops at its next check and
 * owes the guest one deferred PRELOAD_ABORT.
 */
function expectRestartYielded({ sent, sid, evidence }: HostRun, publishedAt: number): void {
  // Every frame carries the same tuple on the guest's single connection.
  for (const { frame } of sent) {
    expect(frame).toMatchObject({ queueItemId: NEXT, sessionId: sid });
  }
  // The paused lane restarts at recovery and stops at its next check once
  // the main lane takes the tuple.
  expect(lane(sent, 'preload-')).toEqual([
    MSG.PRELOAD_START,
    `${MSG.PRELOAD_CHUNK} #0`,
    `${MSG.PRELOAD_START} restart`,
    `${MSG.PRELOAD_CHUNK} #0`,
    `${MSG.PRELOAD_CHUNK} #1`,
    MSG.PRELOAD_ABORT,
  ]);
  expect(lane(sent, 'file-')).toEqual(MAIN_LANE);
  const mainStart = sent.find(({ frame }) => frame.type === MSG.FILE_START)!;
  expect(mainStart.frame).toMatchObject({ startChunk: 0, total: 3, size: PAYLOAD.length });
  expect(mainStart.at).toBeGreaterThan(publishedAt);
  const restart = sent.find(({ frame }) => frame.restart === true)!;
  expect(restart.at).toBe(RECOVER_AT);
  expect(restart.frame).toMatchObject({ skipped: false, total: 3, size: PAYLOAD.length });
  expect(sent.indexOf(restart)).toBeLessThan(sent.indexOf(mainStart));

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

  // Host console (`?mxqrLog=info`): Paused, Resuming, then one Yielding line,
  // each at info with the guest's PeerID alone.
  expect(evidence).toEqual([PAUSED, RESUMING, YIELDING].map((line) => ['info', line]));
}

/** The 9.0.8 wire: the restart reaches its END beside the main lane, with no abort. */
function expectRestartKept({ sent, sid, evidence }: HostRun, mainStartAt: number): void {
  for (const { frame } of sent) {
    expect(frame).toMatchObject({ queueItemId: NEXT, sessionId: sid });
  }
  expect(lane(sent, 'preload-')).toEqual([
    MSG.PRELOAD_START,
    `${MSG.PRELOAD_CHUNK} #0`,
    `${MSG.PRELOAD_START} restart`,
    `${MSG.PRELOAD_CHUNK} #0`,
    `${MSG.PRELOAD_CHUNK} #1`,
    `${MSG.PRELOAD_CHUNK} #2`,
    MSG.PRELOAD_END,
  ]);
  expect(lane(sent, 'file-')).toEqual(MAIN_LANE);
  const restart = sent.find(({ frame }) => frame.restart === true)!;
  expect(restart.at).toBe(RECOVER_AT);
  const mainStart = sent.find(({ frame }) => frame.type === MSG.FILE_START)!;
  expect(mainStart.at).toBe(mainStartAt);
  expect(sent.some(({ frame }) => frame.type === MSG.PRELOAD_ABORT)).toBe(false);
  expect(evidence).toEqual([PAUSED, RESUMING].map((line) => ['info', line]));
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

/**
 * After a yield: playback takes the main lane, and the yielded preload is
 * released, never activated, with no second resident copy.
 */
async function expectGuestPlayedSurvivingMainLane(
  outgoing: readonly Frame[],
  sid: number,
): Promise<void> {
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
  expect(outgoing.slice(1)).toEqual([{ type: MSG.PRELOAD_ACK, queueItemId: NEXT, sessionId: sid }]);
}

/**
 * A guest that is remote at the main FILE_START drops it and plays the
 * restarted preload: its one usable stream, as in 9.0.8.
 */
async function expectGuestPlaysRestartedPreload(
  { sent, sid, request }: HostRun,
  guestRoute: 'remote',
): Promise<void> {
  resetAll();
  initRoom();
  const guest = await guestAwaitingPromotedPreload(sent, request);
  setState('network.connectionType', guestRoute);

  const resumed = afterOutage(sent);
  const mainStart = resumed.findIndex(({ frame }) => frame.type === MSG.FILE_START);
  const preloadEnd = resumed.findIndex(({ frame }) => frame.type === MSG.PRELOAD_END);
  expect(preloadEnd, 'the restarted preload reaches its END').toBeGreaterThan(mainStart);
  await guest.deliver(resumed.slice(0, mainStart + 1));
  // Not local at the header: the guest drops it and keeps awaiting the preload.
  expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
  expect(getState('transfer.state')).not.toBe(TRANSFER_STATE.RECEIVING);

  // The restarted preload completes and the guest activates it.
  await guest.deliver(resumed.slice(mainStart + 1, preloadEnd + 1));
  expect(vi.mocked(loadPreloadedTrack)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(loadPreloadedTrack).mock.calls[0]![0]).toBe(NEXT);
  expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);
  expect(getState('preload.sessionState').get(sid)).toMatchObject({
    finalized: true,
    skipped: false,
    progress: 3,
  });
  await guest.deliver(resumed.slice(preloadEnd + 1));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(getState('playback.lifecycle')).not.toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
  expect(guest.outgoing.filter(({ type }) => type === MSG.REQUEST_DATA_RECOVERY)).toHaveLength(1);
}

/**
 * A guest that takes the main FILE_START plays the main lane, and the kept
 * restart also reaches its END, as for a local guest in 9.0.8. When the main
 * header came first, the guest keeps that preload as a second resident copy;
 * when the restart header came first, the main header retired the preload
 * target and the guest keeps no preload copy.
 */
async function expectGuestPlaysMainLaneBesideKeptRestart(
  { sent, sid, request }: HostRun,
  guestRoute: 'local' | 'unknown',
): Promise<void> {
  resetAll();
  initRoom();
  const guest = await guestAwaitingPromotedPreload(sent, request);
  setState('network.connectionType', guestRoute);

  const resumed = afterOutage(sent);
  const mainStart = resumed.findIndex(({ frame }) => frame.type === MSG.FILE_START);
  const restartStart = resumed.findIndex(({ frame }) => frame.restart === true);
  expect(
    resumed.some(({ frame }) => frame.type === MSG.PRELOAD_END),
    'the host kept the restart',
  ).toBe(true);
  await guest.deliver(resumed.slice(0, mainStart + 1));
  // The guest takes the header: its route is local, or the header names the
  // exact tuple its own recovery request asked for.
  expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
  expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);
  await guest.deliver(resumed.slice(mainStart + 1));
  await vi.advanceTimersByTimeAsync(1_000);

  expect(vi.mocked(loadPreloadedTrack)).not.toHaveBeenCalled();
  expect(vi.mocked(finalizeGuestFile)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(finalizeGuestFile)).toHaveBeenCalledWith(expect.any(File), NEXT, sid);
  expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DECODING);
  expect(await storedBytesEqual(false, sid)).toBe(true);
  expect(getState('preload.sessionState').get(sid)).toMatchObject({
    finalized: true,
    skipped: false,
    progress: 3,
  });
  if (mainStart < restartStart) {
    expect(getState('preload.ready')).toMatchObject({
      queueItemId: NEXT,
      sessionId: sid,
      size: PAYLOAD.length,
    });
    expect(await storedBytesEqual(true, sid)).toBe(true);
  } else {
    expect(getState('preload.ready')).toBeNull();
    expect(await readStoredFile(NEXT, NAME, true, sid)).toBeNull();
    expect(storedFileAdmissionStatsForTests()).toEqual([
      expect.objectContaining({ queueItemId: NEXT, isPreload: false, sessionId: sid }),
    ]);
  }
  expect(guest.outgoing.slice(1)).toEqual([
    { type: MSG.PRELOAD_ACK, queueItemId: NEXT, sessionId: sid },
  ]);
}

describe('one stream per tuple after ICE recovery (C5-12, P4-D10 A)', () => {
  it('the restarted preload yields to a main lane that starts after the host re-detects the guest as local', async () => {
    expectRestartYielded(await runHost('after-recovery', 'local'), REDETECTED_AT);
  });

  // The guest takes the main header only while its own route is local. Without
  // a host re-detection of 'local' before the main lane started, the host
  // cannot know the guest took it, so the restart runs to its END (9.0.8).
  it.each([
    // The header was queued into the outage, before any post-recovery route.
    { arrival: 'during-outage', route: 'local' },
    { arrival: 'during-outage', route: 'remote' },
    { arrival: 'after-recovery', route: 'remote' },
    { arrival: 'during-outage', route: 'pending' },
    { arrival: 'after-recovery', route: 'pending' },
  ] as const)(
    'the restarted preload keeps going when the request arrives $arrival and the host re-detects $route',
    async ({ arrival, route }) => {
      expectRestartKept(
        await runHost(arrival, route),
        arrival === 'during-outage' ? REQUEST_AT : LATE_REQUEST_AT,
      );
    },
  );

  // A second recovery announcement on the same connection (a selected-pair
  // change while it stays connected) resets the host's route after 'local' was
  // published, and the guest resets its own. A guest that then re-detects
  // 'remote', or is still re-detecting, drops the main header, so the published
  // 'local' no longer lets the restart yield.
  it.each(['remote', 'pending'] as const)(
    'the restarted preload keeps going when a second recovery announcement after local re-detects %s',
    async (reannounced) => {
      expectRestartKept(await runHost('after-recovery', 'local', reannounced), LATE_REQUEST_AT);
    },
  );

  it('the restarted preload yields again once the host re-publishes local after a second announcement', async () => {
    expectRestartYielded(await runHost('after-recovery', 'local', 'local'), REDETECTED_AGAIN_AT);
  });
});

/**
 * The same host rows through the connection's link-liveness owner (Phase 4
 * C5-8, OwnerView). The selected-pair report while the restart reads
 * connecting resumes nothing (no restarted lane exists yet to revoke); the
 * owner's connected restarts the lane as route-pending, and only a 'local'
 * published after that lets it yield. A later announcement on the live route
 * revokes the yield as on the raw path. A revocation while the owner holds a
 * new interruption has no row of its own: the restarted lane then pauses at
 * its next check (canContinue asks suspendPreloadPeer before the yield), and
 * the next connected restarts a fresh route-pending lane.
 */
describe('one stream per tuple through the link-liveness owner view (C5-8)', () => {
  const NOT_PUBLISHED: OwnerView = { publishedWhileConnecting: 'pending' };

  /** The connecting report resumed nothing: no preload frame until the owner's connected. */
  function expectNothingResumedWhileConnecting({ sent }: HostRun): void {
    expect(
      sent.filter(
        ({ at, frame }) =>
          at >= CONNECTING_AT && at < RECOVER_AT && String(frame.type).startsWith('preload-'),
      ),
    ).toEqual([]);
  }

  it.each(['pending', 'local'] as const)(
    'the restarted preload waits for its owner to hear connected, then yields to a main lane that starts after the host re-detects the guest as local (published while connecting: %s)',
    async (publishedWhileConnecting) => {
      const run = await runHost('after-recovery', 'local', undefined, {
        publishedWhileConnecting,
      });
      expectNothingResumedWhileConnecting(run);
      expectRestartYielded(run, REDETECTED_AT);
    },
  );

  // A 'local' published before the owner's connected settles no lane: the
  // lane restarts only then, as route-pending, and the announcement resets the
  // route, so it waits for the next publication.
  it('the restarted preload keeps going when the host published local only while the route read connecting', async () => {
    const run = await runHost('after-recovery', 'pending', undefined, {
      publishedWhileConnecting: 'local',
    });
    expectNothingResumedWhileConnecting(run);
    expectRestartKept(run, LATE_REQUEST_AT);
  });

  it.each([
    { arrival: 'during-outage', route: 'local' },
    { arrival: 'during-outage', route: 'remote' },
    { arrival: 'after-recovery', route: 'remote' },
    { arrival: 'during-outage', route: 'pending' },
    { arrival: 'after-recovery', route: 'pending' },
  ] as const)(
    'the restarted preload keeps going through the owner view when the request arrives $arrival and the host re-detects $route',
    async ({ arrival, route }) => {
      const run = await runHost(arrival, route, undefined, NOT_PUBLISHED);
      expectNothingResumedWhileConnecting(run);
      expectRestartKept(run, arrival === 'during-outage' ? REQUEST_AT : LATE_REQUEST_AT);
    },
  );

  it.each(['remote', 'pending'] as const)(
    'the restarted preload keeps going through the owner view when a second recovery announcement after local re-detects %s',
    async (reannounced) => {
      const run = await runHost('after-recovery', 'local', reannounced, NOT_PUBLISHED);
      expectNothingResumedWhileConnecting(run);
      expectRestartKept(run, LATE_REQUEST_AT);
    },
  );

  it('the restarted preload yields again through the owner view once the host re-publishes local after a second announcement', async () => {
    const run = await runHost('after-recovery', 'local', 'local', NOT_PUBLISHED);
    expectNothingResumedWhileConnecting(run);
    expectRestartYielded(run, REDETECTED_AGAIN_AT);
  });
});

describe('the guest under one stream per tuple', () => {
  it('plays the surviving main lane with no second resident copy', async () => {
    const { sent, sid, request } = await runHost('after-recovery', 'local');
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

    await expectGuestPlayedSurvivingMainLane(guest.outgoing, sid);
  });

  // Codex P2 on #487 (RO-18 path 1). The guest's request was in flight when
  // the host published 'local', so the host lets the restart yield. The host
  // sends that publication (the device list) on the control route and the main
  // FILE_START on the independently ordered bulk channel, so the header can
  // overtake it while the guest's own route is still 'unknown' from its
  // recovery reset. The header names the exact tuple the guest's own recovery
  // request asked for on that connection, so the guest takes it.
  it('takes the main lane it asked for when the header overtakes the local route publication', async () => {
    const { sent, sid, request } = await runHost('after-recovery', 'local');
    resetAll();
    initRoom();
    const guest = await guestAwaitingPromotedPreload(sent, request);
    // The guest's own ice-recovered reset its route; the host's device list
    // carrying 'local' is still in flight on the control route.
    setState('network.connectionType', 'unknown');

    // Bulk frames up to and including the main header arrive first.
    const resumed = afterOutage(sent);
    const mainStart = resumed.findIndex(({ frame }) => frame.type === MSG.FILE_START);
    expect(resumed.slice(mainStart).some(({ frame }) => frame.type === MSG.PRELOAD_ABORT)).toBe(
      true,
    );
    await guest.deliver(resumed.slice(0, mainStart + 1));
    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.DOWNLOADING);
    expect(getState('playback.loadSource')).toBe(LOAD_SOURCE.FRESH);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);

    // The overtaken device list lands: the guest adopts the host's 'local'.
    // The abort follows it, sent later on the same control route.
    setState('network.connectionType', 'local');
    await guest.deliver(resumed.slice(mainStart + 1));
    await vi.advanceTimersByTimeAsync(1_000);

    await expectGuestPlayedSurvivingMainLane(guest.outgoing, sid);
  });

  // The exception is the guest's own request and nothing wider: with its route
  // still unknown, a guest awaiting the preload drops a main FILE_START it did
  // not ask for, one before its stall waiter asks or one for another session
  // of the same queue item, as in 9.0.8.
  it.each(['before its request', 'for another session'] as const)(
    'drops a main FILE_START %s while its route is unknown',
    async (variant) => {
      const { sent, sid, request } = await runHost('after-recovery', 'local');
      const mainStart = sent.find(({ frame }) => frame.type === MSG.FILE_START)!;
      resetAll();
      initRoom();
      let guest: ReturnType<typeof becomeGuest>;
      let header: Frame;
      if (variant === 'before its request') {
        guest = becomeGuest();
        await guest.deliver([...sent.slice(0, 2), PLAY]);
        await guest.advanceTo(REQUEST_AT - 2);
        header = mainStart.frame;
      } else {
        guest = await guestAwaitingPromotedPreload(sent, request);
        header = { ...mainStart.frame, sessionId: sid + 1 };
      }
      setState('network.connectionType', 'unknown');
      await guest.deliver([{ at: 0, frame: header }]);

      expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.AWAITING_PRELOAD);
      expect(getState('transfer.state')).not.toBe(TRANSFER_STATE.RECEIVING);
      expect(storedFileAdmissionStatsForTests().filter((a) => !a.isPreload)).toEqual([]);
      expect(guest.outgoing.filter(({ type }) => type === MSG.REQUEST_DATA_RECOVERY)).toHaveLength(
        variant === 'before its request' ? 0 : 1,
      );
    },
  );

  // PRELOAD_ABORT travels on the control route and the bulk frames on the bulk
  // route, so the abort can overtake every bulk frame sent after recovery,
  // the restart header included (the C5-0 lab's usual order).
  it('a PRELOAD_ABORT that overtakes the bulk frames leaves the main lane intact', async () => {
    const { sent, sid, request } = await runHost('after-recovery', 'local');
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

    // Known limit (RO-18): the restart START came after the abort, so the guest
    // admitted the restart as an explicit retry and holds an orphan partial
    // prefix. Nothing finishes it; the existing progress watchdog releases it
    // once the main lane stops advancing (two progress deadlines), never
    // activating it.
    const preloadLeases = () => storedFileAdmissionStatsForTests().filter((a) => a.isPreload);
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
  });

  // A guest awaiting the preload drops the main FILE_START and its chunks
  // while its own route is remote when the header arrives. Its 10 s stall
  // waiter has already asked once, and nothing else asks again, so the
  // restarted preload is its one usable stream.
  it.each([
    { arrival: 'during-outage', hostRoute: 'remote', guestRoute: 'remote' },
    { arrival: 'after-recovery', hostRoute: 'remote', guestRoute: 'remote' },
  ] as const)(
    'plays the restarted preload when its route is $guestRoute at the main FILE_START (request $arrival, host re-detects $hostRoute)',
    async ({ arrival, hostRoute, guestRoute }) => {
      await expectGuestPlaysRestartedPreload(await runHost(arrival, hostRoute), guestRoute);
    },
  );

  // The second recovery announcement after 'local' was published: the guest
  // resets and re-detects its own route as well, and is remote at the main
  // header when it re-detects 'remote'.
  it.each([{ reannounced: 'remote', guestRoute: 'remote' }] as const)(
    'plays the restarted preload when its route is $guestRoute at the main FILE_START after a second recovery announcement (host re-detects $reannounced)',
    async ({ reannounced, guestRoute }) => {
      await expectGuestPlaysRestartedPreload(
        await runHost('after-recovery', 'local', reannounced),
        guestRoute,
      );
    },
  );

  // The host kept the restart, and the guest takes the main header: its route
  // is local again, or still unknown while the header names the exact tuple its
  // own recovery request asked for. It plays the main lane and the restarted
  // preload also reaches its END, as for a local guest in 9.0.8 (a second
  // resident copy when the main header came first).
  it.each([
    // The header queued into the outage reached a guest already local again.
    { arrival: 'during-outage', hostRoute: 'local', guestRoute: 'local' },
    // The same header reached the guest before it learned its recovered route.
    { arrival: 'during-outage', hostRoute: 'local', guestRoute: 'unknown' },
    { arrival: 'during-outage', hostRoute: 'pending', guestRoute: 'unknown' },
    // The restart header came first: a local guest (9.0.8) and an unknown one
    // end the same way.
    { arrival: 'after-recovery', hostRoute: 'pending', guestRoute: 'local' },
    { arrival: 'after-recovery', hostRoute: 'pending', guestRoute: 'unknown' },
  ] as const)(
    'plays the main lane beside the kept restart when its route is $guestRoute at the main FILE_START it asked for (request $arrival, host re-detects $hostRoute)',
    async ({ arrival, hostRoute, guestRoute }) => {
      await expectGuestPlaysMainLaneBesideKeptRestart(
        await runHost(arrival, hostRoute),
        guestRoute,
      );
    },
  );

  // A second recovery announcement after 'local', still re-detecting on both
  // sides: the host kept the restart and the guest is unknown at the header.
  it('plays the main lane beside the kept restart when its route is unknown at the main FILE_START it asked for after a second recovery announcement (host re-detects pending)', async () => {
    await expectGuestPlaysMainLaneBesideKeptRestart(
      await runHost('after-recovery', 'local', 'pending'),
      'unknown',
    );
  });
});
