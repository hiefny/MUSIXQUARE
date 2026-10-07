/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { MSG } from '../../core/constants.ts';
import { handleData } from '../../network/protocol.ts';
import { sendToHost } from '../../network/peer.ts';
import { receiveProRoomRealtimeChat } from '../../chat/protocol.ts';
import type { ProRealtimeRelayEnvelope } from '../../pro-room/network-bridge.ts';
import type { DataConnection } from '../../types/index.ts';
import { t } from '../../i18n/index.ts';
import { showToast } from '../toast.ts';

const pro = vi.hoisted(() => ({ send: vi.fn(() => true), bot: vi.fn() }));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn(), sendToHost: vi.fn() }));
vi.mock('../../pro-room/runtime.ts', () => ({ requestActiveProRoomBotCommand: pro.bot }));
vi.mock('../../pro-room/network-bridge.ts', () => ({ sendProRoomRealtime: pro.send }));
vi.mock('../toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../player-controls.ts', () => ({
  getRoleLabelByChannelMode: vi.fn(() => 'Left'),
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
}));
vi.mock('../../player/transport.ts', () => ({ seekTo: vi.fn() }));
vi.mock('../../youtube/oembed.ts', () => ({ fetchOEmbedTitle: vi.fn(async () => 'Mock Title') }));
vi.mock('../../i18n/locale-fonts.ts', () => ({
  default: { preloadLocaleFontGlyphs: vi.fn(async () => true) },
}));

type ModerationPath = 'standard' | 'pro-snapshot' | 'pro-event';
let host: DataConnection;
let input: HTMLDivElement;

function renderShell(): void {
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync('index.html', 'utf8'),
    'text/html',
  ).body.innerHTML;
  input = document.getElementById('chat-input') as HTMLDivElement;
}

function enterRoom(path: ModerationPath): void {
  setState('network.appRole', 'guest');
  setState('network.myId', 'muted-guest');
  setState('network.hostConn', path === 'standard' ? host : null);
  if (path === 'standard') return;
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: 'coordinator',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
}

async function receiveMute(
  path: ModerationPath,
  muted: boolean,
  targetId = 'muted-guest',
): Promise<void> {
  if (path === 'standard') {
    await handleData(
      { type: muted ? MSG.CHAT_MUTE : MSG.CHAT_UNMUTE, targetId, targetLabel: 'Guest' },
      host,
    );
    return;
  }
  const snapshot = path === 'pro-snapshot';
  const frame: ProRealtimeRelayEnvelope = {
    type: 'pro-realtime',
    version: 1,
    roomCode: '000001',
    coordinatorEpoch: 1,
    eventId: `mute-${path}-${muted}`,
    channel: snapshot ? 'chat-control-snapshot' : 'chat',
    payload: snapshot
      ? { revision: 1, frozen: false, filterEnabled: false, slowmodeSeconds: 0, muted }
      : { kind: 'mute', targetParticipantId: targetId, on: muted },
    sender: {
      participantId: snapshot ? 'server' : 'coordinator',
      presenceIncarnationId: snapshot ? 'server-chat-state' : 'coordinator-presence',
      displayName: 'Host',
    },
  };
  receiveProRoomRealtimeChat(frame);
}

function send(activation: 'pointer' | 'keyboard'): void {
  const button = document.getElementById('btn-chat-send')!;
  if (activation === 'pointer') {
    button.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }),
    );
  } else button.click();
}

beforeEach(async () => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  renderShell();
  host = {
    open: true,
    peer: 'mute-host',
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection;
  const { initChat } = await import('../chat.ts');
  initChat();
});

afterEach(() => {
  clearAllManagedTimers();
  vi.restoreAllMocks();
});

describe('authoritative chat mute at submission', () => {
  it.each([
    ['standard', 'pointer'],
    ['standard', 'keyboard'],
    ['pro-snapshot', 'keyboard'],
    ['pro-event', 'pointer'],
  ] as const)(
    'preserves the %s draft on muted %s send and permits immediate unmute retry',
    async (path, activation) => {
      enterRoom(path);
      const draft = `preserved draft ${path} ${activation}`;
      input.textContent = draft;
      await receiveMute(path, true);
      expect(input.contentEditable).toBe('false');
      send(activation);
      expect(sendToHost).not.toHaveBeenCalled();
      expect(pro.send).not.toHaveBeenCalled();
      expect(document.querySelector('.chat-bubble.mine')).toBeNull();
      expect(input.textContent).toBe(draft);
      expect(showToast).toHaveBeenCalledWith(t('chat.muted_placeholder'));

      await receiveMute(path, false);
      expect(input.contentEditable).toBe('true');
      send(activation);
      expect(path === 'standard' ? sendToHost : pro.send).toHaveBeenCalledOnce();
      expect(document.querySelector('.chat-bubble.mine')?.textContent).toBe(draft);
      expect(input.textContent).toBe('');
    },
  );

  it.each(['help', 'users'])(
    'keeps local %s available without unlocking a muted composer',
    async (command) => {
      enterRoom('standard');
      input.textContent = `/${command}`;
      await receiveMute('standard', true);
      send('keyboard');
      expect(document.querySelector('#chat-messages .chat-group.system')).not.toBeNull();
      expect(sendToHost).not.toHaveBeenCalled();
      expect(input.textContent).toBe('');
      expect(input.contentEditable).toBe('false');
    },
  );

  it.each([
    ['standard', 'w'],
    ['standard', 'whisper'],
    ['pro-snapshot', 'w'],
    ['pro-snapshot', 'whisper'],
  ] as const)('preserves a muted %s /%s draft and sends it after unmute', async (path, alias) => {
    enterRoom(path);
    setState('network.lastKnownDeviceList', [
      {
        id: 'whisper-target',
        label: 'Target',
        isOp: false,
        isHost: false,
        status: 'connected',
        joinOrder: 1,
        role: 'member',
      },
    ]);
    const draft = `/${alias} #1 whisper draft ${path} ${alias}`;
    input.textContent = draft;
    await receiveMute(path, true);
    send('keyboard');
    expect(sendToHost).not.toHaveBeenCalled();
    expect(pro.send).not.toHaveBeenCalled();
    expect(document.querySelector('.chat-bubble.mine')).toBeNull();
    expect(input.textContent).toBe(draft);
    await receiveMute(path, false);
    send('keyboard');
    expect(path === 'standard' ? sendToHost : pro.send).toHaveBeenCalledOnce();
    expect(document.querySelector('.chat-bubble.mine.whisper')).not.toBeNull();
    expect(input.textContent).toBe('');
  });

  it('blocks a visible BOT request while muted before starting the BOT operation', async () => {
    enterRoom('pro-snapshot');
    setState('network.lastKnownDeviceList', [
      {
        id: 'muted-guest',
        label: 'Controller',
        isOp: true,
        isHost: false,
        status: 'connected',
        role: 'controller',
      },
    ]);
    input.textContent = '/bot play jazz';
    await receiveMute('pro-snapshot', true);
    send('keyboard');
    expect(pro.send).not.toHaveBeenCalled();
    expect(pro.bot).not.toHaveBeenCalled();
    expect(input.textContent).toBe('/bot play jazz');
    expect(document.querySelector('.chat-bubble.mine')).toBeNull();
  });

  it.each(['standard', 'pro-event'] as const)(
    'does not mute this composer when %s moderation targets another participant',
    async (path) => {
      enterRoom(path);
      await receiveMute(path, true, 'other-guest');
      input.textContent = `unmuted control ${path}`;
      send('keyboard');
      expect(path === 'standard' ? sendToHost : pro.send).toHaveBeenCalledOnce();
    },
  );

  it('initializes the editor from a PRO mute received before its DOM is bound', async () => {
    enterRoom('pro-snapshot');
    await receiveMute('pro-snapshot', true);
    renderShell();
    const { initChat } = await import('../chat.ts');
    initChat();
    expect(getState('network.chatMuted')).toBe(true);
    expect(input.contentEditable).toBe('false');
    await receiveMute('pro-snapshot', false);
    expect(getState('network.chatMuted')).toBe(false);
    expect(input.contentEditable).toBe('true');
  });
});
