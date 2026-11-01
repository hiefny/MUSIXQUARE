/**
 * "YouTube Sync > initYouTubeSync() > seeds a promoted PRO coordinator from
 * its existing member offset", in a file of its own. initYouTubeSync() seeds
 * the applied offset from the member offset only when the manual-offset
 * endpoint identity changes from none to PRO. sync.ts keeps that identity for
 * as long as the module lives, and no export resets it (resetYouTubeSyncState()
 * leaves it alone), so in sync.test.ts the row passed only when no earlier row
 * had entered a PRO endpoint. The mocks and hooks are sync.test.ts's, except
 * zero-start.ts: no row here forces a zero-start owner, so the real module
 * stays and, with no controller, its facades answer false. No row here
 * registers a PRO timeline, so afterEach has none to unregister.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
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
  describe('initYouTubeSync()', () => {
    it('seeds a promoted PRO coordinator from its existing member offset', async () => {
      const playerMod = await import('../_state.ts');
      vi.mocked(playerMod.getYouTubePlayer).mockReturnValue(null);
      setState('sync.youtubeLocalOffset', 0.25);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      const { initYouTubeSync } = await import('../sync.ts');
      initYouTubeSync();

      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'participant-1',
        epoch: 2,
        snapshotRevision: 2,
        capabilities: ['playback.control'],
      });

      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(0.25);
    });
  });
});
