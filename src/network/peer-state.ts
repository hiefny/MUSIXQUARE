/**
 * MUSIXQUARE — Peer Module Shared State & Helpers (Leaf Node)
 *
 * Contains: transport instance holder, peer slot management, ICE detection,
 * broadcast/send utilities, transport guards.
 *
 * This file is a LEAF NODE — it must NOT import from peer.ts, host.ts, or guest.ts.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MAX_GUEST_SLOTS, MSG, PEER_NAME_PREFIX } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer, delay } from '../core/timers.ts';
import { getDevicePlatform } from '../core/platform.ts';
import type {
  DataConnection,
  PeerInstance,
  AnyProtocolMsg,
  ConnectedPeer,
} from '../types/index.ts';
import { getDirectFilePeers, shouldConnectionUseDirect } from '../share/file-delivery-policy.ts';

// ─── Module-scoped state ────────────────────────────────────────────
let peer: PeerInstance | null = null;

// ─── Public Getters / Setters ───────────────────────────────────────
export function getPeer(): PeerInstance | null {
  return peer;
}
export function setPeer(p: PeerInstance | null): void {
  peer = p;
}

// ─── ICE Connection Type Detection ──────────────────────────────────

const ICE_POLL_INTERVAL_MS = 200;
const ICE_POLL_ATTEMPTS = 50;
const REMOTE_SELECTED_STABLE_SAMPLES = 8;

interface IceCandidatePairInfo {
  id: string;
  localType?: string;
  remoteType?: string;
  selected: boolean;
  nominated: boolean;
}

function readStatsString(report: unknown, key: string): string | undefined {
  const value = (report as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readStatsBoolean(report: unknown, key: string): boolean {
  return (report as Record<string, unknown> | undefined)?.[key] === true;
}

function getSelectedCandidatePairId(stats: RTCStatsReport): string | null {
  for (const report of stats.values()) {
    if (report.type !== 'transport') continue;
    const id = readStatsString(report, 'selectedCandidatePairId');
    if (id) return id;
  }
  return null;
}

function getCandidateType(
  stats: RTCStatsReport,
  candidateId: string | undefined,
): string | undefined {
  if (!candidateId) return undefined;
  return readStatsString(stats.get(candidateId), 'candidateType');
}

function getSucceededCandidatePairs(stats: RTCStatsReport): IceCandidatePairInfo[] {
  const selectedCandidatePairId = getSelectedCandidatePairId(stats);
  const pairs: IceCandidatePairInfo[] = [];

  for (const report of stats.values()) {
    if (report.type !== 'candidate-pair') continue;
    if (readStatsString(report, 'state') !== 'succeeded') continue;

    const id = readStatsString(report, 'id') || report.id;
    pairs.push({
      id,
      localType: getCandidateType(stats, readStatsString(report, 'localCandidateId')),
      remoteType: getCandidateType(stats, readStatsString(report, 'remoteCandidateId')),
      selected: id === selectedCandidatePairId || readStatsBoolean(report, 'selected'),
      nominated: readStatsBoolean(report, 'nominated'),
    });
  }

  return pairs;
}

function getActiveCandidatePair(pairs: IceCandidatePairInfo[]): IceCandidatePairInfo | null {
  return pairs.find((pair) => pair.selected) || pairs.find((pair) => pair.nominated) || null;
}

function getPairKey(pair: IceCandidatePairInfo): string {
  return `${pair.localType || '?'}-${pair.remoteType || '?'}`;
}

function describeCandidatePairs(pairs: IceCandidatePairInfo[]): string {
  if (pairs.length <= 1) return '';
  return `, pairs=${pairs
    .map((pair) => `${getPairKey(pair)}${pair.selected ? '*' : pair.nominated ? '+' : ''}`)
    .join('/')}`;
}

function isLocalSelectedPair(pair: IceCandidatePairInfo): boolean {
  return pair.localType === 'host' && pair.remoteType === 'host';
}

export async function detectConnectionType(conn: DataConnection): Promise<'local' | 'remote'> {
  let lastRemotePairKey: string | null = null;
  let remoteStableSamples = 0;
  let lastActivePair: IceCandidatePairInfo | null = null;

  try {
    const pc = conn.peerConnection as RTCPeerConnection | undefined;
    if (!pc) return 'remote';

    // Poll up to 10 seconds for the selected ICE pair to appear and stabilize.
    for (let i = 0; i < ICE_POLL_ATTEMPTS; i++) {
      if (!conn.open) return 'remote';

      const stats = await pc.getStats();
      const succeededPairs = getSucceededCandidatePairs(stats);
      const activePair = getActiveCandidatePair(succeededPairs);

      if (activePair) {
        lastActivePair = activePair;

        if (isLocalSelectedPair(activePair)) {
          log.info(
            `[Peer] ICE (try ${i + 1}): local=${activePair.localType}, remote=${activePair.remoteType}${describeCandidatePairs(succeededPairs)}`,
          );
          return 'local';
        }

        const pairKey = getPairKey(activePair);
        remoteStableSamples = pairKey === lastRemotePairKey ? remoteStableSamples + 1 : 1;
        lastRemotePairKey = pairKey;

        if (remoteStableSamples >= REMOTE_SELECTED_STABLE_SAMPLES) {
          log.info(
            `[Peer] ICE (try ${i + 1}): local=${activePair.localType}, remote=${activePair.remoteType}${describeCandidatePairs(succeededPairs)}`,
          );
          return 'remote';
        }
      }

      await delay(ICE_POLL_INTERVAL_MS);
    }
  } catch (e) {
    log.debug('[Peer] ICE stats unavailable or failed', e);
  }

  if (lastActivePair) {
    log.info(
      `[Peer] ICE timeout fallback: local=${lastActivePair.localType}, remote=${lastActivePair.remoteType}`,
    );
  }
  return 'remote';
}

// ─── Peer Slot Management ───────────────────────────────────────────

export function getPeerLabelBySlot(slot: number): string {
  return `${PEER_NAME_PREFIX} ${slot}`;
}

export function getAvailablePeerSlot(
  preferredSlot: number | null,
  peerId: string | null,
): number | null {
  const peerSlots = getState('network.peerSlots');
  const pref = Number(preferredSlot);
  if (Number.isInteger(pref) && pref >= 1 && pref <= MAX_GUEST_SLOTS) {
    const occupant = peerSlots[pref];
    if (!occupant || occupant === peerId) return pref;
  }
  for (let i = 1; i <= MAX_GUEST_SLOTS; i++) {
    if (!peerSlots[i]) return i;
  }
  return null;
}

export function assignPeerSlot(peerId: string, slot: number): void {
  if (!peerId) return;
  const s = Number(slot);
  if (!Number.isInteger(s) || s < 1 || s > MAX_GUEST_SLOTS) return;
  const peerSlots = [...getState('network.peerSlots')];
  peerSlots[s] = peerId;
  setState('network.peerSlots', peerSlots);
  const map = new Map(getState('network.peerSlotByPeerId'));
  map.set(peerId, s);
  setState('network.peerSlotByPeerId', map);
}

export function releasePeerSlot(peerId: string): void {
  if (!peerId) return;
  const map = getState('network.peerSlotByPeerId');
  const slot = map.get(peerId);
  if (slot) {
    const peerSlots = [...getState('network.peerSlots')];
    if (peerSlots[slot] === peerId) {
      peerSlots[slot] = null;
      setState('network.peerSlots', peerSlots);
    }
  }
  const updated = new Map(map);
  updated.delete(peerId);
  setState('network.peerSlotByPeerId', updated);
}

// ─── Session Code ───────────────────────────────────────────────────

export function generateSessionCode(): string {
  // CSPRNG over Math.random(): closes Math.random()-prediction enumeration.
  // Modulo bias is ~0.004% across 900_000 outcomes — negligible for a
  // display code; a separate handshake secret is the right long-term fix.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

// ─── Broadcast Utilities ────────────────────────────────────────────

/**
 * Broadcast a message to all connected peers.
 */
export function broadcast(msg: AnyProtocolMsg, isDataOnly = false): void {
  const connectedPeers = getState('network.connectedPeers');
  connectedPeers.forEach((p) => {
    try {
      if (p.status === 'connected' && p.conn) {
        const conn = p.conn as DataConnection;
        if (conn.open) {
          if (!isDataOnly || p.isDataTarget === true) {
            conn.send(msg);
          }
        }
      }
    } catch (e) {
      log.warn(`[broadcast] Send failed for peer ${p.label || p.id}:`, e);
    }
  });
}

/**
 * Broadcast to all peers except one (used for host chat fanout).
 */
export function broadcastExcept(
  excludePeerId: string,
  msg: AnyProtocolMsg,
  isDataOnly = false,
): void {
  const connectedPeers = getState('network.connectedPeers');
  connectedPeers.forEach((p) => {
    try {
      if (p.status === 'connected' && p.conn) {
        const conn = p.conn as DataConnection;
        if (conn.open) {
          if (excludePeerId && p.id === excludePeerId) return;
          if (!isDataOnly || p.isDataTarget === true) {
            conn.send(msg);
          }
        }
      }
    } catch (e) {
      log.warn(`[broadcastExcept] Send failed for peer ${p.label || p.id}:`, e);
    }
  });
}

/**
 * Build and broadcast device list to all peers.
 */
export function broadcastDeviceList(): void {
  const myId = getState('network.myId');
  const connectedPeers = getState('network.connectedPeers');

  const list = [
    {
      id: myId,
      label: getState('network.myDeviceLabel') || 'HOST',
      status: 'connected',
      isHost: true,
      isOp: true,
      joinOrder: 0,
      memberId: getState('network.myMemberId') ?? undefined,
      memberDisplayNumber: getState('network.myMemberDisplayNumber') ?? undefined,
      isAuthenticated: getState('network.myMemberAuthenticated'),
      devicePlatform: getDevicePlatform(),
    },
    ...[...connectedPeers]
      // Transport-open handshakes reserve capacity but are not room members
      // until their exact APPLIED receipt establishes the application session.
      .filter((peer) => peer.status === 'connected')
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((p) => ({
        id: p.id,
        label: p.label,
        status: p.status,
        isHost: false,
        isOp: p.isOp,
        connectionType: (p.connectionType as string) || 'unknown',
        devicePlatform: p.devicePlatform ?? 'other',
        joinOrder: p.joinOrder,
        memberId: p.memberId,
        memberDisplayNumber: p.memberDisplayNumber,
        isAuthenticated: p.isAuthenticated,
        capabilities: p.roomCapabilities ? [...p.roomCapabilities] : undefined,
      })),
  ];

  const msg = { type: MSG.DEVICE_LIST_UPDATE, list };
  broadcast(msg);
  bus.emit('network:device-list', list);
}

/**
 * Send a message to any DataConnection safely (try/catch + open check).
 */
export function safeSend(conn: DataConnection | null | undefined, msg: AnyProtocolMsg): boolean {
  if (!conn || !conn.open) return false;
  try {
    conn.send(msg);
    return true;
  } catch {
    return false;
  }
}

export function sendToHost(msg: AnyProtocolMsg): boolean {
  const hostConn = getState('network.hostConn');
  return safeSend(hostConn, msg);
}

// ─── Transport Guard (Remote File Transfer Blocking) ────────────

/**
 * Wait for a host-side peer's connectionType to resolve from 'unknown'.
 * Returns the resolved type, or 'remote' on timeout (safety default).
 */
type ResolvedConnectionType = 'local' | 'remote';

interface ConnectionTypeWaiter {
  settleRemote: () => void;
}

let connectionTypeWaitEpoch = 0;
const connectionTypeWaiters = new Set<ConnectionTypeWaiter>();

function resolvedConnectionType(value: string | undefined): ResolvedConnectionType | null {
  return value === 'local' || value === 'remote' ? value : null;
}

function waitForResolvedConnectionType(
  timerPrefix: string,
  id: number,
  timeout: number,
  check: () => string | undefined,
): Promise<ResolvedConnectionType> {
  const intervalName = `${timerPrefix}-interval-${id}`;
  const timeoutName = `${timerPrefix}-timeout-${id}`;
  const initial = resolvedConnectionType(check());
  if (initial) return Promise.resolve(initial);

  const waitEpoch = connectionTypeWaitEpoch;
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = (): void => {
      connectionTypeWaiters.delete(waiter);
      clearManagedTimer(intervalName);
      clearManagedTimer(timeoutName);
    };
    const finish = (value: ResolvedConnectionType): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const waiter: ConnectionTypeWaiter = { settleRemote: () => finish('remote') };
    connectionTypeWaiters.add(waiter);

    setManagedTimer(
      intervalName,
      () => {
        if (settled || waitEpoch !== connectionTypeWaitEpoch) return;
        const current = resolvedConnectionType(check());
        if (current) finish(current);
      },
      100,
      { interval: true },
    );

    setManagedTimer(
      timeoutName,
      () => {
        if (settled || waitEpoch !== connectionTypeWaitEpoch) return;
        finish(resolvedConnectionType(check()) ?? 'remote');
      },
      timeout,
    );
  });
}

/** Settle every room-owned connection-type wait before global timer teardown. */
export function cancelConnectionTypeWaiters(): void {
  connectionTypeWaitEpoch += 1;
  for (const waiter of [...connectionTypeWaiters]) waiter.settleRemote();
}

let _peerConnTypeCounter = 0;
function waitForPeerConnectionType(
  peerObj: ConnectedPeer,
  timeout: number,
): Promise<ResolvedConnectionType> {
  const id = ++_peerConnTypeCounter;
  const peerId = peerObj.id; // Capture ID, not object; immutable state updates replace peer objects.

  return waitForResolvedConnectionType('peerConnType', id, timeout, () => {
    const peers = getState('network.connectedPeers');
    const current = peers.find((candidate) => candidate.id === peerId);
    return current?.connectionType;
  });
}

/**
 * Host-side transport guard: can we send file data to this peer?
 *
 * New direct assignments are never created for TURN/remote peers. Once a
 * session has frozen an exact direct DataConnection, a later ICE relabel does
 * not switch engines or drop that in-flight recipient mid-file.
 */
export async function canSendFileTo(conn: DataConnection, sessionId?: number): Promise<boolean> {
  if (!conn || !conn.open) return false;
  const connectedPeers = getState('network.connectedPeers');
  const peerObj = connectedPeers.find((p) => p.conn === conn);
  if (!peerObj) return false;

  // A transfer-session assignment is immutable. ICE stats may be relabeled
  // while the same ordered DataConnection is carrying chunks; use the frozen
  // route instead of making direct recipients disappear mid-file.
  if (sessionId !== undefined) return shouldConnectionUseDirect(conn, sessionId);

  // Orchestrator controls isDataTarget: false = no direct file data, true = host-direct
  if (peerObj.isDataTarget === false) return false;

  const type = peerObj.connectionType as string | undefined;

  // Without a frozen session, only local peers receive file data directly.
  if (type === 'local') {
    return true;
  }

  // Remote peers: blocked — file data must not flow through TURN
  if (type === 'remote') return false;

  // unknown — wait for ICE detection (up to 3s)
  const resolved = await waitForPeerConnectionType(peerObj, 3000);
  if (!conn.open) return false;
  // The orchestrator treats unresolved connections as remote.
  return resolved === 'local';
}

/**
 * Host-side: filter connectedPeers to only those eligible for file data.
 *
 * New transfers without a session still use isDataTarget + local ICE guards.
 * Session-aware callers use the frozen delivery policy instead.
 */
export function filterEligiblePeers(sessionId?: number): ConnectedPeer[] {
  if (sessionId !== undefined) return getDirectFilePeers(sessionId);
  const connectedPeers = getState('network.connectedPeers');
  return connectedPeers.filter(
    (p) =>
      p.status === 'connected' &&
      (p.conn as DataConnection)?.open &&
      p.isDataTarget === true &&
      p.connectionType === 'local',
  );
}

/**
 * Guest-side: am I a remote guest? (remote or unknown = true)
 */
export function isRemoteGuest(): boolean {
  const connType = getState('network.connectionType');
  return connType === 'remote' || connType === 'unknown';
}

/**
 * Guest-side: wait for own connectionType to resolve from 'unknown'.
 * Returns 'remote' on timeout (safety default).
 */
let _guestConnTypeCounter = 0;
export function waitForGuestConnectionType(timeout: number): Promise<'local' | 'remote'> {
  const id = ++_guestConnTypeCounter;
  return waitForResolvedConnectionType('guestConnType', id, timeout, () =>
    getState('network.connectionType'),
  );
}
