import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { MAX_MSG_LENGTH, MAX_SENDER_LABEL_LENGTH, MSG } from '../../core/constants.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  registerHandlers: vi.fn(),
  rememberPinnedNotice: vi.fn(),
  playAnnouncementSound: vi.fn(),
  getRoomContext: vi.fn(),
  isCoordinator: vi.fn(),
  verifyPeerCapability: vi.fn(),
}));

vi.mock('../peer-state.ts', () => ({ broadcast: mocks.broadcast }));
vi.mock('../protocol.ts', () => ({ registerHandlers: mocks.registerHandlers }));
vi.mock('../../chat/protocol.ts', () => ({
  rememberPinnedNotice: mocks.rememberPinnedNotice,
}));
vi.mock('../../audio/ui-sounds.ts', () => ({
  playAnnouncementSound: mocks.playAnnouncementSound,
}));
vi.mock('../../rooms/authority.ts', () => ({
  getRoomContext: mocks.getRoomContext,
  isCoordinator: mocks.isCoordinator,
  verifyPeerCapability: mocks.verifyPeerCapability,
}));
vi.mock('../../i18n/index.ts', () => ({
  t: (key: string): string => key,
}));
vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

type RoomControlHandler = (data: Record<string, unknown>, conn: DataConnection) => void;

function makeConnection(peer: string): DataConnection {
  return { peer, open: true } as DataConnection;
}

function makePeer(
  id: string,
  conn: DataConnection,
  overrides: Partial<ConnectedPeer> = {},
): ConnectedPeer {
  return {
    id,
    slot: 1,
    conn,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    connectionType: 'local',
    isDataTarget: true,
    joinOrder: 1,
    lastHeartbeat: 0,
    label: id,
    ...overrides,
  };
}

function standardRoomContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'standard',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'host-transport',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: [],
    ...overrides,
  };
}

function proRoomContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'pro',
    roomId: '123456',
    role: 'coordinator',
    coordinatorId: 'pro-owner',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['members.manage'],
    ...overrides,
  };
}

describe('room control plane', () => {
  const senderConn = makeConnection('sender');
  const targetConn = makeConnection('target');
  let handlers: Record<string, RoomControlHandler>;

  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    handlers = {};
    mocks.registerHandlers.mockImplementation((next: Record<string, RoomControlHandler>) => {
      Object.assign(handlers, next);
    });

    setState('network.myId', 'host-transport');
    setState('network.sessionCode', '123456');
    setState('network.connectedPeers', [
      makePeer('sender', senderConn, {
        isOp: true,
        joinOrder: 1,
        label: 'Administrator',
        memberId: 'member_sender',
        isAuthenticated: true,
      }),
      makePeer('target', targetConn, {
        joinOrder: 2,
        label: 'Listener',
        memberId: 'member_target',
        isAuthenticated: true,
      }),
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['sender', senderConn],
        ['target', targetConn],
      ]),
    );

    mocks.getRoomContext.mockReturnValue(standardRoomContext());
    mocks.isCoordinator.mockReturnValue(true);
    mocks.verifyPeerCapability.mockReturnValue(true);
  });

  it('keeps member removal behind current room and exact connection authority', async () => {
    const { resolveRoomControlKickTarget } = await import('../room-control.ts');

    expect(resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member')).toBe(
      'target',
    );
    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'sender' }, senderConn, 'member'),
    ).toBeNull();

    mocks.verifyPeerCapability.mockReturnValue(false);
    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();
  });

  it('rejects replaced sender and target connections even when peer ids are reused', async () => {
    const { resolveRoomControlKickTarget } = await import('../room-control.ts');
    const replacedSender = makeConnection('sender');
    const replacedTarget = makeConnection('target');

    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, replacedSender, 'member'),
    ).toBeNull();

    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['sender', senderConn],
        ['target', replacedTarget],
      ]),
    );
    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();

    setState('network.connectedPeers', [
      makePeer('sender', senderConn, { isOp: true, status: 'disconnected' }),
      makePeer('target', targetConn),
    ]);
    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();
  });

  it.each([
    ['participant role', { role: 'participant' }],
    ['missing coordinator', { coordinatorId: null }],
    ['uninitialized epoch', { epoch: 0 }],
    ['missing room capability', { capabilities: [] }],
    ['different room', { roomId: '654321' }],
  ])('fails closed for a PRO room with %s', async (_name, overrides) => {
    const { resolveRoomControlKickTarget } = await import('../room-control.ts');
    mocks.getRoomContext.mockReturnValue(proRoomContext(overrides));

    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();
  });

  it('allows a fully projected PRO member manager to resolve a live member', async () => {
    const { resolveRoomControlKickTarget } = await import('../room-control.ts');
    mocks.getRoomContext.mockReturnValue(proRoomContext());

    expect(resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member')).toBe(
      'target',
    );
  });

  it('requires this transport to be the coordinator in both room kinds', async () => {
    const { resolveRoomControlKickTarget } = await import('../room-control.ts');
    mocks.isCoordinator.mockReturnValue(false);

    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();

    mocks.getRoomContext.mockReturnValue(proRoomContext());
    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();
  });

  it('distinguishes account-wide removal from exact sibling-device removal', async () => {
    const { resolveRoomControlKickTarget } = await import('../room-control.ts');
    setState('network.connectedPeers', [
      makePeer('sender', senderConn, {
        isOp: true,
        memberId: 'member-shared',
        isAuthenticated: true,
      }),
      makePeer('target', targetConn, {
        isOp: true,
        memberId: 'member-shared',
        isAuthenticated: true,
      }),
    ]);

    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();
    expect(resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'physical')).toBe(
      'target',
    );
  });

  it('fails closed for unverified sibling claims and administrators from another account', async () => {
    const { resolveRoomControlKickTarget } = await import('../room-control.ts');
    const sender = makePeer('sender', senderConn, {
      isOp: true,
      memberId: 'member-shared',
      isAuthenticated: false,
    });
    const target = makePeer('target', targetConn, {
      isOp: true,
      memberId: 'member-shared',
      isAuthenticated: false,
    });
    setState('network.connectedPeers', [sender, target]);

    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'physical'),
    ).toBeNull();

    setState('network.connectedPeers', [
      { ...sender, memberId: 'member-sender', isAuthenticated: true },
      { ...target, memberId: 'member-target', isAuthenticated: true },
    ]);
    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'physical'),
    ).toBeNull();
    expect(
      resolveRoomControlKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();
  });

  it.each(['sender', 'host-transport'])(
    'protects self and host target %s',
    async (targetPeerId) => {
      const { resolveRoomControlKickTarget } = await import('../room-control.ts');

      expect(resolveRoomControlKickTarget({ targetPeerId }, senderConn, 'physical')).toBeNull();
      expect(resolveRoomControlKickTarget({ targetPeerId }, senderConn, 'member')).toBeNull();
    },
  );

  it('routes standard member and physical kicks but keeps PRO physical removal server-owned', async () => {
    const { initRoomControl } = await import('../room-control.ts');
    const resolveKickTarget = vi.fn(() => 'target');
    const memberKick = vi.fn();
    const physicalKick = vi.fn();
    bus.on('network:kick-device', memberKick);
    bus.on('network:kick-physical-device', physicalKick);
    initRoomControl(resolveKickTarget);

    handlers[MSG.REQUEST_KICK_DEVICE]?.({ targetPeerId: 'target' }, senderConn);
    handlers[MSG.REQUEST_KICK_PHYSICAL_DEVICE]?.({ targetPeerId: 'target' }, senderConn);

    expect(memberKick).toHaveBeenCalledWith('target');
    expect(physicalKick).toHaveBeenCalledWith('target');
    expect(resolveKickTarget).toHaveBeenNthCalledWith(
      1,
      { targetPeerId: 'target' },
      senderConn,
      'member',
    );
    expect(resolveKickTarget).toHaveBeenNthCalledWith(
      2,
      { targetPeerId: 'target' },
      senderConn,
      'physical',
    );

    mocks.getRoomContext.mockReturnValue(proRoomContext());
    handlers[MSG.REQUEST_KICK_PHYSICAL_DEVICE]?.({ targetPeerId: 'target' }, senderConn);

    expect(physicalKick).toHaveBeenCalledOnce();
    expect(resolveKickTarget).toHaveBeenCalledTimes(2);
  });

  it('uses the narrow standard-room capability for each chat command class', async () => {
    const { initRoomControl } = await import('../room-control.ts');
    mocks.verifyPeerCapability.mockImplementation(
      (_conn: DataConnection, capability: string) => capability === 'chat.notice',
    );
    initRoomControl(() => null);

    handlers[MSG.REQUEST_CHAT_COMMAND]?.({ command: 'freeze', args: ['on'] }, senderConn);
    handlers[MSG.REQUEST_CHAT_COMMAND]?.({ command: 'notice', args: ['Pinned'] }, senderConn);

    expect(mocks.verifyPeerCapability).toHaveBeenCalledWith(senderConn, 'room.configure');
    expect(mocks.verifyPeerCapability).toHaveBeenCalledWith(senderConn, 'chat.notice');
    expect(mocks.broadcast).toHaveBeenCalledOnce();
    expect(mocks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.CHAT_NOTICE, text: 'Pinned' }),
    );
  });

  it('requires the projected operator role for PRO chat administration', async () => {
    const { initRoomControl } = await import('../room-control.ts');
    mocks.getRoomContext.mockReturnValue(proRoomContext());
    mocks.verifyPeerCapability.mockReturnValue(false);
    setState('network.connectedPeers', [
      makePeer('sender', senderConn, { isOp: false }),
      makePeer('target', targetConn),
    ]);
    initRoomControl(() => null);

    handlers[MSG.REQUEST_CHAT_COMMAND]?.({ command: 'notice', args: ['blocked'] }, senderConn);
    expect(mocks.broadcast).not.toHaveBeenCalled();

    setState('network.connectedPeers', [
      makePeer('sender', senderConn, { isOp: true }),
      makePeer('target', targetConn),
    ]);
    handlers[MSG.REQUEST_CHAT_COMMAND]?.({ command: 'notice', args: ['allowed'] }, senderConn);

    expect(mocks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.CHAT_NOTICE, text: 'allowed' }),
    );
    expect(mocks.verifyPeerCapability).not.toHaveBeenCalled();
  });

  it('registers bounded canonical notice publication without exporting handlers', async () => {
    const { initRoomControl } = await import('../room-control.ts');
    const resolveKickTarget = vi.fn(() => null);
    const longLabel = 'L'.repeat(MAX_SENDER_LABEL_LENGTH + 20);
    setState('network.connectedPeers', [
      makePeer('sender', senderConn, {
        isOp: true,
        label: longLabel,
      }),
    ]);

    initRoomControl(resolveKickTarget);
    handlers[MSG.REQUEST_CHAT_COMMAND]?.(
      { command: 'notice', args: ['x'.repeat(MAX_MSG_LENGTH + 100)] },
      senderConn,
    );

    const payload = mocks.broadcast.mock.calls[0]?.[0] as {
      type: string;
      senderLabel: string;
      text: string;
      attention: boolean;
    };
    expect(payload).toMatchObject({
      type: MSG.CHAT_NOTICE,
      attention: true,
    });
    expect(payload.senderLabel).toHaveLength(MAX_SENDER_LABEL_LENGTH);
    expect(payload.text).toHaveLength(MAX_MSG_LENGTH);
    expect(mocks.rememberPinnedNotice).toHaveBeenCalledWith(payload);
    expect(mocks.playAnnouncementSound).toHaveBeenCalledOnce();
    expect(handlers).toMatchObject({
      [MSG.REQUEST_KICK_DEVICE]: expect.any(Function),
      [MSG.REQUEST_KICK_PHYSICAL_DEVICE]: expect.any(Function),
      [MSG.REQUEST_CHAT_COMMAND]: expect.any(Function),
    });
  });
});
