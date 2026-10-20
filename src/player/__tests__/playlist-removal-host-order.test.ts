/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleHostIncomingConnection } from '../../network/host.ts';
import { initProtocol } from '../../network/protocol.ts';
import { verifyPeerCapability } from '../../rooms/authority.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';
import { loadAndBroadcastFile } from '../decode.ts';
import { initPlaylist } from '../playlist.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));
vi.mock('../decode.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../decode.ts')>()),
  loadAndBroadcastFile: vi.fn(async () => false),
}));

const ONE = '21111111-1111-4111-8111-111111111111';
const TWO = '22222222-2222-4222-8222-222222222222';
const THREE = '23333333-3333-4333-8333-333333333333';
const BOOTSTRAP_ID = '12345678-1234-4abc-8def-1234567890ab';

type FiringConn = DataConnection & {
  send: Mock<(data: unknown) => void>;
  fire: (event: string, ...args: unknown[]) => void;
};

function file(queueItemId: string, name: string): PlaylistItem {
  return {
    queueItemId,
    type: 'file',
    name,
    file: new File([new Uint8Array([1])], name, { type: 'audio/wav' }),
    videoId: null,
    playlistId: null,
  };
}

/** A delegated Standard-room administrator on the real host receive path. */
function connectAdministrator(): FiringConn {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const conn = {
    peer: 'operator-device',
    open: true,
    send: vi.fn<(data: unknown) => void>(),
    close: vi.fn(),
    on(event: string, listener: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener]);
    },
    fire(event: string, ...args: unknown[]) {
      for (const listener of [...(handlers.get(event) ?? [])]) listener(...args);
    },
  } as unknown as FiringConn;
  handleHostIncomingConnection(conn);
  conn.fire('open');
  conn.fire('data', { type: MSG.JOIN_BOOTSTRAP_HELLO, version: 1, bootstrapId: BOOTSTRAP_ID });
  conn.fire('data', { type: MSG.JOIN_BOOTSTRAP_APPLIED, version: 1, bootstrapId: BOOTSTRAP_ID });
  bus.emit('network:grant-standard-room-administrator', { memberId: 'peer:operator-device' });
  expect(verifyPeerCapability(conn, 'playback.control')).toBe(true);
  expect(verifyPeerCapability(conn, 'queue.mutate')).toBe(true);
  return conn;
}

beforeAll(() => {
  // The production bridge dispatches each received frame without awaiting
  // the previous one, exactly as the connection delivers them.
  initProtocol();
  initPlaylist();
});

beforeEach(() => {
  clearAllManagedTimers();
  resetState();
  vi.clearAllMocks();
  vi.useFakeTimers();
  setState('network.appRole', 'host');
  setState('network.myId', 'host-device');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  setState('player.isFirstTrackLoad', false);
  setState('playlist.items', [
    file(ONE, 'One.wav'),
    file(TWO, 'Two.wav'),
    file(THREE, 'Three.wav'),
  ]);
  setState('playlist.currentQueueItemId', ONE);
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

it('applies a guest removal before the Next request that followed it on the connection', async () => {
  const conn = connectAdministrator();

  // A guest commits its Undo-pending deletion and then sends Next; the ordered
  // control channel delivers both frames back to back.
  conn.fire('data', {
    type: MSG.REQUEST_PLAYLIST_REMOVE,
    requestId: '44444444-4444-4444-8444-444444444444',
    baseRevision: getState('playlist.revision'),
    queueItemIds: [TWO],
  });
  conn.fire('data', { type: MSG.REQUEST_NEXT_TRACK, queueItemId: ONE });
  await vi.advanceTimersByTimeAsync(0);

  expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([ONE, THREE]);
  expect(getState('playlist.currentQueueItemId')).toBe(THREE);
  const loaded = vi.mocked(loadAndBroadcastFile).mock.calls.map(([, queueItemId]) => queueItemId);
  expect(loaded).not.toContain(TWO);
});

it('would land on the deleted row if Next reached the host first (order is what matters)', async () => {
  const conn = connectAdministrator();

  conn.fire('data', { type: MSG.REQUEST_NEXT_TRACK, queueItemId: ONE });
  conn.fire('data', {
    type: MSG.REQUEST_PLAYLIST_REMOVE,
    requestId: '45555555-5555-4555-8555-555555555555',
    baseRevision: getState('playlist.revision'),
    queueItemIds: [TWO],
  });
  await vi.advanceTimersByTimeAsync(0);

  // Removing the row Next had just selected hands playback to its successor.
  const loaded = vi.mocked(loadAndBroadcastFile).mock.calls.map(([, queueItemId]) => queueItemId);
  expect(loaded[0]).toBe(TWO);
});
