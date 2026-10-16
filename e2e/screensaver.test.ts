import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import {
  cleanupContexts,
  createHostGuestContexts,
  useAnonymousAccountSession,
} from './helpers/context-factory.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { connectHostAndGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import {
  installSyntheticSystemAudio,
  readSyntheticSystemAudio,
} from './helpers/system-audio-source.ts';
import {
  clickPlayButton,
  openChatDrawer,
  readState,
  sendChat,
  waitForFilePlaybackReady,
  waitForState,
} from './helpers/wait.ts';

test.use({ viewport: { width: 1280, height: 720 }, locale: 'en-US', serviceWorkers: 'block' });

type ScreensaverTestWindow = Window & {
  __MUSIXQUARE_SET_STATE__(path: string, value: unknown): void;
};
const pageErrors = new WeakMap<Page, string[]>();
const consoleMessages = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }, testInfo) => {
  const messages = consoleMessages.get(page) || [];
  if (messages.length)
    await testInfo.attach('browser-console', {
      body: messages.join('\n'),
      contentType: 'text/plain',
    });
  expect(pageErrors.get(page) || []).toEqual([]);
});

async function preparePage(page: Page): Promise<string[]> {
  const requests: string[] = [];
  const errors: string[] = [];
  const messages: string[] = [];
  pageErrors.set(page, errors);
  consoleMessages.set(page, messages);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('request', (request) => {
    if (
      /screensaver|fonts\.googleapis\.com|fonts\.gstatic\.com|open-meteo\.com/u.test(request.url())
    ) {
      requests.push(request.url());
    }
  });
  // Functional browser checks do not rely on external font/weather services.
  // The real Google Sans and live provider rendering remain separate visual QA.
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route('https://*.open-meteo.com/**', (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem('musixquare-lang', 'en'));
  await useAnonymousAccountSession(page);
  return requests;
}

async function openHost(page: Page): Promise<string[]> {
  const requests = await preparePage(page);
  await injectPeerServer(page);
  await setupHostAndStart(page);
  return requests;
}

async function openScreensaver(page: Page, command = '/screensaver'): Promise<FrameLocator> {
  await openChatDrawer(page);
  await sendChat(page, command);
  await expect(page.locator('#screensaver-overlay iframe')).toHaveCount(1);
  const child = page.frameLocator('#screensaver-overlay iframe');
  await expect(child.locator('#displayBack')).toHaveAttribute('aria-label', 'Back to MUSIXQUARE');
  await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', /^(clock|music)$/iu);
  return child;
}

async function seedMusic(page: Page, title: string): Promise<void> {
  // Exercise the parent state/DOM bridge without decoding a second large file.
  await page.evaluate((title) => {
    const runtime = window as unknown as ScreensaverTestWindow;
    runtime.__MUSIXQUARE_SET_STATE__('playback.mode', 'file');
    runtime.__MUSIXQUARE_SET_STATE__('player.currentTrackMeta', {
      type: 'file',
      name: 'screensaver-fixture.mp3',
      title,
      size: 1024,
    });
    const subtitle = document.getElementById('track-artist');
    if (subtitle) subtitle.textContent = 'MP3 · 320 kbps';
  }, title);
}

test('loads only on the local command and keeps connected file playback running', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  const { hostPage: host, guestPage: guest } = pair;
  try {
    const [hostRequests, guestRequests] = await Promise.all([
      preparePage(host),
      preparePage(guest),
    ]);
    await connectHostAndGuest(host, guest);
    await uploadFixture(host, 'test01');
    await Promise.all([waitForFilePlaybackReady(host), waitForFilePlaybackReady(guest)]);
    if ((await readState(host, 'playback.activity')) !== 'playing') await clickPlayButton(host);
    await waitForState(host, 'playback.activity', 'playing');
    await waitForState(guest, 'playback.activity', 'playing');
    expect(hostRequests).toEqual([]);
    expect(guestRequests).toEqual([]);

    const currentTrack = await readState(host, 'player.currentTrackMeta');
    const child = await openScreensaver(host);
    await expect(child.locator('#musicTitle')).toHaveText('test-01');
    await expect(guest.locator('#screensaver-overlay')).toHaveCount(0);
    await expect(guest.locator('#chat-messages')).not.toContainText('/screensaver');
    expect(guestRequests).toEqual([]);
    expect(
      hostRequests.some((url) =>
        /^\/assets\/screensaver-runtime-[a-f0-9]{8}\.js$/u.test(new URL(url).pathname),
      ),
    ).toBe(true);
    expect(hostRequests.some((url) => new URL(url).pathname === '/screensaver.js')).toBe(false);
    expect(hostRequests.some((url) => url.includes('open-meteo.com'))).toBe(false);
    expect(await readState(host, 'playback.activity')).toBe('playing');
    expect(await readState(guest, 'playback.activity')).toBe('playing');
    expect(await readState(host, 'player.currentTrackMeta')).toEqual(currentTrack);

    await host.keyboard.press('Escape');
    await expect(host.locator('#screensaver-overlay')).toHaveCount(0);
    await expect
      .poll(() => host.evaluate(() => document.activeElement?.id))
      .toMatch(/^(chat-input|btn-chat-send)$/u);
    expect(
      host.frames().some((frame) => new URL(frame.url()).pathname === '/screensaver.html'),
    ).toBe(false);
    expect(await readState(host, 'playback.activity')).toBe('playing');
  } finally {
    await cleanupContexts(pair);
  }
});

test('allows system audio, then closes and blocks both commands when YouTube is selected', async ({
  page,
}) => {
  await installSyntheticSystemAudio(page);
  const requests = await openHost(page);
  await page.locator('#btn-media-source').click();
  await page.locator('#btn-system-audio').click();
  await waitForState(page, 'playback.mode', 'system-audio');
  const child = await openScreensaver(page);
  await expect(child.locator('#musicTitle')).toHaveText('System audio');
  expect((await readSyntheticSystemAudio(page)).activeCaptures).toBe(1);

  // This checks the production state-event guard, not a live YouTube provider.
  await page.evaluate(() =>
    (window as unknown as ScreensaverTestWindow).__MUSIXQUARE_SET_STATE__(
      'playback.mode',
      'youtube',
    ),
  );
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText(
    'Screensaver is unavailable during YouTube playback',
  );
  const loaded = requests.filter((url) => new URL(url).pathname === '/screensaver.html').length;
  for (const command of ['/screensaver', '/스크린세이버']) {
    await sendChat(page, command);
    await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
    await expect(page.locator('#toast')).toContainText(
      'Screensaver is unavailable during YouTube playback',
    );
  }
  expect(requests.filter((url) => new URL(url).pathname === '/screensaver.html')).toHaveLength(
    loaded,
  );
});

test('shows music before the clock, hides idle chrome, and restores persisted music preferences', async ({
  page,
}) => {
  await openHost(page);
  const title =
    'A very long music title that scrolls across the screensaver without truncating its contents';
  await seedMusic(page, title);
  await page.clock.install();
  let child = await openScreensaver(page);
  await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', 'music');
  await expect(child.locator('#musicTitle')).toHaveText(title);
  await expect(child.locator('#musicSubtitle')).toHaveText('MP3 · 320 kbps');
  await expect(child.locator('#displayMusicToggle')).toHaveAttribute('aria-checked', 'true');
  await expect(child.locator('#musicTitle')).not.toHaveCSS('text-shadow', 'none');

  await page.mouse.move(600, 350);
  await page.clock.fastForward(4_500);
  await expect(child.locator('body')).not.toHaveClass(/chrome-hidden/u);
  await page.clock.fastForward(600);
  await expect(child.locator('body')).toHaveClass(/chrome-hidden/u);
  await expect(child.locator('#musicTitle')).not.toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.mouse.move(620, 350);
  await expect(child.locator('body')).not.toHaveClass(/chrome-hidden/u);
  await page.clock.fastForward(5_200);
  await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', /^clock$/iu);
  await page.mouse.click(620, 350);
  await expect(child.locator('body')).not.toHaveClass(/chrome-hidden/u);
  await child.locator('#displayMusicToggle').click();
  await expect(child.locator('#displayMusicToggle')).toHaveAttribute('aria-checked', 'false');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mxqr:screensaver:music')))
    .toBe('off');
  await child.locator('#displayBack').click();
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);

  child = await openScreensaver(page);
  await expect(child.locator('#displayMusicToggle')).toHaveAttribute('aria-checked', 'false');
  await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', /^clock$/iu);
  await child.locator('#displayMusicToggle').click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mxqr:screensaver:music')))
    .toBe('on');
  await child.locator('#displayBack').click();
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
});

test('renders while the font stylesheet is delayed, then refits the clock after fonts arrive', async ({
  page,
}) => {
  await openHost(page);
  await page.evaluate(() => localStorage.setItem('mxqr:screensaver:music', 'off'));
  await page.addInitScript(() => {
    const measureText = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function (text: string): TextMetrics {
      if (this.canvas.id === 'opticalClockCanvas' && text === '88') {
        this.canvas.dataset.fontFits = String(Number(this.canvas.dataset.fontFits || 0) + 1);
      }
      return measureText.call(this, text);
    };
  });

  let releaseStylesheet: () => void = () => {};
  const stylesheetReady = new Promise<void>((resolve) => {
    releaseStylesheet = resolve;
  });
  let stylesheetRequested = false;
  await page.route('https://fonts.googleapis.com/**', async (route) => {
    stylesheetRequested = true;
    await stylesheetReady;
    await route.fulfill({
      contentType: 'text/css',
      body: `@font-face {
        font-family: 'Google Sans';
        font-style: normal;
        font-weight: 100 900;
        font-display: swap;
        src: url('https://fonts.gstatic.com/screensaver-delayed.woff2') format('woff2');
      }`,
    });
  });
  // A local fixture makes late font metrics deterministic without relying on Google.
  await page.route('https://fonts.gstatic.com/screensaver-delayed.woff2', (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL('../public/designsystem/fonts/PretendardVariable.woff2', import.meta.url),
      ),
      contentType: 'font/woff2',
      headers: { 'access-control-allow-origin': '*' },
    }),
  );

  try {
    const child = await openScreensaver(page);
    await expect.poll(() => stylesheetRequested).toBe(true);
    await expect(child.locator('#googleSansStylesheet')).toHaveAttribute('media', 'print');
    await expect(child.locator('#displayBack')).toBeVisible();
    const canvas = child.locator('#opticalClockCanvas');
    await expect(canvas).toHaveAttribute('aria-label', /^\d{2}:\d{2}:\d{2}$/u, {
      timeout: 6_000,
    });
    expect(
      await canvas.evaluate((element: HTMLCanvasElement) => {
        const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height);
        return pixels.data.some((value, index) => index % 4 === 3 && value > 0);
      }),
    ).toBe(true);
    const initialFits = Number(await canvas.getAttribute('data-font-fits'));
    expect(initialFits).toBeGreaterThan(0);

    releaseStylesheet();
    await expect(child.locator('#googleSansStylesheet')).toHaveAttribute('media', 'all');
    await expect
      .poll(() =>
        canvas.evaluate(() =>
          Array.from(document.fonts).some(
            (font) => font.family.includes('Google Sans') && font.status === 'loaded',
          ),
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-font-fits')))
      .toBeGreaterThan(initialFits);
    await child.locator('#displayBack').click();
    await expect(page.locator('#screensaver-overlay')).toHaveCount(0);

    await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
    const fallback = await openScreensaver(page);
    await expect(fallback.locator('#opticalClockCanvas')).toHaveAttribute(
      'aria-label',
      /^\d{2}:\d{2}:\d{2}$/u,
    );
    await fallback.locator('#displayBack').click();
    await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
  } finally {
    releaseStylesheet();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('keeps denied-location controls separate in a 160×160 weather scene', async ({
  page,
}, testInfo) => {
  const requests = await openHost(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_success: PositionCallback, failure?: PositionErrorCallback | null) =>
          failure?.({
            code: 1,
            message: 'Location permission denied for this browser test',
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          }),
      },
    });
  });
  await page.evaluate(() => localStorage.setItem('mxqr:screensaver:music', 'off'));
  await page.clock.install();
  const child = await openScreensaver(page);
  await page.setViewportSize({ width: 160, height: 160 });
  await expect(child.locator('#displayMusicToggle')).toHaveAttribute('aria-checked', 'false');
  await expect(child.locator('#opticalClockCanvas')).toHaveAttribute('aria-hidden', 'false');
  await page.clock.fastForward(22_000);
  await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', 'weather');
  await page.mouse.move(80, 158);
  await expect(child.locator('body')).not.toHaveClass(/chrome-hidden/u);
  const retry = child.locator('#weatherRetry');
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText('Use current location');
  await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await retry.hover();
  await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  const boxes = await Promise.all(
    ['displayBack', 'weatherRetry', 'displayMusicToggle'].map((id) =>
      child.locator(`#${id}`).boundingBox(),
    ),
  );
  for (const box of boxes) {
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(161);
    expect(box!.y + box!.height).toBeLessThanOrEqual(161);
  }
  const [back, location, music] = boxes;
  expect(back!.y + back!.height).toBeLessThanOrEqual(location!.y);
  expect(location!.y + location!.height).toBeLessThanOrEqual(music!.y);
  expect(requests.some((url) => url.includes('open-meteo.com'))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('screensaver-weather-160x160.png') });
  await child.locator('#displayBack').click();
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
});

for (const viewport of [
  { width: 160, height: 160 },
  { width: 320, height: 240 },
  { width: 1920, height: 1080 },
]) {
  test(`fits controls and music in a ${viewport.width}×${viewport.height} viewport`, async ({
    page,
  }, testInfo) => {
    await openHost(page);
    await seedMusic(page, 'Ambient');
    const child = await openScreensaver(page);
    await page.setViewportSize(viewport);
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    for (const id of ['displayBack', 'displayMusicToggle']) {
      const control = child.locator(`#${id}`);
      await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await control.hover();
      await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    await expect(child.locator('#musicTitle')).toHaveText('Ambient');
    expect(await child.locator('body').evaluate((body) => body.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.screenshot({
      path: testInfo.outputPath(`screensaver-${viewport.width}x${viewport.height}.png`),
    });
    await child.locator('#displayBack').click();
    await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
  });
}
