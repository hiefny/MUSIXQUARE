import { beforeEach, describe, expect, it, vi } from 'vitest';

const timerMocks = vi.hoisted(() => {
  const callbacks = new Map<string, () => void>();
  return {
    callbacks,
    setManagedTimer: vi.fn((name: string, callback: () => void) => {
      callbacks.set(name, callback);
    }),
    clearManagedTimer: vi.fn((name: string) => {
      callbacks.delete(name);
    }),
    delay: vi.fn(async () => undefined),
  };
});

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: timerMocks.setManagedTimer,
  clearManagedTimer: timerMocks.clearManagedTimer,
  delay: timerMocks.delay,
}));

import { resetState, setState } from '../../core/state.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import {
  cancelConnectionTypeWaiters,
  canSendFileTo,
  waitForGuestConnectionType,
} from '../peer-state.ts';

function callbackFor(prefix: string): () => void {
  const match = [...timerMocks.callbacks.entries()].find(([name]) => name.startsWith(prefix));
  if (!match) throw new Error(`Missing timer callback: ${prefix}`);
  return match[1];
}

function connectedPeer(conn: DataConnection): ConnectedPeer {
  return {
    id: 'peer-1',
    slot: 1,
    label: 'Guest 1',
    conn,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'unknown',
    lastHeartbeat: 0,
  };
}

beforeEach(() => {
  cancelConnectionTypeWaiters();
  timerMocks.callbacks.clear();
  timerMocks.setManagedTimer.mockClear();
  timerMocks.clearManagedTimer.mockClear();
  resetState();
});

describe('connection-type waiter lifecycle', () => {
  it('resolves a guest wait normally and releases both managed timers', async () => {
    setState('network.connectionType', 'unknown');
    const pending = waitForGuestConnectionType(3_000);

    setState('network.connectionType', 'local');
    callbackFor('guestConnType-interval-')();

    await expect(pending).resolves.toBe('local');
    expect(timerMocks.callbacks.size).toBe(0);
  });

  it('uses the remote safety default on a normal timeout', async () => {
    setState('network.connectionType', 'unknown');
    const pending = waitForGuestConnectionType(3_000);

    callbackFor('guestConnType-timeout-')();

    await expect(pending).resolves.toBe('remote');
    expect(timerMocks.callbacks.size).toBe(0);
  });

  it('settles a host transfer guard safely when its wait is cancelled', async () => {
    const conn = { open: true } as DataConnection;
    setState('network.connectedPeers', [connectedPeer(conn)]);
    const pending = canSendFileTo(conn);

    cancelConnectionTypeWaiters();

    await expect(pending).resolves.toBe(false);
    expect(timerMocks.callbacks.size).toBe(0);
  });

  it('fences a retained old poll callback from a successor wait', async () => {
    setState('network.connectionType', 'unknown');
    const previous = waitForGuestConnectionType(3_000);
    const retainedPreviousPoll = callbackFor('guestConnType-interval-');

    cancelConnectionTypeWaiters();
    await expect(previous).resolves.toBe('remote');

    const successor = waitForGuestConnectionType(3_000);
    const successorPoll = callbackFor('guestConnType-interval-');
    let successorSettled = false;
    void successor.then(() => {
      successorSettled = true;
    });
    setState('network.connectionType', 'local');

    retainedPreviousPoll();
    await Promise.resolve();
    expect(successorSettled).toBe(false);

    successorPoll();
    await expect(successor).resolves.toBe('local');
    expect(timerMocks.callbacks.size).toBe(0);
  });
});
