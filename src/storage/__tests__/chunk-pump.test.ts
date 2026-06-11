/**
 * @vitest-environment jsdom
 *
 * Engine-level pins for the shared chunk pump (src/storage/chunk-pump.ts).
 * These pin the ENGINE contract that both broadcast wrappers (broadcastFile,
 * backgroundTransfer) rely on. Wrapper-observable behavior is pinned in
 * transfer.test.ts / preload.test.ts.
 *
 * Real timers + small param timeouts: stallTimeoutMs is an engine parameter,
 * so tests pass ~150-200ms instead of faking 5s/30s clocks. Assertions are
 * made strictly AFTER the pump settles — never timing-based mid-flight.
 */
import { describe, it, expect, vi } from 'vitest';
import { pumpChunksToPeers } from '../chunk-pump.ts';
import { MSG } from '../../core/constants.ts';
import type { ConnectedPeer, DataConnection, AnyProtocolMsg } from '../../types/index.ts';

interface MockConn {
  open: boolean;
  peer: string;
  send: ReturnType<typeof vi.fn>;
  dataChannel: { readyState: string; bufferedAmount: number };
}

function makeConn(peer: string, bufferedAmount = 0): MockConn {
  return {
    open: true,
    peer,
    send: vi.fn(),
    dataChannel: { readyState: 'open', bufferedAmount },
  };
}

function makePeer(id: string, conn: MockConn): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: conn as unknown as DataConnection,
    isOp: false,
    preloadedIndexes: new Set<number>(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
}

function buildMsg(chunk: Uint8Array, index: number): AnyProtocolMsg {
  return { type: MSG.PRELOAD_CHUNK, chunk, index, sessionId: 1 };
}

// 5 bytes / chunkSize 2 → 3 chunks
const FILE = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);

const baseOpts = {
  file: FILE,
  chunkSize: 2,
  buildChunkMsg: buildMsg,
  bufferedLimit: 1024,
  stallTimeoutMs: 150,
  isWritable: () => true,
  shouldContinue: () => true,
};

const chunkCalls = (conn: MockConn) =>
  conn.send.mock.calls.filter((c) => (c[0] as { type: string }).type === MSG.PRELOAD_CHUNK);

describe('pumpChunksToPeers — per-peer exclusion', () => {
  it('excludes a backpressure-stalled peer without stalling or flooding it, healthy peer gets all chunks', async () => {
    const healthyConn = makeConn('peer-healthy', 0);
    const frozenConn = makeConn('peer-frozen', 10 * 1024 * 1024); // frozen above limit
    const onPeerExcluded = vi.fn();

    const result = await pumpChunksToPeers({
      ...baseOpts,
      peers: [makePeer('peer-healthy', healthyConn), makePeer('peer-frozen', frozenConn)],
      onPeerExcluded,
    });

    // Engine completes — exclusion is per-peer, never a session stop.
    expect(result.status).toBe('complete');
    expect(result.excluded).toEqual(new Set(['peer-frozen']));

    // Healthy peer: full lockstep stream.
    expect(chunkCalls(healthyConn)).toHaveLength(3);

    // Frozen peer: the wait loop runs BEFORE the send, so it receives ZERO
    // chunks — neither pre-exclusion nor post-timeout flooding.
    expect(chunkCalls(frozenConn)).toHaveLength(0);

    // Callback fires exactly once, with the excluded peer.
    expect(onPeerExcluded).toHaveBeenCalledTimes(1);
    expect(onPeerExcluded.mock.calls[0][0].id).toBe('peer-frozen');
  });

  it('excludes a peer that turns unwritable mid-stream, exactly once', async () => {
    const healthyConn = makeConn('peer-healthy', 0);
    const flakyConn = makeConn('peer-flaky', 0);
    const onPeerExcluded = vi.fn();
    let flakyWritable = true;

    const result = await pumpChunksToPeers({
      ...baseOpts,
      peers: [makePeer('peer-healthy', healthyConn), makePeer('peer-flaky', flakyConn)],
      isWritable: (p) => (p.id === 'peer-flaky' ? flakyWritable : true),
      shouldContinue: () => {
        // Flip writability after chunk 0 has been dispatched.
        if (chunkCalls(flakyConn).length > 0) flakyWritable = false;
        return true;
      },
      onPeerExcluded,
    });

    expect(result.status).toBe('complete');
    expect(result.excluded).toEqual(new Set(['peer-flaky']));
    expect(chunkCalls(flakyConn)).toHaveLength(1); // chunk 0 only
    expect(chunkCalls(healthyConn)).toHaveLength(3);
    // Exactly once despite two further chunk iterations seeing it unwritable.
    expect(onPeerExcluded).toHaveBeenCalledTimes(1);
  });

  it('returns complete (not stopped) when ALL peers become excluded, so wrappers run completion guards', async () => {
    const frozenConn = makeConn('peer-frozen', 10 * 1024 * 1024);

    const result = await pumpChunksToPeers({
      ...baseOpts,
      peers: [makePeer('peer-frozen', frozenConn)],
    });

    // 'stopped' is reserved for shouldContinue() failures ONLY — an
    // all-excluded early break must still let wrappers run END fanout
    // (which then filters to an empty survivor set).
    expect(result.status).toBe('complete');
    expect(result.excluded).toEqual(new Set(['peer-frozen']));
    expect(chunkCalls(frozenConn)).toHaveLength(0);
  });
});

describe('pumpChunksToPeers — shouldContinue contract', () => {
  it('stops with status stopped, evaluated once per chunk at iteration top', async () => {
    const conn = makeConn('peer-a', 0);
    const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

    const result = await pumpChunksToPeers({
      ...baseOpts,
      peers: [makePeer('peer-a', conn)],
      shouldContinue,
    });

    expect(result.status).toBe('stopped');
    expect(result.excluded.size).toBe(0);
    expect(chunkCalls(conn)).toHaveLength(1); // chunk 0 sent, stopped before chunk 1
    // Once per chunk at iteration top: i=0 (true), i=1 (false) — never inside
    // per-peer waits.
    expect(shouldContinue).toHaveBeenCalledTimes(2);
  });
});

describe('pumpChunksToPeers — totality', () => {
  it('never rejects when a conn.send throws (safeSend absorbs); siblings unaffected', async () => {
    const healthyConn = makeConn('peer-healthy', 0);
    const throwingConn = makeConn('peer-throwing', 0);
    throwingConn.send.mockImplementation(() => {
      throw new Error('send failed');
    });

    const result = await pumpChunksToPeers({
      ...baseOpts,
      peers: [makePeer('peer-throwing', throwingConn), makePeer('peer-healthy', healthyConn)],
    });

    expect(result.status).toBe('complete');
    // A throwing send is NOT an exclusion (safeSend swallows it); the engine
    // keeps attempting — matching the pre-refactor try/catch-per-send shape.
    expect(result.excluded.size).toBe(0);
    expect(chunkCalls(healthyConn)).toHaveLength(3);
    expect(throwingConn.send).toHaveBeenCalledTimes(3);
  });

  it('handles an empty peer list as an immediate complete', async () => {
    const result = await pumpChunksToPeers({ ...baseOpts, peers: [] });
    expect(result.status).toBe('complete');
    expect(result.excluded.size).toBe(0);
  });
});

describe('chunk-pump — state-free contract', () => {
  it('the engine module never imports setState (all state writes stay in wrappers)', async () => {
    // The engine being side-effect-free w.r.t. the state tree is what
    // protects the wrappers' audit-hardened aborted-vs-superseded cleanup
    // semantics. Pin it statically: no import binding of setState.
    const source = (await import('../chunk-pump.ts?raw')).default as string;
    expect(source).not.toMatch(/import\s*\{[^}]*\bsetState\b/);
  });
});
