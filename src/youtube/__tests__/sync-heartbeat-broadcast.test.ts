/**
 * "YouTube Sync > broadcastYouTubeSync() > broadcasts sync data when host
 * with player", in a file of its own. sync.ts drops a heartbeat that comes
 * within 500 ms of its last manual broadcast, and keeps that time for as long
 * as the module lives, with no reset. An earlier row's manual broadcast under
 * fake timers can store a fake performance.now() well ahead of this row's real
 * clock, so in sync.test.ts this row's heartbeat was sometimes dropped. No row
 * in this file makes a manual broadcast. The mocks and hooks are
 * sync.test.ts's, except zero-start.ts: no row here forces a zero-start owner,
 * so the real module stays, and with no controller its facades answer false
 * on the heartbeat's owner gate. No row here registers a PRO timeline, so
 * afterEach has none to unregister.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { YouTubePlayerInstance } from '../_state.ts';
import {
  prepareStandardHostManualOffsetRuntimeForTests,
  resetStandardHostManualOffsetTransaction,
} from '../standard-host-manual-offset-gate.ts';

const QUEUE_ITEM_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
}));

vi.mock('../search.ts', () => ({
  fetchPlaylistSubTitles: vi.fn(),
}));

// sync.ts must remain below the iframe runtime boundary. iframe.ts already
// imports sync.ts, so importing it back here recreates an evaluation cycle
// that can leave Vitest/browser ESM bindings in the temporal dead zone.
vi.mock('../iframe.ts', () => {
  throw new Error('sync.ts must not import iframe.ts');
});

vi.mock('../_state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_state.ts')>();
  return { ...actual, getYouTubePlayer: vi.fn(() => null) };
});

beforeEach(async () => {
  await prepareStandardHostManualOffsetRuntimeForTests();
  resetStandardHostManualOffsetTransaction();
  vi.clearAllMocks();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  // clearAllMocks() keeps implementations: restore the factory's null player
  // so no row inherits the previous row's mockReturnValue.
  vi.mocked((await import('../_state.ts')).getYouTubePlayer).mockReset();
  // Clear the sync runtime an earlier row left behind (its last host
  // snapshot, for example) with the reset stopYouTubeMode runs. It runs
  // after bus.clear(), so its events reach no earlier row's listener.
  (await import('../sync.ts')).resetYouTubeSyncState();
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Same Video',
      videoId: 'same-video',
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('YouTube Sync', () => {
  describe('broadcastYouTubeSync()', () => {
    it('broadcasts sync data when host with player', async () => {
      const playerMod = await import('../_state.ts');
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue({
        getCurrentTime: () => 42.5,
        getPlayerState: () => 1,
      } as YouTubePlayerInstance);
      setState('network.hostConn', null);

      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');

      broadcastYouTubeSync();
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          time: 42.5,
          state: 1,
        }),
      );
    });
  });
});
