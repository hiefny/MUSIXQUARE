/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, TRANSFER_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import type { DataConnection } from '../../types/index.ts';
import { isActiveHostPreloadChunkForRateLimitForTests } from '../preload.ts';
import { isActiveHostFileChunkForRateLimit } from '../transfer-receive.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = 7;
const hostConn = { peer: 'host', open: true } as DataConnection;
const guestConn = { peer: 'guest', open: true } as DataConnection;
const isActiveHostPreloadChunkForRateLimit = isActiveHostPreloadChunkForRateLimitForTests;

function fileChunk(overrides: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
  return {
    type: 'file-chunk',
    chunk: new Uint8Array(CHUNK_SIZE),
    chunkIndex: 0,
    queueItemId: QUEUE_ITEM_ID,
    sessionId: SESSION_ID,
    total: 2,
    name: 'track.wav',
    size: CHUNK_SIZE + 1,
    ...overrides,
  };
}

function preloadChunk(overrides: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
  return {
    type: 'preload-chunk',
    chunk: new Uint8Array(CHUNK_SIZE),
    chunkIndex: 0,
    queueItemId: QUEUE_ITEM_ID,
    sessionId: SESSION_ID,
    ...overrides,
  };
}

beforeEach(() => {
  resetState();
  setState('network.appRole', 'guest');
  setState('network.hostConn', hostConn);
});

describe('main-transfer chunk rate-limit exemption', () => {
  beforeEach(() => {
    setState('transfer.localSessionId', SESSION_ID);
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('transfer.meta', {
      queueItemId: QUEUE_ITEM_ID,
      indexHint: 0,
      name: 'track.wav',
      total: 2,
      size: CHUNK_SIZE + 1,
      sessionId: SESSION_ID,
    });
  });

  it('exempts only the exact active tuple from the exact host connection', () => {
    expect(isActiveHostFileChunkForRateLimit(fileChunk(), hostConn)).toBe(true);
    expect(isActiveHostFileChunkForRateLimit(fileChunk(), guestConn)).toBe(false);
    expect(
      isActiveHostFileChunkForRateLimit(fileChunk({ queueItemId: OTHER_QUEUE_ITEM_ID }), hostConn),
    ).toBe(false);
    expect(
      isActiveHostFileChunkForRateLimit(fileChunk({ sessionId: SESSION_ID + 1 }), hostConn),
    ).toBe(false);
    expect(isActiveHostFileChunkForRateLimit(fileChunk({ chunkIndex: 2 }), hostConn)).toBe(false);
    expect(
      isActiveHostFileChunkForRateLimit(
        fileChunk({ chunk: new Uint8Array(CHUNK_SIZE + 1) }),
        hostConn,
      ),
    ).toBe(false);
    expect(
      isActiveHostFileChunkForRateLimit(fileChunk({ total: 1, size: CHUNK_SIZE }), hostConn),
    ).toBe(false);
    expect(isActiveHostFileChunkForRateLimit(fileChunk({ unexpected: true }), hostConn)).toBe(
      false,
    );
  });

  it('stops exempting as soon as the receive state or authority is inactive', () => {
    setState('transfer.state', TRANSFER_STATE.READY);
    expect(isActiveHostFileChunkForRateLimit(fileChunk(), hostConn)).toBe(false);

    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    setState('network.hostConn', guestConn);
    expect(isActiveHostFileChunkForRateLimit(fileChunk(), hostConn)).toBe(false);

    setState('network.hostConn', hostConn);
    setState('network.appRole', 'host');
    expect(isActiveHostFileChunkForRateLimit(fileChunk(), hostConn)).toBe(false);
  });
});

describe('preload chunk rate-limit exemption', () => {
  beforeEach(() => {
    setState(
      'preload.sessionState',
      new Map([
        [
          SESSION_ID,
          {
            skipped: false,
            progress: 0,
            total: 2,
            name: 'next.wav',
            queueItemId: QUEUE_ITEM_ID,
            indexHint: 1,
            size: CHUNK_SIZE + 1,
            mime: 'audio/wav',
            nextExpectedChunk: 0,
            finalized: false,
          },
        ],
      ]),
    );
  });

  it('exempts only a bounded active session from the exact host connection', () => {
    expect(isActiveHostPreloadChunkForRateLimit(preloadChunk(), hostConn)).toBe(true);
    expect(isActiveHostPreloadChunkForRateLimit(preloadChunk(), guestConn)).toBe(false);
    expect(
      isActiveHostPreloadChunkForRateLimit(
        preloadChunk({ queueItemId: OTHER_QUEUE_ITEM_ID }),
        hostConn,
      ),
    ).toBe(false);
    expect(
      isActiveHostPreloadChunkForRateLimit(preloadChunk({ sessionId: SESSION_ID + 1 }), hostConn),
    ).toBe(false);
    expect(isActiveHostPreloadChunkForRateLimit(preloadChunk({ chunkIndex: 2 }), hostConn)).toBe(
      false,
    );
    expect(
      isActiveHostPreloadChunkForRateLimit(
        preloadChunk({ chunk: new Uint8Array(CHUNK_SIZE + 1) }),
        hostConn,
      ),
    ).toBe(false);
    expect(isActiveHostPreloadChunkForRateLimit(preloadChunk({ unexpected: true }), hostConn)).toBe(
      false,
    );
  });

  it('does not exempt skipped, finalized, or missing preload sessions', () => {
    const sessions = new Map(getState('preload.sessionState'));
    const active = sessions.get(SESSION_ID)!;

    sessions.set(SESSION_ID, { ...active, skipped: true });
    setState('preload.sessionState', sessions);
    expect(isActiveHostPreloadChunkForRateLimit(preloadChunk(), hostConn)).toBe(false);

    sessions.set(SESSION_ID, { ...active, finalized: true });
    setState('preload.sessionState', new Map(sessions));
    expect(isActiveHostPreloadChunkForRateLimit(preloadChunk(), hostConn)).toBe(false);

    setState('preload.sessionState', new Map());
    expect(isActiveHostPreloadChunkForRateLimit(preloadChunk(), hostConn)).toBe(false);
  });
});
