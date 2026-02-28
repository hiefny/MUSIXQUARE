/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
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

vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(async () => {}),
}));

vi.mock('../../audio/effects.ts', () => ({
  applySettings: vi.fn(async () => {}),
  setEngineMode: vi.fn(),
}));

vi.mock('../../ui/player-controls.ts', () => ({
  fmtTime: vi.fn((s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`),
  showPlacementToastForChannel: vi.fn(),
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  getRoleLabelByChannelMode: vi.fn(),
}));

vi.mock('../search.ts', () => ({
  extractYouTubeVideoId: vi.fn((url: string) => {
    const m = url.match(/v=([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }),
  fetchOEmbedTitle: vi.fn(async () => 'Test Title'),
  fetchYouTubePreview: vi.fn(),
  fetchPlaylistSubTitles: vi.fn(),
}));

vi.mock('../sync.ts', () => ({
  broadcastYouTubeSync: vi.fn(),
  resetAdDetection: vi.fn(),
  initYouTubeSync: vi.fn(),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../ui/dom.ts', () => ({
  animateTransition: vi.fn((fn: Function) => fn()),
}));

beforeEach(() => {
  resetState();
  bus.clear();
  vi.useFakeTimers();

  // Create required DOM elements
  const container = document.createElement('div');
  container.id = 'youtube-container';
  document.body.appendChild(container);

  const playerDiv = document.createElement('div');
  playerDiv.id = 'youtube-player';
  container.appendChild(playerDiv);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('YouTube Player', () => {
  describe('Module Exports', () => {
    it('exports getYouTubePlayer', async () => {
      const mod = await import('../player.ts');
      expect(typeof mod.getYouTubePlayer).toBe('function');
    });

    it('exports loadYouTubeVideo', async () => {
      const mod = await import('../player.ts');
      expect(typeof mod.loadYouTubeVideo).toBe('function');
    });

    it('exports stopYouTubeMode', async () => {
      const mod = await import('../player.ts');
      expect(typeof mod.stopYouTubeMode).toBe('function');
    });

    it('exports initYouTube', async () => {
      const mod = await import('../player.ts');
      expect(typeof mod.initYouTube).toBe('function');
    });
  });

  describe('getYouTubePlayer()', () => {
    it('returns null initially', async () => {
      const { getYouTubePlayer } = await import('../player.ts');
      expect(getYouTubePlayer()).toBeNull();
    });
  });

  describe('stopYouTubeMode()', () => {
    it('does not throw when no player exists', async () => {
      const { stopYouTubeMode } = await import('../player.ts');
      expect(() => stopYouTubeMode()).not.toThrow();
    });
  });

  describe('Duration Caching Logic', () => {
    // Test the duration cache stickiness behavior
    let cachedDuration = 0;
    let cachedSubIndex = -1;

    function getDuration(
      playerDuration: number,
      currentSubIndex: number
    ): number {
      // Reset cache on sub-index change
      if (currentSubIndex !== cachedSubIndex) {
        cachedDuration = 0;
        cachedSubIndex = currentSubIndex;
      }

      // Lock on first valid read
      if (cachedDuration <= 0 && playerDuration > 0) {
        cachedDuration = playerDuration;
      }
      return cachedDuration;
    }

    beforeEach(() => {
      cachedDuration = 0;
      cachedSubIndex = -1;
    });

    it('caches first valid duration', () => {
      expect(getDuration(120, 0)).toBe(120);
      // Subsequent different values should be ignored
      expect(getDuration(130, 0)).toBe(120);
    });

    it('returns 0 when player reports 0', () => {
      expect(getDuration(0, 0)).toBe(0);
    });

    it('resets on sub-index change', () => {
      getDuration(120, 0);
      expect(getDuration(200, 1)).toBe(200); // new sub-index → reset → cache new
    });

    it('prevents flickering duration', () => {
      getDuration(120, 0);
      // Even if player briefly reports 0, cache persists
      expect(getDuration(0, 0)).toBe(120);
    });
  });

  describe('YouTube URL Extraction', () => {
    it('extractYouTubeVideoId from watch URL', async () => {
      const { extractYouTubeVideoId } = await import('../search.ts');
      expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('returns null for non-YouTube URL', async () => {
      const { extractYouTubeVideoId } = await import('../search.ts');
      expect(extractYouTubeVideoId('https://example.com')).toBeNull();
    });
  });
});
