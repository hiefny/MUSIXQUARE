import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type { ConnectedPeer, DataConnection, PeerInstance } from '../../types/index.ts';
import type { StandardRoomPinCommit } from '../transport/types.ts';
import { setPeer } from '../peer-state.ts';
import { changeStandardRoomPin } from '../standard-room-pin.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface Deferred {
  readonly promise: Promise<StandardRoomPinCommit>;
  resolve(commit: StandardRoomPinCommit): void;
}

function deferred(): Deferred {
  let resolve: (commit: StandardRoomPinCommit) => void = () => undefined;
  const promise = new Promise<StandardRoomPinCommit>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function peer(id: string): ConnectedPeer {
  return {
    id,
    slot: 1,
    label: id,
    conn: { peer: id, open: true } as DataConnection,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
}

function startStandardHost(): void {
  setState('network.appRole', 'host');
  setState('network.hostConn', null);
  setState('network.myId', 'host-device');
  setState('network.sessionCode', '123456');
  setState('room.context', {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'host-device',
    epoch: 1,
    snapshotRevision: 0,
    capabilities: [],
  });
}

const setRoomPassword = vi.fn<NonNullable<PeerInstance['setRoomPassword']>>();
const revoked = vi.fn();

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  setRoomPassword.mockReset();
  setPeer({ setRoomPassword } as unknown as PeerInstance);
  bus.on('network:room-pin-revoke-present', revoked);
  startStandardHost();
});

afterEach(() => {
  setPeer(null);
  vi.useRealTimers();
});

describe('changeStandardRoomPin', () => {
  it('keeps every device present at the decision, bound to the commit', async () => {
    setState('network.connectedPeers', [peer('guest-a'), peer('guest-b')]);
    setRoomPassword.mockResolvedValueOnce({ status: 'applied', membership: 'keep_present' });

    await expect(
      changeStandardRoomPin('12345678', { membership: 'keep_present', enabling: true }),
    ).resolves.toBe('applied');

    expect(setRoomPassword).toHaveBeenCalledExactlyOnceWith('12345678', {
      mode: 'keep_present',
      keptPeerIds: ['guest-a', 'guest-b'],
    });
    expect(revoked).not.toHaveBeenCalled();
  });

  it.each([
    [true, 'room-pin-enabled'],
    [false, 'room-pin-changed'],
  ] as const)(
    'removes present devices only after the Worker applies "Everyone rejoins" (enabling: %s)',
    async (enabling, reason) => {
      setState('network.connectedPeers', [peer('guest-a')]);
      const commit = deferred();
      setRoomPassword.mockReturnValueOnce(commit.promise);

      const outcome = changeStandardRoomPin('12345678', { membership: 'revoke_all', enabling });
      await Promise.resolve();
      expect(setRoomPassword).toHaveBeenCalledExactlyOnceWith('12345678', {
        mode: 'revoke_all',
        keptPeerIds: [],
      });
      expect(revoked).not.toHaveBeenCalled();

      commit.resolve({ status: 'applied', membership: 'revoke_all' });
      await expect(outcome).resolves.toBe('applied');
      expect(revoked).toHaveBeenCalledExactlyOnceWith(reason);
    },
  );

  it('still removes present devices when an older Worker applied the PIN alone', async () => {
    setRoomPassword.mockResolvedValueOnce({ status: 'applied', membership: 'legacy' });

    await expect(
      changeStandardRoomPin('12345678', { membership: 'revoke_all', enabling: false }),
    ).resolves.toBe('applied');

    expect(revoked).toHaveBeenCalledExactlyOnceWith('room-pin-changed');
  });

  it('reports pending at the UI deadline and removes people when the late ack arrives', async () => {
    vi.useFakeTimers();
    const commit = deferred();
    setRoomPassword.mockReturnValueOnce(commit.promise);

    const outcome = changeStandardRoomPin('12345678', {
      membership: 'revoke_all',
      enabling: false,
      waitMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(outcome).resolves.toBe('pending');
    expect(revoked).not.toHaveBeenCalled();

    commit.resolve({ status: 'applied', membership: 'revoke_all' });
    await vi.advanceTimersByTimeAsync(0);
    expect(revoked).toHaveBeenCalledExactlyOnceWith('room-pin-changed');
  });

  it('never removes anyone for a superseded change', async () => {
    setRoomPassword.mockResolvedValueOnce({ status: 'superseded' });

    await expect(
      changeStandardRoomPin('12345678', { membership: 'revoke_all', enabling: false }),
    ).resolves.toBe('unsupported');

    expect(revoked).not.toHaveBeenCalled();
  });

  it('disarms an armed removal when protection is turned off before the ack', async () => {
    vi.useFakeTimers();
    const revoke = deferred();
    setRoomPassword
      .mockReturnValueOnce(revoke.promise)
      .mockResolvedValueOnce({ status: 'applied', membership: 'legacy' });

    const first = changeStandardRoomPin('12345678', {
      membership: 'revoke_all',
      enabling: true,
      waitMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toBe('pending');

    await expect(changeStandardRoomPin(null, { enabling: false })).resolves.toBe('applied');
    expect(setRoomPassword).toHaveBeenLastCalledWith(null, undefined);

    // Even a late "applied" for the older mutation must not remove anyone.
    revoke.resolve({ status: 'applied', membership: 'revoke_all' });
    await vi.advanceTimersByTimeAsync(0);
    expect(revoked).not.toHaveBeenCalled();
  });

  it('does not remove anyone after the host session changed', async () => {
    const commit = deferred();
    setRoomPassword.mockReturnValueOnce(commit.promise);
    const outcome = changeStandardRoomPin('12345678', {
      membership: 'revoke_all',
      enabling: false,
    });
    setState('network.sessionCode', '654321');

    commit.resolve({ status: 'applied', membership: 'revoke_all' });
    await expect(outcome).resolves.toBe('applied');
    expect(revoked).not.toHaveBeenCalled();
  });

  it('applies PeerJS hosts (no signaling PIN) with the host-side removal', async () => {
    setPeer({} as PeerInstance);

    await expect(
      changeStandardRoomPin('12345678', { membership: 'revoke_all', enabling: true }),
    ).resolves.toBe('applied');

    expect(revoked).toHaveBeenCalledExactlyOnceWith('room-pin-enabled');
  });

  it('never sends a membership choice when protection is turned off', async () => {
    setRoomPassword.mockResolvedValueOnce({ status: 'applied', membership: 'legacy' });

    await changeStandardRoomPin(null, { membership: 'revoke_all', enabling: false });

    expect(setRoomPassword).toHaveBeenCalledExactlyOnceWith(null, undefined);
    expect(revoked).not.toHaveBeenCalled();
  });

  it.each([
    ['a guest tab', () => setState('network.appRole', 'guest')],
    ['a PRO room', () => setState('room.context', { ...proContext() })],
    ['no transport', () => setPeer(null)],
    ['no session code', () => setState('network.sessionCode', '')],
  ])('refuses from %s', async (_label, arrange) => {
    arrange();

    await expect(
      changeStandardRoomPin('12345678', { membership: 'revoke_all', enabling: true }),
    ).resolves.toBe('unsupported');

    expect(setRoomPassword).not.toHaveBeenCalled();
    expect(revoked).not.toHaveBeenCalled();
  });

  it('reports a transport that throws as unsupported', async () => {
    setRoomPassword.mockImplementationOnce(() => {
      throw new Error('closed');
    });

    await expect(
      changeStandardRoomPin('12345678', { membership: 'keep_present', enabling: true }),
    ).resolves.toBe('unsupported');
  });
});

function proContext() {
  return {
    kind: 'pro' as const,
    roomId: '000001',
    role: 'coordinator' as const,
    coordinatorId: 'host-device',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: [],
  };
}
