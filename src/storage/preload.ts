/**
 * MUSIXQUARE — Preload System
 *
 * Manages: Host-side preload scheduling, background transfer to peers,
 * Guest-side preload receive (start/chunk/end), preload-ack, play-preloaded.
 */

import { log } from '../core/log.ts';
import { SessionScope } from '../core/session-scope.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, DELAY, TRANSFER_STATE, PLAYBACK_STATE } from '../core/constants.ts';
import { nextSessionId, validateSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer, delay } from '../core/timers.ts';
import { postWorkerCommand, readFileFromOpfs } from './opfs.ts';
import { registerHandlers } from '../network/protocol.ts';
import {
  safeSend,
  sendToHost,
  canSendFileTo,
  filterEligiblePeers,
  isRemoteGuest,
  hasActiveRelay,
} from '../network/peer.ts';
import type { DataConnection, AnyProtocolMsg } from '../types/index.ts';
import { showLoader, updateLoader } from '../ui/toast.ts';
import { transition } from '../player/lifecycle.ts';
import { setPendingRecoveryTarget } from '../player/_state.ts';

// ─── Reorder Buffer ──────────────────────────────────────────────────
// sessionId → Map(chunkIndex → Uint8Array)
const preloadReorderBuffer = new Map<number, Map<number, Uint8Array>>();
let latestPreloadSessionId = 0;
const MAX_EARLY_PRELOAD_CHUNKS = 128;
let _activePlayPreloadedIndex: number | undefined;
let _preloadScope: SessionScope | null = null;
/** Per-peer unicast preload abort controls (key: peerId).
 *  Tracks scope + sid + conn so cancelPreloadTransfer can send a targeted
 *  PRELOAD_ABORT to the receiving peer before disposing the scope. */
interface UnicastEntry {
  scope: SessionScope;
  sid: number;
  conn: DataConnection;
}
const _activePreloadUnicasts = new Map<string, UnicastEntry>();

// ─── Approach B: Serialized Preload Transfers ──────────────────────
// Track the in-flight backgroundTransfer promise so the next preload
// can await it rather than aborting it mid-stream. This preserves
// partial preload data on guests when the host advances to the
// preloaded track before transfer is complete — avoiding the
// 0%-restart penalty and resulting "수신중" loader flicker.
let _inFlightBackgroundTransfer: Promise<void> | null = null;
/**
 * Monotonic counter incremented on every schedulePreload/cancelPreloadTransfer
 * call. Each preloadNextTrack snapshot its myGeneration; after the serialization
 * await, it re-checks against the current _preloadGeneration. If a newer call
 * has come in (or a cancel has fired), the stale preloadNextTrack aborts.
 */
let _preloadGeneration = 0;

/**
 * Clean up reorder buffers and session state for stale (non-current) sessions.
 */
const PRELOAD_SESSION_MAX = 20;

function cleanupStalePreloadSessions(keepSessionId: number): void {
  // Clean up reorder buffers for old sessions
  for (const sid of preloadReorderBuffer.keys()) {
    if (sid !== keepSessionId) {
      preloadReorderBuffer.delete(sid);
    }
  }
  // Clean up finalized/skipped session entries (immutable update)
  const sessionState = getState('preload.sessionState');
  const toRemove: number[] = [];
  for (const [sid, entry] of sessionState.entries()) {
    if (sid !== keepSessionId && (entry.finalized || entry.skipped)) {
      toRemove.push(sid);
    }
  }
  // Hard cap: evict numerically oldest beyond the active one
  if (sessionState.size - toRemove.length > PRELOAD_SESSION_MAX) {
    const sortedSids = [...sessionState.keys()].sort((a, b) => a - b);
    for (const sid of sortedSids) {
      if (sid !== keepSessionId && !toRemove.includes(sid)) {
        toRemove.push(sid);
        if (sessionState.size - toRemove.length <= PRELOAD_SESSION_MAX) break;
      }
    }
  }
  if (toRemove.length > 0) {
    const updated = new Map(sessionState);
    for (const sid of toRemove) updated.delete(sid);
    setState('preload.sessionState', updated);
  }
}

// ─── Host: Cancel In-Flight Preload ─────────────────────────────────

/**
 * Cancel any in-flight preload transfer (host-only).
 * Called by clearPreloadState() during backward navigation to prevent stale
 * preload data from reaching guests after the host changes tracks.
 *
 * Sends PRELOAD_ABORT to receivers BEFORE disposing the scopes so guests
 * can release their OPFS preload slot, sessionState entry, and reorder
 * buffer for this sid. Without the explicit abort signal, a mid-stream
 * cancel leaves guests with `finalized=false, skipped=false` zombie
 * sessions — cleanupStalePreloadSessions only purges finalized/skipped,
 * so they sit until the PRELOAD_SESSION_MAX=20 cap evicts oldest, while
 * the worker's preloadSlots[N] keeps its sync access handle until same-
 * filename preempt or session leave. The abort path tells guests to
 * tear down immediately.
 *
 * Order matters — send first, then dispose. The data channel is FIFO,
 * so the ABORT lands BEFORE any chunk that the loop might still send
 * after dispose (loop checks scope.aborted only at iteration top, so
 * one chunk in flight is possible). Guest's handlePreloadAbort marks
 * the session skipped; subsequent chunks for that sid hit the existing
 * skipped guard at handlePreloadChunk:814 and are dropped.
 */
export function cancelPreloadTransfer(): void {
  // Supersede any pending preloadNextTrack that is still awaiting a prior
  // serialized transfer — it will notice the generation mismatch after its
  // await and exit instead of starting a new (unwanted) transfer.
  _preloadGeneration++;

  // Notify receivers of in-flight transfers BEFORE disposing scopes.
  const sid = getState('preload.sessionId') as number;

  // Broadcast: every eligible peer that the broadcast loop targets shares
  // the current preload sid. Send ABORT to all of them — handler is a
  // no-op if a peer never had a session for this sid.
  if (sid) {
    const broadcastTargets = filterEligiblePeers();
    broadcastTargets.forEach((p) => {
      const conn = p.conn as DataConnection;
      safeSend(conn, { type: MSG.PRELOAD_ABORT, sessionId: sid });
    });
  }

  // Unicast: each entry tracks its own (sid, conn). May differ from the
  // broadcast sid if a unicast was started for an earlier preload session
  // that's still streaming to a late-joiner.
  for (const entry of _activePreloadUnicasts.values()) {
    safeSend(entry.conn, { type: MSG.PRELOAD_ABORT, sessionId: entry.sid });
    entry.scope.dispose();
  }
  _activePreloadUnicasts.clear();

  if (_preloadScope) {
    _preloadScope.dispose();
    _preloadScope = null;
  }
  // Bump sessionId so any lingering async loop sees a mismatch and exits
  setState('preload.sessionId', nextSessionId());
}

// ─── Host: Schedule Preload ─────────────────────────────────────────

/**
 * Schedule next track preload after a delay (host-only).
 *
 * Each call bumps the preload generation so any in-flight preloadNextTrack
 * that is still awaiting a prior serialized transfer will notice it has
 * been superseded and exit cleanly after its await resolves.
 */
export function schedulePreload(delayMs = 500): void {
  _preloadGeneration++;
  clearManagedTimer('preloadScheduleTimer');
  setManagedTimer(
    'preloadScheduleTimer',
    () => {
      preloadNextTrack();
    },
    delayMs,
  );
}

/** Reset the preload cache fields so the host fast path can't pick up a stale entry. */
function clearPreloadCacheState(): void {
  setState('preload.nextTrackIndex', -1);
  setState('preload.isPreloading', false);
  setState('preload.nextFileBlob', null);
  setState('preload.meta', null);
}

/**
 * Preload the next track in the playlist (host-only).
 *
 * Approach B: serialization
 * ─────────────────────────
 * Before starting a new backgroundTransfer, await any prior in-flight
 * backgroundTransfer so it can complete naturally. This prevents the
 * old behavior where advancing to the preloaded track would cancel
 * the old transfer mid-stream, forcing guests to restart from 0%.
 *
 * Pitfall guarded: during the await, another schedulePreload (or a
 * cancelPreloadTransfer) may bump _preloadGeneration. We snapshot
 * myGeneration up-front and re-check after the await; if superseded,
 * we exit without starting a new transfer.
 */
async function preloadNextTrack(): Promise<void> {
  const myGeneration = _preloadGeneration;

  const playlist = getState('playlist.items');
  if (playlist.length <= 1) return;

  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const repeatMode = getState('playlist.repeatMode');
  const isShuffle = getState('playlist.isShuffle');

  // Determine next index
  let nextIdx: number;
  if (repeatMode === 2) {
    nextIdx = currentTrackIndex; // Repeat One
  } else if (isShuffle && playlist.length > 1) {
    // Ask playlist.ts for the next slot in its Fisher-Yates permutation so
    // the preload matches exactly what playNextTrack will pick. Falls back
    // to a safe random pick if the order isn't ready (first-run edge case).
    try {
      const mod = await import('../player/playlist.ts');
      const hinted = mod.getShuffleNextIndex();
      if (hinted >= 0 && hinted < playlist.length && hinted !== currentTrackIndex) {
        nextIdx = hinted;
      } else {
        do {
          nextIdx = Math.floor(Math.random() * playlist.length);
        } while (nextIdx === currentTrackIndex);
      }
    } catch {
      do {
        nextIdx = Math.floor(Math.random() * playlist.length);
      } while (nextIdx === currentTrackIndex);
    }
  } else {
    nextIdx = currentTrackIndex + 1;
    if (nextIdx >= playlist.length) {
      if (repeatMode === 1) nextIdx = 0;
      else nextIdx = -1;
    }
  }

  // Invalid-target early exit: clear stale preload state and bail out
  // (this runs BEFORE the serialization await so there's no window
  // where inconsistent state could be observed by the host fast path).
  if (nextIdx < 0 || nextIdx >= playlist.length) {
    clearPreloadCacheState();
    return;
  }

  // Scan-forward through consecutive YouTube entries to find the next
  // preloadable local file. Without this, hybrid playlists like
  // local→YT→local→YT got zero preload benefit: every nextIdx that landed
  // on a YouTube track aborted, even though a local file was just one
  // slot further. The scan respects the same wrap/end semantics as the
  // initial nextIdx pick — repeatMode=1 wraps to 0, repeatMode=0 stops
  // at the playlist end. The currentTrackIndex check prevents an infinite
  // wrap on an all-YouTube playlist (or a repeat-all list with only one
  // local track that we'd otherwise re-pick as our own preload target).
  // Shuffle and repeat-one keep the prior behavior — shuffle has its own
  // permutation that we don't second-guess, and repeat-one preloading
  // self is the entire point.
  if (!isShuffle && repeatMode !== 2) {
    let scanCount = 0;
    while (
      scanCount < playlist.length &&
      playlist[nextIdx] &&
      playlist[nextIdx].type === 'youtube'
    ) {
      nextIdx = nextIdx + 1;
      if (nextIdx >= playlist.length) {
        if (repeatMode === 1) {
          nextIdx = 0;
        } else {
          nextIdx = -1;
          break;
        }
      }
      if (nextIdx === currentTrackIndex) {
        // Wrapped a full lap without finding a local file.
        nextIdx = -1;
        break;
      }
      scanCount++;
    }

    if (nextIdx < 0 || nextIdx >= playlist.length) {
      clearPreloadCacheState();
      return;
    }
  }

  const item = playlist[nextIdx];
  if (!item) return;

  // Still possible to land on a YouTube item: shuffle's getShuffleNextIndex
  // can return one, and repeat-one of a YouTube track maps to itself.
  // Either way, clear stale preload state so the host's fast path in
  // playTrack doesn't match a no-longer-valid cached file.
  if (item.type === 'youtube') {
    clearPreloadCacheState();
    return;
  }

  const file = item.file as File;
  if (!file) return;

  // Serialize: wait for any prior backgroundTransfer to finish naturally
  // before starting a new one. This is the core of Approach B — it lets
  // in-progress preloads reach their PRELOAD_END on guests instead of
  // being torn down and forcing a 0%-restart recovery.
  //
  // NOTE: we do NOT mutate preload.* state before this await. Publishing
  // nextFileBlob early (while preload.meta is still stale from the prior
  // session) would create a half-updated cache the host's fast path
  // could consume, leading to blob/meta mismatch in loadPreloadedTrack.
  // All preload state is written AFTER the await as one atomic snapshot.
  const prevTransfer = _inFlightBackgroundTransfer;
  if (prevTransfer) {
    log.debug('[Preload] Serializing — awaiting prior backgroundTransfer');
    try {
      await prevTransfer;
    } catch {
      /* prior may have been cancelled */
    }
  }

  // Re-check generation: a newer schedulePreload or cancelPreloadTransfer
  // may have fired while we were awaiting the prior transfer.
  if (_preloadGeneration !== myGeneration) {
    log.debug('[Preload] Aborted — superseded during serialization wait');
    return;
  }

  // Verify the chosen item is still at nextIdx (playlist may have been
  // mutated during the await — track removed, reordered, etc.).
  const playlistNow = getState('playlist.items');
  if (!playlistNow || playlistNow[nextIdx] !== item) {
    log.debug('[Preload] Aborted — playlist changed during serialization wait');
    return;
  }

  // Safe to allocate the new session id and publish the preload cache
  // atomically. All five state fields below describe the SAME track and
  // the SAME session — the host's fast path in playTrack will only ever
  // observe them as a consistent snapshot.
  const currentSession = nextSessionId();
  setState('preload.sessionId', currentSession);
  setState('preload.nextTrackIndex', nextIdx);
  setState('preload.nextFileBlob', file);
  setState('preload.isPreloading', true);

  const total = Math.ceil(file.size / CHUNK_SIZE);
  setState('preload.meta', {
    name: file.name,
    index: nextIdx,
    mime: file.type,
    total,
    size: file.size,
    sessionId: currentSession,
  });

  log.debug('[Preload] Starting for:', file.name, 'session:', currentSession);

  // Broadcast preload to connected peers
  const transferPromise = backgroundTransfer(file, nextIdx, currentSession);
  _inFlightBackgroundTransfer = transferPromise;
  try {
    await transferPromise;
  } catch (e) {
    log.warn('[Preload] backgroundTransfer failed:', e);
  } finally {
    if (_inFlightBackgroundTransfer === transferPromise) {
      _inFlightBackgroundTransfer = null;
    }
    if (getState('preload.sessionId') === currentSession) {
      setState('preload.isPreloading', false);
    }
  }
}

// ─── Host: Background Transfer ──────────────────────────────────────

async function backgroundTransfer(file: File, index: number, sessionId: number): Promise<void> {
  // Approach B: caller (preloadNextTrack) has already awaited the prior
  // in-flight transfer, so we create a fresh scope WITHOUT disposing the
  // previous one. cancelPreloadTransfer is the only path that aborts a
  // scope; it operates on the current _preloadScope reference.
  const scope = new SessionScope();
  _preloadScope = scope;

  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const header = {
    type: MSG.PRELOAD_START,
    name: file.name,
    mime: file.type,
    total,
    size: file.size,
    index,
    sessionId,
  };

  const targets = filterEligiblePeers();

  if (targets.length === 0) return;

  const targetsWhoNeedChunks = targets.filter((p) => {
    const preloadedIndexes = p.preloadedIndexes as Set<number> | undefined;
    return !preloadedIndexes || !preloadedIndexes.has(index);
  });

  // Send header per-peer
  targets.forEach((p) => {
    const conn = p.conn as DataConnection;
    const needsChunks = targetsWhoNeedChunks.includes(p);
    safeSend(conn, { ...header, skipped: !needsChunks });
  });

  // Send chunks
  for (let i = 0; i < total; i++) {
    if (scope.aborted) return;
    if (getState('preload.sessionId') !== sessionId) return;

    // Backpressure (with 30s timeout to prevent infinite stall)
    let congested = true;
    const bpStart = Date.now();
    while (congested) {
      congested = false;
      for (const p of targetsWhoNeedChunks) {
        const conn = p.conn as DataConnection;
        if (conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
          congested = true;
          break;
        }
      }
      if (congested) {
        if (Date.now() - bpStart > 30_000) {
          log.warn('[Preload] Backpressure timeout');
          break;
        }
        await delay(DELAY.BACKPRESSURE);
      }
    }

    const start = i * CHUNK;
    const end = Math.min(start + CHUNK, file.size);
    const chunkBuf = await file.slice(start, end).arrayBuffer();
    const chunk = new Uint8Array(chunkBuf);
    const chunkMsg = { type: MSG.PRELOAD_CHUNK, chunk, index: i, sessionId };

    targetsWhoNeedChunks.forEach((p) => {
      const conn = p.conn as DataConnection;
      if (conn?.open) safeSend(conn, chunkMsg);
    });
  }

  if (getState('preload.sessionId') === sessionId) {
    const endMsg = { type: MSG.PRELOAD_END, name: file.name, index, sessionId };
    targets.forEach((p) => {
      const conn = p.conn as DataConnection;
      if (conn?.open) safeSend(conn, endMsg);
    });
    log.debug('[Preload] Complete for index:', index);
  }
}

/**
 * Unicast preload data to a single peer (for late-joining guests).
 */
export async function unicastPreload(
  conn: DataConnection,
  file: File | Blob,
  index: number,
  sessionId: number,
): Promise<void> {
  // Per-peer scope isolation: cancel any previous unicast preload to same peer
  const unicastKey = conn.peer;
  const prevEntry = _activePreloadUnicasts.get(unicastKey);
  const scope = SessionScope.replace(prevEntry?.scope ?? null);
  _activePreloadUnicasts.set(unicastKey, { scope, sid: sessionId, conn });

  if (!conn || !conn.open || !file) {
    scope.dispose();
    _activePreloadUnicasts.delete(unicastKey);
    return;
  }

  // Transport guard: block remote/unknown peers
  if (!(await canSendFileTo(conn))) {
    log.info('[Preload Unicast] Skipped — remote/unknown peer');
    scope.dispose();
    _activePreloadUnicasts.delete(unicastKey);
    return;
  }

  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const fileName = 'name' in file ? file.name : 'Track';

  try {
    safeSend(conn, {
      type: MSG.PRELOAD_START,
      name: fileName,
      mime: file.type,
      total,
      size: file.size,
      index,
      sessionId,
      skipped: false,
    });

    for (let i = 0; i < total; i++) {
      if (scope.aborted) return;
      if (!conn.open) return;
      const bpStart = Date.now();
      while (conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
        if (Date.now() - bpStart > 30_000) {
          log.warn('[Preload Unicast] Backpressure timeout');
          return;
        }
        await delay(DELAY.BACKPRESSURE);
      }
      if (!conn.open) return;
      const start = i * CHUNK;
      const chunkBuf = await file.slice(start, Math.min(start + CHUNK, file.size)).arrayBuffer();
      safeSend(conn, {
        type: MSG.PRELOAD_CHUNK,
        chunk: new Uint8Array(chunkBuf),
        index: i,
        sessionId,
      });
    }

    safeSend(conn, { type: MSG.PRELOAD_END, name: fileName, index, sessionId });
  } finally {
    // Clean up scope if still ours
    if (_activePreloadUnicasts.get(unicastKey)?.scope === scope) {
      scope.dispose();
      _activePreloadUnicasts.delete(unicastKey);
    }
  }
}

// ─── Guest: Preload Receive Handlers ────────────────────────────────

/**
 * Reject broadcast frames not arriving via hostConn. Preload messages
 * (START/CHUNK/END/PLAY_PRELOADED) flow host→guest only — host triggers
 * preloads from its own scheduler and broadcasts; the host's dispatcher
 * never receives them on the legitimate path. Without this guard, a peer
 * connected over DATA_RELAY (peer.ts:292 accepts without auth) can inject
 * raw frames to corrupt preload state, force PLAY_PRELOADED of a wrong
 * index, or DoS the OPFS pipeline. Same threat-model class as 4838a0c
 * SYNC_PONG and the post-4838a0c sibling sweep — non-RELAYABLE host→guest
 * messages need per-handler guards because the dispatcher's RELAY DOWNSTREAM
 * amplification check (b2ad18e) only fires for RELAYABLE commands. PLAY_
 * PRELOADED is RELAYABLE so the dispatcher blocks amplification past the
 * relay, but per-handler guards still protect each receiver's own state.
 *
 * handlePreloadAck stays unguarded — it's the host-side reply handler
 * (guest→host direction); on host hostConn=null so the guard would
 * fail-closed against every legitimate ack.
 */
function isHostBroadcast(conn: DataConnection | undefined): boolean {
  const hostConn = getState('network.hostConn');
  return !!hostConn && conn === hostConn;
}

function handlePreloadStart(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  // Remote guests: skip preload unless relay is active
  if (isRemoteGuest() && !hasActiveRelay()) {
    log.info('[Preload] Skipped — remote/unknown guest without relay');
    return;
  }

  const sid = data.sessionId as number;
  if (!sid) {
    log.warn('[Preload] Start message missing sessionId. Ignoring.');
    return;
  }

  clearManagedTimer('prepareWatchdog');

  // Clean up buffers from previous sessions when a new one starts
  if (latestPreloadSessionId && latestPreloadSessionId !== sid) {
    cleanupStalePreloadSessions(sid);
  }
  latestPreloadSessionId = sid;

  // Skip if this preload was already marked as skipped by host
  if (data.skipped) {
    log.debug(`[Preload] Skipping session ${sid}`);
    const skipSessionState = new Map(getState('preload.sessionState'));
    skipSessionState.set(sid, {
      skipped: true,
      progress: 0,
      total: (data.total as number) || 0,
      name: (data.name as string) || '',
      index: (data.index as number) || 0,
      size: (data.size as number) || 0,
      mime: (data.mime as string) || '',
      nextExpectedChunk: 0,
      finalized: false,
    });
    setState('preload.sessionState', skipSessionState);
    try {
      preloadReorderBuffer.delete(sid);
    } catch (e) {
      log.debug('[Preload] reorder buffer cleanup:', e);
    }
    return;
  }

  // Clear any stuck waiting state from previous preload

  // Validate required metadata
  if (!data.name || !data.total || (data.total as number) <= 0) {
    log.error('[Preload] Start message has invalid metadata:', data);
    return;
  }

  log.debug(`[Preload] Start: ${data.name} (index: ${data.index}, total: ${data.total})`);

  // Show loader only if main transfer is not in progress
  const transferState = getState('transfer.state');
  if (
    transferState === TRANSFER_STATE.READY ||
    transferState === TRANSFER_STATE.IDLE ||
    !transferState
  ) {
    showLoader(true, t('toast.preparing_next', { name: data.name as string }));
  }

  // Initialize session state
  const initSessionState = new Map(getState('preload.sessionState'));
  initSessionState.set(sid, {
    skipped: false,
    progress: 0,
    total: (data.total as number) || 0,
    name: (data.name as string) || '',
    index: (data.index as number) || 0,
    size: (data.size as number) || 0,
    mime: (data.mime as string) || '',
    nextExpectedChunk: 0,
    finalized: false,
  });
  setState('preload.sessionState', initSessionState);

  // Clear stale preload blob BEFORE updating meta — prevents meta/blob mismatch
  // where old blob (from a completed stale preload) matches new meta index,
  // causing handlePlayPreloaded to use the wrong file.
  setState('preload.nextFileBlob', null);

  setState('preload.meta', {
    name: data.name as string,
    index: data.index as number,
    mime: data.mime as string,
    total: data.total as number,
    size: data.size as number,
    sessionId: sid,
  });

  // OPFS: Start preload slot
  // Note: We deliberately do NOT send OPFS_RESET here. The worker now
  // manages preload slots by sessionId. Sending OPFS_RESET would abort
  // any still-downloading "stale" preloads (like a late-joiner's Track 2
  // that was superseded by Track 3).
  postWorkerCommand({
    command: 'OPFS_START',
    filename: data.name as string,
    isPreload: true,
    sessionId: validateSessionId(sid),
    size: CHUNK_SIZE,
  });

  // Drain any chunks that arrived before PRELOAD_START (unordered delivery)
  // Use setTimeout(0) to let the worker process OPFS_START before receiving WRITE commands
  setManagedTimer(
    'preload-drain-' + sid,
    () => {
      try {
        drainPreloadReorderBuffer(sid);
      } catch (e) {
        log.debug('[Preload] drain reorder buffer:', e);
      }
    },
    0,
  );

  // Relay downstream
  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach((p) => {
    safeSend(p, data as AnyProtocolMsg);
  });

  // Watchdog: unconditionally clear preload loader after 30s
  clearManagedTimer('preloadWatchdog');
  setManagedTimer(
    'preloadWatchdog',
    () => {
      log.warn('[Preload] Watchdog: forcing preload loader reset after 30s');
      showLoader(false);
      // If main transfer is still in progress, restore its loader
      const transferState = getState('transfer.state');
      if (transferState === TRANSFER_STATE.RECEIVING) {
        const meta = getState('transfer.meta');
        const receivedCount = getState('transfer.receivedCount');
        const total = (meta?.total as number) || 0;
        if (total > 0) {
          const pct = Math.round((receivedCount / total) * 100);
          updateLoader(pct);
        }
      }
    },
    30000,
  );
}

function drainPreloadReorderBuffer(sessionId: number): void {
  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sessionId);
  if (!session || session.skipped) return;

  const sessionBuffer = preloadReorderBuffer.get(sessionId);
  if (!sessionBuffer) return;

  let nextChunkPtr = session.nextExpectedChunk || 0;

  while (sessionBuffer.has(nextChunkPtr)) {
    const chunk = sessionBuffer.get(nextChunkPtr)!;

    // Clone chunk to prevent detachment issues (one for relay, one for worker)
    const chunkClone = new Uint8Array(chunk);
    const fileName = session.name;

    // If we still don't know the filename, keep buffering
    if (!fileName) break;

    // Relay downstream
    const downstreamPeers = getState('relay.downstreamDataPeers');
    if (downstreamPeers.length > 0) {
      const relayCopy = new Uint8Array(chunk);
      const relayMsg = {
        type: MSG.PRELOAD_CHUNK,
        chunk: relayCopy,
        index: nextChunkPtr,
        sessionId,
      };
      downstreamPeers.forEach((p) => {
        safeSend(p, relayMsg);
      });
    }

    postWorkerCommand({
      command: 'OPFS_WRITE',
      chunk: chunkClone.buffer as ArrayBuffer,
      index: nextChunkPtr,
      isPreload: true,
      filename: fileName,
      sessionId: validateSessionId(sessionId),
    });

    sessionBuffer.delete(nextChunkPtr);
    nextChunkPtr++;
  }

  // Immutable update: create new session object with updated progress
  const totalExpected = session.total || 0;
  const fileSize = session.size || 0;
  const isComplete = totalExpected > 0 && nextChunkPtr >= totalExpected;
  const updatedSession = {
    ...session,
    nextExpectedChunk: nextChunkPtr,
    progress: nextChunkPtr,
    finalized: session.finalized || (isComplete ? true : false),
  };
  const newSessionState = new Map(getState('preload.sessionState'));
  newSessionState.set(sessionId, updatedSession);
  setState('preload.sessionState', newSessionState);

  // Update preload progress UI (only if main transfer is not active)
  // To avoid UI flickering when a superseded session finishes in the background,
  // we must be mutually exclusive. If we're blocked waiting for a track, ONLY show
  // that track's progress. Otherwise, show the latest broadcast preload.
  const lifecycle = getState('playback.lifecycle');
  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  const shouldUpdateUI =
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD
      ? updatedSession.index === recoveryTarget?.index
      : sessionId === latestPreloadSessionId;

  if (shouldUpdateUI && updatedSession.total > 0) {
    const pct = Math.round((updatedSession.progress / updatedSession.total) * 100);
    const transferState = getState('transfer.state');
    if (
      transferState === TRANSFER_STATE.READY ||
      transferState === TRANSFER_STATE.IDLE ||
      !transferState
    ) {
      showLoader(true, t('toast.preparing_next_pct', { pct }));
      updateLoader(pct);
    }
  }

  // Tick watchdog on progress
  const preloadMeta = getState('preload.meta');
  if (preloadMeta && (preloadMeta.total as number) > 0) {
    clearManagedTimer('preloadWatchdog');
    setManagedTimer(
      'preloadWatchdog',
      () => {
        const transferState = getState('transfer.state');
        if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE) {
          showLoader(false);
        }
      },
      15000,
    );
  }

  // Finalize if all chunks received (in-chunk finalization)
  if (isComplete && !session.finalized) {
    log.debug(`[Preload] All chunks received (${nextChunkPtr}/${totalExpected}). Finalizing...`);
    postWorkerCommand({
      command: 'OPFS_END',
      filename: updatedSession.name,
      isPreload: true,
      sessionId: validateSessionId(sessionId),
      totalSize: fileSize,
    });
    preloadReorderBuffer.delete(sessionId); // Prevent memory leak
  }
}

function handlePreloadChunk(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  // Remote guests: drop preload chunks unless relay is active
  if (isRemoteGuest() && !hasActiveRelay()) return;

  // Require explicit sessionId — fallback to latestPreloadSessionId
  let sid = data.sessionId as number;
  if (!sid && latestPreloadSessionId !== 0) {
    log.warn('[Preload] Chunk missing sessionId — falling back to latest:', latestPreloadSessionId);
    sid = latestPreloadSessionId;
  }
  if (!sid) return;

  // We intentionally DO NOT drop chunks for sid < latestPreloadSessionId.
  // This allows "stale" preloads (like a late-joiner's unicastPreload that
  // got superseded by a track advance) to finish naturally and be promoted
  // to the current track without forcing a 0% recovery restart.

  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sid);

  // If session state is marked skipped/finalized, ignore
  if (session?.skipped || session?.finalized) return;

  // Bounds check: drop chunks with index beyond expected total
  if (session && session.total > 0 && (data.index as number) >= session.total) {
    log.warn(`[Preload] Out-of-bounds chunk index ${data.index} (total: ${session.total})`);
    return;
  }

  // Buffer the chunk in the reorder map
  if (!preloadReorderBuffer.has(sid)) {
    preloadReorderBuffer.set(sid, new Map());
  }
  const sessionBuffer = preloadReorderBuffer.get(sid)!;

  // Clone data before storing to avoid detached ArrayBuffer issues
  sessionBuffer.set(data.index as number, new Uint8Array(data.chunk as Uint8Array));

  // If PRELOAD_START hasn't been processed yet (unordered delivery),
  // keep buffering until sessionState exists so we have a reliable filename/total.
  if (!session) {
    if (sessionBuffer.size > MAX_EARLY_PRELOAD_CHUNKS) {
      // Drop highest-index chunk — the drain loop starts from chunk 0, so
      // evicting low indices (especially 0) permanently stalls the drain.
      const highestKey = Math.max(...sessionBuffer.keys());
      sessionBuffer.delete(highestKey);
      log.warn(`[Preload] Early chunk buffer overflow (SID: ${sid}). Dropped chunk ${highestKey}.`);
    }
    return;
  }

  // Drain the reorder buffer sequentially
  drainPreloadReorderBuffer(sid);
}

function handlePreloadEnd(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  const sid = data.sessionId as number;
  if (!sid) return;

  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sid);
  if (!session || session.skipped) return;

  // Drain any remaining buffered chunks FIRST — ensures OPFS_WRITE messages
  // are posted to the worker before OPFS_END (worker processes sequentially).
  drainPreloadReorderBuffer(sid);

  // Re-read session after drain (drain may have updated it via immutable setState)
  const freshSession = getState('preload.sessionState').get(sid);
  if (!freshSession) return;

  // Only finalize if not already finalized by in-chunk detection (drain may have done it)
  if (!freshSession.finalized) {
    const allReceived = freshSession.total > 0 && freshSession.progress >= freshSession.total;
    if (allReceived) {
      // All chunks drained — safe to send OPFS_END
      const finalizedSession = { ...freshSession, finalized: true };
      const updatedSessionState = new Map(getState('preload.sessionState'));
      updatedSessionState.set(sid, finalizedSession);
      setState('preload.sessionState', updatedSessionState);

      postWorkerCommand({
        command: 'OPFS_END',
        filename: freshSession.name,
        isPreload: true,
        sessionId: validateSessionId(sid),
        totalSize: freshSession.size,
      });
    } else {
      // Some chunks still missing — let future handlePreloadChunk → drain finalize it.
      // This prevents premature OPFS_END when network reordering causes late chunk arrival.
      log.debug(
        `[Preload] END received but ${freshSession.progress}/${freshSession.total} — deferring OPFS_END`,
      );

      // Bound the deferred state. Preload broadcasts are one-way (no per-chunk
      // recovery like main transfer), so a chunk that never arrives would
      // otherwise leave this session stuck at finalized=false forever, leaking
      // the reorder buffer and blocking cleanupStalePreloadSessions from
      // evicting it. After the cap, mark the session skipped so it becomes
      // evictable; the next track entry will fall back to main-transfer
      // download via the standard handlePlayPreloaded path.
      const sidLocal = sid;
      setManagedTimer(
        `preload-end-deferred-${sidLocal}`,
        () => {
          const cur = getState('preload.sessionState').get(sidLocal);
          if (!cur || cur.finalized || cur.skipped) return;
          log.warn(
            `[Preload] Deferred END for session ${sidLocal} timed out (${cur.progress}/${cur.total}) — marking skipped.`,
          );
          const updated = new Map(getState('preload.sessionState'));
          updated.set(sidLocal, { ...cur, skipped: true });
          setState('preload.sessionState', updated);
          preloadReorderBuffer.delete(sidLocal);
        },
        10_000,
      );
    }
  }

  // Cleanup reorder buffer only if finalized (otherwise chunks may still arrive)
  if (getState('preload.sessionState').get(sid)?.finalized) {
    preloadReorderBuffer.delete(sid);
  }

  log.debug(
    `[Preload] End: ${freshSession.name} (${freshSession.progress}/${freshSession.total} chunks)`,
  );

  // NOTE: PRELOAD_ACK is now sent in storage:preload-file-ready handler (after OPFS confirms file)
  // Previously it was sent here (before OPFS confirmed), causing timing issues.

  // Relay downstream
  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach((p) => {
    safeSend(p, data as AnyProtocolMsg);
  });

  bus.emit('storage:preload-ready', data.index as number);
}

/**
 * Tear down a preload session aborted mid-stream by the host.
 *
 * Why this exists: cancelPreloadTransfer disposes the host's broadcast and
 * unicast scopes, which makes the loops stop sending chunks. But scope
 * disposal is local to the host — receivers don't know the transfer was
 * cut and would otherwise carry a `finalized=false, skipped=false` session
 * entry until PRELOAD_SESSION_MAX=20 evicts them, plus a worker preloadSlot
 * keeping a sync access handle on the partial OPFS file. This handler
 * propagates the abort.
 *
 * Idempotent on every guard:
 *   - !session         → no work to undo, return.
 *   - session.finalized → natural finalize already cleaned up; skip skip-
 *                         marking + skip OPFS_RESET_SESSION (firing it now
 *                         would race against a possibly-already-released
 *                         worker slot — silent no-op there too, but no
 *                         reason to post in the first place).
 *   - session.skipped   → already torn down by an earlier abort or skipped
 *                         flag from PRELOAD_START; bail out.
 *
 * Late chunks for sid arriving AFTER abort hit handlePreloadChunk's
 * existing skipped guard (preload.ts:814) and are dropped.
 */
function handlePreloadAbort(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  const sid = data.sessionId as number;
  if (!sid) return;

  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sid);

  // Cancel any pending deferred-end timer that handlePreloadEnd may have
  // set when it saw a partial session. Idempotent (no-op if absent).
  clearManagedTimer(`preload-end-deferred-${sid}`);

  // Drop any reorder buffer entries for this sid — they would otherwise
  // wait forever for chunks that aren't coming. Idempotent.
  preloadReorderBuffer.delete(sid);

  if (!session || session.finalized || session.skipped) {
    log.debug(
      `[Preload] Abort received for sid ${sid} — session ${
        !session ? 'absent' : session.finalized ? 'finalized' : 'skipped'
      }, no teardown needed`,
    );
    // Still relay downstream — a deeper relay-host may have an in-flight
    // session for the same sid that we don't track here.
    const downstreamPeersEarly = getState('relay.downstreamDataPeers');
    downstreamPeersEarly.forEach((p) => {
      safeSend(p, { type: MSG.PRELOAD_ABORT, sessionId: sid });
    });
    return;
  }

  log.debug(`[Preload] Abort: tearing down sid ${sid} (${session.name})`);

  // Mark skipped so cleanupStalePreloadSessions can evict on the next
  // PRELOAD_START, and so any in-flight chunks for this sid are dropped
  // by the existing skipped guard.
  const updated = new Map(sessionState);
  updated.set(sid, { ...session, skipped: true });
  setState('preload.sessionState', updated);

  // Release the worker preload slot for this sid. Critical: do NOT use
  // OPFS_END here — that path posts OPFS_FILE_READY which would push a
  // partial blob into preload.nextFileBlob via the storage:preload-file-
  // ready handler. OPFS_RESET_SESSION just releases the lock and removes
  // the slot.
  if (session.name) {
    postWorkerCommand({
      command: 'OPFS_RESET_SESSION',
      isPreload: true,
      sessionId: validateSessionId(sid),
    });
  }

  // Hide the preparing-next loader if it was showing for THIS preload.
  const preloadMeta = getState('preload.meta');
  if (preloadMeta && (preloadMeta.sessionId as number) === sid) {
    showLoader(false);
  }

  // Relay downstream so remote-via-relay guests also tear down.
  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach((p) => {
    safeSend(p, { type: MSG.PRELOAD_ABORT, sessionId: sid });
  });
}

function handlePreloadAck(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guest ignores

  const connectedPeers = getState('network.connectedPeers');
  const p = connectedPeers.find((x) => x.id === conn.peer);
  if (p && data.index !== undefined) {
    const preloadedIndexes = p.preloadedIndexes as Set<number>;
    if (preloadedIndexes) {
      const idx = Number(data.index);
      if (preloadedIndexes.has(idx)) return; // Already marked
      // Immutable update: new Set → new peer → new array → setState
      const updatedSet = new Set(preloadedIndexes);
      updatedSet.add(idx);
      const updatedPeers = connectedPeers.map((x) =>
        x.id === conn.peer ? { ...x, preloadedIndexes: updatedSet } : x,
      );
      setState('network.connectedPeers', updatedPeers);
      log.debug(`[Host] Marked index ${idx} as CACHED for peer ${p.label}`);
    }
  }
}

function handlePlayPreloaded(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  const index = data.index as number;
  const name = (data.name as string) || '';

  log.debug(`[Guest] Command: Play Preloaded Track, index: ${index}, name: ${name}`);

  // Dedup: ignore duplicate commands for same track
  if (_activePlayPreloadedIndex === index) {
    log.debug(`[PlayPreloaded] Already processing track ${index}, ignoring duplicate`);
    return;
  }

  _activePlayPreloadedIndex = index;
  bus.emit('player:stop-all-media');

  if (data.index !== undefined) {
    setState('playlist.currentTrackIndex', index);
  }

  // Update metadata for UI title display
  const playlist = getState('playlist.items') || [];
  if (playlist[index]) {
    setState('player.currentTrackMeta', playlist[index]);
  }

  // Check if preloaded blob matches requested track
  const nextFileBlob = getState('preload.nextFileBlob');
  const nextMeta = getState('preload.meta');
  const isMatch =
    nextFileBlob &&
    nextMeta &&
    ((nextMeta.index as number) === index || (nextMeta.name as string) === name);

  if (isMatch) {
    // Preloaded file available — activate it directly via playback module
    log.debug('[Guest] Using preloaded file for track', index);
    // Lifecycle (Phase 3 dual-write): blob is ready in memory → promote to DECODING.
    // The subsequent loadPreloadedTrack flow will emit DECODE_SUCCESS on completion.
    transition({ type: 'PLAY_PRELOADED', variant: 'blob-ready', index, name });
    setPendingRecoveryTarget(index, name);
    bus.emit('storage:use-preloaded', index, name);
    _activePlayPreloadedIndex = undefined;

    // Relay downstream
    const downstreamPeers = getState('relay.downstreamDataPeers');
    downstreamPeers.forEach((p) => {
      safeSend(p, { type: MSG.PLAY_PRELOADED, index, name });
    });
    return;
  }

  // Check if preload download is still in progress for this track
  const sessionState = getState('preload.sessionState');
  let isDownloadingSame = false;
  for (const [, session] of sessionState) {
    if (
      !session.skipped &&
      !session.finalized &&
      (session.index === index || session.name === name)
    ) {
      isDownloadingSame = true;
      break;
    }
  }

  // Approach B: preload is still downloading → delegate to the waiter path
  // (storage:use-preloaded) instead of the old 4× retry / 0%-restart fallback.
  //
  // The waiter sets transfer.waitingForPreload=true and installs a progress-aware
  // watchdog in playback.ts. When the remaining PRELOAD_CHUNK / PRELOAD_END
  // messages arrive (host has serialized its transfers so they WILL arrive),
  // storage:preload-file-ready auto-triggers playback via use-preloaded again.
  //
  // This replaces the old path where:
  //   - 4 retries × 500 ms = 2 s forced wait
  //   - then REQUEST_DATA_RECOVERY { nextChunk: 0 } = full re-download
  //   - then "수신중 0%" loader flicker
  //
  // With serialization on the host side, the in-flight PRELOAD session will
  // finalize on its own; we just need to wait for it without panicking.
  if (isDownloadingSame) {
    log.debug('[Guest] Preload in progress — delegating to waiter (storage:use-preloaded)');
    // Lifecycle (Phase 3 dual-write): enter AWAITING_PRELOAD. A subsequent
    // PLAY arrival in this state must NOT fire stale-audio-recovery — that
    // logic is gated in playback.ts::handlePlay on the lifecycle check.
    transition({ type: 'PLAY_PRELOADED', variant: 'blob-waiting', index, name });
    setPendingRecoveryTarget(index, name);
    showLoader(true, t('transfer.download_finishing'));
    bus.emit('storage:use-preloaded', index, name);
    _activePlayPreloadedIndex = undefined;

    // Relay downstream
    const downstreamPeers = getState('relay.downstreamDataPeers');
    downstreamPeers.forEach((p) => {
      safeSend(p, { type: MSG.PLAY_PRELOADED, index, name });
    });
    return;
  }

  // Fallback: no preloaded file available — request from host
  log.warn('[Guest] No preloaded file for track', index, '— requesting from Host');
  // No preload session exists for this track. Enter DOWNLOADING (fresh) via
  // the recovery fallback. shouldSkipIncomingFile() returns false naturally
  // once lifecycle = DOWNLOADING. The actual REQUEST_DATA_RECOVERY fires
  // below after a small jitter.
  transition({ type: 'PLAY_PRELOADED', variant: 'no-session', index, name });
  _activePlayPreloadedIndex = undefined;

  setPendingRecoveryTarget(index, name);
  showLoader(true, t('transfer.file_requesting'));

  const hostConn = getState('network.hostConn');
  const trackName = name || playlist[index]?.name || '';

  if (hostConn?.open) {
    // Short jitter to avoid thundering herd, but not too long to cause stale track
    const jitter = Math.random() * 300 + 50;
    setManagedTimer(
      'preload-recovery-jitter',
      () => {
        // Double-check: did preload arrive during wait?
        const nowBlob = getState('preload.nextFileBlob');
        const nowMeta = getState('preload.meta');
        if (
          nowBlob &&
          nowMeta &&
          ((nowMeta.index as number) === index || (nowMeta.name as string) === trackName)
        ) {
          log.debug('[Guest] Preload arrived during jitter wait! Using it.');
          bus.emit('storage:use-preloaded', index, trackName);
          return;
        }

        // Check if host already moved past this track — don't request stale file
        const currentTrackIndex = getState('playlist.currentTrackIndex');
        if (currentTrackIndex !== index) {
          log.debug(
            `[Guest] Track already changed (${currentTrackIndex} != ${index}), skipping recovery request`,
          );
          showLoader(false);
          return;
        }

        if (
          sendToHost({
            type: MSG.REQUEST_DATA_RECOVERY,
            nextChunk: 0,
            fileName: trackName,
            index,
          })
        ) {
          log.debug('[Guest] Requested file recovery from Host for:', trackName);
        }
      },
      jitter,
    );
  }

  // Relay downstream regardless
  const downstreamPeers = getState('relay.downstreamDataPeers');
  downstreamPeers.forEach((p) => {
    safeSend(p, { type: MSG.PLAY_PRELOADED, index, name: trackName });
  });
}

// ─── Debug: Memory Stats ────────────────────────────────────────────
//
// Exposes module-local reorder buffer footprint for `/debug memory`. Walks
// the nested Map<sid, Map<chunkIndex, Uint8Array>> to sum chunk byteLengths.
// Hot-path safe: only called from chat command handler, not from the
// receive pipeline.

export function getPreloadMemoryStats(): {
  reorderSessions: number;
  reorderChunks: number;
  reorderBytes: number;
  latestSessionId: number;
} {
  let chunks = 0;
  let bytes = 0;
  for (const sessionBuf of preloadReorderBuffer.values()) {
    chunks += sessionBuf.size;
    for (const chunk of sessionBuf.values()) {
      bytes += chunk.byteLength;
    }
  }
  return {
    reorderSessions: preloadReorderBuffer.size,
    reorderChunks: chunks,
    reorderBytes: bytes,
    latestSessionId: latestPreloadSessionId,
  };
}

// ─── Register Handlers ──────────────────────────────────────────────

export function initPreload(): void {
  registerHandlers({
    [MSG.PRELOAD_START]: handlePreloadStart,
    [MSG.PRELOAD_CHUNK]: handlePreloadChunk,
    [MSG.PRELOAD_END]: handlePreloadEnd,
    [MSG.PRELOAD_ABORT]: handlePreloadAbort,
    [MSG.PRELOAD_ACK]: handlePreloadAck,
    [MSG.PLAY_PRELOADED]: handlePlayPreloaded,
  });

  // Handle preload file ready from OPFS (bridged from opfs:file-ready via playback.ts)
  bus.on('storage:preload-file-ready', async (filename: string, sessionId: number) => {
    try {
      log.debug(`[Preload] OPFS preload ready: ${filename} (SID: ${sessionId})`);

      // Guard: ignore stale OPFS completions from superseded preload sessions.
      // After backward navigation, clearPreloadState cancels the host's transfer
      // and bumps the session ID, but the OPFS worker may still signal completion
      // for the old session. Accepting it would set preload.nextFileBlob to a stale
      // file, causing handlePlayPreloaded to use the wrong track.
      //
      // HOTFIX (2026-04-20): there's ONE case where a "stale" completion is not
      // actually stale — we explicitly want it. When the user advances to a
      // track whose preload was still assembling, we transition the lifecycle
      // to AWAITING_PRELOAD for that track (playback.pendingRecoveryTarget
      // records it). Host then schedules the NEXT preload, which bumps
      // latestPreloadSessionId. When OUR target's OPFS write finally resolves
      // moments later, the naïve guard drops it because its session ID is now
      // behind latest. Result: guest stalls in AWAITING_PRELOAD for 10s, then
      // the watchdog triggers a 0% re-download — the exact behaviour the
      // Phase 3 refactor was meant to kill.
      //
      // So: if the "stale" session is the one we're actively awaiting, accept
      // the completion. The newer session keeps progressing in the background;
      // when it eventually finishes, its own preload-file-ready call will
      // overwrite preload.meta / nextFileBlob with its data.
      // Resolve how to classify this completion. Two sources of "which track
      // is this for?":
      //   (a) preload.sessionState.get(sessionId) — authoritative, but may be
      //       GONE because cleanupStalePreloadSessions() purges finalized
      //       sessions when the NEXT PRELOAD_START arrives. That's the crux
      //       of the beta regression: session 2 finalizes → PRELOAD_START(3)
      //       cleans session 2 up → OPFS completion for 2 fires → lookup
      //       misses → we wrongly think it's stale → drop.
      //   (b) filename compared against playback.pendingRecoveryTarget.name
      //       — our AWAITING_PRELOAD target.
      //
      // Fall through to (b) when (a) is missing AND we're AWAITING_PRELOAD.
      const sessionForFile = getState('preload.sessionState').get(sessionId);
      const lifecycle = getState('playback.lifecycle');
      const recoveryTarget = getState('playback.pendingRecoveryTarget');
      const awaitedName =
        lifecycle === 'AWAITING_PRELOAD' ? (recoveryTarget?.name ?? '') : '';
      const pendingIdx = recoveryTarget?.index ?? -1;
      const isOurAwaitTarget =
        lifecycle === 'AWAITING_PRELOAD' && !!filename && !!awaitedName && filename === awaitedName;

      if (latestPreloadSessionId !== 0 && sessionId < latestPreloadSessionId) {
        // "Stale" per the old guard's definition — but accept if it matches
        // our wait target by filename (handles the session-cleanup race).
        if (!isOurAwaitTarget) {
          log.debug(
            `[Preload] Ignoring stale OPFS completion: SID ${sessionId} < latest ${latestPreloadSessionId}, filename=${filename}, awaited=${awaitedName || '(none)'}`,
          );
          return;
        }
        log.info(
          `[Preload] Accepting "stale" OPFS completion — matches our AWAITING_PRELOAD target by filename (${filename}, SID ${sessionId}, latest ${latestPreloadSessionId}, session ${sessionForFile ? 'present' : 'cleaned up'})`,
        );
      }

      const file = await readFileFromOpfs(filename, true);
      if (!file) {
        log.error('[Preload] Failed to read preload file from OPFS:', filename);
        return;
      }

      // Store as preload blob
      setState('preload.nextFileBlob', file);

      const preloadMeta = getState('preload.meta');

      // Build the right meta to publish. If the session is still around, use
      // it (the normal case). Otherwise, if we're honouring our await target,
      // reconstruct meta from the playlist + the File so downstream readers
      // (loadPreloadedTrack's localMeta) see track-2 info instead of the
      // newer preload's stale track-3 info that lives in `preloadMeta`.
      let resolvedNextTrackIndex: number;
      if (sessionForFile) {
        setState('preload.meta', sessionForFile);
        resolvedNextTrackIndex = sessionForFile.index;
      } else if (isOurAwaitTarget) {
        const reconstructed = {
          name: filename,
          index: pendingIdx as number,
          mime: file.type || '',
          total: 0, // best-effort; loadPreloadedTrack doesn't rely on total
          size: file.size,
          sessionId,
        };
        setState('preload.meta', reconstructed);
        resolvedNextTrackIndex = pendingIdx as number;
      } else {
        // Normal non-stale completion with no session record — fall back to
        // whatever meta we had. Should be rare.
        setState('preload.meta', preloadMeta);
        resolvedNextTrackIndex = (preloadMeta?.index as number) ?? -1;
      }
      setState('preload.nextTrackIndex', resolvedNextTrackIndex);
      const nextTrackIndex = resolvedNextTrackIndex;

      // Send PRELOAD_ACK to host now that OPFS file is confirmed ready
      if (nextTrackIndex >= 0) {
        const ackSent = getState('preload.ackSent');
        if (!ackSent.has(nextTrackIndex)) {
          const updatedAckSent = new Set(ackSent);
          updatedAckSent.add(nextTrackIndex);
          setState('preload.ackSent', updatedAckSent);
          if (sendToHost({ type: MSG.PRELOAD_ACK, index: nextTrackIndex })) {
            log.debug(`[Guest] Sent PRELOAD_ACK for index ${nextTrackIndex}`);
          }
        }
      }

      // Hide preload loader (background preload complete)
      showLoader(false);

      // If guest was waiting for this preloaded file, trigger playback.
      // Lifecycle is authoritative for the wait gate; pendingRecoveryTarget
      // confirms the index match.
      const isAwaiting = getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD;
      const pendingFileIndex = getState('playback.pendingRecoveryTarget')?.index;
      if (isAwaiting && pendingFileIndex === nextTrackIndex) {
        log.debug('[Preload] Guest was waiting for this track. Playing now.');
        // Lifecycle (Phase 3 dual-write): the blob we were AWAITING_PRELOAD for
        // is now assembled → promote to DECODING. No-op if we're in any other
        // state (e.g. background preload for next track while currently PLAYING).
        transition({ type: 'PRELOAD_FILE_READY', index: nextTrackIndex });
        bus.emit('storage:use-preloaded', nextTrackIndex, filename);
      }
    } catch (e) {
      log.error('[Preload] preload-file-ready handler failed:', e);
    }
  });

  // Handle preload-ready notification (emitted after PRELOAD_END)
  bus.on('storage:preload-ready', (index: number) => {
    log.debug(`[Preload] Preload ready for index: ${index}`);
    // This signals the preload chain is complete.
    // The actual file finalization is handled by opfs:file-ready → storage:preload-file-ready
  });

  // Clean up module-local variables when the session is left
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      latestPreloadSessionId = 0;
      preloadReorderBuffer.clear();
      _activePlayPreloadedIndex = undefined;
      _preloadScope?.dispose();
      _preloadScope = null;
      _activePreloadUnicasts.forEach((e) => e.scope.dispose());
      _activePreloadUnicasts.clear();
    }
  });

  log.info('[Preload] Handlers registered');
}
