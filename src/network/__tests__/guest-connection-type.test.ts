import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import type { DataConnection } from '../../types/index.ts';

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('guest connection type authority', () => {
  const conn = { open: true, peer: 'host-1' } as DataConnection;

  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    setState('network.hostConn', conn);
    setState('network.myId', 'guest-1');
  });

  it('lets the host device list override the guest local ICE view', async () => {
    const { initGuestProtocolHandlers } = await import('../guest.ts');
    const { handleData } = await import('../protocol.ts');

    setState('network.connectionType', 'local');

    initGuestProtocolHandlers();
    await handleData(
      {
        type: MSG.DEVICE_LIST_UPDATE,
        list: [
          { id: 'host-1', label: 'HOST', status: 'connected', isHost: true, joinOrder: 0 },
          {
            id: 'guest-1',
            label: 'Guest',
            status: 'connected',
            isHost: false,
            joinOrder: 1,
            connectionType: 'remote',
          },
        ],
      },
      conn,
    );

    expect(getState('network.connectionType')).toBe('remote');
  });
});
