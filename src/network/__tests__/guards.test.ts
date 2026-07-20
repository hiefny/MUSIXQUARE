/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import type { DataConnection, RoomCapability } from '../../types/index.ts';
import { showToast } from '../../ui/toast.ts';
import { isGuestBlocked } from '../guards.ts';

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
}));

beforeEach(() => {
  resetState();
  vi.mocked(showToast).mockClear();
});

function enterStandardAdministrator(capabilities: RoomCapability[]): void {
  setState('network.appRole', 'guest');
  setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);
  setState('network.isOperator', true);
  setState('network.standardRoomCapabilities', capabilities);
}

describe('isGuestBlocked', () => {
  it('allows a standard administrator with playback.control', () => {
    enterStandardAdministrator(['playback.control']);

    expect(isGuestBlocked()).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not treat the legacy operator role as playback authority', () => {
    enterStandardAdministrator(['media.add']);

    expect(isGuestBlocked()).toBe(true);
    expect(showToast).toHaveBeenCalledOnce();
  });

  it('uses the same playback capability boundary in a PRO room', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['media.add'],
    });
    expect(isGuestBlocked()).toBe(true);

    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 2,
      capabilities: ['playback.control'],
    });
    expect(isGuestBlocked()).toBe(false);
  });
});
