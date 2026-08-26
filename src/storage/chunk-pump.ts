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
 *   - Callbacks must be TOTAL (never throw): every send goes through
 *     safeSend and every per-peer exit path is a plain return, so the
 *     per-chunk Promise.all can never reject — a rejection would abort
 *     sibling peers' sends mid-chunk and bubble into wrapper catch paths.
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
  /** Source file/blob, sliced lazily one chunk at a time. */
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
   * Supersession/abort predicate, evaluated once at each chunk boundary.
   * Per-peer waits do not re-check it. Must not throw.
   */
  shouldContinue: () => boolean;
  /**
   * Fired exactly once per excluded peer, at exclusion time. Must not throw
   * (use safeSend for any message it sends) and must stay PER-PEER — never
   * escalate a single peer's exclusion to session-level teardown.
   */
  onPeerExcluded?: (peer: ConnectedPeer) => void;
  /**
   * Fired after every active peer has either accepted or been excluded from
   * one prepared chunk. Unicast producers use this for sender-side progress
   * without maintaining a second, subtly different backpressure loop.
   */
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
 * Stream a file's chunks to many peers in lockstep with PER-PEER flow
 * control: each peer waits on its OWN dataChannel.bufferedAmount only, so a
 * slow peer neither stalls healthy peers nor keeps receiving chunks onto a
 * non-draining channel — it is excluded after stallTimeoutMs and skipped for
 * all remaining chunks (chunk holes would force a full recovery re-transfer,
 * so exclusion is one-way).
 *
 * May reject only if file.slice().arrayBuffer() rejects (backing storage
 * gone). Deliberately propagated: wrapper catch/finally paths own cleanup.
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
    onChunkComplete,
  } = opts;

  const total = Math.ceil(file.size / chunkSize);
  const excluded = new Set<string>();

  // Exclusion is one-way and fires the callback exactly once per peer.
  const exclude = (p: ConnectedPeer): void => {
    if (excluded.has(p.id)) return;
    excluded.add(p.id);
    onPeerExcluded?.(p);
  };

  for (let i = 0; i < total; i++) {
    if (!shouldContinue()) return { status: 'stopped', excluded };

    // All peers excluded (or none to begin with) — nothing left to stream
    // to. Early break, but still 'complete' (see ChunkPumpResult docs).
    if (excluded.size >= peers.length) break;

    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunkBuf = await file.slice(start, end).arrayBuffer();
    const chunk = new Uint8Array(chunkBuf);
    const chunkMsg = buildChunkMsg(chunk, i);

    // Send to all peers concurrently — backpressure is PER-PEER, never
    // global. Callbacks are total (plain returns + safeSend), so this
    // Promise.all can never reject.
    await Promise.all(
      peers.map(async (p) => {
        if (excluded.has(p.id)) return;
        if (!isWritable(p)) {
          exclude(p);
          return;
        }
        const conn = p.conn;
        if (!conn) {
          // isWritable implementations check conn; defensive for laxer params.
          exclude(p);
          return;
        }
        const waitStart = Date.now();
        while (conn.dataChannel && conn.dataChannel.bufferedAmount > bufferedLimit) {
          if (!isWritable(p)) {
            exclude(p);
            return;
          }
          if (Date.now() - waitStart > stallTimeoutMs) {
            log.warn(
              `[ChunkPump] Backpressure timeout for peer ${p.label || p.id}. Excluding from remaining stream`,
            );
            exclude(p);
            return;
          }
          // delay() is a plain unmanaged setTimeout promise — safe for
          // concurrent per-peer waits. Do NOT replace with a name-keyed
          // managed timer: concurrent waits would cancel each other.
          await delay(DELAY.BACKPRESSURE);
        }
        // Ownership/connection health may change during the final
        // backpressure await just as bufferedAmount falls below the limit.
        // Recheck before the send so a superseded lane cannot leak one stale
        // chunk after a recovery header has taken ownership.
        if (!isWritable(p)) {
          exclude(p);
          return;
        }
        safeSend(conn, chunkMsg);
      }),
    );

    onChunkComplete?.(i, chunk.byteLength);

    // Yield periodically so chunk preparation does not monopolize the thread.
    if (i % 50 === 0) await delay(DELAY.TICK);
  }

  return { status: 'complete', excluded };
}
