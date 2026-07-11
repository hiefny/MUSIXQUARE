import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: mocks.showToast,
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

  // Every guest control handler drops frames that do not arrive via hostConn
  // (threat comments in guest.ts: a malicious same-session peer can otherwise
  // forge session-teardown / privilege frames over its own DataConnection).
  // Each test pairs the forged-frame drop with the honored host-frame path so
  // a regression in either direction fails.
  describe('control frames are host-gated', () => {
    const evilConn = { open: true, peer: 'guest-evil' } as DataConnection;
    let gatedHostConn: DataConnection;

    beforeEach(async () => {
      gatedHostConn = {
        open: true,
        peer: 'host-1',
        close: vi.fn(),
        send: vi.fn(),
      } as unknown as DataConnection;
      setState('network.hostConn', gatedHostConn);
      const { initGuestProtocolHandlers } = await import('../guest.ts');
      initGuestProtocolHandlers();
    });

    it('ignores a forged kick-device frame but leaves the session on the host frame', async () => {
      const { handleData } = await import('../protocol.ts');
      const kicked = vi.fn();
      bus.on('network:kicked-explicitly', kicked);

      await handleData({ type: MSG.KICK_DEVICE }, evilConn);
      expect(kicked).not.toHaveBeenCalled();
      expect(getState('network.isIntentionalDisconnect')).toBe(false);

      await handleData({ type: MSG.KICK_DEVICE }, gatedHostConn);
      expect(kicked).toHaveBeenCalledTimes(1);
      expect(getState('network.isIntentionalDisconnect')).toBe(true);
    });

    it('ignores a forged session-full frame and tears down only on the host frame', async () => {
      const { handleData } = await import('../protocol.ts');
      const sessionFull = vi.fn();
      bus.on('network:session-full', sessionFull);

      await handleData({ type: MSG.SESSION_FULL, message: 'forged' }, evilConn);
      expect(sessionFull).not.toHaveBeenCalled();
      expect(getState('network.hostConn')).toBe(gatedHostConn);

      await handleData({ type: MSG.SESSION_FULL, message: 'Room is full' }, gatedHostConn);
      expect(sessionFull).toHaveBeenCalledWith('Room is full');
      expect(gatedHostConn.close).toHaveBeenCalledTimes(1);
      expect(getState('network.hostConn')).toBeNull();
      expect(getState('network.isIntentionalDisconnect')).toBe(true);
    });

    it('drops a forged empty device list and leaves only on a host list that excludes us', async () => {
      const { handleData } = await import('../protocol.ts');
      const kickedFromSession = vi.fn();
      bus.on('network:kicked-from-session', kickedFromSession);

      await handleData({ type: MSG.DEVICE_LIST_UPDATE, list: [] }, evilConn);
      expect(kickedFromSession).not.toHaveBeenCalled();
      expect(getState('network.lastKnownDeviceList')).toBeNull();

      await handleData(
        {
          type: MSG.DEVICE_LIST_UPDATE,
          list: [{ id: 'host-1', label: 'HOST', status: 'connected', isHost: true, joinOrder: 0 }],
        },
        gatedHostConn,
      );
      expect(kickedFromSession).toHaveBeenCalledTimes(1);
      expect(getState('network.isIntentionalDisconnect')).toBe(true);
      // A list that excludes us is never stored — only the kick flow runs.
      expect(getState('network.lastKnownDeviceList')).toBeNull();
    });

    it('rejects forged operator grants and strips a stale operator flag on host welcome', async () => {
      const { handleData } = await import('../protocol.ts');

      await handleData({ type: MSG.OPERATOR_GRANT }, evilConn);
      expect(getState('network.isOperator')).toBe(false);

      await handleData({ type: MSG.OPERATOR_GRANT }, gatedHostConn);
      expect(getState('network.isOperator')).toBe(true);

      await handleData({ type: MSG.WELCOME, label: 'PWNED' }, evilConn);
      expect(getState('network.myDeviceLabel')).not.toBe('PWNED');
      expect(getState('network.isOperator')).toBe(true);

      // Host WELCOME means the host recreated this peer with isOp=false, so a
      // stale local OP flag must ratchet down (host re-grants explicitly).
      await handleData({ type: MSG.WELCOME, label: 'Guest 2' }, gatedHostConn);
      expect(getState('network.myDeviceLabel')).toBe('Guest 2');
      expect(getState('network.isOperator')).toBe(false);
    });
  });

  it('shows operator-only toasts only when they come from the host', async () => {
    const { initGuestProtocolHandlers } = await import('../guest.ts');
    const { handleData } = await import('../protocol.ts');

    initGuestProtocolHandlers();
    setState('network.isOperator', true);

    await handleData({ type: MSG.OPERATOR_TOAST, text: 'operator notice' }, conn);
    expect(mocks.showToast).toHaveBeenCalledWith('operator notice');

    mocks.showToast.mockClear();
    setState('network.isOperator', false);
    await handleData({ type: MSG.OPERATOR_TOAST, text: 'operator notice' }, conn);
    expect(mocks.showToast).not.toHaveBeenCalled();

    mocks.showToast.mockClear();
    setState('network.isOperator', true);
    await handleData({ type: MSG.OPERATOR_TOAST, text: 'operator notice' }, {
      open: true,
      peer: 'guest-a',
    } as DataConnection);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});
