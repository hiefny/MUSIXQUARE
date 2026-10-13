/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { newLoadEpoch } from '../../player/_state.ts';
import { showLoader, showToast } from '../../ui/toast.ts';
import {
  getPrefetchedYouTubePlaylistManifest,
  resolveYouTubePlaylistManifest,
  type YouTubePlaylistManifest,
} from '../search.ts';
import {
  cancelStandardPlaylistSelection,
  prepareStandardPlaylistSelection,
} from '../standard-playlist.ts';

vi.mock('../search.ts', () => ({
  getPrefetchedYouTubePlaylistManifest: vi.fn(() => null),
  resolveYouTubePlaylistManifest: vi.fn(),
}));
vi.mock('../../ui/toast.ts', () => ({ showLoader: vi.fn(), showToast: vi.fn() }));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));

const OLD = '44444444-4444-4444-8444-444444444444';
const TARGET = '55555555-5555-4555-8555-555555555555';
const ids = Array.from({ length: 248 }, (_, i) => `video${String(i).padStart(6, '0')}`);
const manifest: YouTubePlaylistManifest = {
  playlistId: 'PL_FULL',
  videoId: ids[0],
  videoIds: ids,
  title: 'Full',
};
function pendingManifest() {
  let resolve!: (value: YouTubePlaylistManifest) => void;
  let reject!: (error: Error) => void;
  vi.mocked(resolveYouTubePlaylistManifest).mockReturnValueOnce(
    new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    }),
  );
  return { resolve, reject };
}
beforeEach(() => {
  cancelStandardPlaylistSelection();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  vi.mocked(getPrefetchedYouTubePlaylistManifest).mockReturnValue(null);
  setState('playlist.items', [
    { queueItemId: OLD, type: 'file', name: 'Playing.mp3', videoId: null, playlistId: null },
    { queueItemId: TARGET, type: 'youtube', name: 'Full', videoId: ids[0], playlistId: 'PL_FULL' },
  ]);
  setState('playlist.currentQueueItemId', OLD);
  setState('playback.activity', 'playing');
  setState('youtube.subItemsMap', { PL_FULL: { ids: ids.slice(0, 200), titles: [] } });
});
afterEach(() => cancelStandardPlaylistSelection());

describe('complete Standard playlist selection', () => {
  it('repairs a 200-ID cache without selecting or stopping the old track during acquisition', async () => {
    const pending = pendingManifest();
    const stop = vi.fn();
    bus.on('player:stop-all-media', stop);
    const selection = prepareStandardPlaylistSelection(TARGET);
    expect(getState('playlist.currentQueueItemId')).toBe(OLD);
    expect(getState('playback.activity')).toBe('playing');
    expect(stop).not.toHaveBeenCalled();
    pending.resolve(manifest);
    expect(await selection).toBe(true);
    expect(getState('youtube.subItemsMap').PL_FULL).toMatchObject({ ids, manifestComplete: true });
    expect(getState('playlist.currentQueueItemId')).toBe(OLD);
  });

  it('keeps the queue and old playback on failure and permits an explicit retry', async () => {
    const before = getState('playlist.items');
    vi.mocked(resolveYouTubePlaylistManifest).mockRejectedValueOnce(new Error('unavailable'));
    expect(await prepareStandardPlaylistSelection(TARGET)).toBe(false);
    expect(getState('playlist.items')).toBe(before);
    expect(getState('playlist.currentQueueItemId')).toBe(OLD);
    expect(getState('playback.activity')).toBe('playing');
    expect(getState('youtube.subItemsMap').PL_FULL.ids).toHaveLength(200);
    expect(showToast).toHaveBeenCalledWith('youtube.fetch_failed');
    vi.mocked(resolveYouTubePlaylistManifest).mockResolvedValueOnce(manifest);
    expect(await prepareStandardPlaylistSelection(TARGET)).toBe(true);
  });

  it.each(['room', 'selection', 'pause', 'stop', 'removed', 'superseded'] as const)(
    'aborts %s during acquisition and ignores an uncooperative late response',
    async (reason) => {
      const pending = pendingManifest();
      const selection = prepareStandardPlaylistSelection(TARGET);
      const signal = vi.mocked(resolveYouTubePlaylistManifest).mock.calls.at(-1)![1]!;
      if (reason === 'room') setState('network.sessionCode', '222222');
      if (reason === 'selection') setState('playlist.currentQueueItemId', TARGET);
      if (reason === 'pause') setState('playback.activity', 'paused');
      if (reason === 'stop') bus.emit('player:stop-all-media');
      if (reason === 'removed') setState('playlist.items', getState('playlist.items').slice(0, 1));
      if (reason === 'superseded') cancelStandardPlaylistSelection();
      expect(signal.aborted).toBe(true);
      expect(await selection).toBe(false);
      pending.resolve(manifest);
      await Promise.resolve();
      expect(getState('youtube.subItemsMap').PL_FULL.ids).toHaveLength(200);
      expect(showToast).not.toHaveBeenCalled();
      expect(showLoader).toHaveBeenLastCalledWith(false, undefined, expect.any(String));
    },
  );

  it('does not publish a result after a newer physical load epoch', async () => {
    const pending = pendingManifest();
    const selection = prepareStandardPlaylistSelection(TARGET);
    newLoadEpoch();
    pending.resolve(manifest);
    expect(await selection).toBe(false);
    expect(getState('youtube.subItemsMap').PL_FULL.ids).toHaveLength(200);
  });

  it('rechecks ownership after publishing the manifest before invoking the selection', async () => {
    vi.mocked(resolveYouTubePlaylistManifest).mockResolvedValueOnce(manifest);
    bus.on('state:youtube.subItemsMap', () => setState('playlist.currentQueueItemId', TARGET));
    const apply = vi.fn();
    expect(await prepareStandardPlaylistSelection(TARGET, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps selection failures distinct from manifest acquisition failures', async () => {
    vi.mocked(resolveYouTubePlaylistManifest).mockResolvedValueOnce(manifest);
    const failure = new Error('selection failed');
    await expect(
      prepareStandardPlaylistSelection(TARGET, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(showToast).not.toHaveBeenCalled();
  });
});
