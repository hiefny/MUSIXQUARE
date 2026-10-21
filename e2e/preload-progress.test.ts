import { expect, test, type Page } from '@playwright/test';
import { CHUNK_SIZE } from '../src/core/constants.ts';
import {
  cleanupContexts,
  createHostGuestContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { waitForFilePlaybackReady, waitForState } from './helpers/wait.ts';

const CURRENT = '10000000-0000-4000-8000-000000000001';
const NEXT = '10000000-0000-4000-8000-000000000002';
const SESSION_ID = 73;
const TOTAL_CHUNKS = 50;
const FILE_NAME = 'partial-preload.wav';

type TestHooks = {
  __MUSIXQUARE_GET_STATE__?: (path: string) => unknown;
  __MUSIXQUARE_SET_STATE__?: (path: string, value: unknown) => void;
  __MUSIXQUARE_BUS__?: { emit: (type: string, ...args: unknown[]) => void };
};

async function sendChunkRange(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(
    ({ start, end, chunkSize, total, queueItemId, sessionId }) => {
      const hooks = window as unknown as TestHooks;
      const hostConn = hooks.__MUSIXQUARE_GET_STATE__?.('network.hostConn');
      const bus = hooks.__MUSIXQUARE_BUS__;
      if (!hostConn || !bus) throw new Error('Connected guest protocol hooks unavailable');

      for (let chunkIndex = start; chunkIndex < end; chunkIndex += 1) {
        const chunk = new Uint8Array(chunkSize);
        if (chunkIndex === 0) {
          // A complete, silent PCM WAV keeps the real RAM finalization and
          // native decode path in this regression. Only frame delivery is
          // controlled; no progress or loader implementation is substituted.
          const view = new DataView(chunk.buffer);
          const text = (offset: number, value: string): void => {
            for (let i = 0; i < value.length; i += 1) {
              view.setUint8(offset + i, value.charCodeAt(i));
            }
          };
          text(0, 'RIFF');
          view.setUint32(4, total * chunkSize - 8, true);
          text(8, 'WAVE');
          text(12, 'fmt ');
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, 48_000, true);
          view.setUint32(28, 96_000, true);
          view.setUint16(32, 2, true);
          view.setUint16(34, 16, true);
          text(36, 'data');
          view.setUint32(40, total * chunkSize - 44, true);
        }
        bus.emit(
          'network:data',
          { type: 'preload-chunk', queueItemId, sessionId, chunkIndex, chunk },
          hostConn,
        );
      }
    },
    {
      start,
      end,
      chunkSize: CHUNK_SIZE,
      total: TOTAL_CHUNKS,
      queueItemId: NEXT,
      sessionId: SESSION_ID,
    },
  );
  await expect
    .poll(() =>
      page.evaluate((sessionId) => {
        const get = (window as unknown as TestHooks).__MUSIXQUARE_GET_STATE__;
        const sessions = get?.('preload.sessionState') as
          Map<number, { progress: number }> | undefined;
        return sessions?.get(sessionId)?.progress;
      }, SESSION_ID),
    )
    .toBe(end);
}

async function headerPercent(page: Page): Promise<number> {
  return page.locator('#header-progress-bg').evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).a * 100;
  });
}

test('keeps promoted preload progress and waiting animation until the file is ready', async ({
  browser,
}, testInfo) => {
  const pair: HostGuestPair = await createHostGuestContexts(browser);
  try {
    await Promise.all(
      [pair.hostPage, pair.guestPage].map(async (page) => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.addInitScript(() => localStorage.setItem('musixquare-lang', 'en'));
      }),
    );
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    const page = pair.guestPage;
    await page.evaluate(
      ({ current, next, sessionId, total, chunkSize, name }) => {
        const hooks = window as unknown as TestHooks;
        const set = hooks.__MUSIXQUARE_SET_STATE__;
        const hostConn = hooks.__MUSIXQUARE_GET_STATE__?.('network.hostConn');
        const bus = hooks.__MUSIXQUARE_BUS__;
        if (!set || !hostConn || !bus) throw new Error('Connected guest hooks unavailable');
        set('network.connectionType', 'local');
        set('playlist.items', [
          {
            queueItemId: current,
            type: 'file',
            name: 'current.wav',
            videoId: null,
            playlistId: null,
          },
          { queueItemId: next, type: 'file', name, videoId: null, playlistId: null },
        ]);
        set('playlist.currentQueueItemId', current);
        bus.emit(
          'network:data',
          {
            type: 'preload-start',
            queueItemId: next,
            sessionId,
            name,
            mime: 'audio/wav',
            total,
            size: total * chunkSize,
          },
          hostConn,
        );
      },
      {
        current: CURRENT,
        next: NEXT,
        sessionId: SESSION_ID,
        total: TOTAL_CHUNKS,
        chunkSize: CHUNK_SIZE,
        name: FILE_NAME,
      },
    );
    await sendChunkRange(page, 0, 42);
    const text = page.locator('#header-loading-text');
    await expect(text).toContainText('84%');
    await expect.poll(() => headerPercent(page)).toBeGreaterThan(83.5);

    await page.evaluate(
      ({ queueItemId, name }) => {
        const hooks = window as unknown as TestHooks;
        hooks.__MUSIXQUARE_BUS__?.emit(
          'network:data',
          { type: 'play-preloaded', queueItemId, name },
          hooks.__MUSIXQUARE_GET_STATE__?.('network.hostConn'),
        );
      },
      { queueItemId: NEXT, name: FILE_NAME },
    );
    await waitForState(page, 'playback.lifecycle', 'AWAITING_PRELOAD');
    await expect(text).toHaveText('Finishing download... 84%');
    await expect.poll(() => headerPercent(page)).toBeGreaterThan(83.5);
    await expect(page.locator('#play-btn')).toHaveAttribute('aria-busy', 'true');

    const spinner = page.locator('#play-btn .play-loading-spinner > svg');
    await expect(spinner).toBeVisible();
    const animation = await spinner.evaluate((element) => {
      const spin = element
        .getAnimations()
        .find(
          (entry) =>
            entry instanceof CSSAnimation && entry.animationName === 'material-elastic-spin',
        );
      if (!spin) throw new Error('Waiting spinner has no rotation animation');
      return { time: Number(spin.currentTime), playState: spin.playState };
    });
    expect(animation.playState).toBe('running');
    await expect
      .poll(() =>
        spinner.evaluate((element) => {
          const spin = element
            .getAnimations()
            .find(
              (entry) =>
                entry instanceof CSSAnimation && entry.animationName === 'material-elastic-spin',
            );
          return Number(spin?.currentTime ?? -1);
        }),
      )
      .toBeGreaterThan(animation.time + 150);
    await expect(text).toHaveText('Finishing download... 84%');

    await sendChunkRange(page, 42, 45);
    await expect(text).toHaveText('Finishing download... 90%');
    await expect.poll(() => headerPercent(page)).toBeGreaterThan(89.5);
    expect(await headerPercent(page)).toBeLessThanOrEqual(90.05);
    await expect(page.locator('#play-btn')).toHaveAttribute('aria-busy', 'true');
    await page.screenshot({ path: testInfo.outputPath('promoted-preload-90-percent.png') });

    await sendChunkRange(page, 45, TOTAL_CHUNKS);
    await waitForFilePlaybackReady(page);
    await expect(page.locator('#main-header')).not.toHaveClass(/\bloading\b/);
    await expect(page.locator('#play-btn')).toHaveAttribute('aria-busy', 'false');
  } finally {
    await cleanupContexts(pair);
  }
});
