/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));

import { handleHostIncomingConnection } from '../host.ts';
import { handleData } from '../protocol.ts';
import { initPlaylist, setRepeatMode, setShuffle } from '../../player/playlist.ts';
import { initPlayback } from '../../player/playback.ts';

const Q1 = '00000000-0000-4000-8000-000000000001';
const Q2 = '00000000-0000-4000-8000-000000000002';
const BOOTSTRAP_ID = '00000000-0000-4000-8000-000000000010';

type Frame = Record<string, unknown>;
type FiringConn = DataConnection & {
  sent: Frame[];
  fire(event: string, ...args: unknown[]): void;
};

function connection(peer: string): FiringConn {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const sent: Frame[] = [];
  return {
    peer,
    open: true,
    sent,
    send: vi.fn((frame: unknown) => sent.push(structuredClone(frame as Frame))),
    close: vi.fn(),
    on(event: string, handler: (...args: unknown[]) => void) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
    },
    fire(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  } as unknown as FiringConn;
}

function beginJoin(conn: FiringConn): void {
  handleHostIncomingConnection(conn);
  conn.fire('open');
  conn.fire('data', { type: MSG.JOIN_BOOTSTRAP_HELLO, version: 1, bootstrapId: BOOTSTRAP_ID });
}

function deliverApplied(conn: FiringConn): void {
  conn.fire('data', { type: MSG.JOIN_BOOTSTRAP_APPLIED, version: 1, bootstrapId: BOOTSTRAP_ID });
}

function playlistFrames(conn: FiringConn): Frame[] {
  return conn.sent.filter((frame) => frame.type === MSG.PLAYLIST_UPDATE);
}

async function applyReceivedQueue(frames: Frame[]): Promise<void> {
  clearAllManagedTimers();
  resetState();
  const hostConn = connection('host');
  setState('network.appRole', 'guest');
  setState('network.hostConn', hostConn);
  for (const frame of frames) {
    if (
      frame.type === MSG.PLAYLIST_UPDATE ||
      frame.type === MSG.REPEAT_MODE ||
      frame.type === MSG.SHUFFLE_MODE
    ) {
      await handleData(frame, hostConn);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  bus.clear();
  resetState();
  setState('network.appRole', 'host');
  setState('network.myId', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  const items: PlaylistItem[] = [
    {
      queueItemId: Q1,
      type: 'file',
      name: 'a.mp3',
      file: new File(['a'], 'a.mp3'),
      videoId: null,
      playlistId: null,
    },
    {
      queueItemId: Q2,
      type: 'file',
      name: 'b.mp3',
      file: new File(['b'], 'b.mp3'),
      videoId: null,
      playlistId: null,
    },
  ];
  setState('playlist.items', items);
  setState('playlist.currentQueueItemId', Q1);
  setState('playlist.revision', 1);
  initPlaylist();
  initPlayback();
});

afterEach(() => {
  clearAllManagedTimers();
  bus.clear();
  vi.useRealTimers();
});

describe('standard host queue changes while APPLIED is in flight', () => {
  it('catches a late guest up after a real playlist removal without restarting an existing guest', async () => {
    const existing = connection('existing');
    beginJoin(existing);
    deliverApplied(existing);
    existing.sent.length = 0;
    const late = connection('late');
    const connected = vi.fn();
    bus.on('network:peer-connected', connected);
    beginJoin(late);
    expect(getState('network.connectedPeers').find((peer) => peer.conn === late)?.status).toBe(
      'connecting',
    );
    expect(playlistFrames(late)).toHaveLength(1);

    // APPLIED is a separate network message. The host can edit the queue
    // after sending its baseline but before that acknowledgement arrives.
    bus.emit('playlist:remove-tracks', [Q2]);
    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([Q1]);
    expect(playlistFrames(existing).at(-1)?.list).toEqual([
      expect.objectContaining({ queueItemId: Q1 }),
    ]);
    expect(playlistFrames(late)).toHaveLength(1);

    deliverApplied(late);
    expect(connected).toHaveBeenCalledExactlyOnceWith(late);
    expect(
      existing.sent.some(
        (frame) =>
          frame.type === MSG.PLAY || frame.type === MSG.PAUSE || frame.type === MSG.FILE_START,
      ),
    ).toBe(false);
    const latestQueueIndex = late.sent.findLastIndex((frame) => frame.type === MSG.PLAYLIST_UPDATE);
    const firstPlaybackIndex = late.sent.findIndex(
      (frame) => frame.type === MSG.PAUSE || frame.type === MSG.PLAY,
    );
    expect(latestQueueIndex).toBeLessThan(firstPlaybackIndex);
    await applyReceivedQueue(late.sent);
    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([Q1]);
  });

  it('catches repeat and shuffle changes even when the playlist revision does not change', async () => {
    const late = connection('late');
    beginJoin(late);
    setRepeatMode(2, false);
    setShuffle(true, false);
    expect(getState('playlist.revision')).toBe(1);
    deliverApplied(late);
    await applyReceivedQueue(late.sent);
    expect(getState('playlist.repeatMode')).toBe(2);
    expect(getState('playlist.isShuffle')).toBe(true);
  });

  it('does not repeat an unchanged bootstrap or start playback twice', () => {
    const late = connection('late');
    beginJoin(late);
    deliverApplied(late);
    deliverApplied(late);
    expect(playlistFrames(late)).toHaveLength(1);
    expect(late.sent.filter((frame) => frame.type === MSG.PAUSE)).toHaveLength(1);
  });

  it('fails closed before publication if the catch-up snapshot cannot be sent', () => {
    const late = connection('late');
    const connected = vi.fn();
    bus.on('network:peer-connected', connected);
    beginJoin(late);
    bus.emit('playlist:remove-tracks', [Q2]);
    vi.mocked(late.send).mockImplementationOnce(() => {
      throw new Error('transport send failed');
    });
    deliverApplied(late);
    expect(connected).not.toHaveBeenCalled();
    expect(late.close).toHaveBeenCalledOnce();
    expect(getState('network.connectedPeers').some((peer) => peer.conn === late)).toBe(false);
    expect(late.sent.some((frame) => frame.type === MSG.PLAY || frame.type === MSG.PAUSE)).toBe(
      false,
    );
  });

  it('never lets an old APPLIED catch up or publish a replacement connection', () => {
    const old = connection('late');
    beginJoin(old);
    bus.emit('playlist:remove-tracks', [Q2]);
    const replacement = connection('late');
    beginJoin(replacement);
    const connected = vi.fn();
    bus.on('network:peer-connected', connected);
    const oldFrameCount = old.sent.length;
    const replacementFrameCount = replacement.sent.length;
    deliverApplied(old);
    expect(old.sent).toHaveLength(oldFrameCount);
    expect(replacement.sent).toHaveLength(replacementFrameCount);
    expect(connected).not.toHaveBeenCalled();
    deliverApplied(replacement);
    expect(connected).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(playlistFrames(replacement)).toHaveLength(1);
  });
});
