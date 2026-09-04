/**
 * MUSIXQUARE — Shared Backpressure-Aware Chunk Pump
 *
 * Shared by the active-file and preload broadcast senders. Centralizing the
 * loop keeps their per-peer backpressure and exclusion behavior consistent;
 * scripts/check-chunk-pump.mts prevents additional multi-peer pumps.
 *
 * Design contract:
 *   - The engine is SIDE-EFFECT-FREE with respect to the state tree: it never
 *     imports setState and its pump body reads nothing from state. The
 *     supersession/abort predicate (shouldContinue) and peer-health check
 *     (isWritable) are caller-supplied. State writes stay in the wrappers.
 *   - Each peer owns a sequential read/send loop and at most one prepared
 *     chunk. No shared backlog grows when one receiver falls behind.
 *   - Callbacks must be TOTAL (never throw). A source failure stops all
 *     unfinished peers; every loop settles before wrapper cleanup runs.
 *   - Unicast paths remain separate because they terminate on one peer's
 *     timeout and carry resume or per-peer cancellation semantics.
 */

import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { DELAY } from '../core/constants.ts';
import { delay } from '../core/timers.ts';
import { safeSend } from '../network/peer.ts';
import type { AnyProtocolMsg, ConnectedPeer, DataConnection } from '../types/index.ts';

// ─── Peer-health helpers ────────────────────────────────────────────
// These DO read the state tree — they are wrapper-supplied parameters and
// deliberately live OUTSIDE the pump body, which stays state-free.

/**
 * A peer's `conn` reference can be superseded by a reconnect. Sending bulk
 * data down a stale connection wastes bandwidth and can poison recovery, so
 * senders verify the connection is still the peer's current one.
 */
export function isPeerConnectionCurrent(peerId: string, conn: DataConnection): boolean {
  const peer = getState('network.connectedPeers').find((p) => p.id === peerId);
  if (!peer || peer.conn !== conn) return false;

  const activeConn = getState('network.activeHostConnByPeerId').get(peerId);
  return !activeConn || activeConn === conn;
}

/**
 * Health gate for bulk (chunk) streaming: open conn, open data channel,
 * live peer connection, and the connection is still the peer's current one.
 */
export function isBulkTransferWritablePeer(peer: ConnectedPeer): boolean {
  const conn = peer.conn as DataConnection | null;
  if (!conn?.open) return false;

  const dataChannelState = conn.dataChannel?.readyState;
  if (dataChannelState && dataChannelState !== 'open') return false;

  const pcState = conn.peerConnection?.connectionState;
  if (pcState === 'closed' || pcState === 'failed' || pcState === 'disconnected') return false;

  const iceState = conn.peerConnection?.iceConnectionState;
  if (iceState === 'closed' || iceState === 'failed' || iceState === 'disconnected') return false;

  return isPeerConnectionCurrent(peer.id, conn);
}

// ─── Pump Engine ─────────────────────────────────────────────────────

interface ChunkPumpOptions {
  /** Source file/blob, sliced lazily one chunk at a time per peer. */
  file: File | Blob;
  /** Chunk size in bytes (CHUNK_SIZE for all current callers). */
  chunkSize: number;
  /** Peers to stream to. Wrappers pre-filter eligibility/writability. */
  peers: ConnectedPeer[];
  /** Builds the protocol message for chunk i — header shape differs per caller. */
  buildChunkMsg: (chunk: Uint8Array, index: number) => AnyProtocolMsg;
  /** Per-peer bufferedAmount ceiling before the backpressure wait engages. */
  bufferedLimit: number;
  /** Max per-chunk wait per peer before that peer is excluded. */
  stallTimeoutMs: number;
  /**
   * Peer-health check, re-evaluated inside per-peer waits. Failing it
   * excludes the peer. Must not throw.
   */
  isWritable: (peer: ConnectedPeer) => boolean;
  /**
   * Pure supersession/abort predicate, rechecked around reads and waits.
   * Once false, the entire pump stops. Must not throw.
   */
  shouldContinue: () => boolean;
  /**
   * Fired exactly once per excluded peer, at exclusion time. Must not throw
   * (use safeSend for any message it sends) and must stay PER-PEER — never
   * escalate a single peer's exclusion to session-level teardown.
   */
  onPeerExcluded?: (peer: ConnectedPeer) => void;
  /**
   * Fired once when this peer has accepted every chunk, without waiting for
   * other peers. Wrappers send their END frame here. Must not throw.
   */
  onPeerComplete?: (peer: ConnectedPeer) => void;
  /** Ordered aggregate progress after all remaining peers accept a chunk. */
  onChunkComplete?: (index: number, byteLength: number) => void;
}

interface ChunkPumpResult {
  /**
   * `stopped` means the caller's abort/supersession predicate failed.
   * `complete` also covers the case where every peer was excluded.
   */
  status: 'complete' | 'stopped';
  /** Ids of peers excluded mid-stream (backpressure timeout / unwritable). */
  excluded: Set<string>;
}

/**
 * Stream independently to each peer, preserving that peer's chunk order.
 * Backpressure is checked before reading the next slice, so a blocked peer
 * retains no prepared backlog and cannot delay another peer's completion.
 * Exclusion is one-way: a stalled peer needs recovery for its missing suffix.
 *
 * Source errors propagate only after every peer loop has settled. Pending
 * reads cannot be cancelled, but their bytes are discarded after failure or
 * supersession, before any further send or completion callback.
 */
export async function pumpChunksToPeers(opts: ChunkPumpOptions): Promise<ChunkPumpResult> {
  const {
    file,
    chunkSize,
    peers,
    buildChunkMsg,
    bufferedLimit,
    stallTimeoutMs,
    isWritable,
    shouldContinue,
    onPeerExcluded,
    onPeerComplete,
    onChunkComplete,
  } = opts;

  const total = Math.ceil(file.size / chunkSize);
  const excluded = new Set<string>();
  let stopped = false;
  let failed = false;
  let failure: unknown;
  const nextChunks = peers.map(() => 0);
  let sentThrough = 0;
  let reportedThrough = 0;

  const reportProgress = (): void => {
    if (!onChunkComplete) return;
    const through = Math.min(sentThrough, ...nextChunks);
    while (reportedThrough < through) {
      const index = reportedThrough++;
      onChunkComplete(index, Math.min(chunkSize, file.size - index * chunkSize));
    }
  };

  const canContinue = (): boolean => {
    if (failed || stopped) return false;
    if (!shouldContinue()) stopped = true;
    return !stopped;
  };

  // Exclusion is one-way and fires the callback exactly once per peer.
  const exclude = (p: ConnectedPeer, peerIndex: number): void => {
    if (excluded.has(p.id)) return;
    excluded.add(p.id);
    onPeerExcluded?.(p);
    nextChunks[peerIndex] = total;
    reportProgress();
  };

  await Promise.all(
    peers.map(async (p, peerIndex) => {
      try {
        const conn = p.conn;
        const canSend = (): boolean => {
          if (!canContinue()) return false;
          if (conn && p.conn === conn && isWritable(p)) return true;
          exclude(p, peerIndex);
          return false;
        };
        if (!canSend() || !conn) return;

        for (let i = 0; i < total; i++) {
          if (!canSend()) return;
          const waitStart = Date.now();
          while (conn.dataChannel && conn.dataChannel.bufferedAmount > bufferedLimit) {
            if (!canSend()) return;
            if (Date.now() - waitStart > stallTimeoutMs) {
              log.warn(
                `[ChunkPump] Backpressure timeout for peer ${p.label || p.id}. Excluding from remaining stream`,
              );
              exclude(p, peerIndex);
              return;
            }
            // Unmanaged delay: concurrent peers must not replace one another's timer.
            await delay(DELAY.BACKPRESSURE);
          }
          if (!canSend()) return;
          const start = i * chunkSize;
          const chunkBuf = await file
            .slice(start, Math.min(start + chunkSize, file.size))
            .arrayBuffer();
          if (!canSend()) return;
          safeSend(conn, buildChunkMsg(new Uint8Array(chunkBuf), i));
          nextChunks[peerIndex] = i + 1;
          sentThrough = Math.max(sentThrough, i + 1);
          reportProgress();

          // Each peer yields independently, including when Blob reads resolve immediately.
          if (i % 50 === 0) await delay(DELAY.TICK);
        }
        if (canSend()) onPeerComplete?.(p);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }),
  );

  if (failed) throw failure;
  return { status: stopped ? 'stopped' : 'complete', excluded };
}
