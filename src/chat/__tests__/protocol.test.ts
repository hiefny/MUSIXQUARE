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
  broadcastSystemMessage,
  registerChatProtocolHandlers,
  rememberPinnedNotice,
  sendLatestPinnedNotice,
  sendSystemMessage,
} from '../protocol.ts';
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
