/**
 * E2E: Mobile background resume behavior.
 *
 * Uses a real decoded file and AudioContext. Unit tests deterministically pin
 * WebKit's frozen-clock detector; this browser test owns the surrounding app
 * wiring: healthy automatic rejoin and the trusted-gesture recovery dialog.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import {
  clickPlayButton,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
} from './helpers/wait.ts';

interface ResumeSignals {
  rejoinReasons: string[];
  refreshCurrentPosition: number;
  forceResync: number;
  sourceCreations: number;
}

async function createMobileResumePage(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  await injectPeerServer(page);
  return { context, page };
}

async function installResumeSignalProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const bus = w.__MUSIXQUARE_BUS__ as
      | {
          on: (type: string, callback: (payload?: unknown) => void) => void;
        }
      | undefined;
    if (!bus) throw new Error('E2E bus hook unavailable');

    const signals: ResumeSignals = {
      rejoinReasons: [],
      refreshCurrentPosition: 0,
      forceResync: 0,
      sourceCreations: 0,
    };
    w.__backgroundResumeSignals = signals;
    bus.on('playback:local-output-rejoin', (payload) => {
      const reason = (payload as { reason?: unknown } | undefined)?.reason;
      if (typeof reason === 'string') signals.rejoinReasons.push(reason);
    });
    bus.on('playback:refresh-current-position', () => {
      signals.refreshCurrentPosition += 1;
    });
    bus.on('sync:force-resync', () => {
      signals.forceResync += 1;
    });

    // Install after initial playback is established. Any subsequent source
    // creation therefore proves that foreground recovery rebuilt the audible
    // source instead of preserving continuity.
    const originalCreateBufferSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function (this: AudioContext) {
      signals.sourceCreations += 1;
      return originalCreateBufferSource.call(this);
    };
  });
}

async function simulateBackgroundBounce(page: Page, hiddenMs: number): Promise<void> {
  await page.evaluate(async (elapsed) => {
    const setVisibility = (value: DocumentVisibilityState): void => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => value,
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => value === 'hidden',
      });
    };

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise<void>((resolve) => window.setTimeout(resolve, elapsed));
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
  }, hiddenMs);
}

async function readFileIdentity(page: Page): Promise<{
  queueItemId: string | null;
  residentQueueItemId: string | null;
}> {
  return page.evaluate(() => {
    const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
      | ((path: string) => unknown)
      | undefined;
    if (!get) throw new Error('E2E state hook unavailable');
    const resident = get('files.current') as { queueItemId?: unknown } | null;
    const queueItemId = get('playlist.currentQueueItemId');
    return {
      queueItemId: typeof queueItemId === 'string' ? queueItemId : null,
      residentQueueItemId: typeof resident?.queueItemId === 'string' ? resident.queueItemId : null,
    };
  });
}

async function emitDetectedClockStall(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const get = w.__MUSIXQUARE_GET_STATE__ as ((path: string) => unknown) | undefined;
    const bus = w.__MUSIXQUARE_BUS__ as
      | { emit: (type: string, payload: unknown) => void }
      | undefined;
    if (!get || !bus) throw new Error('E2E app hooks unavailable');
    bus.emit('audio:output-recovery-needed', {
      reason: 'clock-stalled',
      source: 'background-resume',
      queueItemId: get('playlist.currentQueueItemId'),
    });
  });
}

test.describe('Mobile Background Resume', () => {
  test('keeps the room connected while healthy and gesture-assisted file output recover', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context, page } = await createMobileResumePage(browser);

    try {
      await setupHostAndStart(page);
      await uploadFixture(page, 'test01');
      await waitForFilePlaybackReady(page, 20_000);
      await clickPlayButton(page);
      await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 15_000);

      const identityBefore = await readFileIdentity(page);
      expect(identityBefore.queueItemId).not.toBeNull();
      expect(identityBefore.residentQueueItemId).toBe(identityBefore.queueItemId);

      await installResumeSignalProbe(page);
      await simulateBackgroundBounce(page, 2_000);
      await page.waitForTimeout(1_000);

      const healthySignals = await page.evaluate(() => {
        return (window as unknown as Record<string, unknown>)
          .__backgroundResumeSignals as ResumeSignals;
      });
      expect(healthySignals.rejoinReasons).toEqual([]);
      expect(healthySignals.refreshCurrentPosition).toBe(0);
      expect(healthySignals.forceResync).toBe(0);
      expect(healthySignals.sourceCreations).toBe(0);
      await expect(page.locator('#dialog-overlay.show')).toHaveCount(0);

      await emitDetectedClockStall(page);
      await expect(page.locator('#dialog-overlay.show')).toBeVisible();
      await expect(page.locator('#dialog-title')).toHaveText('Audio paused unexpectedly');
      await expect(page.locator('#btn-dialog-ok')).toHaveText('Restore audio');
      await page.locator('#btn-dialog-ok').click();

      await page.waitForFunction(
        () => {
          const signals = (window as unknown as Record<string, unknown>)
            .__backgroundResumeSignals as ResumeSignals | undefined;
          return signals?.rejoinReasons.includes('audio-recovery-gesture') === true;
        },
        undefined,
        { timeout: 10_000 },
      );
      await page.waitForFunction(
        () => {
          const signals = (window as unknown as Record<string, unknown>)
            .__backgroundResumeSignals as ResumeSignals | undefined;
          return signals?.refreshCurrentPosition === 1 && signals.sourceCreations === 1;
        },
        undefined,
        { timeout: 10_000 },
      );

      const signals = await page.evaluate(() => {
        return (window as unknown as Record<string, unknown>)
          .__backgroundResumeSignals as ResumeSignals;
      });
      expect(signals.rejoinReasons.filter((reason) => reason === 'background-resume')).toHaveLength(
        0,
      );
      expect(
        signals.rejoinReasons.filter((reason) => reason === 'audio-recovery-gesture'),
      ).toHaveLength(1);
      expect(signals.refreshCurrentPosition).toBe(1);
      expect(signals.forceResync).toBe(0);
      expect(signals.sourceCreations).toBe(1);

      await expect(page.locator('#dialog-overlay.show')).toHaveCount(0);
      await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 10_000);
      expect(await readFileIdentity(page)).toEqual(identityBefore);
    } finally {
      await context.close().catch(() => {});
    }
  });
});
