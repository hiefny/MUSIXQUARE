import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';

const mocks = vi.hoisted(() => ({
  addSystemChatMessage: vi.fn(),
  addWhisperMessage: vi.fn(),
  addNoticeChatMessage: vi.fn(),
  sendToHost: vi.fn(),
  cmdDebug: vi.fn(),
  rememberPinnedNotice: vi.fn(),
  showToast: vi.fn(),
  requestActiveProRoomBotCommand: vi.fn(),
  beginLocalBotChatRequest: vi.fn(() => true),
  publishBotChatResult: vi.fn(() => true),
}));

vi.mock('../../ui/chat-render.ts', () => ({
  addSystemChatMessage: mocks.addSystemChatMessage,
  addWhisperMessage: mocks.addWhisperMessage,
  addNoticeChatMessage: mocks.addNoticeChatMessage,
}));
vi.mock('../../network/peer.ts', () => ({ sendToHost: mocks.sendToHost }));
vi.mock('../debug-console.ts', () => ({ cmdDebug: mocks.cmdDebug }));
vi.mock('../protocol.ts', () => ({
  rememberPinnedNotice: mocks.rememberPinnedNotice,
  beginLocalBotChatRequest: mocks.beginLocalBotChatRequest,
  publishBotChatResult: mocks.publishBotChatResult,
}));
vi.mock('../../ui/toast.ts', () => ({ showToast: mocks.showToast }));
vi.mock('../../pro-room/runtime.ts', () => ({
  requestActiveProRoomBotCommand: mocks.requestActiveProRoomBotCommand,
}));

import {
  parseCommand,
  executeCommand,
  getAvailableCommands,
  shouldBroadcastCommand,
} from '../commands.ts';

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
});

describe('parseCommand', () => {
  it('parses name (lowercased), args, and rawArgs', () => {
    expect(parseCommand('/kick Foo bar')).toEqual({
      name: 'kick',
      args: ['Foo', 'bar'],
      rawArgs: 'Foo bar',
    });
  });

  it('handles a no-arg command', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', args: [], rawArgs: '' });
  });

  it('lowercases the command name but preserves argument case', () => {
    const parsed = parseCommand('/DEBUG Screen');
    expect(parsed?.name).toBe('debug');
    expect(parsed?.args).toEqual(['Screen']);
  });

  it('returns null for non-commands', () => {
    expect(parseCommand('hello world')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

describe('executeCommand permission gating', () => {
  it('rejects a host-only command from a guest without running its effect', () => {
    setState('network.hostConn', { peer: 'host', open: true });
    executeCommand({ name: 'kick', args: ['someone'], rawArgs: 'someone' });
    expect(mocks.sendToHost).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledTimes(1);
  });

  it('routes /debug (permission "all") to the extracted debug-console entry point', () => {
    setState('network.hostConn', { peer: 'host', open: true });
    executeCommand({ name: 'debug', args: ['screen'], rawArgs: 'screen' });
    expect(mocks.cmdDebug).toHaveBeenCalledWith(['screen'], 'screen');
  });

  it('reports an unknown command', () => {
    executeCommand({ name: 'nonsense', args: [], rawArgs: '' });
    expect(mocks.addSystemChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.cmdDebug).not.toHaveBeenCalled();
  });
});

describe('getAvailableCommands permission filtering', () => {
  it('hides host-only commands from a guest but lists them for the host', () => {
    setState('network.hostConn', { peer: 'host', open: true });
    const guestCmds = getAvailableCommands().map((c) => c.name);
    expect(guestCmds).not.toContain('kick');
    expect(guestCmds).toContain('users');

    setState('network.hostConn', null);
    const hostCmds = getAvailableCommands().map((c) => c.name);
    expect(hostCmds).toContain('kick');
  });
});

describe('/bot beta command', () => {
  const requestId = `mxqr-pro-${'a'.repeat(48)}`;

  function enterBotRoom(): void {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'participant_00001',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['queue.mutate', 'playback.control'],
    });
  }

  it('is suggested only in PRO room 000001 and fails locally elsewhere', () => {
    expect(getAvailableCommands().map((command) => command.name)).not.toContain('bot');

    executeCommand({ name: 'bot', args: ['next'], rawArgs: 'next' });

    expect(mocks.requestActiveProRoomBotCommand).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledOnce();

    enterBotRoom();
    expect(getAvailableCommands().map((command) => command.name)).toContain('bot');
    expect(shouldBroadcastCommand(parseCommand('/bot next')!)).toBe(true);
    expect(shouldBroadcastCommand(parseCommand('/bot')!)).toBe(false);
  });

  it('uses the authoritative added count instead of the model summary', async () => {
    enterBotRoom();
    mocks.requestActiveProRoomBotCommand.mockResolvedValueOnce({
      ok: true,
      summary: 'untrusted model summary',
      addedCount: 3,
      playbackChanged: false,
    });

    executeCommand(
      {
        name: 'bot',
        args: ['인기곡', '3개'],
        rawArgs: '  인기곡 3개 추가해줘  ',
      },
      { botRequestId: requestId },
    );

    expect(mocks.addSystemChatMessage).not.toHaveBeenCalled();
    expect(mocks.beginLocalBotChatRequest).toHaveBeenCalledWith(requestId);
    await vi.waitFor(() => {
      expect(mocks.requestActiveProRoomBotCommand).toHaveBeenCalledWith(
        '인기곡 3개 추가해줘',
        requestId,
      );
      expect(mocks.publishBotChatResult).toHaveBeenCalledWith(requestId, {
        kind: 'added',
        count: 3,
        playbackChanged: false,
      });
    });
  });

  it('reports when added tracks also started playing', async () => {
    enterBotRoom();
    mocks.requestActiveProRoomBotCommand.mockResolvedValueOnce({
      ok: true,
      summary: 'untrusted model summary',
      addedCount: 1,
      playbackChanged: true,
    });

    executeCommand(
      { name: 'bot', args: ['play'], rawArgs: '한 곡 추가하고 재생해줘' },
      { botRequestId: requestId },
    );

    await vi.waitFor(() => {
      expect(mocks.publishBotChatResult).toHaveBeenCalledWith(requestId, {
        kind: 'added',
        count: 1,
        playbackChanged: true,
      });
    });
  });

  it('keeps the model summary for requests that add no tracks', async () => {
    enterBotRoom();
    mocks.requestActiveProRoomBotCommand.mockResolvedValueOnce({
      ok: true,
      summary: '셔플을 켰어요.',
      addedCount: 0,
      playbackChanged: true,
    });

    executeCommand(
      { name: 'bot', args: ['shuffle'], rawArgs: '셔플 켜줘' },
      { botRequestId: requestId },
    );

    await vi.waitFor(() => {
      expect(mocks.publishBotChatResult).toHaveBeenCalledWith(requestId, {
        kind: 'answer',
        text: '셔플을 켰어요.',
      });
    });
  });

  it('shows a localized retry delay for rate-limited API errors', async () => {
    enterBotRoom();
    mocks.requestActiveProRoomBotCommand.mockRejectedValueOnce({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 12.2,
    });

    executeCommand({ name: 'bot', args: ['next'], rawArgs: 'next' }, { botRequestId: requestId });

    await vi.waitFor(() => {
      expect(mocks.publishBotChatResult).toHaveBeenCalledWith(requestId, {
        kind: 'rate_limited',
        retryAfterSeconds: 13,
      });
    });
  });

  it('settles the BOT bubble for the remainder of a room-wide 24-hour limit', async () => {
    enterBotRoom();
    mocks.requestActiveProRoomBotCommand.mockRejectedValueOnce({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 70_000.2,
    });

    executeCommand(
      { name: 'bot', args: ['next'], rawArgs: 'next' },
      { botRequestId: requestId },
    );

    await vi.waitFor(() => {
      expect(mocks.publishBotChatResult).toHaveBeenCalledWith(requestId, {
        kind: 'rate_limited',
        retryAfterSeconds: 70_001,
      });
    });
  });

  it('degrades an out-of-contract rate-limit delay to a generic failure', async () => {
    enterBotRoom();
    mocks.requestActiveProRoomBotCommand.mockRejectedValueOnce({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 86_401,
    });

    executeCommand(
      { name: 'bot', args: ['next'], rawArgs: 'next' },
      { botRequestId: requestId },
    );

    await vi.waitFor(() => {
      expect(mocks.publishBotChatResult).toHaveBeenCalledWith(requestId, { kind: 'failed' });
    });
  });

  it('shows failure feedback without leaking the server error', async () => {
    enterBotRoom();
    mocks.requestActiveProRoomBotCommand.mockRejectedValueOnce(new Error('secret upstream detail'));

    executeCommand({ name: 'bot', args: ['next'], rawArgs: 'next' }, { botRequestId: requestId });

    await vi.waitFor(() => {
      expect(mocks.publishBotChatResult).toHaveBeenCalledWith(requestId, { kind: 'failed' });
    });
    expect(mocks.publishBotChatResult.mock.calls.flat().join(' ')).not.toContain(
      'secret upstream detail',
    );
  });

  it('shows usage without contacting the server for an empty request', () => {
    enterBotRoom();

    executeCommand({ name: 'bot', args: [], rawArgs: '   ' });

    expect(mocks.requestActiveProRoomBotCommand).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledOnce();
  });
});
