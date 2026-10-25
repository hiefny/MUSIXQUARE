/**
 * MUSIXQUARE — Transport Health
 *
 * The one read path from a data connection's transport state to the decisions
 * the host's bulk senders, preload lanes and heartbeat monitor make on it.
 * Each caller takes a snapshot with readTransportHealth() and asks one of the
 * pure predicates below instead of reading `connectionState` or
 * `iceConnectionState` itself (scripts/check-transport-health.mts). Callers
 * keep their own currency check (the connection is still the peer's current
 * one), which reads room state that this module never touches.
 *
 * A Standard-room Cloudflare connection exposes its link-liveness owner
 * (`linkLiveness`, registry RO-15). Since Phase 4 C5-8 the bulk and preload
 * predicates take the original route from that owner's phase instead of the
 * peer connection's connectionState, and the recovery lease from its deadline.
 * A connection without one (PeerJS) is read raw. The owner does not observe
 * iceConnectionState, so its disconnected, failed and closed rows still apply
 * on both paths. The heartbeat threshold follows the peer connection alone.
 */

import { RTC_INTERRUPTION_GRACE_MS } from '../core/constants.ts';
import type { DataConnection } from '../types/index.ts';

const HEARTBEAT_STALE_THRESHOLD = 8_000;
const HEARTBEAT_LIVE_TRANSPORT_GRACE = 90_000;
const HEARTBEAT_RECOVERING_TRANSPORT_GRACE = 30_000;

/** One synchronous read of a data connection's transport state. */
interface TransportHealth {
  readonly open: boolean;
  /** The link-liveness owner's phase of the original route, when the connection has one. */
  readonly link: NonNullable<DataConnection['linkLiveness']>['phase'] | undefined;
  readonly pc: RTCPeerConnectionState | undefined;
  readonly ice: RTCIceConnectionState | undefined;
  readonly data: RTCDataChannelState | undefined;
  readonly control: RTCDataChannelState | undefined;
  /** The provider's deadline for this exact ICE interruption, when it owns one. */
  readonly recoveryDeadline: number | undefined;
}

export function readTransportHealth(conn: DataConnection | null | undefined): TransportHealth {
  const owner = conn?.linkLiveness;
  return {
    open: !!conn?.open,
    link: owner?.phase,
    pc: conn?.peerConnection?.connectionState,
    ice: conn?.peerConnection?.iceConnectionState,
    data: conn?.dataChannel?.readyState,
    control: conn?.controlChannel?.readyState,
    recoveryDeadline: owner ? owner.recoveryDeadline : conn?.iceRecoveryDeadline,
  };
}

/**
 * Bulk (chunk) streaming needs an open connection and data channel, an
 * original route its owner reads live (raw: a peer connection that is not
 * disconnected, failed or closed), and ICE not disconnected, failed or
 * closed. New and connecting raw routes stay writable.
 */
export function isBulkWritable(health: TransportHealth): boolean {
  if (!health.open) return false;

  const dataChannelState = health.data;
  if (dataChannelState && dataChannelState !== 'open') return false;

  if (health.link) {
    if (health.link !== 'live') return false;
  } else {
    const pcState = health.pc;
    if (pcState === 'closed' || pcState === 'failed' || pcState === 'disconnected') return false;
  }

  // The owner does not observe ICE: its rows apply on both paths.
  const iceState = health.ice;
  if (iceState === 'closed' || iceState === 'failed' || iceState === 'disconnected') return false;

  return true;
}

/**
 * The owner holds an interruption of the original route (raw: the peer
 * connection is disconnected, or failed with an ICE restart pending), or ICE
 * is disconnected or failed; the channel itself is still open.
 */
export function isRecoverablyInterrupted(health: TransportHealth): boolean {
  if (!health.open) return false;
  const channelState = health.data;
  if (channelState && channelState !== 'open') return false;
  const routeInterrupted = health.link
    ? health.link === 'recovering'
    : health.pc === 'disconnected' || health.pc === 'failed';
  return routeInterrupted || health.ice === 'disconnected' || health.ice === 'failed';
}

/**
 * How long the host heartbeat monitor waits for a heartbeat before it fences
 * the peer: 8 s for a missing or closed transport, 30 s while the peer
 * connection is recovering, 90 s for a fully connected transport (browser
 * background timer suspension).
 */
export function heartbeatStaleThreshold(health: TransportHealth): number {
  if (!health.open) return HEARTBEAT_STALE_THRESHOLD;

  const pcState = health.pc;
  const dataState = health.data;
  const controlState = health.control;
  if (
    pcState === 'closed' ||
    pcState === 'failed' ||
    dataState === 'closed' ||
    controlState === 'closed'
  ) {
    return HEARTBEAT_STALE_THRESHOLD;
  }

  if (
    pcState === 'connected' &&
    (dataState === undefined || dataState === 'open') &&
    (controlState === undefined || controlState === 'open')
  ) {
    return HEARTBEAT_LIVE_TRANSPORT_GRACE;
  }

  if (pcState === 'disconnected' || pcState === 'connecting' || pcState === 'new') {
    return HEARTBEAT_RECOVERING_TRANSPORT_GRACE;
  }

  return HEARTBEAT_STALE_THRESHOLD;
}

/**
 * A recovery lease the heartbeat monitor honours: an open connection whose
 * data and control channels are open, inside the provider's deadline for this
 * interruption (the link-liveness owner's, when the connection has one), and
 * that deadline at most one RTC interruption grace away.
 */
export function honoursRecoveryLease(health: TransportHealth, now: number): boolean {
  const recoveryRemaining = (health.recoveryDeadline ?? 0) - now;
  return (
    health.open &&
    recoveryRemaining > 0 &&
    recoveryRemaining <= RTC_INTERRUPTION_GRACE_MS &&
    health.data === 'open' &&
    health.control === 'open'
  );
}
