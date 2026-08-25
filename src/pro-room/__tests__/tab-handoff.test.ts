import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  announceProRoomTabTakeover,
  onProRoomTabTakeover,
  resetProRoomTabHandoffForTests,
} from '../tab-handoff.ts';

class FakeBroadcastChannel {
  static readonly channels = new Set<FakeBroadcastChannel>();

  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(readonly name: string) {
    FakeBroadcastChannel.channels.add(this);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  postMessage(data: unknown): void {
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel === this || channel.name !== this.name) continue;
      for (const listener of channel.listeners) listener({ data } as MessageEvent<unknown>);
    }
  }

  close(): void {
    FakeBroadcastChannel.channels.delete(this);
    this.listeners.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  resetProRoomTabHandoffForTests();
});

afterEach(() => {
  resetProRoomTabHandoffForTests();
  for (const channel of [...FakeBroadcastChannel.channels]) channel.close();
  vi.unstubAllGlobals();
});

describe('PRO room cross-tab handoff', () => {
  it('notifies an older tab only for a valid PRO room takeover', () => {
    const received: string[] = [];
    const stop = onProRoomTabTakeover((roomCode) => received.push(roomCode));
    const otherTab = new FakeBroadcastChannel('musixquare-pro-room-tab-handoff-v1');

    otherTab.postMessage({ type: 'pro-room-tab-takeover', roomCode: '000001' });
    otherTab.postMessage({ type: 'pro-room-tab-takeover', roomCode: '123456' });
    otherTab.postMessage({ type: 'untrusted-message', roomCode: '000001' });

    expect(received).toEqual(['000001']);
    stop();
  });

  it('announces a committed takeover to other tabs and tolerates unsupported browsers', () => {
    const otherTab = new FakeBroadcastChannel('musixquare-pro-room-tab-handoff-v1');
    const received: unknown[] = [];
    otherTab.addEventListener('message', (event) => received.push(event.data));

    announceProRoomTabTakeover('000000');
    announceProRoomTabTakeover('999999');

    expect(received).toEqual([{ type: 'pro-room-tab-takeover', roomCode: '000000' }]);

    resetProRoomTabHandoffForTests();
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(() => announceProRoomTabTakeover('000001')).not.toThrow();
  });

  it('isolates takeover observers so one failure cannot suppress later cleanup', () => {
    const received: string[] = [];
    onProRoomTabTakeover(() => {
      throw new Error('stale observer failed');
    });
    onProRoomTabTakeover((roomCode) => received.push(roomCode));
    const otherTab = new FakeBroadcastChannel('musixquare-pro-room-tab-handoff-v1');

    expect(() =>
      otherTab.postMessage({ type: 'pro-room-tab-takeover', roomCode: '000001' }),
    ).not.toThrow();
    expect(received).toEqual(['000001']);
  });
});
