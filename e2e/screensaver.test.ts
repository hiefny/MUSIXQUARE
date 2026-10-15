import { expect, test, type FrameLocator, type Page } from '@playwright/test';
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
      const box = await child.locator(`#${id}`).boundingBox();
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
