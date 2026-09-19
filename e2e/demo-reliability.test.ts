import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { cleanupContexts, createHostGuestContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest, setupGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import { readState } from './helpers/wait.ts';
import { injectPeerServer } from './helpers/peer-server.ts';

const DEMO_URL = 'https://demo.musixquare.com/linelight/*.m4a';
const AUDIO = fileURLToPath(new URL('./fixtures/demo-track.mp3', import.meta.url));

async function prepare(page: Page): Promise<void> {
  await injectPeerServer(page);
  await page.addInitScript(() => {
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {};
    (window as unknown as Record<string, unknown>).__demoNativeActions = actions;
    const original = navigator.mediaSession.setActionHandler;
    navigator.mediaSession.setActionHandler = function (action, handler) {
      if (handler) actions[action] = handler;
      else delete actions[action];
      return original.call(this, action, handler);
    };
  });
}

async function emit(page: Page, event: string): Promise<void> {
  await page.evaluate((event) => {
    const bus = (window as unknown as Record<string, { emit: (event: string) => void }>)
      .__MUSIXQUARE_BUS__;
    bus.emit(event);
  }, event);
}

async function nativeAction(page: Page, action: 'play' | 'pause'): Promise<void> {
  await page.evaluate((action) => {
    const actions = (
      window as unknown as {
        __demoNativeActions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>>;
      }
    ).__demoNativeActions;
    const handler = actions[action];
    if (!handler) throw new Error(`Missing native ${action} handler`);
    handler({ action });
  }, action);
}

async function activity(page: Page, expected: string): Promise<void> {
  await expect.poll(() => readState(page, 'playback.activity')).toBe(expected);
}

test('demo native pause and resume retain host authority and restore guest sync', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  try {
    for (const page of [pair.hostPage, pair.guestPage]) {
      await prepare(page);
      await page.route(DEMO_URL, (route) =>
        route.fulfill({ path: AUDIO, contentType: 'audio/mpeg' }),
      );
    }
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await emit(pair.hostPage, 'demo:enter');
    await activity(pair.hostPage, 'playing');
    await activity(pair.guestPage, 'playing');
    expect(await readState(pair.guestPage, 'playlist.currentQueueItemId')).toBeNull();

    await nativeAction(pair.guestPage, 'pause');
    await activity(pair.guestPage, 'paused');
    await activity(pair.hostPage, 'playing');
    await nativeAction(pair.guestPage, 'play');
    await activity(pair.guestPage, 'playing');

    await nativeAction(pair.guestPage, 'pause');
    await activity(pair.guestPage, 'paused');
    await nativeAction(pair.hostPage, 'pause');
    await activity(pair.hostPage, 'paused');
    await pair.guestPage.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const decisions: string[] = [];
      w.__demoSyncDecisions = decisions;
      const bus = w.__MUSIXQUARE_BUS__ as {
        on: (
          event: string,
          listener: (data: { decision: string; reason?: string }) => void,
        ) => void;
      };
      bus.on('sync:diagnostic-standard-decision', (data) =>
        decisions.push(data.reason || data.decision),
      );
    });
    await nativeAction(pair.hostPage, 'play');
    await activity(pair.hostPage, 'playing');
    await activity(pair.guestPage, 'playing');
    await expect
      .poll(() =>
        pair.guestPage.evaluate(() => {
          const decisions = (window as unknown as { __demoSyncDecisions: string[] })
            .__demoSyncDecisions;
          return decisions.some((value) =>
            ['initial', 'observe', 'hard', 'bootstrap'].includes(value),
          );
        }),
      )
      .toBe(true);
    await emit(pair.hostPage, 'demo:request-exit');
    await expect.poll(() => readState(pair.guestPage, 'demo.active')).toBe(false);
  } finally {
    await cleanupContexts(pair);
  }
});

test('a failed superseded guest download cannot discard the latest demo track', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  let release!: () => void;
  const obsolete = new Promise<void>((resolve) => {
    release = resolve;
  });
  let oldRequestPending = false;
  try {
    await Promise.all([prepare(pair.hostPage), prepare(pair.guestPage)]);
    await pair.hostPage.route(DEMO_URL, (route) =>
      route.fulfill({ path: AUDIO, contentType: 'audio/mpeg' }),
    );
    await pair.guestPage.route(DEMO_URL, async (route) => {
      if (route.request().url().includes('/01-adventure')) {
        oldRequestPending = true;
        await obsolete;
        await route.fulfill({ status: 503, body: 'temporary failure' });
        return;
      }
      await route.fulfill({ path: AUDIO, contentType: 'audio/mpeg' });
    });
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await pair.guestPage.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const get = w.__MUSIXQUARE_GET_STATE__ as (path: string) => unknown;
      const host = get('network.hostConn') as {
        on: (event: string, listener: (data: { type: string; index?: number }) => void) => void;
      };
      host.on('data', (data) => {
        if (data.type === 'demo-play') w.__latestDemoPlayIndex = data.index;
      });
    });
    await emit(pair.hostPage, 'demo:enter');
    await activity(pair.hostPage, 'playing');
    await expect.poll(() => oldRequestPending).toBe(true);
    await emit(pair.hostPage, 'player:ended');
    await expect.poll(() => readState(pair.hostPage, 'demo.currentTrackIndex')).toBe(1);
    await activity(pair.hostPage, 'playing');
    await expect
      .poll(() =>
        pair.guestPage.evaluate(
          () => (window as unknown as Record<string, unknown>).__latestDemoPlayIndex,
        ),
      )
      .toBe(1);
    release();
    await expect.poll(() => readState(pair.guestPage, 'demo.currentTrackIndex')).toBe(1);
    await activity(pair.guestPage, 'playing');
    expect(await readState(pair.guestPage, 'demo.active')).toBe(true);
  } finally {
    release();
    await cleanupContexts(pair);
  }
});

test('a paused demo late join retains the authoritative position after native decode', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  try {
    await Promise.all([prepare(pair.hostPage), prepare(pair.guestPage)]);
    await pair.hostPage.route(DEMO_URL, (route) =>
      route.fulfill({ path: AUDIO, contentType: 'audio/mpeg' }),
    );
    await pair.guestPage.route(DEMO_URL, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.fulfill({ path: AUDIO, contentType: 'audio/mpeg' });
    });
    const code = await setupHostAndStart(pair.hostPage);
    await emit(pair.hostPage, 'demo:enter');
    await activity(pair.hostPage, 'playing');
    await pair.hostPage.waitForTimeout(800);
    await nativeAction(pair.hostPage, 'pause');
    await activity(pair.hostPage, 'paused');
    const pausedAt = Number(await readState(pair.hostPage, 'player.pausedAt'));
    expect(pausedAt).toBeGreaterThan(0.5);
    await setupGuest(pair.guestPage, code);
    await expect.poll(() => readState(pair.guestPage, 'demo.active')).toBe(true);
    await expect.poll(() => readState(pair.guestPage, 'demo.loading')).toBe(false);
    await expect.poll(() => readState(pair.guestPage, 'player.pausedAt')).toBeCloseTo(pausedAt, 2);
    expect(await readState(pair.guestPage, 'playback.activity')).not.toBe('playing');
  } finally {
    await cleanupContexts(pair);
  }
});

test('retry replaces a demo preload rejected by the native audio decoder', async ({ page }) => {
  await prepare(page);
  let secondTrackRequests = 0;
  await page.route(DEMO_URL, async (route) => {
    if (route.request().url().includes('/02-lockstep-lunge')) {
      secondTrackRequests += 1;
      if (secondTrackRequests === 1) {
        await route.fulfill({ body: 'invalid audio bytes', contentType: 'audio/mp4' });
        return;
      }
    }
    await route.fulfill({ path: AUDIO, contentType: 'audio/mpeg' });
  });
  await setupHostAndStart(page);
  await emit(page, 'demo:enter');
  await activity(page, 'playing');
  await expect.poll(() => secondTrackRequests).toBe(1);
  await emit(page, 'player:ended');
  await expect.poll(() => readState(page, 'demo.currentTrackIndex')).toBe(1);
  await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
  expect(await readState(page, 'playback.activity')).not.toBe('playing');
  await page.locator('#btn-demo-settings').click();
  await expect(page.locator('#manual-sync-overlay')).toHaveClass(/show/);
  await page.locator('[data-demo-play]').click();
  await expect.poll(() => secondTrackRequests).toBe(2);
  await activity(page, 'playing');
});
