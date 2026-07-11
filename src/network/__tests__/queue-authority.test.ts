import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type { DataConnection } from '../../types/index.ts';
import { handleData, registerHandler } from '../protocol.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';

const QID = '00000000-0000-4000-8000-000000000001';

function connection(peer: string): DataConnection {
  return { peer, open: true } as DataConnection;
}

beforeEach(() => {
  resetState();
  bus.clear();
  setState('network.appRole', 'guest');
});

describe('central guest queue authority gate', () => {
  it('drops qid and media frames until the active connection is ready', async () => {
    const conn = connection('host-pending');
    const play = vi.fn();
    const systemAudio = vi.fn();
    registerHandler(MSG.PLAY, play);
    registerHandler(MSG.SYSTEM_AUDIO_START, systemAudio);
    setState('network.hostConn', conn);

    await handleData({ type: MSG.PLAY, time: 0, queueItemId: QID }, conn);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, conn);
    expect(play).not.toHaveBeenCalled();
    expect(systemAudio).not.toHaveBeenCalled();

    markQueueAuthorityReady(conn);
    await handleData({ type: MSG.PLAY, time: 0, queueItemId: QID }, conn);
    await handleData({ type: MSG.SYSTEM_AUDIO_START }, conn);
    expect(play).toHaveBeenCalledTimes(1);
    expect(systemAudio).toHaveBeenCalledTimes(1);
  });

  it('drops every frame from a replaced host connection centrally', async () => {
    const stale = connection('host-stale');
    const active = connection('host-active');
    const welcome = vi.fn();
    registerHandler(MSG.WELCOME, welcome);
    setState('network.hostConn', active);
    markQueueAuthorityReady(stale);
    markQueueAuthorityReady(active);

    await handleData(
      { type: MSG.WELCOME, lockChannel: false, label: 'stale', chatFrozen: false },
      stale,
    );
    expect(welcome).not.toHaveBeenCalled();

    await handleData(
      { type: MSG.WELCOME, lockChannel: false, label: 'active', chatFrozen: false },
      active,
    );
    expect(welcome).toHaveBeenCalledTimes(1);
  });
});

describe('central host connection authority gate', () => {
  it('accepts commands only from the exact active connection for a stable peer id', async () => {
    const stale = connection('guest-1');
    const active = connection('guest-1');
    const requestPlay = vi.fn();
    registerHandler(MSG.REQUEST_PLAY, requestPlay);
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('network.activeHostConnByPeerId', new Map([['guest-1', active]]));

    await handleData({ type: MSG.REQUEST_PLAY, queueItemId: QID, time: 0 }, stale);
    expect(requestPlay).not.toHaveBeenCalled();

    await handleData({ type: MSG.REQUEST_PLAY, queueItemId: QID, time: 0 }, active);
    expect(requestPlay).toHaveBeenCalledTimes(1);
  });
});
