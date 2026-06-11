/**
 * @vitest-environment jsdom
 *
 * Host fan-out truncation pin (CHAT-1, 22차 domain audit): the host must
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
import { registerChatProtocolHandlers } from '../protocol.ts';
import type { DataConnection } from '../../types/index.ts';

// Render-fn mocks only. The wire caps (MAX_MSG_LENGTH/MAX_SENDER_LABEL_LENGTH)
// now come from core/constants.ts (real values, unmocked) — mocking them here
// previously drifted (phantom label cap 24 vs real 30).
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
