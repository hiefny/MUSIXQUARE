/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SENDER_LABEL_LENGTH, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { t } from '../../i18n/index.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import {
  broadcastTracksAdded,
  localQueueActorName,
  queueActorNameForConnection,
} from '../queue-events.ts';

function connectedPeer(conn: DataConnection, label: string): ConnectedPeer {
  return {
    id: conn.peer,
    slot: 1,
    label,
    status: 'connected',
    conn,
    isOp: true,
    isDataTarget: true,
    joinOrder: 1,
    lastHeartbeat: 0,
    preloadedQueueItemIds: new Set(),
    connectionType: 'local',
  };
}

describe('queue-add system messages', () => {
  beforeEach(() => {
    resetState();
    bus.clear();
  });

  it('broadcasts one localized gray system row with a bounded actor and count', () => {
    const send = vi.fn();
    const conn = { peer: 'peer-1', open: true, send } as unknown as DataConnection;
    setState('network.connectedPeers', [connectedPeer(conn, 'Peer 1')]);
    const localMessages: string[] = [];
    bus.on('chat:system-message', (text) => localMessages.push(text));

    expect(broadcastTracksAdded('  Studio bot  ', 24)).toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: MSG.CHAT_SYSTEM,
      text: t('chat.tracks_added', { name: 'Studio bot', count: 24 }),
      i18nKey: 'chat.tracks_added',
      i18nParams: { name: 'Studio bot', count: 24 },
    });
    expect(localMessages).toEqual([t('chat.tracks_added', { name: 'Studio bot', count: 24 })]);
  });

  it('derives actors only from local state or the exact authoritative connection', () => {
    const conn = { peer: 'peer-1', open: true } as DataConnection;
    const replaced = { peer: 'peer-1', open: true } as DataConnection;
    setState('network.myDeviceLabel', `  ${'H'.repeat(50)}  `);
    setState('network.connectedPeers', [connectedPeer(conn, 'Cafe admin')]);

    expect(localQueueActorName()).toBe('H'.repeat(MAX_SENDER_LABEL_LENGTH));
    expect(queueActorNameForConnection(conn)).toBe('Cafe admin');
    expect(queueActorNameForConnection(replaced)).toBeNull();
  });

  it('rejects zero, fractional, and oversized counts without emitting', () => {
    const localMessages = vi.fn();
    bus.on('chat:system-message', localMessages);

    expect(broadcastTracksAdded('Bot', 0)).toBe(false);
    expect(broadcastTracksAdded('Bot', 1.5)).toBe(false);
    expect(broadcastTracksAdded('Bot', 1001)).toBe(false);
    expect(localMessages).not.toHaveBeenCalled();
  });
});
