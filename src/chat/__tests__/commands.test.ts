import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { t } from '../../i18n/index.ts';
import type { TransportDataConnection } from '../../network/transport/types.ts';

function hostConnection(peer = 'host'): TransportDataConnection {
  return {
    peer,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  };
}

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

  it('parses the compact // BOT alias without exposing its slashes to the prompt', () => {
    expect(parseCommand('//강남스타일 틀어줘')).toEqual({
      name: 'bot',
      args: ['강남스타일', '틀어줘'],
      rawArgs: '강남스타일 틀어줘',
    });
    expect(parseCommand('// 셔플 켜줘')).toEqual({
      name: 'bot',
      args: ['셔플', '켜줘'],
      rawArgs: ' 셔플 켜줘',
    });
    expect(shouldBroadcastCommand(parseCommand('//')!)).toBe(false);
    expect(parseCommand('///not-a-bot')?.name).toBe('//not-a-bot');
  });
});

describe('executeCommand permission gating', () => {
  it('names the exact member-management permission required by /kick', () => {
    setState('network.hostConn', hostConnection());
    executeCommand({ name: 'kick', args: ['someone'], rawArgs: 'someone' });
    expect(mocks.sendToHost).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledWith(t('toast.member_management_required'));
  });

  it('names chat-notice and room-owner requirements for manual hidden commands', () => {
    setState('network.hostConn', hostConnection());

    executeCommand({ name: 'notice', args: ['hello'], rawArgs: 'hello' });
    expect(mocks.addSystemChatMessage).toHaveBeenLastCalledWith(t('toast.chat_notice_required'));

    executeCommand({ name: 'clear', args: [], rawArgs: '' });
    expect(mocks.addSystemChatMessage).toHaveBeenLastCalledWith(t('toast.room_owner_required'));

    executeCommand({ name: 'op', args: ['#1'], rawArgs: '#1' });
    expect(mocks.addSystemChatMessage).toHaveBeenLastCalledWith(t('toast.host_setting_required'));
  });

  it('routes /debug (permission "all") to the extracted debug-console entry point', () => {
    setState('network.hostConn', hostConnection());
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
    setState('network.hostConn', hostConnection());
    const guestCmds = getAvailableCommands().map((c) => c.name);
    expect(guestCmds).not.toContain('kick');
    expect(guestCmds).toContain('users');

    setState('network.hostConn', null);
    setState('network.appRole', 'host');
    const hostCmds = getAvailableCommands().map((c) => c.name);
    expect(hostCmds).toContain('kick');
    expect(hostCmds).toContain('notice');
    expect(hostCmds).toContain('op');
    expect(hostCmds).toContain('deop');
  });

  it('hides and disables the legacy operator hierarchy in a PRO room', () => {
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    });
    const toggleOperator = vi.fn();
    bus.on('network:toggle-operator', toggleOperator);

    const commands = getAvailableCommands().map((command) => command.name);
    expect(commands).not.toContain('op');
    expect(commands).not.toContain('deop');

    executeCommand({ name: 'op', args: ['#1'], rawArgs: '#1' });
    executeCommand({ name: 'deop', args: ['#1'], rawArgs: '#1' });

    expect(toggleOperator).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledTimes(2);
  });

  it('exposes only the explicitly granted standard-room administrator commands', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConnection());
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['members.manage', 'chat.notice']);

    const commands = getAvailableCommands().map((command) => command.name);
    expect(commands).toContain('kick');
    expect(commands).toContain('notice');
    expect(commands).not.toContain('clear');
    expect(commands).not.toContain('mute');
    expect(commands).not.toContain('op');
  });

  it('routes owner-sibling room controls through the physical host and hides admin-directory commands', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConnection('physical-host'));
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', [
      'media.add',
      'queue.mutate',
      'playback.control',
      'effects.control',
      'asset.upload',
      'members.manage',
      'chat.notice',
      'room.configure',
    ]);
    const broadcast = vi.fn();
    bus.on('network:broadcast', broadcast);

    const commands = getAvailableCommands().map((command) => command.name);
    expect(commands).toEqual(
      expect.arrayContaining(['clear', 'filter', 'freeze', 'slowmode', 'mute', 'notice']),
    );
    expect(commands).not.toContain('op');
    expect(commands).not.toContain('deop');

    executeCommand({ name: 'freeze', args: ['on'], rawArgs: 'on' });
    expect(mocks.sendToHost).toHaveBeenCalledWith({
      type: MSG.REQUEST_CHAT_COMMAND,
      command: 'freeze',
      args: ['on'],
    });
    expect(getState('network.chatFrozen')).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();

    executeCommand({ name: 'op', args: ['#2'], rawArgs: '#2' });
    expect(mocks.addSystemChatMessage).toHaveBeenCalled();
  });

  it('routes an account target kick through the account-wide standard member event', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConnection());
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['members.manage']);
    setState('network.lastKnownDeviceList', [
      {
        id: 'minsu-phone',
        label: 'Minsu',
        isOp: false,
        isHost: false,
        status: 'connected',
        joinOrder: 1,
        memberId: 'member_abcdefghijklmnopqrstuv',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
    ]);
    const requested = vi.fn();
    bus.on('network:request-kick-standard-room-member', requested);

    executeCommand({ name: 'kick', args: ['Minsu'], rawArgs: 'Minsu' });

    expect(requested).toHaveBeenCalledWith({
      memberId: 'member_abcdefghijklmnopqrstuv',
    });
  });

  it("resolves the grouped member number after that account's first physical device leaves", () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConnection());
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['members.manage']);
    setState('network.lastKnownDeviceList', [
      {
        id: 'minsu-laptop',
        label: 'Minsu',
        isOp: false,
        isHost: false,
        status: 'connected',
        joinOrder: 2,
        memberId: 'member_abcdefghijklmnopqrstuv',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
    ]);
    const requested = vi.fn();
    bus.on('network:request-kick-standard-room-member', requested);

    executeCommand({ name: 'kick', args: ['#1'], rawArgs: '#1' });

    expect(requested).toHaveBeenCalledWith({
      memberId: 'member_abcdefghijklmnopqrstuv',
    });

    requested.mockClear();
    executeCommand({ name: 'kick', args: ['#2'], rawArgs: '#2' });
    expect(requested).not.toHaveBeenCalled();
  });

  it('keeps physical joinOrder targeting for a legacy anonymous device projection', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConnection());
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['members.manage']);
    setState('network.lastKnownDeviceList', [
      {
        id: 'legacy-peer-7',
        label: 'Peer 7',
        isOp: false,
        isHost: false,
        status: 'connected',
        joinOrder: 7,
      },
    ]);
    const requested = vi.fn();
    bus.on('network:request-kick-standard-room-member', requested);

    executeCommand({ name: 'kick', args: ['#7'], rawArgs: '#7' });

    expect(requested).toHaveBeenCalledWith({ memberId: 'peer:legacy-peer-7' });
  });

  it('passes a grouped PRO target as its member identity for account-wide removal', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    });
    setState('network.lastKnownDeviceList', [
      {
        id: 'jisu-tablet',
        label: 'Jisu',
        isOp: false,
        isHost: false,
        status: 'connected',
        joinOrder: 5,
        memberId: 'member_zyxwvutsrqponmlkjihgfe',
        memberDisplayNumber: 4,
        isAuthenticated: true,
      },
    ]);
    const requested = vi.fn();
    bus.on('pro-room:kick-member', requested);

    executeCommand({ name: 'kick', args: ['#4'], rawArgs: '#4' });

    expect(requested).toHaveBeenCalledWith('member_zyxwvutsrqponmlkjihgfe');
  });
});

describe('/users PRO hierarchy', () => {
  it('shows equal members without HOST or ADMIN labels', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 3,
      snapshotRevision: 7,
      capabilities: ['members.manage'],
    });
    setState('network.myId', 'participant-me');
    setState('network.myDeviceLabel', 'Studio');
    setState('network.myJoinOrder', 0);
    setState('network.lastKnownDeviceList', [
      {
        id: 'participant-me',
        label: 'Studio',
        isHost: false,
        isOp: true,
        status: 'connected',
        joinOrder: 0,
        connectionType: 'remote',
      },
      {
        id: 'participant-friend',
        label: 'Friend',
        isHost: false,
        isOp: true,
        status: 'connected',
        joinOrder: 1,
        connectionType: 'remote',
      },
    ]);

    executeCommand({ name: 'users', args: [], rawArgs: '' });

    const rendered = String(mocks.addSystemChatMessage.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('Studio');
    expect(rendered).toContain('Friend');
    expect(rendered).not.toContain('HOST');
    expect(rendered).not.toContain('ADMIN');
  });
});

describe('/users member grouping', () => {
  it('lists one visible member number and a device count for one account on several devices', () => {
    setState('network.myId', 'minsu-laptop');
    setState('network.myJoinOrder', 2);
    setState('network.myMemberDisplayNumber', 1);
    setState('network.lastKnownDeviceList', [
      {
        id: 'minsu-phone',
        label: 'Minsu',
        isHost: false,
        isOp: false,
        status: 'connected',
        joinOrder: 1,
        memberId: 'member_abcdefghijklmnopqrstuv',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
      {
        id: 'minsu-laptop',
        label: 'Minsu',
        isHost: false,
        isOp: false,
        status: 'connected',
        joinOrder: 2,
        memberId: 'member_abcdefghijklmnopqrstuv',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
      {
        id: 'peer-3',
        label: 'Peer 3',
        isHost: false,
        isOp: false,
        status: 'connected',
        joinOrder: 3,
      },
    ]);

    executeCommand({ name: 'users', args: [], rawArgs: '' });

    const rendered = String(mocks.addSystemChatMessage.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('#1. Minsu (2)');
    expect(rendered).toMatch(/#1\. Minsu \(2\) \[[^\]]+\]/);
    expect(rendered).toContain('#3. Peer 3');
    expect(rendered).not.toContain('#2. Minsu');
  });
});

describe('/bot PRO-room command', () => {
  const requestId = `mxqr-pro-${'a'.repeat(48)}`;

  function enterBotRoom(
    roomId = '000002',
    role: 'owner' | 'controller' | 'member' = 'controller',
  ): void {
    setState('network.myId', 'participant-bot-viewer');
    setState('network.lastKnownDeviceList', [
      {
        id: 'participant-bot-viewer',
        label: 'BOT viewer',
        isOp: role !== 'member',
        isHost: role === 'owner',
        status: 'connected',
        role,
      },
    ]);
    setState('room.context', {
      kind: 'pro',
      roomId,
      role: 'member',
      coordinatorId: 'participant_00001',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['queue.mutate', 'playback.control'],
    });
  }

  it('is suggested in every PRO room and fails locally elsewhere', () => {
    expect(getAvailableCommands().map((command) => command.name)).not.toContain('bot');

    executeCommand({ name: 'bot', args: ['next'], rawArgs: 'next' });

    expect(mocks.requestActiveProRoomBotCommand).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledOnce();

    enterBotRoom('000000');
    expect(getAvailableCommands().map((command) => command.name)).toContain('bot');

    enterBotRoom('000002');
    expect(getAvailableCommands().map((command) => command.name)).toContain('bot');
    expect(shouldBroadcastCommand(parseCommand('/bot next')!)).toBe(true);
    expect(shouldBroadcastCommand(parseCommand('/bot')!)).toBe(false);
  });

  it('does not expose or broadcast BOT requests from an ordinary PRO member', () => {
    enterBotRoom('000002', 'member');

    expect(getAvailableCommands().map((command) => command.name)).not.toContain('bot');
    expect(shouldBroadcastCommand(parseCommand('/bot next')!)).toBe(false);

    executeCommand({ name: 'bot', args: ['next'], rawArgs: 'next' });

    expect(mocks.beginLocalBotChatRequest).not.toHaveBeenCalled();
    expect(mocks.requestActiveProRoomBotCommand).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledOnce();
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
    expect(mocks.beginLocalBotChatRequest).toHaveBeenCalledWith(requestId, '000002');
    await vi.waitFor(() => {
      expect(mocks.requestActiveProRoomBotCommand).toHaveBeenCalledWith(
        '000002',
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

  it('accepts the exact one-hour rate-limit delay', async () => {
    enterBotRoom();
    mocks.requestActiveProRoomBotCommand.mockRejectedValueOnce({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 3_600,
    });

    executeCommand({ name: 'bot', args: ['next'], rawArgs: 'next' }, { botRequestId: requestId });

    await vi.waitFor(() => {
      expect(mocks.publishBotChatResult).toHaveBeenCalledWith(requestId, {
        kind: 'rate_limited',
        retryAfterSeconds: 3_600,
      });
    });
  });

  it('degrades an out-of-contract rate-limit delay to a generic failure', async () => {
    enterBotRoom();
    mocks.requestActiveProRoomBotCommand.mockRejectedValueOnce({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 3_601,
    });

    executeCommand({ name: 'bot', args: ['next'], rawArgs: 'next' }, { botRequestId: requestId });

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

  it('does not publish a late result after moving to another PRO room', async () => {
    let resolveResult!: (value: {
      ok: true;
      summary: string;
      addedCount: number;
      playbackChanged: boolean;
    }) => void;
    mocks.requestActiveProRoomBotCommand.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResult = resolve;
      }),
    );
    enterBotRoom('000001');

    executeCommand({ name: 'bot', args: ['next'], rawArgs: 'next' }, { botRequestId: requestId });
    await vi.waitFor(() => expect(mocks.requestActiveProRoomBotCommand).toHaveBeenCalledOnce());

    enterBotRoom('000002');
    expect(shouldBroadcastCommand(parseCommand('/bot next')!)).toBe(true);
    enterBotRoom('000001');
    expect(shouldBroadcastCommand(parseCommand('/bot next')!)).toBe(false);
    enterBotRoom('000002');
    resolveResult({
      ok: true,
      summary: 'done',
      addedCount: 0,
      playbackChanged: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.publishBotChatResult).not.toHaveBeenCalled();
    expect(shouldBroadcastCommand(parseCommand('/bot next')!)).toBe(true);
  });

  it('shows usage without contacting the server for an empty request', () => {
    enterBotRoom();

    executeCommand({ name: 'bot', args: [], rawArgs: '   ' });

    expect(mocks.requestActiveProRoomBotCommand).not.toHaveBeenCalled();
    expect(mocks.addSystemChatMessage).toHaveBeenCalledOnce();
  });
});
