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
}));

vi.mock('../../ui/chat-render.ts', () => ({
  addSystemChatMessage: mocks.addSystemChatMessage,
  addWhisperMessage: mocks.addWhisperMessage,
  addNoticeChatMessage: mocks.addNoticeChatMessage,
}));
vi.mock('../../network/peer.ts', () => ({ sendToHost: mocks.sendToHost }));
vi.mock('../debug-console.ts', () => ({ cmdDebug: mocks.cmdDebug }));
vi.mock('../protocol.ts', () => ({ rememberPinnedNotice: mocks.rememberPinnedNotice }));

import { parseCommand, executeCommand, getAvailableCommands } from '../commands.ts';

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
