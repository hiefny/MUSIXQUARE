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
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { handleData } from '../../network/protocol.ts';
import {
  beginLocalBotChatRequest,
  broadcastSystemMessage,
  publishBotChatResult,
  registerChatProtocolHandlers,
  rememberPinnedNotice,
  sendLatestPinnedNotice,
  sendSystemMessage,
} from '../protocol.ts';
import { upsertBotChatMessage } from '../../ui/chat-render.ts';
import type { DataConnection } from '../../types/index.ts';

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
      { type: MSG.CHAT, text, ts: ++_ts, senderId: guestConn.peer, senderLabel: 'GUEST 1' },
      guestConn,
    );
    return relayed;
  }

  it('relays the TRUNCATED text with the profanity filter off (the default)', () => {
    const relayed = sendChat('x'.repeat(3000)); // passes the 4000 validator cap

    expect(relayed).toHaveLength(1);
    expect((relayed[0].text as string).length).toBe(500);
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
      {
        id: 'guest-room',
        label: 'GUEST 1',
        status: 'connected',
        conn: { peer: 'guest-room', open: true, send: roomSend } as unknown as DataConnection,
      },
    ]);
    rememberPinnedNotice({
      type: MSG.CHAT_NOTICE,
      senderLabel: 'HOST',
      text: 'Important room notice',
      ts: 123,
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

describe('PRO BOT chat correlation', () => {
  const requestId = (suffix: string): string => `mxqr-pro-${suffix.repeat(48).slice(0, 48)}`;

  function enterBotRoom(role: 'coordinator' | 'member'): void {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
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

  it('renders an ordinary request then relays its authoritative BOT correlation id', async () => {
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
        text: '/bot 셔플재생 켜줘',
        ts: 20_001,
        botRequestId: id,
      },
      conn,
    );

    expect(upsertBotChatMessage).toHaveBeenCalledWith(id, 'typing');
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

  it('completes and sends a requester-owned local result through the host exactly once', () => {
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
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: MSG.CHAT_BOT_RESULT,
      requestId: id,
      senderId: 'member-local',
      result: { kind: 'added', count: 2, playbackChanged: true },
    });
  });

  it('broadcasts one terminal result when the coordinator itself is the requester', () => {
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

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: MSG.CHAT_BOT_RESULT,
      requestId: id,
      senderId: 'host-bot-local',
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

  it('strips a BOT request id from ordinary non-command text inside the beta room', async () => {
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

  it('strips BOT metadata outside the beta room before coordinator fan-out', async () => {
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
});
