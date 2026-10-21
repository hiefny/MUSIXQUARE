/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { getManagedTimer } from '../../core/timers.ts';
import { t } from '../../i18n/index.ts';
import type {
  ConnectedPeer,
  DataConnection,
  HostPresence,
  PlaylistItem,
} from '../../types/index.ts';
import {
  getHostPresence,
  handleHostCommandRejectedMessage,
  hostPresenceTimingForTests,
  initHostPresence,
  isHostSilentFor,
  noteHostFrame,
  refuseHostCommand,
  refuseWhileHostHidden,
  resetHostPresenceForTests,
  syncPongHostPresence,
} from '../host-presence.ts';
import { handleData, registerHandler } from '../protocol.ts';
import { safeSend } from '../peer-state.ts';

const FILE_ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YOUTUBE_ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const { silenceMs, longSilenceMs } = hostPresenceTimingForTests;
const WATCHDOG_TIMER = 'host-presence-watchdog';

type FakeConnection = DataConnection & { send: ReturnType<typeof vi.fn> };

function connection(peer: string): FakeConnection {
  return { peer, open: true, send: vi.fn() } as unknown as FakeConnection;
}

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

const toasts: string[] = [];
const changes: Array<[HostPresence, HostPresence, 'host' | 'reset']> = [];
let longSilences = 0;

function joinAsGuest(conn: DataConnection): void {
  setState('network.appRole', 'guest');
  setState('network.hostConn', conn);
  bus.emit('network:peer-connected', conn);
}

function playlist(): PlaylistItem[] {
  return [
    { queueItemId: FILE_ITEM, type: 'file', name: 'song.mp3' } as PlaylistItem,
    { queueItemId: YOUTUBE_ITEM, type: 'youtube', name: 'video' } as PlaylistItem,
  ];
}

function startStandardHost(guest: DataConnection, isOp = true): void {
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('network.activeHostConnByPeerId', new Map([[guest.peer, guest]]));
  setState('network.connectedPeers', [
    {
      id: guest.peer,
      slot: 1,
      label: 'Guest',
      conn: guest,
      isOp,
      preloadedQueueItemIds: new Set(),
      status: 'connected',
      isDataTarget: true,
      joinOrder: 1,
      connectionType: 'local',
      lastHeartbeat: Date.now(),
    } as ConnectedPeer,
  ]);
  setState('playlist.items', playlist());
  setState('playlist.currentQueueItemId', FILE_ITEM);
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  visibility = 'visible';
  resetState();
  resetHostPresenceForTests();
  initHostPresence();
  toasts.length = 0;
  changes.length = 0;
  longSilences = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

bus.on('ui:show-toast', (message) => toasts.push(message));
bus.on('host-presence:changed', (next, previous, cause) => changes.push([next, previous, cause]));
bus.on('host-presence:long-unresponsive', () => {
  longSilences += 1;
});

describe('guest view of a Standard host', () => {
  it('does not judge the host before the join finishes', () => {
    const host = connection('host');
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);

    vi.advanceTimersByTime(silenceMs * 3);

    expect(getHostPresence()).toBe('ok');
  });

  it('marks a silent host unresponsive and holds room commands with a toast', () => {
    const host = connection('host');
    joinAsGuest(host);

    vi.advanceTimersByTime(silenceMs - 1_000);
    expect(getHostPresence()).toBe('ok');
    vi.advanceTimersByTime(1_000);

    expect(getHostPresence()).toBe('unresponsive');
    expect(changes.at(-1)).toEqual(['unresponsive', 'ok', 'host']);
    expect(refuseHostCommand(host, { type: MSG.CHAT })).toBe(true);
    expect(refuseHostCommand(host, { type: MSG.REQUEST_PAUSE })).toBe(true);
    expect(toasts).toEqual([
      t('toast.host_unresponsive_chat'),
      t('toast.host_unresponsive_blocked'),
    ]);
  });

  it('keeps pings and other traffic flowing while the host is silent', () => {
    const host = connection('host');
    joinAsGuest(host);
    vi.advanceTimersByTime(silenceMs);

    expect(safeSend(host, { type: MSG.SYNC_PING, pingId: 1, guestTime: Date.now() })).toBe(true);
    expect(host.send).toHaveBeenCalledTimes(1);
    expect(safeSend(host, { type: MSG.REQUEST_NEXT_TRACK, queueItemId: null })).toBe(false);
    expect(host.send).toHaveBeenCalledTimes(1);
  });

  it('returns to ok when any host frame arrives', async () => {
    const host = connection('host');
    joinAsGuest(host);
    vi.advanceTimersByTime(silenceMs);

    await handleData({ type: MSG.SYNC_PONG }, host);

    expect(getHostPresence()).toBe('ok');
    expect(changes.at(-1)).toEqual(['ok', 'unresponsive', 'host']);
    expect(refuseHostCommand(host, { type: MSG.CHAT })).toBe(false);
  });

  it('ignores frames and presence from a replaced connection', () => {
    const stale = connection('host-old');
    const host = connection('host');
    joinAsGuest(host);
    vi.advanceTimersByTime(silenceMs);

    noteHostFrame(stale, { type: MSG.SYNC_PONG });

    expect(getHostPresence()).toBe('unresponsive');
  });

  it('shows a hidden host as background without holding commands', () => {
    const host = connection('host');
    joinAsGuest(host);

    noteHostFrame(host, { type: MSG.SYNC_PONG, hostHidden: true });
    expect(getHostPresence()).toBe('background');
    expect(refuseHostCommand(host, { type: MSG.REQUEST_PLAY })).toBe(false);

    // Other frames say nothing about visibility; the next ping reply does.
    noteHostFrame(host, { type: MSG.PLAY });
    expect(getHostPresence()).toBe('background');
    noteHostFrame(host, { type: MSG.SYNC_PONG });
    expect(getHostPresence()).toBe('ok');
    expect(changes.map(([next]) => next)).toEqual(['background', 'ok']);
  });

  it('explains a command the hidden host refused', () => {
    const host = connection('host');
    joinAsGuest(host);

    handleHostCommandRejectedMessage(
      { type: MSG.HOST_COMMAND_REJECTED, reason: 'host-hidden', command: MSG.REQUEST_PLAY },
      host,
    );

    expect(getHostPresence()).toBe('background');
    expect(toasts).toEqual([t('toast.host_background_blocked')]);
  });

  it('offers to leave once after a long silence', () => {
    const host = connection('host');
    joinAsGuest(host);

    vi.advanceTimersByTime(longSilenceMs + 5_000);

    expect(longSilences).toBe(1);
    expect(isHostSilentFor(longSilenceMs)).toBe(true);
  });

  it('does not judge the host while this page is hidden', () => {
    const host = connection('host');
    joinAsGuest(host);
    setVisibility('hidden');

    vi.advanceTimersByTime(silenceMs * 4);
    expect(getHostPresence()).toBe('ok');

    // Back on screen, the silence window restarts instead of firing at once.
    setVisibility('visible');
    vi.advanceTimersByTime(1_000);
    expect(getHostPresence()).toBe('ok');
  });

  it('stops the watchdog while hidden and checks at once when shown again', () => {
    const host = connection('host');
    joinAsGuest(host);
    expect(getManagedTimer(WATCHDOG_TIMER)).not.toBeNull();
    vi.advanceTimersByTime(silenceMs);
    expect(getHostPresence()).toBe('unresponsive');

    setVisibility('hidden');
    expect(getManagedTimer(WATCHDOG_TIMER)).toBeNull();

    setVisibility('visible');
    expect(getManagedTimer(WATCHDOG_TIMER)).not.toBeNull();
    // The silence window restarted and was judged without waiting a tick.
    expect(getHostPresence()).toBe('ok');
    vi.advanceTimersByTime(silenceMs);
    expect(getHostPresence()).toBe('unresponsive');
  });

  it('starts the watchdog for a link that opened while hidden only once shown', () => {
    setVisibility('hidden');
    const host = connection('host');
    joinAsGuest(host);
    expect(getManagedTimer(WATCHDOG_TIMER)).toBeNull();

    setVisibility('visible');
    expect(getManagedTimer(WATCHDOG_TIMER)).not.toBeNull();
    vi.advanceTimersByTime(silenceMs);
    expect(getHostPresence()).toBe('unresponsive');
  });

  it('resets quietly when the host connection closes', () => {
    const host = connection('host');
    joinAsGuest(host);
    vi.advanceTimersByTime(silenceMs);

    setState('network.hostConn', null);

    expect(getHostPresence()).toBe('ok');
    expect(changes.at(-1)).toEqual(['ok', 'unresponsive', 'reset']);
  });

  it('leaves PRO rooms alone', () => {
    const host = connection('host');
    setState('room.context', { ...standardRoomContext(), kind: 'pro' });
    joinAsGuest(host);

    vi.advanceTimersByTime(silenceMs * 3);

    expect(getHostPresence()).toBe('ok');
    expect(refuseHostCommand(host, { type: MSG.CHAT })).toBe(false);
  });
});

describe('hidden Standard host', () => {
  it('refuses an operator command that would start a local file', async () => {
    const guest = connection('guest-1');
    startStandardHost(guest);
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_PLAY, handler);
    visibility = 'hidden';

    await handleData({ type: MSG.REQUEST_PLAY, queueItemId: FILE_ITEM, time: 0 }, guest);

    expect(handler).not.toHaveBeenCalled();
    expect(guest.send).toHaveBeenCalledWith({
      type: MSG.HOST_COMMAND_REJECTED,
      reason: 'host-hidden',
      command: MSG.REQUEST_PLAY,
    });
  });

  it('runs the same command while visible', async () => {
    const guest = connection('guest-1');
    startStandardHost(guest);
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_PLAY, handler);

    await handleData({ type: MSG.REQUEST_PLAY, queueItemId: FILE_ITEM, time: 0 }, guest);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(guest.send).not.toHaveBeenCalled();
  });

  it('leaves pause, paused seeks and YouTube items to their handlers', () => {
    const guest = connection('guest-1');
    startStandardHost(guest);
    visibility = 'hidden';

    expect(refuseWhileHostHidden(MSG.REQUEST_PAUSE, { queueItemId: FILE_ITEM }, guest)).toBe(false);
    expect(
      refuseWhileHostHidden(MSG.REQUEST_SEEK, { queueItemId: FILE_ITEM, time: 3 }, guest),
    ).toBe(false);
    expect(
      refuseWhileHostHidden(MSG.REQUEST_TRACK_CHANGE, { queueItemId: YOUTUBE_ITEM }, guest),
    ).toBe(false);
    expect(
      refuseWhileHostHidden(MSG.REQUEST_YOUTUBE_PLAY, { queueItemId: YOUTUBE_ITEM }, guest),
    ).toBe(false);
    expect(guest.send).not.toHaveBeenCalled();
  });

  it('refuses a seek while a local file is playing', () => {
    const guest = connection('guest-1');
    startStandardHost(guest);
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    visibility = 'hidden';

    expect(
      refuseWhileHostHidden(MSG.REQUEST_SEEK, { queueItemId: FILE_ITEM, time: 3 }, guest),
    ).toBe(true);
  });

  it('leaves a non-operator command to the normal permission check', () => {
    const guest = connection('guest-1');
    startStandardHost(guest, false);
    visibility = 'hidden';

    expect(refuseWhileHostHidden(MSG.REQUEST_PLAY, { queueItemId: FILE_ITEM }, guest)).toBe(false);
    expect(guest.send).not.toHaveBeenCalled();
  });

  it('marks its ping replies only while hidden', () => {
    const guest = connection('guest-1');
    startStandardHost(guest);

    expect(syncPongHostPresence()).toEqual({});
    visibility = 'hidden';
    expect(syncPongHostPresence()).toEqual({ hostHidden: true });
  });

  it('does not mark ping replies before the room has started', () => {
    setState('network.appRole', 'host');
    visibility = 'hidden';

    expect(syncPongHostPresence()).toEqual({});
  });
});

function standardRoomContext() {
  return {
    kind: 'standard' as const,
    roomId: null,
    role: 'idle' as const,
    coordinatorId: null,
    epoch: 0,
    snapshotRevision: 0,
    capabilities: [],
  };
}
