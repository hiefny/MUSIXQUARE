/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import {
  validateMessage,
  registerHandlers,
  registerHandler,
  hasHandler,
  verifyOperator,
  RELAYABLE_COMMANDS,
} from '../protocol.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

// ─── validateMessage ──────────────────────────────────────────────────

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
        PLAY: () => {},
        PAUSE: () => {},
      } as any);
    }).not.toThrow();
  });

  it('registers a single handler via registerHandler', () => {
    expect(() => {
      registerHandler('PLAY' as any, () => {});
    }).not.toThrow();
  });

  it('hasHandler returns true after registration', () => {
    const uniqueType = ('TEST_HAS_HANDLER_' + Date.now()) as any;
    registerHandler(uniqueType, () => {});
    expect(hasHandler(uniqueType)).toBe(true);
  });

  it('hasHandler returns false for unregistered type', () => {
    expect(hasHandler('NEVER_REGISTERED_TYPE_XYZ' as any)).toBe(false);
  });
});

// ─── RELAYABLE_COMMANDS ───────────────────────────────────────────────

describe('RELAYABLE_COMMANDS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(RELAYABLE_COMMANDS)).toBe(true);
    expect(RELAYABLE_COMMANDS.length).toBeGreaterThan(0);
  });

  it('contains known command types', () => {
    // MSG constants use lowercase values (e.g., MSG.PLAY = 'play')
    expect(RELAYABLE_COMMANDS).toContain('play');
    expect(RELAYABLE_COMMANDS).toContain('pause');
    expect(RELAYABLE_COMMANDS).toContain('volume');
  });
});

// ─── verifyOperator ───────────────────────────────────────────────────

describe('verifyOperator', () => {
  it('returns false when connection is null', () => {
    expect(verifyOperator(null as any)).toBe(false);
  });

  it('returns false when connection is undefined', () => {
    expect(verifyOperator(undefined as any)).toBe(false);
  });

  it('returns false when conn.peer is empty', () => {
    const conn = { peer: '' } as any;
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns false when no operator in connectedPeers', () => {
    const conn = { peer: 'peer-123' } as any;
    // Default connectedPeers is empty, so no match
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns false when peer is found but isOp is false', () => {
    const conn = { peer: 'peer-456' } as any;
    // Manually set state to include a non-operator peer
    const peers = getState('network.connectedPeers');
    peers.push({ id: 'peer-456', isOp: false } as any);
    expect(verifyOperator(conn)).toBe(false);
  });

  it('returns true when peer is found and isOp is true', () => {
    const conn = { peer: 'peer-789' } as any;
    const peers = getState('network.connectedPeers');
    peers.push({ id: 'peer-789', isOp: true } as any);
    expect(verifyOperator(conn)).toBe(true);
  });
});
