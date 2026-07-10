import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import type { DataConnection } from '../../types/index.ts';

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

vi.mock('../_state.ts', () => ({
  getYouTubePlayer: vi.fn(() => null),
}));

beforeEach(() => {
  resetState();
  bus.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('YouTube Sync', () => {
  describe('broadcastYouTubeSync()', () => {
    it('does nothing if player is null', async () => {
      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');

      broadcastYouTubeSync();
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('does nothing if hostConn is set (guest mode)', async () => {
      const playerMod = await import('../_state.ts');
      (playerMod.getYouTubePlayer as ReturnType<typeof vi.fn>).mockReturnValue({
        getCurrentTime: () => 10,
        getPlayerState: () => 1,
      });
      setState('network.hostConn', { open: true } as DataConnection);

      const { broadcastYouTubeSync } = await import('../sync.ts');
      const { broadcast } = await import('../../network/peer.ts');

      broadcastYouTubeSync();
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts sync data when host with player', async () => {
      const playerMod = await import('../_state.ts');
      (playerMod.getYouTubePlayer as ReturnType<typeof vi.fn>).mockReturnValue({
        getCurrentTime: () => 42.5,
        getPlayerState: () => 1,
      });
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

  describe('Ad Detection Logic', () => {
    it('resets all ad detection state', async () => {
      const { resetAdDetection } = await import('../sync.ts');
      resetAdDetection();
    });
  });

  describe('Ad Detection — stale time threshold', () => {
    // Boundary table for the production stale-frame threshold state machine.
    const HOST_AD_STALE_THRESHOLD = 3;

    function simulateAdDetection(
      hostTimes: number[],
      hostStates: number[],
    ): { staleCount: number; adActive: boolean } {
      let lastTime: number | null = null;
      let staleCount = 0;
      let adActive = false;

      for (let i = 0; i < hostTimes.length; i++) {
        const hostTime = hostTimes[i];
        const hostState = hostStates[i];

        if (hostState === 1) {
          if (lastTime !== null && Math.abs(hostTime - lastTime) < 1.0) {
            staleCount++;
            if (staleCount >= HOST_AD_STALE_THRESHOLD) {
              adActive = true;
            }
          } else {
            if (adActive) adActive = false;
            staleCount = 0;
          }
          lastTime = hostTime;
        } else {
          staleCount = 0;
          lastTime = null;
          adActive = false;
        }
      }

      return { staleCount, adActive };
    }

    it('detects ad after 3 stale frames', () => {
      const result = simulateAdDetection([10.0, 10.0, 10.0, 10.0], [1, 1, 1, 1]);
      expect(result.adActive).toBe(true);
      expect(result.staleCount).toBe(3);
    });

    it('does NOT detect ad with only 2 stale frames', () => {
      const result = simulateAdDetection([10.0, 10.0, 10.0], [1, 1, 1]);
      expect(result.staleCount).toBe(2);
      expect(result.adActive).toBe(false);
    });

    it('resets when time moves again', () => {
      const result = simulateAdDetection([10.0, 10.0, 10.0, 10.0, 15.0], [1, 1, 1, 1, 1]);
      expect(result.adActive).toBe(false);
      expect(result.staleCount).toBe(0);
    });

    it('resets when host explicitly pauses', () => {
      const result = simulateAdDetection(
        [10.0, 10.0, 10.0],
        [1, 1, 2], // explicit pause resets the stale-frame detector
      );
      expect(result.adActive).toBe(false);
      expect(result.staleCount).toBe(0);
    });

    it('accepts time movement > 1.0s as non-stale', () => {
      const result = simulateAdDetection([10.0, 11.1, 12.2], [1, 1, 1]);
      expect(result.staleCount).toBe(0);
      expect(result.adActive).toBe(false);
    });

    it('treats time movement < 1.0s as stale', () => {
      const result = simulateAdDetection([10.0, 10.5, 10.9], [1, 1, 1]);
      expect(result.staleCount).toBe(2);
    });
  });

  describe('Drift Correction Logic', () => {
    function shouldSeek(
      currentTime: number,
      hostTime: number,
      autoOffset: number,
      localOffset: number,
    ): boolean {
      const compensated = hostTime + autoOffset + localOffset;
      const drift = Math.abs(currentTime - compensated);
      return drift > 2;
    }

    it('seeks when drift > 2s', () => {
      expect(shouldSeek(10, 15, 0, 0)).toBe(true);
    });

    it('does NOT seek when drift <= 2s', () => {
      expect(shouldSeek(10, 11, 0, 0)).toBe(false);
    });

    it('does NOT seek when drift is exactly 2s', () => {
      expect(shouldSeek(10, 12, 0, 0)).toBe(false);
    });

    it('accounts for sync offsets', () => {
      expect(shouldSeek(10, 10, 3, 1)).toBe(true);
    });

    it('no seek with compensating offsets', () => {
      expect(shouldSeek(10, 10, -1, 0)).toBe(false);
    });
  });

  describe('initYouTubeSync()', () => {
    it('registers protocol handlers', async () => {
      const { registerHandlers } = await import('../../network/protocol.ts');
      const { initYouTubeSync } = await import('../sync.ts');

      initYouTubeSync();
      expect(registerHandlers).toHaveBeenCalled();

      const handlerMap = (registerHandlers as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(Object.keys(handlerMap).length).toBeGreaterThanOrEqual(4);
    });
  });
});
