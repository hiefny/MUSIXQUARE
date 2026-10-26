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

// What a current host grants an ordinary administrator with every permission.
const ADMIN_GRANT = [
  'effects.control',
  'media.add',
  'queue.mutate',
  'asset.upload',
  'playback.control',
  'members.manage',
  'chat.notice',
];

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
          {
            id: 'host-1',
            label: 'HOST',
            status: 'connected',
            isHost: true,
            joinOrder: 0,
            devicePlatform: 'windows',
          },
          {
            id: 'guest-1',
            label: 'Guest',
            status: 'connected',
            isHost: false,
            joinOrder: 1,
            connectionType: 'remote',
            devicePlatform: 'ios',
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
      expect(kicked).toHaveBeenCalledWith();
      expect(getState('network.isIntentionalDisconnect')).toBe(true);
    });

    it('forwards only a known room-PIN kick reason, and only from the host', async () => {
      const { handleData } = await import('../protocol.ts');
      const kicked = vi.fn();
      bus.on('network:kicked-explicitly', kicked);

      await handleData({ type: MSG.KICK_DEVICE, reason: 'room-pin-changed' }, evilConn);
      expect(kicked).not.toHaveBeenCalled();

      await handleData({ type: MSG.KICK_DEVICE, reason: 'room-pin-changed' }, gatedHostConn);
      await handleData({ type: MSG.KICK_DEVICE, reason: 'room-pin-enabled' }, gatedHostConn);
      // A reason this App does not know keeps the generic kick copy.
      await handleData({ type: MSG.KICK_DEVICE, reason: 'future-reason' }, gatedHostConn);
      expect(kicked.mock.calls).toEqual([['room-pin-changed'], ['room-pin-enabled'], []]);
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

    // Old-version removal train 2 (Q4, receive side): a host may later drop
    // the fallback text, so the guest owns the copy.
    it.each([
      { label: 'only a translation key', frame: { i18nKey: 'network.session_full_detail' } },
      { label: 'neither text nor key', frame: {} },
    ])('leaves with the translated room-full notice from $label', async ({ frame }) => {
      const { handleData } = await import('../protocol.ts');
      const { t } = await import('../../i18n/index.ts');
      const sessionFull = vi.fn();
      bus.on('network:session-full', sessionFull);

      await handleData({ type: MSG.SESSION_FULL, ...frame }, gatedHostConn);

      expect(sessionFull).toHaveBeenCalledWith(
        t('i18nKey' in frame ? 'network.session_full_detail' : 'network.session_full'),
      );
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
          list: [
            {
              id: 'host-1',
              label: 'HOST',
              status: 'connected',
              isHost: true,
              joinOrder: 0,
              devicePlatform: 'windows',
            },
          ],
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

      await handleData({ type: MSG.OPERATOR_GRANT, capabilities: ADMIN_GRANT }, evilConn);
      expect(getState('network.isOperator')).toBe(false);

      await handleData({ type: MSG.OPERATOR_GRANT, capabilities: ADMIN_GRANT }, gatedHostConn);
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

    it('confers no administrator capability from a grant without its capability list', async () => {
      const { handleData } = await import('../protocol.ts');
      const { hasRoomCapability } = await import('../../rooms/authority.ts');
      setState('network.appRole', 'guest');

      await handleData({ type: MSG.OPERATOR_GRANT }, gatedHostConn);

      expect(getState('network.isOperator')).toBe(false);
      expect(hasRoomCapability('media.add')).toBe(false);
      expect(hasRoomCapability('playback.control')).toBe(false);
      expect(mocks.showToast).not.toHaveBeenCalled();
    });

    it('accepts every owner product capability from the host but strips physical transport roles', async () => {
      const { handleData } = await import('../protocol.ts');
      const { hasRoomCapability, isCoordinator } = await import('../../rooms/authority.ts');
      setState('network.appRole', 'guest');

      await handleData(
        {
          type: MSG.OPERATOR_GRANT,
          capabilities: [
            'media.add',
            'queue.mutate',
            'playback.control',
            'effects.control',
            'asset.upload',
            'members.manage',
            'chat.notice',
            'room.configure',
            'system-audio.publish',
            'coordinator.eligible',
          ],
        },
        gatedHostConn,
      );

      expect(getState('network.standardRoomCapabilities')).toEqual([
        'media.add',
        'queue.mutate',
        'playback.control',
        'effects.control',
        'asset.upload',
        'members.manage',
        'chat.notice',
        'room.configure',
      ]);
      expect(hasRoomCapability('queue.mutate')).toBe(true);
      expect(hasRoomCapability('effects.control')).toBe(true);
      expect(hasRoomCapability('room.configure')).toBe(true);
      expect(hasRoomCapability('system-audio.publish')).toBe(false);
      expect(hasRoomCapability('coordinator.eligible')).toBe(false);
      expect(isCoordinator()).toBe(false);
      expect(getState('network.hostConn')).toBe(gatedHostConn);
      expect(mocks.showToast).not.toHaveBeenCalled();

      await handleData({ type: MSG.OPERATOR_REVOKE }, gatedHostConn);
      expect(getState('network.isOperator')).toBe(false);
      expect(getState('network.standardRoomCapabilities')).toBeNull();
      expect(mocks.showToast).not.toHaveBeenCalled();
    });

    it('shows administrator toasts only for real legacy state transitions', async () => {
      const { handleData } = await import('../protocol.ts');

      // A non-administrator receives this during ordinary authority
      // reconciliation. It must remain a no-op from the user's perspective.
      await handleData({ type: MSG.OPERATOR_REVOKE }, gatedHostConn);
      expect(getState('network.isOperator')).toBe(false);
      expect(mocks.showToast).not.toHaveBeenCalled();

      await handleData({ type: MSG.OPERATOR_GRANT, capabilities: ADMIN_GRANT }, gatedHostConn);
      expect(getState('network.isOperator')).toBe(true);
      expect(mocks.showToast).toHaveBeenCalledTimes(1);

      // Duplicate projections still refresh the state but cannot announce a
      // second promotion.
      await handleData({ type: MSG.OPERATOR_GRANT, capabilities: ADMIN_GRANT }, gatedHostConn);
      expect(getState('network.isOperator')).toBe(true);
      expect(mocks.showToast).toHaveBeenCalledTimes(1);

      await handleData({ type: MSG.OPERATOR_REVOKE }, gatedHostConn);
      expect(getState('network.isOperator')).toBe(false);
      expect(mocks.showToast).toHaveBeenCalledTimes(2);

      await handleData({ type: MSG.OPERATOR_REVOKE }, gatedHostConn);
      expect(getState('network.isOperator')).toBe(false);
      expect(mocks.showToast).toHaveBeenCalledTimes(2);
    });

    it('confirms the guest role only from the host projection on the current link', async () => {
      const { handleData } = await import('../protocol.ts');
      const { roomCapabilityStatus } = await import('../../rooms/authority.ts');
      setState('network.appRole', 'guest');
      setState('setup.sessionStarted', true);

      expect(roomCapabilityStatus('media.add')).toBe('pending');

      // WELCOME precedes a returning administrator's grant, and a forged
      // projection from another peer proves nothing.
      await handleData({ type: MSG.WELCOME, label: 'Guest' }, gatedHostConn);
      await handleData({ type: MSG.OPERATOR_REVOKE, silent: true }, evilConn);
      expect(roomCapabilityStatus('media.add')).toBe('pending');

      await handleData({ type: MSG.OPERATOR_REVOKE, silent: true }, gatedHostConn);
      expect(roomCapabilityStatus('media.add')).toBe('denied');

      // A reconnect starts a new link that waits for its own projection.
      const replacement = { ...gatedHostConn } as DataConnection;
      setState('network.hostConn', replacement);
      expect(roomCapabilityStatus('media.add')).toBe('pending');

      await handleData(
        { type: MSG.OPERATOR_GRANT, capabilities: ['effects.control'], silent: true },
        replacement,
      );
      expect(roomCapabilityStatus('effects.control')).toBe('granted');
      expect(roomCapabilityStatus('media.add')).toBe('denied');
    });

    it('fails authority closed and restores it silently during identity reconciliation', async () => {
      const { handleData } = await import('../protocol.ts');

      setState('network.isOperator', true);
      setState('network.standardRoomCapabilities', ['media.add', 'playback.control']);

      await handleData({ type: MSG.OPERATOR_REVOKE, silent: true }, gatedHostConn);
      expect(getState('network.isOperator')).toBe(false);
      expect(getState('network.standardRoomCapabilities')).toBeNull();
      expect(mocks.showToast).not.toHaveBeenCalled();

      await handleData(
        {
          type: MSG.OPERATOR_GRANT,
          capabilities: ['media.add', 'playback.control'],
          silent: true,
        },
        gatedHostConn,
      );
      expect(getState('network.isOperator')).toBe(true);
      expect(getState('network.standardRoomCapabilities')).toEqual([
        'media.add',
        'playback.control',
      ]);
      expect(mocks.showToast).not.toHaveBeenCalled();
    });

    it('resolves delayed account feedback only from the current host roster after its role frame', async () => {
      const { handleData } = await import('../protocol.ts');
      const authority = await import('../../rooms/authority.ts');
      setState('network.appRole', 'guest');
      setState('network.myId', 'guest-1');
      setState('network.lastJoinCode', '123456');
      const check = authority.beginStandardRoomAccountAuthorityCheck({
        roomCode: '123456',
        peerId: 'guest-1',
        role: 'guest',
      });
      await handleData({ type: MSG.OPERATOR_REVOKE, silent: true }, gatedHostConn);
      expect(authority.roomCapabilityStatus('asset.upload')).toBe('pending');
      authority.settleStandardRoomAccountAuthorityCheck(check, false);
      const memberId = `member_${'a'.repeat(22)}`;
      authority.acceptStandardRoomAccountAuthorityIdentity(memberId);
      const frame = {
        type: MSG.DEVICE_LIST_UPDATE,
        list: [
          {
            id: 'host-1',
            label: 'Host',
            isHost: true,
            isOp: true,
            status: 'connected',
            devicePlatform: 'other',
          },
          {
            id: 'guest-1',
            label: 'Peer',
            isHost: false,
            isOp: false,
            status: 'connected',
            connectionType: 'remote',
            isAuthenticated: true,
            memberId,
            devicePlatform: 'other',
          },
        ],
      };
      await handleData(frame, evilConn);
      expect(authority.roomCapabilityStatus('asset.upload')).toBe('pending');
      await handleData(frame, gatedHostConn);
      expect(authority.roomCapabilityStatus('asset.upload')).toBe('denied');
    });

    it('keeps a silent bootstrap pending but honors a deliberate host revocation', async () => {
      const { handleData } = await import('../protocol.ts');
      const authority = await import('../../rooms/authority.ts');
      setState('network.appRole', 'guest');
      setState('network.myId', 'guest-1');
      setState('network.lastJoinCode', '123456');
      const check = authority.beginStandardRoomAccountAuthorityCheck({
        roomCode: '123456',
        peerId: 'guest-1',
        role: 'guest',
      });
      await handleData({ type: MSG.OPERATOR_REVOKE, silent: true }, gatedHostConn);
      expect(authority.roomCapabilityStatus('asset.upload')).toBe('pending');
      await handleData({ type: MSG.OPERATOR_REVOKE }, evilConn);
      expect(authority.roomCapabilityStatus('asset.upload')).toBe('pending');

      await handleData({ type: MSG.OPERATOR_REVOKE }, gatedHostConn);
      expect(authority.roomCapabilityStatus('asset.upload')).toBe('denied');
      // The older account request cannot re-open checking after this decision.
      authority.settleStandardRoomAccountAuthorityCheck(check, false);
      expect(authority.roomCapabilityStatus('asset.upload')).toBe('denied');
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

  // Old-version removal train 2 (Q4, receive side): a key alone is enough.
  it('shows a translated operator toast that carries no fallback text', async () => {
    const { initGuestProtocolHandlers } = await import('../guest.ts');
    const { handleData } = await import('../protocol.ts');
    const { t } = await import('../../i18n/index.ts');

    initGuestProtocolHandlers();
    setState('network.isOperator', true);

    await handleData(
      { type: MSG.OPERATOR_TOAST, i18nKey: 'toast.remote_decode_device_wait' },
      conn,
    );
    expect(mocks.showToast).toHaveBeenCalledOnce();
    expect(mocks.showToast).toHaveBeenCalledWith(t('toast.remote_decode_device_wait'));

    mocks.showToast.mockClear();
    await handleData({ type: MSG.OPERATOR_TOAST }, conn);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});
