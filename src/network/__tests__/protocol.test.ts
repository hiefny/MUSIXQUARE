/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import {
  validateMessage,
  registerHandlers,
  registerHandler,
  hasHandler,
  verifyOperator,
} from '../protocol.ts';
import type { ConnectedPeer, DataConnection, MsgType } from '../../types/index.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

// ─── validateMessage ──────────────────────────────────────────────────

function makeConnection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

function makeConnectedPeer(id: string, isOp: boolean): ConnectedPeer {
  return {
    id,
    slot: 0,
    label: id,
    conn: null,
    isOp,
    preloadedIndexes: new Set<number>(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: 0,
  };
}

describe('validateMessage', () => {
  it('returns true for a valid object with a type property', () => {
    expect(validateMessage({ type: 'PLAY' })).toBe(true);
  });

  it('returns true for object with type and extra fields', () => {
    expect(validateMessage({ type: 'VOLUME', value: 80 })).toBe(true);
  });

  it('returns false for null', () => {
    expect(validateMessage(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(validateMessage(undefined)).toBe(false);
  });

  it('returns false for an empty object (no type field)', () => {
    expect(validateMessage({})).toBe(false);
  });

  it('returns false for a non-object (string)', () => {
    expect(validateMessage('hello')).toBe(false);
  });

  it('returns false for a non-object (number)', () => {
    expect(validateMessage(42)).toBe(false);
  });

  it('returns false for a non-object (boolean)', () => {
    expect(validateMessage(true)).toBe(false);
  });

  it('returns false when type field is missing', () => {
    expect(validateMessage({ name: 'test', value: 123 })).toBe(false);
  });

  it('returns false when type field is empty string (falsy)', () => {
    expect(validateMessage({ type: '' })).toBe(false);
  });

  it('returns false when type field is 0 (falsy)', () => {
    expect(validateMessage({ type: 0 })).toBe(false);
  });

  it('validates required fields — passes when all present', () => {
    const msg = { type: 'FILE_CHUNK', index: 5, sessionId: 1 };
    expect(validateMessage(msg, ['index', 'sessionId'])).toBe(true);
  });

  it('validates required fields — fails when a required field is missing', () => {
    const msg = { type: 'FILE_CHUNK', index: 5 };
    expect(validateMessage(msg, ['index', 'sessionId'])).toBe(false);
  });

  it('validates required fields — fails when a required field is null', () => {
    const msg = { type: 'FILE_CHUNK', index: 5, sessionId: null };
    expect(validateMessage(msg, ['index', 'sessionId'])).toBe(false);
  });

  it('validates required fields — fails when a required field is undefined', () => {
    const msg = { type: 'FILE_CHUNK', index: 5, sessionId: undefined };
    expect(validateMessage(msg, ['index', 'sessionId'])).toBe(false);
  });
});

// ─── registerHandlers / registerHandler / hasHandler ──────────────────

describe('registerHandlers', () => {
  it('registers handlers without throwing', () => {
    expect(() => {
      registerHandlers({
        [MSG.PLAY]: () => {},
        [MSG.PAUSE]: () => {},
      });
    }).not.toThrow();
  });

  it('registers a single handler via registerHandler', () => {
    expect(() => {
      registerHandler(MSG.PLAY, () => {});
    }).not.toThrow();
  });

  it('hasHandler returns true after registration', () => {
    const uniqueType = ('test-has-handler-' + Date.now()) as MsgType;
    registerHandler(uniqueType, () => {});
    expect(hasHandler(uniqueType)).toBe(true);
  });

  it('hasHandler returns false for unregistered type', () => {
    expect(hasHandler('never-registered-type-xyz' as MsgType)).toBe(false);
  });
});

describe('verifyOperator', () => {
  it('returns false when connection is null', () => {
    expect(verifyOperator(null as unknown as DataConnection)).toBe(false);
  });

  it('returns false when connection is undefined', () => {
    expect(verifyOperator(undefined as unknown as DataConnection)).toBe(false);
  });

  it('returns false when conn.peer is empty', () => {
    const conn = makeConnection('');
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns false when no operator in connectedPeers', () => {
    const conn = makeConnection('peer-123');
    // Default connectedPeers is empty, so no match
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns false when peer is found but isOp is false', () => {
    const conn = makeConnection('peer-456');
    // Manually set state to include a non-operator peer
    const peers = getState('network.connectedPeers');
    peers.push(makeConnectedPeer('peer-456', false));
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns true when peer is found and isOp is true', () => {
    const conn = makeConnection('peer-789');
    const peers = getState('network.connectedPeers');
    peers.push(makeConnectedPeer('peer-789', true));
    expect(verifyOperator(conn)).toBe(true);
  });
});
