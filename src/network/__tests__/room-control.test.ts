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
  verifyPeerCapability: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../peer.ts', () => ({ broadcast: mocks.broadcast }));
vi.mock('../protocol.ts', () => ({ registerHandlers: mocks.registerHandlers }));
vi.mock('../../chat/protocol.ts', () => ({
  rememberPinnedNotice: mocks.rememberPinnedNotice,
}));
vi.mock('../../audio/ui-sounds.ts', () => ({
  playAnnouncementSound: mocks.playAnnouncementSound,
}));
vi.mock('../../rooms/authority.ts', () => ({
  getRoomContext: mocks.getRoomContext,
  verifyPeerCapability: mocks.verifyPeerCapability,
}));
vi.mock('../../i18n/index.ts', () => ({
  t: (key: string): string => key,
}));
vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
  },
}));

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

describe('room control plane', () => {
  const senderConn = makeConnection('sender');
  const targetConn = makeConnection('target');

  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();

    setState('network.appRole', 'host');
    setState('network.hostConn', null);
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

    mocks.getRoomContext.mockReturnValue({
      kind: 'standard',
      roomId: '123456',
      role: 'coordinator',
      coordinatorId: 'host-transport',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    mocks.verifyPeerCapability.mockReturnValue(true);
  });

  it('keeps member removal behind exact live-connection authority', async () => {
    const { resolveRequestedKickTarget } = await import('../room-control.ts');

    expect(
      resolveRequestedKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBe('target');
    expect(
      resolveRequestedKickTarget({ targetPeerId: 'sender' }, senderConn, 'member'),
    ).toBeNull();

    mocks.verifyPeerCapability.mockReturnValue(false);
    expect(
      resolveRequestedKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();
  });

  it('does not let member-wide removal target another administrator', async () => {
    const { resolveRequestedKickTarget } = await import('../room-control.ts');
    const peers = [
      makePeer('sender', senderConn, { isOp: true, memberId: 'member_sender' }),
      makePeer('target', targetConn, { isOp: true, memberId: 'member_target' }),
    ];
    setState('network.connectedPeers', peers);

    expect(
      resolveRequestedKickTarget({ targetPeerId: 'target' }, senderConn, 'member'),
    ).toBeNull();
  });

  it('canonicalizes and bounds delegated notice publication', async () => {
    const { handleRequestChatCommand } = await import('../room-control.ts');
    const longLabel = 'L'.repeat(MAX_SENDER_LABEL_LENGTH + 20);
    setState('network.connectedPeers', [
      makePeer('sender', senderConn, {
        isOp: true,
        label: longLabel,
      }),
    ]);
    setState('network.activeHostConnByPeerId', new Map([['sender', senderConn]]));

    handleRequestChatCommand(
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
  });

  it('registers only room-control protocol handlers', async () => {
    const { initRoomControl } = await import('../room-control.ts');

    initRoomControl();

    expect(mocks.registerHandlers).toHaveBeenCalledWith({
      [MSG.REQUEST_KICK_DEVICE]: expect.any(Function),
      [MSG.REQUEST_KICK_PHYSICAL_DEVICE]: expect.any(Function),
      [MSG.REQUEST_CHAT_COMMAND]: expect.any(Function),
    });
  });
});
