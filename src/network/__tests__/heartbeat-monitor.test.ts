import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
  broadcastDeviceList: vi.fn(),
  detachHostPeerConnection: vi.fn(),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: mocks.setManagedTimer,
  clearManagedTimer: mocks.clearManagedTimer,
}));
vi.mock('../peer.ts', () => ({
  broadcastDeviceList: mocks.broadcastDeviceList,
}));
vi.mock('../host-peer-departure.ts', () => ({
  detachHostPeerConnection: mocks.detachHostPeerConnection,
}));
vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function connection(
  state: RTCPeerConnectionState | undefined,
  open = true,
  dataState?: RTCDataChannelState,
  controlState?: RTCDataChannelState,
): DataConnection {
  return {
    open,
    peerConnection: state === undefined ? undefined : { connectionState: state },
    dataChannel: dataState === undefined ? undefined : { readyState: dataState },
    controlChannel: controlState === undefined ? undefined : { readyState: controlState },
  } as DataConnection;
}

describe('host heartbeat monitor', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
  });

  it('derives grace from the live RTC transport rather than timer absence alone', async () => {
    const { heartbeatTransportGrace } = await import('../heartbeat-monitor.ts');

    expect(heartbeatTransportGrace(undefined)).toBe(8_000);
    expect(heartbeatTransportGrace(connection('connected', false))).toBe(8_000);
    expect(heartbeatTransportGrace(connection('failed'))).toBe(8_000);
    expect(heartbeatTransportGrace(connection('connected', true, 'open', 'open'))).toBe(90_000);
    expect(heartbeatTransportGrace(connection('disconnected'))).toBe(30_000);
    expect(heartbeatTransportGrace(connection('connecting'))).toBe(30_000);
  });

  it('owns the session lifecycle that starts and stops the monitor', async () => {
    const { initHeartbeatMonitor } = await import('../heartbeat-monitor.ts');
    setState('network.hostConn', null);

    initHeartbeatMonitor();
    setState('setup.sessionStarted', true);

    expect(mocks.clearManagedTimer).toHaveBeenCalledWith('heartbeat-monitor');
    expect(mocks.setManagedTimer).toHaveBeenCalledWith(
      'heartbeat-monitor',
      expect.any(Function),
      5_000,
      { interval: true },
    );

    setState('setup.sessionStarted', false);
    expect(mocks.clearManagedTimer).toHaveBeenLastCalledWith('heartbeat-monitor');
  });
});
