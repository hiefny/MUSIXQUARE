import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { MSG } from '../../core/constants.ts';
import type { DataConnection, DeviceInfo } from '../../types/index.ts';
import { initGuestProtocolHandlers } from '../guest.ts';

vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));

function hostConnection(): DataConnection & { send: ReturnType<typeof vi.fn> } {
  return {
    peer: 'host-transport',
    open: true,
    send: vi.fn(),
  } as unknown as DataConnection & { send: ReturnType<typeof vi.fn> };
}

function memberDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 'target-device-a',
    label: 'Minsu',
    isOp: false,
    isHost: false,
    status: 'connected',
    memberId: 'member_abcdefghijklmnopqrstuv',
    memberDisplayNumber: 1,
    isAuthenticated: true,
    ...overrides,
  };
}

describe('standard-room delegated member requests', () => {
  beforeEach(() => {
    bus.clear();
    resetState();
    setState('network.appRole', 'guest');
    setState('room.context', {
      kind: 'standard',
      roomId: '123456',
      role: 'member',
      coordinatorId: 'host-transport',
      epoch: 0,
      snapshotRevision: 0,
      capabilities: [],
    });
    initGuestProtocolHandlers();
  });

  it('relays one physical target and leaves account-wide expansion to the host', () => {
    const host = hostConnection();
    const identity = memberDevice();
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['members.manage']);
    setState('network.lastKnownDeviceList', [identity, memberDevice({ id: 'target-device-b' })]);

    bus.emit('network:request-kick-standard-room-member', {
      memberId: identity.memberId!,
    });

    expect(host.send).toHaveBeenCalledTimes(1);
    expect(host.send).toHaveBeenCalledWith({
      type: MSG.REQUEST_KICK_DEVICE,
      targetPeerId: 'target-device-a',
    });
  });

  it('uses a distinct frame for one exact physical connection', () => {
    const host = hostConnection();
    const identity = memberDevice();
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['members.manage']);
    setState('network.lastKnownDeviceList', [identity, memberDevice({ id: 'target-device-b' })]);

    bus.emit('network:request-kick-standard-room-device', { peerId: 'target-device-b' });

    expect(host.send).toHaveBeenCalledTimes(1);
    expect(host.send).toHaveBeenCalledWith({
      type: MSG.REQUEST_KICK_PHYSICAL_DEVICE,
      targetPeerId: 'target-device-b',
    });
  });

  it('supports the anonymous canonical peer key', () => {
    const host = hostConnection();
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['members.manage']);
    setState('network.lastKnownDeviceList', [
      memberDevice({
        id: 'anonymous-device',
        label: 'Peer 2',
        memberId: undefined,
        memberDisplayNumber: undefined,
        isAuthenticated: false,
      }),
    ]);

    bus.emit('network:request-kick-standard-room-member', {
      memberId: 'peer:anonymous-device',
    });

    expect(host.send).toHaveBeenCalledWith({
      type: MSG.REQUEST_KICK_DEVICE,
      targetPeerId: 'anonymous-device',
    });
  });

  it('does not relay without the explicit member-management capability', () => {
    const host = hostConnection();
    const identity = memberDevice();
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control']);
    setState('network.lastKnownDeviceList', [identity]);

    bus.emit('network:request-kick-standard-room-member', {
      memberId: identity.memberId!,
    });

    expect(host.send).not.toHaveBeenCalled();
  });
});
