/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { TRANSFER_STATE } from '../../core/constants.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

// ─── TRANSFER_STATE Constants ─────────────────────────────────────────

describe('TRANSFER_STATE constants', () => {
  it('has IDLE state', () => {
    expect(TRANSFER_STATE.IDLE).toBe('IDLE');
  });

  it('has RECEIVING state', () => {
    expect(TRANSFER_STATE.RECEIVING).toBe('RECEIVING');
  });

  it('has PROCESSING state', () => {
    expect(TRANSFER_STATE.PROCESSING).toBe('PROCESSING');
  });

  it('has READY state', () => {
    expect(TRANSFER_STATE.READY).toBe('READY');
  });

  it('has exactly 4 states', () => {
    expect(Object.keys(TRANSFER_STATE)).toHaveLength(4);
  });
});

// ─── Initial Transfer State ───────────────────────────────────────────

describe('initial transfer state', () => {
  it('transfer.state defaults to IDLE', () => {
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
  });

  it('transfer.receivedCount defaults to 0', () => {
    expect(getState('transfer.receivedCount')).toBe(0);
  });

  it('transfer.localSessionId defaults to 0', () => {
    expect(getState('transfer.localSessionId')).toBe(0);
  });

  it('transfer.currentSessionId defaults to 0', () => {
    expect(getState('transfer.currentSessionId')).toBe(0);
  });

  it('transfer.skipIncomingFile defaults to false', () => {
    expect(getState('transfer.skipIncomingFile')).toBe(false);
  });

  it('transfer.activeBroadcastSession defaults to null', () => {
    expect(getState('transfer.activeBroadcastSession')).toBeNull();
  });

  it('transfer.meta defaults to empty object', () => {
    const meta = getState('transfer.meta');
    expect(meta).toBeDefined();
    expect(typeof meta).toBe('object');
  });
});

// ─── State Reset ──────────────────────────────────────────────────────

describe('transfer state reset', () => {
  it('resetState restores transfer.state to IDLE', () => {
    setState('transfer.state', TRANSFER_STATE.RECEIVING);
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.RECEIVING);

    resetState();
    expect(getState('transfer.state')).toBe(TRANSFER_STATE.IDLE);
  });

  it('resetState restores transfer.receivedCount to 0', () => {
    setState('transfer.receivedCount', 42);
    expect(getState('transfer.receivedCount')).toBe(42);

    resetState();
    expect(getState('transfer.receivedCount')).toBe(0);
  });
});

// ─── Transfer Module Exports ──────────────────────────────────────────

describe('transfer module exports', () => {
  it('imports broadcastFile without error', async () => {
    const mod = await import('../transfer.ts');
    expect(typeof mod.broadcastFile).toBe('function');
  });

  it('imports unicastFile without error', async () => {
    const mod = await import('../transfer.ts');
    expect(typeof mod.unicastFile).toBe('function');
  });

  it('imports initTransfer without error', async () => {
    const mod = await import('../transfer.ts');
    expect(typeof mod.initTransfer).toBe('function');
  });
});
