/**
 * @vitest-environment jsdom
 *
 * Host fan-out truncation contract: the host must
 * write the truncated text back onto the relayed payload — renderers cap at
 * MAX_MSG_LENGTH, but without the write-back the wire relayed the original
 * oversized text to N-1 guests (amplification). The 4000-char validator cap
 * is the defense-in-depth behind it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG, PEER_NAME_PREFIX } from '../../core/constants.ts';
import { handleData } from '../../network/protocol.ts';
import {
  beginLocalBotChatRequest,
  broadcastSystemMessage,
  publishBotChatResult,
  receiveProRoomRealtimeChat,
  registerChatProtocolHandlers,
  rememberPinnedNotice,
  sendLatestPinnedNotice,
  sendSystemMessage,
} from '../protocol.ts';
import {
  addChatMessage,
  addSystemChatMessage,
  upsertBotChatMessage,
} from '../../ui/chat-render.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import type { ProRealtimeRelayEnvelope } from '../../pro-room/network-bridge.ts';

const realtimeMocks = vi.hoisted(() => ({
  send: vi.fn(() => true),
}));

// Mock renderer functions only. Keep the wire caps
// (MAX_MSG_LENGTH/MAX_SENDER_LABEL_LENGTH) unmocked so tests exercise the
// authoritative values from core/constants.ts.
vi.mock('../../ui/chat-render.ts', () => ({
  addChatMessage: vi.fn(),
  addSystemChatMessage: vi.fn(),
  addWhisperMessage: vi.fn(),
  addNoticeChatMessage: vi.fn(),
  formatChatDisplayName: (s: string) => s,
  upsertBotChatMessage: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../pro-room/network-bridge.ts', () => ({
  sendProRoomRealtime: realtimeMocks.send,
}));

function connectedPeer(
  overrides: Pick<ConnectedPeer, 'id' | 'conn'> & Partial<ConnectedPeer>,
): ConnectedPeer {
  return {
    slot: 0,
    label: overrides.id,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: false,
    joinOrder: 0,
    connectionType: 'unknown',
    lastHeartbeat: 0,
    ...overrides,
  };
}

describe('PRO member-level chat projection', () => {
  function enterProRoom(): void {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 7,
      snapshotRevision: 11,
      capabilities: ['playback.control'],
    });
  }

  function messageFrame(
    senderId: string,
    text = 'hello',
    memberId?: string,
  ): ProRealtimeRelayEnvelope {
    return {
      type: 'pro-realtime',
      version: 1,
      roomCode: '000001',
      coordinatorEpoch: 7,
      eventId: `event-${senderId}`,
      channel: 'chat',
      payload: { kind: 'message', text },
      sender: {
        participantId: senderId,
        presenceIncarnationId: `presence-${senderId}`,
        ...(memberId ? { memberId } : {}),
        displayName: 'relay fallback',
      },
    };
  }

  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    enterProRoom();
    setState('network.myId', 'device-local');
    setState('network.myMemberId', 'member-minsu');
  });

  it('renders another device of the local account as mine without suppressing it', () => {
    setState('network.lastKnownDeviceList', [
      {
        id: 'device-local',
        label: 'Minsu',
        isOp: true,
        isHost: false,
        status: 'connected',
        memberId: 'member-minsu',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        role: 'controller',
      },
      {
        id: 'device-tablet',
        label: 'Minsu',
        isOp: true,
        isHost: false,
        status: 'connected',
        memberId: 'member-minsu',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        role: 'controller',
      },
    ]);

    receiveProRoomRealtimeChat(messageFrame('device-tablet'));

    expect(addChatMessage).toHaveBeenCalledWith('Minsu', 'hello', true, 'op', 1, 'member-minsu');
  });

  it('groups the first account message even when its presence row has not arrived yet', () => {
    setState('network.lastKnownDeviceList', [
      {
        id: 'device-local',
        label: 'Minsu',
        isOp: true,
        isHost: false,
        status: 'connected',
        memberId: 'member-minsu',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        role: 'controller',
      },
    ]);

    receiveProRoomRealtimeChat(messageFrame('device-tablet', 'first', 'member-minsu'));

    expect(addChatMessage).toHaveBeenCalledWith(
      'relay fallback',
      'first',
      true,
      undefined,
      undefined,
      'member-minsu',
    );
  });

  it('keeps the physical self echo suppressed while deriving crowns from the room role', () => {
    setState('network.lastKnownDeviceList', [
      {
        id: 'device-local',
        label: 'Minsu',
        isOp: false,
        isHost: false,
        status: 'connected',
        memberId: 'member-minsu',
        memberDisplayNumber: 1,
        role: 'member',
      },
      {
        id: 'device-owner',
        label: 'Owner',
        isOp: true,
        isHost: true,
        status: 'connected',
        memberId: 'member-owner',
        memberDisplayNumber: 0,
        role: 'owner',
      },
      {
        id: 'device-member',
        label: 'Guest',
        isOp: false,
        isHost: false,
        status: 'connected',
        memberId: 'member-guest',
        memberDisplayNumber: 2,
        role: 'member',
      },
    ]);

    receiveProRoomRealtimeChat(messageFrame('device-local', 'echo'));
    expect(addChatMessage).not.toHaveBeenCalled();

    receiveProRoomRealtimeChat(messageFrame('device-owner', 'owner'));
    receiveProRoomRealtimeChat(messageFrame('device-member', 'member'));

    expect(addChatMessage).toHaveBeenNthCalledWith(
      1,
      'Owner',
      'owner',
      false,
      'host',
      0,
      'member-owner',
    );
    expect(addChatMessage).toHaveBeenNthCalledWith(
      2,
      'Guest',
      'member',
      false,
      undefined,
      2,
      'member-guest',
    );
  });

  it('silently applies an authenticated reconnect control projection, including OFF values', () => {
    setState('network.chatFrozen', true);
    setState('network.filterEnabled', true);
    setState('network.slowmodeSeconds', 15);
    const muted: boolean[] = [];
    bus.on('chat:muted-state-changed', (on) => muted.push(on));
    const snapshotFrame: ProRealtimeRelayEnvelope = {
      type: 'pro-realtime',
      version: 1,
      roomCode: '000001',
      coordinatorEpoch: 7,
      eventId: 'snapshot-control-state',
      channel: 'chat-control-snapshot',
      payload: {
        revision: 8,
        frozen: false,
        filterEnabled: false,
        slowmodeSeconds: 0,
        muted: false,
      },
      sender: {
        participantId: 'server',
        presenceIncarnationId: 'server-chat-state',
        displayName: 'MUSIXQUARE',
      },
    };

    receiveProRoomRealtimeChat(snapshotFrame);

    expect(getState('network.chatFrozen')).toBe(false);
    expect(getState('network.filterEnabled')).toBe(false);
    expect(getState('network.slowmodeSeconds')).toBe(0);
    expect(muted).toEqual([false]);
    expect(addSystemChatMessage).not.toHaveBeenCalled();
  });
});

describe('host chat fan-out truncation (CHAT-1)', () => {
  const guestConn = { peer: 'guest-chat-1', open: true } as DataConnection;
  let _ts = 1000;

  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    registerChatProtocolHandlers();
    // Host context: no hostConn, own id distinct from the sender.
    setState('network.myId', 'host-id');
  });

  function sendChat(text: string): Array<Record<string, unknown>> {
    const relayed: Array<Record<string, unknown>> = [];
    bus.on('network:broadcast-except', (_peerId, data) => {
      relayed.push(data as Record<string, unknown>);
    });
    void handleData(
      {
        type: MSG.CHAT,
        text,
        ts: ++_ts,
        senderId: guestConn.peer,
        senderLabel: 'GUEST 1',
        joinOrder: 999,
      },
      guestConn,
    );
    return relayed;
  }

  it('relays the TRUNCATED text with the profanity filter off (the default)', () => {
    const relayed = sendChat('x'.repeat(3000)); // passes the 4000 validator cap

    expect(relayed).toHaveLength(1);
    expect((relayed[0].text as string).length).toBe(500);
  });

  it('never renders or relays a raw sender label before the peer list is authoritative', () => {
    const relayed = sendChat('hello');

    expect(addChatMessage).toHaveBeenCalledWith(
      PEER_NAME_PREFIX,
      'hello',
      false,
      undefined,
      undefined,
      guestConn.peer,
    );
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({
      senderId: guestConn.peer,
      senderLabel: PEER_NAME_PREFIX,
    });
    expect(relayed[0]).not.toHaveProperty('joinOrder');
  });

  it('relays truncated text with the filter on too (guards the branch re-coupling)', () => {
    setState('network.filterEnabled', true);
    const relayed = sendChat('y'.repeat(3000));

    expect(relayed).toHaveLength(1);
    expect((relayed[0].text as string).length).toBe(500);
  });

  it('drops multi-KB frames at the validator before the handler runs', () => {
    const relayed = sendChat('z'.repeat(5000)); // over the 4000 wire cap

    expect(relayed).toHaveLength(0);
  });

  it('does not amplify unknown inbound fields through host fan-out', () => {
    const relayed: Array<Record<string, unknown>> = [];
    bus.on('network:broadcast-except', (_peerId, data) => {
      relayed.push(data as Record<string, unknown>);
    });

    void handleData(
      {
        type: MSG.CHAT,
        text: 'bounded',
        ts: ++_ts,
        senderId: guestConn.peer,
        senderLabel: 'SPOOFED',
        junk: 'x'.repeat(100_000),
        nested: { junk: 'y'.repeat(100_000) },
      },
      guestConn,
    );

    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toEqual({
      type: MSG.CHAT,
      senderId: guestConn.peer,
      sender: PEER_NAME_PREFIX,
      senderLabel: PEER_NAME_PREFIX,
      isHost: false,
      isOp: false,
      text: 'bounded',
      ts: _ts,
    });
  });

  it('rewrites a claimed member identity from the host directory and groups another own device', async () => {
    const memberId = 'member_abcdefghijklmnopqrstuv';
    setState('network.myMemberId', memberId);
    setState('network.connectedPeers', [
      connectedPeer({
        id: guestConn.peer,
        label: 'Minsu',
        joinOrder: 3,
        memberId,
        memberDisplayNumber: 1,
        isAuthenticated: true,
        status: 'connected',
        conn: guestConn,
      }),
    ]);
    const relayed: Array<Record<string, unknown>> = [];
    bus.on('network:broadcast-except', (_peerId, data) => {
      relayed.push(data as Record<string, unknown>);
    });

    await handleData(
      {
        type: MSG.CHAT,
        text: 'from my other device',
        ts: ++_ts,
        senderId: 'spoofed',
        senderMemberId: 'member_zyxwvutsrqponmlkjihgfe',
        senderLabel: 'SPOOFED',
      },
      guestConn,
    );

    expect(addChatMessage).toHaveBeenCalledWith(
      'Minsu',
      'from my other device',
      true,
      undefined,
      1,
      memberId,
    );
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({
      senderId: guestConn.peer,
      senderMemberId: memberId,
      senderLabel: 'Minsu',
      joinOrder: 1,
    });
  });

  it('renders a verified owner sibling with the owner crown from host-projected capability', async () => {
    const memberId = 'member_abcdefghijklmnopqrstuv';
    setState('network.myMemberId', memberId);
    setState('network.connectedPeers', [
      connectedPeer({
        id: guestConn.peer,
        label: 'Minsu',
        joinOrder: 3,
        memberId,
        memberDisplayNumber: 1,
        isAuthenticated: true,
        isOp: true,
        roomCapabilities: ['room.configure'],
        status: 'connected',
        conn: guestConn,
      }),
    ]);
    const relayed: Array<Record<string, unknown>> = [];
    bus.on('network:broadcast-except', (_peerId, data) => {
      relayed.push(data as Record<string, unknown>);
    });

    await handleData(
      {
        type: MSG.CHAT,
        text: 'owner sibling',
        ts: ++_ts,
        isHost: false,
        isOp: false,
      },
      guestConn,
    );

    expect(addChatMessage).toHaveBeenCalledWith(
      'Minsu',
      'owner sibling',
      true,
      'host',
      1,
      memberId,
    );
    expect(relayed[0]).toMatchObject({
      senderId: guestConn.peer,
      senderMemberId: memberId,
      senderLabel: 'Minsu',
      isHost: true,
      isOp: false,
    });
  });

  it('never derives an owner crown from nickname or sender claims', async () => {
    const ownerMemberId = 'member_abcdefghijklmnopqrstuv';
    const otherMemberId = 'member_vutsrqponmlkjihgfedcba';
    setState('network.myMemberId', ownerMemberId);
    setState('network.connectedPeers', [
      connectedPeer({
        id: guestConn.peer,
        label: 'Minsu',
        joinOrder: 4,
        memberId: otherMemberId,
        memberDisplayNumber: 2,
        isAuthenticated: true,
        isOp: false,
        roomCapabilities: [],
        status: 'connected',
        conn: guestConn,
      }),
    ]);
    const relayed: Array<Record<string, unknown>> = [];
    bus.on('network:broadcast-except', (_peerId, data) => {
      relayed.push(data as Record<string, unknown>);
    });

    await handleData(
      {
        type: MSG.CHAT,
        text: 'spoof attempt',
        ts: ++_ts,
        senderMemberId: ownerMemberId,
        senderLabel: 'Minsu',
        isHost: true,
        isOp: true,
      },
      guestConn,
    );

    expect(addChatMessage).toHaveBeenCalledWith(
      'Minsu',
      'spoof attempt',
      false,
      undefined,
      2,
      otherMemberId,
    );
    expect(relayed[0]).toMatchObject({
      senderId: guestConn.peer,
      senderMemberId: otherMemberId,
      isHost: false,
      isOp: false,
    });
  });
});

describe('automatic system-message channel', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
  });

  it('does not replace the latest human-authored pinned notice', () => {
    const roomSend = vi.fn();
    const lateJoinSend = vi.fn();
    setState('network.connectedPeers', [
      connectedPeer({
        id: 'guest-room',
        label: 'GUEST 1',
        status: 'connected',
        conn: { peer: 'guest-room', open: true, send: roomSend } as unknown as DataConnection,
      }),
    ]);
    rememberPinnedNotice({
      type: MSG.CHAT_NOTICE,
      senderLabel: 'HOST',
      text: 'Important room notice',
      ts: 123,
      attention: true,
    });

    const localMessages: string[] = [];
    bus.on('chat:system-message', (text) => localMessages.push(text));
    broadcastSystemMessage('chat.decode_skip_system_message');

    expect(roomSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.CHAT_SYSTEM,
        i18nKey: 'chat.decode_skip_system_message',
      }),
    );
    expect(localMessages).toHaveLength(1);

    const delivered = sendLatestPinnedNotice({
      peer: 'guest-late',
      open: true,
      send: lateJoinSend,
    } as unknown as DataConnection);
    expect(delivered).toBe(true);
    expect(lateJoinSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.CHAT_NOTICE,
        senderLabel: 'HOST',
        text: 'Important room notice',
        attention: false,
      }),
    );
  });

  it('sends targeted automatic events as CHAT_SYSTEM rather than CHAT_NOTICE', () => {
    const send = vi.fn();
    sendSystemMessage(
      { peer: 'guest-remote', open: true, send } as unknown as DataConnection,
      'chat.remote_upload_failed_system_message',
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.CHAT_SYSTEM,
        i18nKey: 'chat.remote_upload_failed_system_message',
      }),
    );
  });
});

describe('host whisper relay canonicalization', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    registerChatProtocolHandlers();
    setState('network.appRole', 'host');
    setState('network.myId', 'host-id');
  });

  it('does not forward spoofed identity or unknown nested fields to the target', async () => {
    const senderConn = { peer: 'guest-sender', open: true } as DataConnection;
    const targetSend = vi.fn();
    const targetConn = {
      peer: 'guest-target',
      open: true,
      send: targetSend,
    } as unknown as DataConnection;
    setState('network.connectedPeers', [
      connectedPeer({
        id: 'guest-sender',
        label: 'GUEST 1',
        joinOrder: 1,
        status: 'connected',
        conn: senderConn,
      }),
      connectedPeer({
        id: 'guest-target',
        label: 'GUEST 2',
        joinOrder: 2,
        status: 'connected',
        conn: targetConn,
      }),
    ]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        ['guest-sender', senderConn],
        ['guest-target', targetConn],
      ]),
    );

    await handleData(
      {
        type: MSG.CHAT_WHISPER,
        senderId: 'host-id',
        senderLabel: 'HOST',
        targetId: 'guest-target',
        text: 'bounded whisper',
        ts: 1234,
        joinOrder: 999,
        junk: 'x'.repeat(100_000),
        nested: { junk: 'y'.repeat(100_000) },
      },
      senderConn,
    );

    expect(targetSend).toHaveBeenCalledTimes(1);
    expect(targetSend).toHaveBeenCalledWith({
      type: MSG.CHAT_WHISPER,
      senderId: 'guest-sender',
      senderLabel: 'GUEST 1',
      targetId: 'guest-target',
      text: 'bounded whisper',
      ts: 1234,
      joinOrder: 1,
    });
  });
});

describe('PRO BOT chat correlation', () => {
  const requestId = (suffix: string): string => `mxqr-pro-${suffix.repeat(48).slice(0, 48)}`;

  function enterBotRoom(role: 'coordinator' | 'member', roomId = '000002'): void {
    setState('room.context', {
      kind: 'pro',
      roomId,
      role,
      coordinatorId: role === 'coordinator' ? 'host-bot' : 'remote-host',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
  }

  beforeEach(() => {
    resetState();
    bus.clear();
    vi.clearAllMocks();
    registerChatProtocolHandlers();
  });

  it('accepts the compact // request and relays its authoritative BOT correlation id', async () => {
    enterBotRoom('coordinator');
    setState('network.myId', 'host-bot');
    const conn = { peer: 'guest-bot-ordinary', open: true } as DataConnection;
    setState('network.connectedPeers', [
      {
        id: conn.peer,
        label: 'GUEST 1',
        conn,
        isOp: true,
        joinOrder: 1,
        status: 'connected',
        isDataTarget: true,
        slot: 1,
        connectionType: 'local',
        lastHeartbeat: 0,
        preloadedQueueItemIds: new Set(),
      },
    ]);
    const relayed: Array<Record<string, unknown>> = [];
    bus.on('network:broadcast-except', (_peerId, data) =>
      relayed.push(data as Record<string, unknown>),
    );
    const id = requestId('a');

    await handleData(
      {
        type: MSG.CHAT,
        senderId: 'spoofed-owner',
        senderLabel: 'SPOOFED',
        text: '//셔플재생 켜줘',
        ts: 20_001,
        botRequestId: id,
      },
      conn,
    );

    expect(upsertBotChatMessage).toHaveBeenCalledWith(id, 'typing');
    expect(addChatMessage).toHaveBeenCalledWith(
      'GUEST 1',
      expect.any(String),
      false,
      'op',
      1,
      conn.peer,
    );
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({
      type: MSG.CHAT,
      senderId: conn.peer,
      senderLabel: 'GUEST 1',
      botRequestId: id,
    });
  });

  it('accepts one terminal result only from the participant that created the request', async () => {
    enterBotRoom('coordinator');
    setState('network.myId', 'host-bot');
    const owner = { peer: 'guest-bot-owner', open: true } as DataConnection;
    const attacker = { peer: 'guest-bot-attacker', open: true } as DataConnection;
    const id = requestId('b');
    const relayed: Array<Record<string, unknown>> = [];
    bus.on('network:broadcast-except', (_peerId, data) =>
      relayed.push(data as Record<string, unknown>),
    );

    await handleData(
      {
        type: MSG.CHAT,
        senderId: owner.peer,
        senderLabel: 'OWNER',
        text: '/bot jazz 재생',
        ts: 20_002,
        botRequestId: id,
      },
      owner,
    );
    relayed.length = 0;

    const terminal = {
      type: MSG.CHAT_BOT_RESULT,
      requestId: id,
      senderId: owner.peer,
      result: { kind: 'answer', text: '재생을 시작했어요' },
    } as const;
    await handleData(terminal, attacker);
    expect(upsertBotChatMessage).toHaveBeenCalledTimes(1);
    expect(relayed).toHaveLength(0);

    await handleData(terminal, owner);
    await handleData(terminal, owner);
    expect(upsertBotChatMessage).toHaveBeenCalledTimes(2);
    expect(upsertBotChatMessage).toHaveBeenLastCalledWith(id, 'complete', '재생을 시작했어요');
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject(terminal);
  });

  it('lets a member accept the terminal update only from its current host connection', async () => {
    enterBotRoom('member');
    setState('network.myId', 'member-bot');
    const host = { peer: 'remote-host', open: true } as DataConnection;
    const rogue = { peer: 'rogue-host', open: true } as DataConnection;
    setState('network.hostConn', host);
    const id = requestId('c');

    await handleData(
      {
        type: MSG.CHAT,
        senderId: 'request-owner',
        senderLabel: 'PEER 2',
        text: '/bot 다음 곡',
        ts: 20_003,
        botRequestId: id,
      },
      host,
    );
    const terminal = {
      type: MSG.CHAT_BOT_RESULT,
      requestId: id,
      senderId: 'request-owner',
      result: { kind: 'failed' },
    } as const;

    await handleData(terminal, rogue);
    expect(upsertBotChatMessage).toHaveBeenCalledTimes(1);
    await handleData(terminal, host);
    expect(upsertBotChatMessage).toHaveBeenCalledTimes(2);
    expect(upsertBotChatMessage).toHaveBeenLastCalledWith(id, 'complete', expect.any(String));
  });

  it('keeps request ownership when a member becomes coordinator mid-request', async () => {
    enterBotRoom('member');
    setState('network.myId', 'coordinator-successor');
    const oldHost = { peer: 'old-host', open: true } as DataConnection;
    setState('network.hostConn', oldHost);
    const id = requestId('i');

    await handleData(
      {
        type: MSG.CHAT,
        senderId: 'request-owner-handoff',
        senderLabel: 'PEER 3',
        text: '/bot 핸드오프 중 요청',
        ts: 20_007,
        botRequestId: id,
      },
      oldHost,
    );

    enterBotRoom('coordinator');
    setState('network.hostConn', null);
    await handleData(
      {
        type: MSG.CHAT_BOT_RESULT,
        requestId: id,
        senderId: 'request-owner-handoff',
        result: { kind: 'answer', text: '이어받았어요' },
      },
      { peer: 'request-owner-handoff', open: true } as DataConnection,
    );

    expect(upsertBotChatMessage).toHaveBeenCalledTimes(2);
    expect(upsertBotChatMessage).toHaveBeenLastCalledWith(id, 'complete', '이어받았어요');
  });

  it('completes and sends a requester-owned local result through the server exactly once', () => {
    enterBotRoom('member');
    setState('network.myId', 'member-local');
    const send = vi.fn();
    setState('network.hostConn', {
      peer: 'remote-host',
      open: true,
      send,
    } as unknown as DataConnection);
    const id = requestId('d');

    expect(beginLocalBotChatRequest(id)).toBe(true);
    expect(publishBotChatResult(id, { kind: 'added', count: 2, playbackChanged: true })).toBe(true);
    expect(publishBotChatResult(id, { kind: 'failed' })).toBe(false);

    expect(upsertBotChatMessage).toHaveBeenNthCalledWith(1, id, 'typing');
    expect(upsertBotChatMessage).toHaveBeenNthCalledWith(2, id, 'complete', expect.any(String));
    expect(send).not.toHaveBeenCalled();
    expect(realtimeMocks.send).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.send).toHaveBeenCalledWith('chat', {
      kind: 'bot-result',
      requestId: id,
      result: { kind: 'added', count: 2, playbackChanged: true },
    });
  });

  it('rejects an over-one-hour retry and completes for the exact maximum', () => {
    enterBotRoom('member');
    setState('network.myId', 'member-hourly-limit');
    const send = vi.fn();
    setState('network.hostConn', {
      peer: 'remote-host',
      open: true,
      send,
    } as unknown as DataConnection);
    const id = requestId('j');

    expect(beginLocalBotChatRequest(id)).toBe(true);
    expect(publishBotChatResult(id, { kind: 'rate_limited', retryAfterSeconds: 3_601 })).toBe(
      false,
    );
    expect(publishBotChatResult(id, { kind: 'rate_limited', retryAfterSeconds: 3_600 })).toBe(true);

    expect(upsertBotChatMessage).toHaveBeenNthCalledWith(1, id, 'typing');
    expect(upsertBotChatMessage).toHaveBeenNthCalledWith(2, id, 'complete', expect.any(String));
    expect(send).not.toHaveBeenCalled();
    expect(realtimeMocks.send).toHaveBeenCalledWith('chat', {
      kind: 'bot-result',
      requestId: id,
      result: { kind: 'rate_limited', retryAfterSeconds: 3_600 },
    });
  });

  it('relays one terminal result when an equal participant is the requester', () => {
    enterBotRoom('coordinator');
    setState('network.myId', 'host-bot-local');
    const send = vi.fn();
    setState('network.connectedPeers', [
      {
        id: 'guest-bot-observer',
        label: 'GUEST 1',
        conn: {
          peer: 'guest-bot-observer',
          open: true,
          send,
        } as unknown as DataConnection,
        isOp: false,
        joinOrder: 1,
        status: 'connected',
        isDataTarget: true,
        slot: 1,
        connectionType: 'local',
        lastHeartbeat: 0,
        preloadedQueueItemIds: new Set(),
      },
    ]);
    const id = requestId('f');

    expect(beginLocalBotChatRequest(id)).toBe(true);
    expect(publishBotChatResult(id, { kind: 'failed' })).toBe(true);
    expect(publishBotChatResult(id, { kind: 'failed' })).toBe(false);

    expect(send).not.toHaveBeenCalled();
    expect(realtimeMocks.send).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.send).toHaveBeenCalledWith('chat', {
      kind: 'bot-result',
      requestId: id,
      result: { kind: 'failed' },
    });
  });

  it('drops terminal results after the bounded pending window expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      enterBotRoom('coordinator');
      setState('network.myId', 'host-bot');
      const owner = { peer: 'guest-bot-stale', open: true } as DataConnection;
      const id = requestId('g');

      await handleData(
        {
          type: MSG.CHAT,
          senderId: owner.peer,
          senderLabel: 'OWNER',
          text: '/bot 오래된 요청',
          ts: 20_005,
          botRequestId: id,
        },
        owner,
      );
      now.mockReturnValue(1_060_001);
      await handleData(
        {
          type: MSG.CHAT_BOT_RESULT,
          requestId: id,
          senderId: owner.peer,
          result: { kind: 'answer', text: 'too late' },
        },
        owner,
      );

      expect(upsertBotChatMessage).toHaveBeenCalledTimes(1);
      expect(upsertBotChatMessage).toHaveBeenCalledWith(id, 'typing');
    } finally {
      now.mockRestore();
    }
  });

  it('strips a BOT request id from ordinary non-command text inside a PRO room', async () => {
    enterBotRoom('coordinator');
    setState('network.myId', 'host-bot');
    const conn = { peer: 'guest-bot-non-command', open: true } as DataConnection;
    const relayed: Array<Record<string, unknown>> = [];
    bus.on('network:broadcast-except', (_peerId, data) =>
      relayed.push(data as Record<string, unknown>),
    );

    await handleData(
      {
        type: MSG.CHAT,
        senderId: conn.peer,
        senderLabel: 'GUEST',
        text: '이건 일반 메시지예요',
        ts: 20_006,
        botRequestId: requestId('h'),
      },
      conn,
    );

    expect(relayed).toHaveLength(1);
    expect(relayed[0]).not.toHaveProperty('botRequestId');
    expect(upsertBotChatMessage).not.toHaveBeenCalled();
  });

  it('strips BOT metadata outside a PRO room before coordinator fan-out', async () => {
    setState('network.myId', 'host-standard');
    const conn = { peer: 'guest-standard', open: true } as DataConnection;
    const relayed: Array<Record<string, unknown>> = [];
    bus.on('network:broadcast-except', (_peerId, data) =>
      relayed.push(data as Record<string, unknown>),
    );

    await handleData(
      {
        type: MSG.CHAT,
        senderId: conn.peer,
        senderLabel: 'GUEST',
        text: '/bot should stay unavailable',
        ts: 20_004,
        botRequestId: requestId('e'),
      },
      conn,
    );

    expect(relayed).toHaveLength(1);
    expect(relayed[0]).not.toHaveProperty('botRequestId');
    expect(upsertBotChatMessage).not.toHaveBeenCalled();
  });

  it('binds a local BOT result to the PRO room where its placeholder began', () => {
    enterBotRoom('member', '000001');
    setState('network.myId', 'member-room-bound');
    const id = requestId('k');

    expect(beginLocalBotChatRequest(id)).toBe(true);
    enterBotRoom('member', '000002');
    expect(publishBotChatResult(id, { kind: 'answer', text: 'late result' })).toBe(false);

    expect(upsertBotChatMessage).toHaveBeenCalledTimes(1);
    expect(upsertBotChatMessage).toHaveBeenCalledWith(id, 'typing');
  });
});
