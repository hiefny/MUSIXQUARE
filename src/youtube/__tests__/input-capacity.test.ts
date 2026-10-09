/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import {
  commitPlaylistItems,
  getQueueItemById,
  MAX_QUEUE_ITEMS,
  moveQueueItemBefore,
} from '../../player/queue-model.ts';
import { initYouTube } from '../player.ts';
import { showToast } from '../../ui/toast.ts';
import { log } from '../../core/log.ts';
import { searchYouTubeFromInput, getSelectedYouTubeSearchResult } from '../search.ts';
import { fetchOEmbedTitle } from '../oembed.ts';
import type { PlaylistItem } from '../../types/index.ts';
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
  getManagedTimer: vi.fn(() => null),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn(),
  verifyOperator: vi.fn(() => true),
}));
vi.mock('../../audio/engine.ts', () => ({ initAudio: vi.fn(async () => {}) }));
vi.mock('../../audio/effects.ts', () => ({
  applySettings: vi.fn(async () => {}),
  setEngineMode: vi.fn(),
}));
vi.mock('../../ui/player-controls.ts', () => ({
  fmtTime: vi.fn(),
  showPlacementToastForChannel: vi.fn(),
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  getRoleLabelByChannelMode: vi.fn(),
}));
vi.mock('../sync.ts', () => ({
  broadcastYouTubeSync: vi.fn(),
  cancelGuestRendezvous: vi.fn(),
  invalidateGuestYouTubeTimeline: vi.fn(),
  guestRendezvousSync: vi.fn(() => ({ status: 'not-ready' })),
  isGuestYouTubeTransitionPending: vi.fn(() => false),
  resetAdDetection: vi.fn(),
  initYouTubeSync: vi.fn(),
  resetYouTubeSyncState: vi.fn(),
  suppressDriftUntil: vi.fn(),
}));
vi.mock('../oembed.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchOEmbedTitle: vi.fn(async () => null),
}));
vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));
vi.mock('../../ui/dom.ts', () => ({ animateTransition: vi.fn((fn: () => unknown) => fn()) }));
vi.mock('../../i18n/index.ts', () => ({ t: vi.fn((key: string) => key) }));
function row(index: number): PlaylistItem {
  return {
    queueItemId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    type: 'youtube',
    name: `Existing ${index}`,
    videoId: 'AAAAAAAAAAA',
    playlistId: null,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  bus.clear();
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', true);
  setState('network.sessionCode', '161616');
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(16);
    return 1;
  });
  document.body.innerHTML =
    '<div id="youtube-url-overlay" class="active"><div id="youtube-url-input">https://www.youtube.com/watch?v=aB3dE5gH7_j</div><div id="youtube-preview-title">R16 video</div><div id="youtube-preview-status"></div><button id="youtube-play-btn"></button></div>';
  initYouTube();
});
afterEach(() => {
  document.body.innerHTML = '';
  bus.clear();
  vi.unstubAllGlobals();
});
async function prepareInput(mode: string): Promise<void> {
  if (mode === 'search-query') {
    document.getElementById('youtube-url-input')!.textContent = 'round16 capacity search';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/security-config')
          return Response.json({ capabilityRequired: false });
        if (url.pathname === '/api/youtube-search')
          return Response.json({
            results: [
              { videoId: 'aB3dE5gH7_j', title: 'R16 search video', channelTitle: 'Fixture' },
            ],
          });
        throw new Error(`Unexpected fixture request ${url.pathname}`);
      }),
    );
    const results = document.createElement('div');
    results.id = 'youtube-search-results';
    document.body.appendChild(results);
    await searchYouTubeFromInput('round16 capacity search');
    expect(getSelectedYouTubeSearchResult('round16 capacity search')?.videoId).toBe('aB3dE5gH7_j');
  }
}
describe('H3 YouTube host queue capacity must reject visibly', () => {
  it.each(['video-url', 'search-query'])(
    'positive control %s: the last permitted YouTube row is appended once',
    async (mode) => {
      commitPlaylistItems(Array.from({ length: MAX_QUEUE_ITEMS - 1 }, (_, i) => row(i)));
      await prepareInput(mode);
      bus.emit('youtube:load-from-input');
      await Promise.resolve();
      expect(getState('playlist.items')).toHaveLength(MAX_QUEUE_ITEMS);
      expect(getState('playlist.items').at(-1)?.videoId).toBe('aB3dE5gH7_j');
      expect(log.error).not.toHaveBeenCalled();
    },
  );
  it.each(['video-url', 'search-query'])(
    '%s: a full queue reports queue_full before consuming the input',
    async (mode) => {
      const original = Array.from({ length: MAX_QUEUE_ITEMS }, (_, i) => row(i));
      commitPlaylistItems(original);
      const revision = getState('playlist.revision');
      await prepareInput(mode);
      const submittedText = document.getElementById('youtube-url-input')!.textContent;
      bus.emit('youtube:load-from-input');
      await Promise.resolve();
      expect(getState('playlist.items')).toEqual(original);
      expect(getState('playlist.revision')).toBe(revision);
      expect.soft(showToast).toHaveBeenCalledWith('playlist.queue_full');
      expect
        .soft(document.getElementById('youtube-url-overlay')!.classList.contains('active'))
        .toBe(true);
      expect.soft(document.getElementById('youtube-url-input')!.textContent).toBe(submittedText);
      expect(log.error).not.toHaveBeenCalled();
    },
  );
});
describe('H4 identical YouTube content keeps distinct queue occurrence ownership', () => {
  it('reorder and removal preserve the selected occurrence and exact row objects', () => {
    const a = row(1),
      b = row(2),
      c = row(3);
    commitPlaylistItems([a, b, c], { currentQueueItemId: b.queueItemId });
    const moved = moveQueueItemBefore(c.queueItemId, a.queueItemId)!;
    commitPlaylistItems(moved);
    expect(getState('playlist.items')).toEqual([c, a, b]);
    expect(getState('playlist.items')[2]).toBe(b);
    expect(getState('playlist.currentQueueItemId')).toBe(b.queueItemId);
    commitPlaylistItems(moved.filter((item) => item.queueItemId !== a.queueItemId));
    expect(getState('playlist.items')).toEqual([c, b]);
    expect(getState('playlist.currentQueueItemId')).toBe(b.queueItemId);
  });
  it.each(['reordered', 'removed'])(
    'late title refresh follows stable ID when the added duplicate is %s',
    async (ending) => {
      const a = { ...row(1), videoId: 'aB3dE5gH7_j' },
        b = { ...row(2), videoId: 'aB3dE5gH7_j' };
      commitPlaylistItems([a, b], { currentQueueItemId: a.queueItemId });
      let resolveTitle!: (title: string | null) => void;
      vi.mocked(fetchOEmbedTitle).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveTitle = resolve;
        }),
      );
      bus.emit('youtube:load-from-input');
      const added = getState('playlist.items').at(-1)!;
      expect(getState('playlist.items')).toHaveLength(3);
      expect(added.queueItemId).not.toBe(a.queueItemId);
      if (ending === 'reordered')
        commitPlaylistItems(moveQueueItemBefore(added.queueItemId, a.queueItemId)!);
      else
        commitPlaylistItems(
          getState('playlist.items').filter((item) => item.queueItemId !== added.queueItemId),
        );
      const revision = getState('playlist.revision');
      resolveTitle('Resolved late duplicate title');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(getQueueItemById(a.queueItemId)?.name).toBe(a.name);
      expect(getQueueItemById(b.queueItemId)?.name).toBe(b.name);
      expect(getState('playlist.currentQueueItemId')).toBe(a.queueItemId);
      if (ending === 'reordered') {
        expect(getState('playlist.items')[0]?.queueItemId).toBe(added.queueItemId);
        expect(getQueueItemById(added.queueItemId)?.name).toBe('Resolved late duplicate title');
        expect(getState('playlist.revision')).toBe(revision + 1);
      } else {
        expect(getQueueItemById(added.queueItemId)).toBeNull();
        expect(getState('playlist.items')).toHaveLength(2);
        expect(getState('playlist.revision')).toBe(revision);
      }
    },
  );
});
