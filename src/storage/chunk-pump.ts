/**
 * MUSIXQUARE — Shared Backpressure-Aware Chunk Pump
 *
 * THE single multi-peer chunk-streaming engine, used by both broadcast
 * senders: transfer-send.ts (broadcastFile) and preload.ts
 * (backgroundTransfer).
 *
 * Why this exists (threat model / history): the chunk pump used to exist as
 * hand-rolled per-module copies. Flow-control hardening then landed where the
 * symptom was reported — commit 36f8fbf2 (2026-05-09) added per-peer
 * backpressure exclusion (timedOutPeers) to broadcastFile ONLY, leaving
 * preload's broadcast with a single GLOBAL congested flag: one slow peer
 * stalled the entire preload broadcast for every guest, and after the
 * timeout the loop kept queuing chunks onto the non-draining channel
 * (browsers hard-close an SCTP channel on send-buffer overflow, escalating a
 * slow guest into a dropped guest). Identical control loop, divergent
 * hardening — sibling-parity blind spot. Factoring the pump into one engine
 * makes that divergence structurally impossible, and
 * scripts/check-chunk-pump.mjs statically enforces that no new hand-rolled
 * multi-peer pump can appear.
 *
 * Design contract:
 *   - The engine is SIDE-EFFECT-FREE with respect to the state tree: it never
 *     imports setState and its pump body reads nothing from state. The
 *     supersession/abort predicate (shouldContinue) and the peer-health check
 *     (isWritable) are caller-supplied. All state writes stay in the
 *     audit-hardened wrappers, which protects their aborted-vs-superseded
 *     cleanup semantics.
 *   - Callbacks must be TOTAL (never throw): every send goes through
 *     safeSend and every per-peer exit path is a plain return, so the
 *     per-chunk Promise.all can never reject — a rejection would abort
 *     sibling peers' sends mid-chunk and bubble into wrapper catch paths.
 *   - The unicast pair (unicastFile, unicastPreload) is intentionally NOT
 *     routed through this engine: single-peer return-on-timeout is the
 *     correct degenerate case, and they carry distinct semantics
 *     (FILE_RESUME startChunk, currentTrackIndex abort, the
 *     _activePreloadUnicasts registry). Documented divergence, not drift.
 */

import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { DELAY } from '../core/constants.ts';
import { delay } from '../core/timers.ts';
import { safeSend } from '../network/peer.ts';
import type { AnyProtocolMsg, ConnectedPeer, DataConnection } from '../types/index.ts';

// ─── Peer-health helpers (moved from transfer-send.ts) ───────────────
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
   * Supersession/abort predicate, evaluated ONCE per chunk at iteration top
   * (parity with both pre-refactor loops). Per-peer waits do NOT re-check
   * it — a superseded session exits at the next chunk boundary. Must not
   * throw.
   */
  shouldContinue: () => boolean;
  /**
   * Fired exactly once per excluded peer, at exclusion time. Must not throw
   * (use safeSend for any message it sends) and must stay PER-PEER — never
   * escalate a single peer's exclusion to session-level teardown.
   */
  onPeerExcluded?: (peer: ConnectedPeer) => void;
}

interface ChunkPumpResult {
  /**
   * 'stopped' ONLY when shouldContinue() failed (abort/supersession) —
   * wrappers skip their completion fanout and let the canceller own state.
   * 'complete' otherwise, INCLUDING the all-peers-excluded early break, so
   * wrappers run their normal completion guards (the fanout then filters to
   * an empty survivor set — observably identical to the pre-refactor
   * send-to-nobody tail).
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
              `[ChunkPump] Backpressure timeout for peer ${p.label || p.id} — excluding from remaining stream`,
            );
            exclude(p);
            return;
          }
          // delay() is a plain unmanaged setTimeout promise — safe for
          // concurrent per-peer waits. Do NOT replace with a name-keyed
          // managed timer: concurrent waits would cancel each other.
          await delay(DELAY.BACKPRESSURE);
        }
        safeSend(conn, chunkMsg);
      }),
    );

    // Main-thread breathing room, including i=0 (parity with the
    // pre-refactor transfer-send loop; preload inherits this pacing).
    if (i % 50 === 0) await delay(DELAY.TICK);
  }

  return { status: 'complete', excluded };
}
