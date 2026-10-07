import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, getState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection } from '../../types/index.ts';
import { handleHostIncomingConnection } from '../host.ts';

type FiringConnection = DataConnection & {
  open: boolean;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fire: (event: string, ...args: unknown[]) => void;
};

function makeConnection(peerId: string, initiallyOpen = false): FiringConnection {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    peer: peerId,
    open: initiallyOpen,
    send: vi.fn(),
    close: vi.fn(),
    on(event: string, listener: (...args: unknown[]) => void) {
      const callbacks = listeners.get(event) ?? [];
      callbacks.push(listener);
      listeners.set(event, callbacks);
    },
    fire(event: string, ...args: unknown[]) {
      if (event === 'open') (this as FiringConnection).open = true;
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
  } as unknown as FiringConnection;
}

const BOOTSTRAP_IDS = [
  '12345678-1234-4abc-8def-1234567890ab',
  '87654321-4321-4cba-9fed-ba0987654321',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
];

function hello(bootstrapId: string) {
  return { type: MSG.JOIN_BOOTSTRAP_HELLO, version: 1, bootstrapId };
}

function applied(bootstrapId: string) {
  return { type: MSG.JOIN_BOOTSTRAP_APPLIED, version: 1, bootstrapId };
}

function installBootstrapResponder(): () => void {
  return bus.on('network:peer-bootstrap', (_conn, send, acknowledge) => {
    const sent =
      send({
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        revision: 12,
        currentQueueItemId: null,
        bootstrap: true,
      }) &&
      send({ type: MSG.REPEAT_MODE, value: 0, _bootstrap: true }) &&
      send({ type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true });
    acknowledge(sent);
  });
}

function admit(conn: FiringConnection, bootstrapId: string): void {
  handleHostIncomingConnection(conn);
  conn.fire('open');
  conn.fire('data', hello(bootstrapId));
  conn.fire('data', applied(bootstrapId));
}

const eventOrders = [['close', 'error'], ['error', 'close'], ['close'], ['error']] as const;

const cases = [
  ...([true, false] as const).flatMap((helloBeforeOpen) =>
    ([true, false] as const).flatMap((staleBeforeHello) =>
      ([0, 1, 2, 3] as const).flatMap((newcomerBoundary) =>
        eventOrders.map((staleOrder) => ({
          helloBeforeOpen,
          staleBeforeHello,
          newcomerBoundary,
          staleOrder,
        })),
      ),
    ),
  ),
].map((scenario, index) => ({ ...scenario, index }));

const caseSignatures = cases.map(
  ({ helloBeforeOpen, staleBeforeHello, newcomerBoundary, staleOrder }) =>
    `${helloBeforeOpen}|${staleBeforeHello}|${newcomerBoundary}|${staleOrder.join(',')}`,
);
if (new Set(caseSignatures).size !== cases.length) {
  throw new Error('Luna session-ordering matrix contains duplicate case signatures');
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  setState('network.myId', 'host');
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', true);
  setState('playback.activity', 'playing');
  setState('playlist.items', [
    {
      queueItemId: '00000000-0000-4000-8000-000000000012',
      type: 'file',
      name: 'already-playing.mp3',
      videoId: null,
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000012');
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('Luna standard-room session ordering matrix', () => {
  it.each(cases)(
    'keeps a playing peer isolated across reconnect and late join sequence $index',
    ({ helloBeforeOpen, staleBeforeHello, newcomerBoundary, staleOrder }) => {
      const stopBootstrap = installBootstrapResponder();
      try {
        const playingGuest = makeConnection('guest-playing', true);
        const priorConnection = makeConnection('guest-reconnecting');
        admit(playingGuest, BOOTSTRAP_IDS[0]!);
        admit(priorConnection, BOOTSTRAP_IDS[1]!);
        playingGuest.send.mockClear();
        priorConnection.send.mockClear();

        const newcomer = makeConnection('guest-late');
        const startNewcomer = () => handleHostIncomingConnection(newcomer);
        const openNewcomerWithPreOpenHello = () => {
          newcomer.fire('data', hello(BOOTSTRAP_IDS[3]!));
          newcomer.fire('open');
        };
        const openNewcomerWithPostOpenHello = () => {
          newcomer.fire('open');
          newcomer.fire('data', hello(BOOTSTRAP_IDS[3]!));
        };

        if (newcomerBoundary === 0) {
          startNewcomer();
          openNewcomerWithPreOpenHello();
        }
        const replacement = makeConnection('guest-reconnecting');
        handleHostIncomingConnection(replacement);
        if (helloBeforeOpen) {
          if (staleBeforeHello) fireStaleCallbacks(priorConnection, staleOrder);
          replacement.fire('data', hello(BOOTSTRAP_IDS[2]!));
        }
        replacement.fire('open');
        if (newcomerBoundary === 1) {
          // The first admission point is before replacement transport open;
          // this one follows replacement open and precedes its HELLO.
          startNewcomer();
          openNewcomerWithPostOpenHello();
        }
        if (!helloBeforeOpen) {
          if (staleBeforeHello) fireStaleCallbacks(priorConnection, staleOrder);
          replacement.fire('data', hello(BOOTSTRAP_IDS[2]!));
        }
        if (!staleBeforeHello) fireStaleCallbacks(priorConnection, staleOrder);
        if (newcomerBoundary === 2) {
          // A late join is admitted after replacement HELLO, before APPLIED.
          startNewcomer();
          openNewcomerWithPostOpenHello();
        }

        // The old exact connection is retired as soon as the replacement is
        // admitted. Its delayed transport events and protocol frames must not
        // tear down the replacement or make the still-playing guest recover.
        replacement.fire('data', applied(BOOTSTRAP_IDS[2]!));
        if (newcomerBoundary === 3) {
          startNewcomer();
          openNewcomerWithPostOpenHello();
        }
        if (newcomer.open) newcomer.fire('data', applied(BOOTSTRAP_IDS[3]!));

        const livePeers = getState('network.connectedPeers');
        expect(livePeers).toHaveLength(3);
        expect(livePeers.find((peer) => peer.id === 'guest-playing')?.conn).toBe(playingGuest);
        expect(livePeers.find((peer) => peer.id === 'guest-reconnecting')?.conn).toBe(replacement);
        expect(livePeers.find((peer) => peer.id === 'guest-late')?.conn).toBe(newcomer);
        expect(getState('network.activeHostConnByPeerId').get('guest-reconnecting')).toBe(
          replacement,
        );
        expect(getState('playback.activity')).toBe('playing');
        expect(getState('playlist.currentQueueItemId')).toBe(
          '00000000-0000-4000-8000-000000000012',
        );

        const incumbentTypes = playingGuest.send.mock.calls.map(
          ([frame]) => (frame as { type?: string }).type,
        );
        for (const forbidden of [
          MSG.PLAYLIST_UPDATE,
          MSG.REPEAT_MODE,
          MSG.SHUFFLE_MODE,
          MSG.PLAY,
          MSG.PAUSE,
          MSG.REQUEST_SEEK,
        ]) {
          expect(incumbentTypes, `incumbent unexpectedly received ${forbidden}`).not.toContain(
            forbidden,
          );
        }
        expect(
          newcomer.send.mock.calls.map(([frame]) => (frame as { type?: string }).type),
        ).toEqual(expect.arrayContaining([MSG.PLAYLIST_UPDATE, MSG.REPEAT_MODE, MSG.SHUFFLE_MODE]));
      } finally {
        stopBootstrap();
      }
    },
  );
});

function fireStaleCallbacks(
  priorConnection: FiringConnection,
  order: readonly ('close' | 'error')[],
): void {
  for (const event of order) priorConnection.fire(event, new Error(`stale ${event}`));
  priorConnection.fire('data', applied(BOOTSTRAP_IDS[1]!));
  priorConnection.fire('data', { type: MSG.PLAY, queueItemId: 'stale-track' });
}
