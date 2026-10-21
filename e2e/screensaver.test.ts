import { expect, test, type Frame, type FrameLocator, type Page } from '@playwright/test';
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
  __MUSIXQUARE_BUS__: { emit(type: string, ...args: unknown[]): void };
  __screensaverGeolocationCalls?: number;
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
  // Functional browser checks do not rely on the external font service.
  // The real Google Sans rendering remains separate visual QA.
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem('musixquare-lang', 'en'));
  // Count location requests from the app and the screensaver frame alike.
  await page.addInitScript(() => {
    const geolocation = navigator.geolocation;
    if (!geolocation) return;
    for (const method of ['getCurrentPosition', 'watchPosition'] as const) {
      const original = geolocation[method].bind(geolocation) as (...args: unknown[]) => number;
      Object.defineProperty(geolocation, method, {
        configurable: true,
        value: (...args: unknown[]) => {
          const top = window.top as ScreensaverTestWindow;
          top.__screensaverGeolocationCalls = (top.__screensaverGeolocationCalls || 0) + 1;
          return original(...args);
        },
      });
    }
  });
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
  return waitForScreensaver(page);
}

async function openScreensaverFromBus(page: Page): Promise<FrameLocator> {
  await page.evaluate(() =>
    (window as unknown as ScreensaverTestWindow).__MUSIXQUARE_BUS__.emit('ui:open-screensaver'),
  );
  return waitForScreensaver(page);
}

async function geolocationCalls(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as ScreensaverTestWindow).__screensaverGeolocationCalls || 0,
  );
}

async function actionLook(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        background: style.backgroundColor,
        color: style.color,
        radius: style.borderRadius,
        font: `${style.fontWeight} ${style.fontSize}`,
        minHeight: style.minHeight,
      };
    });
}

async function waitForScreensaver(page: Page): Promise<FrameLocator> {
  await expect(page.locator('#screensaver-overlay iframe')).toHaveCount(1);
  const child = page.frameLocator('#screensaver-overlay iframe');
  await expect(child.locator('#displayBack')).toHaveAttribute('aria-label', 'Back to MUSIXQUARE');
  await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', /^clock$/iu);
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

async function disableFullscreenForLayoutProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const method of [
      'requestFullscreen',
      'webkitRequestFullscreen',
      'webkitRequestFullScreen',
    ]) {
      Object.defineProperty(document.documentElement, method, {
        configurable: true,
        value: undefined,
      });
    }
  });
}

async function visibleForegroundSources(child: FrameLocator, canvasId: string): Promise<number> {
  return child.locator(`[data-compat-compositor="${canvasId}"] canvas`).evaluateAll((canvases) => {
    const sample = document.createElement('canvas');
    sample.width = sample.height = 128;
    const context = sample.getContext('2d', { willReadFrequently: true })!;
    let nonempty = 0;
    for (const node of canvases) {
      if (!(node instanceof HTMLCanvasElement)) continue;
      let visible = true;
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0) {
          visible = false;
          break;
        }
      }
      if (!visible || !node.width || !node.height) continue;
      context.clearRect(0, 0, 128, 128);
      context.drawImage(node, 0, 0, 128, 128);
      const pixels = context.getImageData(0, 0, 128, 128).data;
      if (pixels.some((value, index) => index % 4 === 3 && value > 0)) nonempty++;
    }
    return nonempty;
  });
}

function screensaverFrame(page: Page): Frame {
  const frame = page
    .frames()
    .find((candidate) => new URL(candidate.url()).pathname === '/screensaver.html');
  if (!frame) throw new Error('The screensaver frame is not attached');
  return frame;
}

interface ClockProbeFrame {
  minute: number;
  second: number;
  passes: number;
}

/**
 * Starts the screensaver's clock at `second` past a minute, and records for every animation
 * frame its clock time and how many canvas shadow blurs it drew. Each Gaussian pass of a clock
 * tile is one: a digit takes ten and the colon two, so a whole scene takes 42.
 */
async function probeScreensaverClock(page: Page, second: number): Promise<void> {
  await page.addInitScript((second) => {
    if (location.pathname !== '/screensaver.html') return;
    const RealDate = Date;
    const start = new RealDate();
    start.setSeconds(second, 0);
    const shift = start.getTime() - RealDate.now();
    // The screensaver only ever asks for the current time.
    window.Date = class extends RealDate {
      constructor() {
        super(RealDate.now() + shift);
      }
      static now() {
        return RealDate.now() + shift;
      }
    } as unknown as DateConstructor;
    let passes = 0;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args: unknown[]
    ) {
      if (this.shadowBlur > 0) passes++;
      Reflect.apply(drawImage, this, args);
    } as CanvasRenderingContext2D['drawImage'];
    const frames: ClockProbeFrame[] = [];
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      requestFrame((time) => {
        const now = new Date();
        passes = 0;
        callback(time);
        frames.push({ minute: now.getMinutes(), second: now.getSeconds(), passes });
      });
    Object.assign(window, { __clockFrames: frames });
  }, second);
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
    await expect
      .poll(() =>
        hostRequests.some((url) =>
          new URL(url).pathname.startsWith('/assets/screensaver/backgrounds/clock/'),
        ),
      )
      .toBe(true);
    expect(hostRequests.some((url) => url.includes('open-meteo.com'))).toBe(false);
    expect(await geolocationCalls(host)).toBe(0);
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

test('allows system audio, interrupts an exit fade for YouTube, and blocks both commands', async ({
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

  await expect(page.locator('#screensaver-overlay')).toHaveCSS('opacity', '1');
  // Trigger the provider-state guard in the first microtask of the normal exit fade.
  await page.evaluate(() => {
    const overlay = document.getElementById('screensaver-overlay')!;
    const observer = new MutationObserver(() => {
      if (overlay.style.opacity !== '0') return;
      observer.disconnect();
      (window as unknown as ScreensaverTestWindow).__MUSIXQUARE_SET_STATE__(
        'playback.mode',
        'youtube',
      );
      Object.assign(window, { __screensaverYouTubeRemovedImmediately: !overlay.isConnected });
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['style'] });
  });
  await child.locator('#displayBack').click();
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __screensaverYouTubeRemovedImmediately: boolean })
          .__screensaverYouTubeRemovedImmediately,
    ),
  ).toBe(true);
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

test('shows two-line track details with idle chrome without adding a music scene', async ({
  page,
}) => {
  await openHost(page);
  const title = 'A very long music title that stays in the small bottom information area';
  await seedMusic(page, title);
  await page.evaluate(() => localStorage.setItem('mxqr:screensaver:music', 'off'));
  await page.clock.install();
  const child = await openScreensaver(page);
  await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', /^clock$/iu);
  await expect(child.locator('#displayMusicInfo')).toBeVisible();
  await expect(child.locator('#musicTitle')).toHaveText(title);
  await expect(child.locator('#musicSubtitle')).toHaveText('MP3 · 320 kbps');
  await expect(child.locator('#displayMusicToggle, #musicToggleLabel, #musicScene')).toHaveCount(0);
  await expect(child.locator('#musicTitle')).toHaveCSS('text-shadow', 'none');
  await expect(child.locator('#musicTitle')).toHaveCSS('text-overflow', 'ellipsis');

  await page.mouse.move(600, 350);
  await page.clock.fastForward(4_500);
  await expect(child.locator('body')).not.toHaveClass(/chrome-hidden/u);
  await page.clock.fastForward(600);
  await expect(child.locator('body')).toHaveClass(/chrome-hidden/u);
  await page.mouse.move(620, 350);
  await expect(child.locator('body')).not.toHaveClass(/chrome-hidden/u);
  await page.clock.fastForward(5_200);
  await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', /^clock$/iu);
  await seedMusic(page, 'Second track');
  await expect(child.locator('#musicTitle')).toHaveText('Second track');
  await page.mouse.click(620, 350);
  await expect(child.locator('body')).not.toHaveClass(/chrome-hidden/u);
  await page.clock.fastForward(40_000);
  await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', /^clock$/iu);
  await expect(child.locator('#musicTitle')).toHaveText('Second track');
  expect(await page.evaluate(() => localStorage.getItem('mxqr:screensaver:music'))).toBe('off');
  await page.mouse.move(640, 350);
  await child.locator('#displayBack').click();
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
});

test('requests fullscreen before the cold import and fades into and out of the screensaver', async ({
  page,
}) => {
  await openHost(page);
  await page.evaluate(() => {
    const probe = {
      activation: [] as boolean[],
      samples: [] as { target: string; opacity: number }[],
    };
    Object.assign(window, { __screensaverMotionProbe: probe });
    const request = document.documentElement.requestFullscreen;
    document.documentElement.requestFullscreen = function (options?: FullscreenOptions) {
      probe.activation.push(navigator.userActivation.isActive);
      return request.call(this, options);
    };
    const observer = new MutationObserver(() => {
      const overlay = document.getElementById('screensaver-overlay');
      if (!overlay) return;
      observer.disconnect();
      const sample = () => {
        if (!overlay.isConnected) return;
        probe.samples.push({
          target: overlay.style.opacity,
          opacity: Number(getComputedStyle(overlay).opacity),
        });
        requestAnimationFrame(sample);
      };
      sample();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  const child = await openScreensaver(page);
  const overlay = page.locator('#screensaver-overlay');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('HTML');
  await expect(overlay).toHaveCSS('opacity', '1');
  await child.locator('#displayBack').click();
  await expect(overlay).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  const probe = await page.evaluate(
    () =>
      (
        window as unknown as {
          __screensaverMotionProbe: {
            activation: boolean[];
            samples: { target: string; opacity: number }[];
          };
        }
      ).__screensaverMotionProbe,
  );
  expect(probe.activation).toEqual([true]);
  expect(probe.samples.some((sample) => sample.opacity === 0)).toBe(true);
  for (const target of ['0', '1']) {
    expect(
      probe.samples.some(
        (sample) => sample.target === target && sample.opacity > 0 && sample.opacity < 1,
      ),
    ).toBe(true);
  }
});

for (const existing of ['root', 'nested'] as const) {
  test(
    'preserves existing ' + existing + ' fullscreen and keeps screensaver controls usable',
    async ({ page }) => {
      await openHost(page);
      await seedMusic(page, 'Ambient');
      await page.evaluate((existing) => {
        let target: HTMLElement = document.documentElement;
        if (existing === 'nested') {
          const wrapper = document.createElement('div');
          wrapper.id = 'fullscreen-fixture';
          Object.assign(wrapper.style, { width: '100%', height: '100%', overflow: 'auto' });
          for (const child of Array.from(document.body.children)) {
            if (child.id !== 'dialog-overlay') wrapper.append(child);
          }
          document.body.append(wrapper);
          target = wrapper;
        }
        const button = document.createElement('button');
        button.id = 'fullscreen-fixture-enter';
        button.textContent = 'Enter fullscreen';
        Object.assign(button.style, {
          position: 'fixed',
          top: '0',
          left: '0',
          zIndex: '999999',
        });
        button.addEventListener('click', () => {
          target.requestFullscreen().then(
            () => button.remove(),
            () => {
              button.textContent = 'Fullscreen request rejected';
            },
          );
        });
        document.body.append(button);
      }, existing);
      await page.locator('#fullscreen-fixture-enter').click();
      const expectedFullscreen = existing === 'root' ? 'HTML' : 'fullscreen-fixture';
      const fullscreen = () =>
        page.evaluate(() => document.fullscreenElement?.id || document.fullscreenElement?.tagName);
      await expect.poll(fullscreen).toBe(expectedFullscreen);
      const child = await openScreensaver(page);
      await expect(child.locator('#displayMusicInfo')).toBeVisible();
      await expect(child.locator('#displayBack')).toBeVisible();
      if (existing === 'nested') {
        await expect(page.locator('#fullscreen-fixture > #screensaver-overlay')).toHaveCount(1);
        await page.evaluate(() => {
          const dialog = document.getElementById('dialog-overlay')!;
          document.getElementById('dialog-message')!.textContent = 'Screensaver dialog fixture';
          const action = document.getElementById('btn-dialog-ok')!;
          action.textContent = 'Close fixture';
          action.addEventListener('click', () => dialog.classList.remove('show'), { once: true });
          dialog.classList.add('show');
        });
        const dialog = page.locator('#fullscreen-fixture > #dialog-overlay');
        await expect(dialog).toBeVisible();
        await expect(page.locator('#screensaver-overlay')).toHaveAttribute('inert', '');
        await page.locator('#btn-dialog-ok').click();
        await expect(page.locator('#dialog-overlay')).toBeHidden();
        await expect(page.locator('#screensaver-overlay')).not.toHaveAttribute('inert', '');
        expect(
          await page.locator('#dialog-overlay').evaluate((node) => node.parentElement?.tagName),
        ).toBe('BODY');
      }
      await child.locator('#displayBack').click();
      await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
      await expect.poll(fullscreen).toBe(expectedFullscreen);
      await page.evaluate(() => document.exitFullscreen());
    },
  );
}

test('renders while the font stylesheet is delayed, then refits the clock after fonts arrive', async ({
  page,
}) => {
  await openHost(page);
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
    const background = child.locator('#imageBackgroundRoot .image-background-layer img');
    await expect(background).toHaveCount(1, { timeout: 1_500 });
    await expect(background).toHaveAttribute('src', /\/clock\/.*\.webp$/u);
    expect(
      await background.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    ).toBe(true);
    const canvas = child.locator('#opticalClockCanvas');
    await expect(canvas).toHaveAttribute('aria-label', /^\d{2}:\d{2}:\d{2}$/u, {
      timeout: 6_000,
    });
    await expect
      .poll(() => visibleForegroundSources(child, 'opticalClockCanvas'))
      .toBeGreaterThan(0);
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

test('holds the decoded background while a resized variant loads, then crossfades only two layers', async ({
  page,
}) => {
  await openHost(page);
  await disableFullscreenForLayoutProbe(page);
  let releaseImage: () => void = () => {};
  const imageReady = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  const portrait = '**/assets/screensaver/backgrounds/clock/portrait-*.webp';
  let portraitRequested = false;
  await page.route(portrait, async (route) => {
    portraitRequested = true;
    await imageReady;
    await route.continue();
  });
  try {
    const child = await openScreensaver(page);
    const images = child.locator('#imageBackgroundRoot .image-background-layer img');
    await expect(images).toHaveCount(1);
    await expect(images).toHaveAttribute('src', /\/clock\/wide-[a-f0-9]{8}\.webp$/u);
    expect(
      await images.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
    ).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => portraitRequested).toBe(true);
    await page.waitForTimeout(300);
    await expect(images).toHaveCount(1);
    await expect(images).toHaveAttribute('src', /\/clock\/wide-[a-f0-9]{8}\.webp$/u);

    releaseImage();
    await expect(images).toHaveCount(2);
    await expect
      .poll(() =>
        images.evaluateAll((nodes) =>
          nodes.every((node) => {
            const image = node as HTMLImageElement;
            return image.complete && image.naturalWidth > 0;
          }),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        child
          .locator('#imageBackgroundRoot .image-background-layer')
          .evaluateAll((layers) =>
            layers.every((layer) => Number(getComputedStyle(layer).opacity) > 0),
          ),
      )
      .toBe(true);
    await expect(images).toHaveCount(1);
    await expect(images).toHaveAttribute('src', /\/clock\/portrait-[a-f0-9]{8}\.webp$/u);
    expect(
      await child
        .locator('body')
        .evaluate(() =>
          Array.from(
            document.querySelectorAll('#imageBackgroundRoot, #imageBackgroundRoot *'),
          ).some((node) => getComputedStyle(node).filter !== 'none'),
        ),
    ).toBe(false);
    await expect(child.locator('#backgroundGrain')).toHaveCSS('opacity', '0.62');
    await page.keyboard.press('Escape');
    await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
  } finally {
    releaseImage();
    await page.unroute(portrait);
  }
});

test('keeps the previous image after a failed background request and recovers on reopening', async ({
  page,
}) => {
  await openHost(page);
  await disableFullscreenForLayoutProbe(page);
  const portrait = '**/assets/screensaver/backgrounds/clock/portrait-*.webp';
  await page.route(portrait, (route) => route.abort());
  let child = await openScreensaver(page);
  await expect(child.locator('#imageBackgroundRoot img')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await expect(child.locator('#imageBackgroundRoot img')).toHaveCount(1);
  await expect(child.locator('#imageBackgroundRoot img')).toHaveAttribute(
    'src',
    /\/clock\/wide-[a-f0-9]{8}\.webp$/u,
  );
  await expect.poll(() => visibleForegroundSources(child, 'opticalClockCanvas')).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);

  await page.unroute(portrait);
  child = await openScreensaverFromBus(page);
  await expect(child.locator('#imageBackgroundRoot img')).toHaveCount(1);
  await expect(child.locator('#imageBackgroundRoot img')).toHaveAttribute(
    'src',
    /\/clock\/portrait-[a-f0-9]{8}\.webp$/u,
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
});

test('renders glow without Canvas filter and recreates bounded layers after page lifecycle cleanup', async ({
  page,
}, testInfo) => {
  await openHost(page);
  await page.clock.install({ time: new Date('2026-10-16T12:58:30Z') });
  await page.addInitScript(() => {
    Reflect.deleteProperty(CanvasRenderingContext2D.prototype, 'filter');
  });
  const child = await openScreensaver(page);
  const compositor = child.locator('[data-compat-compositor="opticalClockCanvas"]');
  await expect(compositor).toHaveCount(1);
  await expect.poll(() => visibleForegroundSources(child, 'opticalClockCanvas')).toBeGreaterThan(0);
  expect(
    await child
      .locator('body')
      .evaluate(() => Reflect.has(CanvasRenderingContext2D.prototype, 'filter')),
  ).toBe(false);
  await page.clock.setFixedTime(new Date('2026-10-16T13:59:30Z'));
  await expect
    .poll(() =>
      compositor
        .locator('*')
        .evaluateAll((nodes) =>
          nodes.some((node) => /blur\((?!0px)/u.test(getComputedStyle(node).filter)),
        ),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('screensaver-canvas-filter-unavailable.png') });
  await child.locator('body').evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await expect(child.locator('#imageBackgroundRoot')).toHaveCount(0);
  await expect(child.locator('[data-compat-compositor]')).toHaveCount(0);
  await child.locator('body').evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(child.locator('#imageBackgroundRoot')).toHaveCount(1);
  await expect(child.locator('#imageBackgroundRoot .image-background-layer')).toHaveCount(2);
  await expect(child.locator('#imageBackgroundRoot img')).toHaveCount(1);
  await expect(compositor).toHaveCount(1);
  await expect.poll(() => visibleForegroundSources(child, 'opticalClockCanvas')).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
});

test('holds the particles still with reduced motion and lets them drift again without it', async ({
  page,
}) => {
  await openHost(page);
  await disableFullscreenForLayoutProbe(page);
  await probeScreensaverClock(page, 5);
  const child = await openScreensaver(page);
  const frame = screensaverFrame(page);
  await expect.poll(() => visibleForegroundSources(child, 'opticalClockCanvas')).toBeGreaterThan(0);
  const particles = () =>
    frame.evaluate(() =>
      document.querySelector<HTMLCanvasElement>('#speckleFieldCanvas')!.toDataURL(),
    );
  const clockLabel = () => child.locator('#opticalClockCanvas').getAttribute('aria-label');
  const drifting = await particles();
  await expect.poll(particles).not.toBe(drifting);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(200);
  const still = await particles();
  const time = await clockLabel();
  // The clock keeps counting while the particles neither drift nor twinkle.
  await expect.poll(clockLabel).not.toBe(time);
  expect(await particles()).toBe(still);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(particles).not.toBe(still);
  await page.keyboard.press('Escape');
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
});

test('drifts the particles as far in a second at 120 frames per second as at 60', async ({
  page,
}) => {
  await openHost(page);
  await disableFullscreenForLayoutProbe(page);
  await page.addInitScript(() => {
    if (location.pathname !== '/screensaver.html') return;
    // The same particles on every opening, a clock that stands still, and frames the test runs.
    let seed = 0x2f6b3a1d;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const RealDate = Date;
    const fixed = new RealDate(2026, 9, 22, 12, 34, 20).getTime();
    window.Date = class extends RealDate {
      constructor() {
        super(fixed);
      }
      static now() {
        return fixed;
      }
    } as unknown as DateConstructor;
    let callbacks: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => callbacks.push(callback);
    window.cancelAnimationFrame = () => {};
    Object.assign(window, {
      __framesQueued: () => callbacks.length,
      __runFrames(count: number, interval: number) {
        for (let index = 0; index <= count; index++) {
          const due = callbacks;
          callbacks = [];
          for (const callback of due) callback(1_000 + index * interval);
        }
      },
    });
  });
  type FrameDriverWindow = Window & {
    __framesQueued(): number;
    __runFrames(count: number, interval: number): void;
  };
  const fieldAfterOneSecond = async (fps: number) => {
    const frame = screensaverFrame(page);
    await expect
      .poll(() => frame.evaluate(() => (window as unknown as FrameDriverWindow).__framesQueued()))
      .toBeGreaterThan(0);
    const lit = await frame.evaluate((fps) => {
      (window as unknown as FrameDriverWindow).__runFrames(fps, 1000 / fps);
      const canvas = document.querySelector<HTMLCanvasElement>('#speckleFieldCanvas')!;
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const pixels: number[] = [];
      for (let index = 3; index < data.length; index += 4)
        if (data[index]) pixels.push(index, data[index]);
      return pixels;
    }, fps);
    await page.keyboard.press('Escape');
    await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
    const field = new Map<number, number>();
    for (let index = 0; index < lit.length; index += 2) field.set(lit[index]!, lit[index + 1]!);
    return field;
  };
  await openScreensaver(page);
  const at60 = await fieldAfterOneSecond(60);
  await openScreensaverFromBus(page);
  const at120 = await fieldAfterOneSecond(120);
  const pixels = new Set([...at60.keys(), ...at120.keys()]);
  const differing = [...pixels].filter((pixel) => at60.get(pixel) !== at120.get(pixel)).length;
  expect(at60.size).toBeGreaterThan(200);
  // Frame-counted motion would move every particle twice as far at 120 fps.
  expect(differing / pixels.size).toBeLessThan(0.1);
});

test('opens from the Help tab and shows only the clock without asking for location', async ({
  page,
}, testInfo) => {
  const requests = await openHost(page);
  await page.clock.install();
  if (!(await page.locator('#settings-subtab-help').isVisible()))
    await page.locator('#nav-settings').click();
  await page.locator('#settings-subtab-help').click();
  const tour = page.locator('#btn-demo-media');
  const button = page.locator('#btn-screensaver');
  await expect(button).toHaveText('Turn on screensaver');
  await expect(button).toHaveClass(/\baccent-action-btn\b/u);
  await expect(tour).toHaveClass(/\baccent-action-btn\b/u);
  // The tour and the screensaver share the accent look.
  expect(await actionLook(page, '#btn-demo-media')).toEqual(
    await actionLook(page, '#btn-screensaver'),
  );
  await expect(button).toHaveCSS('color', 'rgb(0, 122, 255)');
  const [tourBox, buttonBox] = await Promise.all([tour.boundingBox(), button.boundingBox()]);
  expect(buttonBox!.y).toBeGreaterThan(tourBox!.y + tourBox!.height);
  expect(buttonBox!.width).toBeCloseTo(tourBox!.width, 0);
  await page.screenshot({ path: testInfo.outputPath('help-actions-1280x720.png') });

  await button.click();
  const child = await waitForScreensaver(page);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('HTML');
  await expect(child.locator('#opticalClockCanvas')).toHaveAttribute(
    'aria-label',
    /^\d{2}:\d{2}:\d{2}$/u,
  );
  await expect(child.locator('#mainStage > canvas')).toHaveCount(2);
  await expect(child.locator('#weatherCanvas, #weatherRetry, #weatherAttribution')).toHaveCount(0);
  await expect(child.locator('a[href]')).toHaveCount(0);
  // Long enough for every former scene rotation (10 s each) to have come around.
  for (let elapsed = 0; elapsed < 60_000; elapsed += 10_000) {
    await page.clock.fastForward(10_000);
    await expect(child.locator('#mainStage')).toHaveAttribute('aria-label', /^clock$/iu);
    await expect(child.locator('#opticalClockCanvas')).not.toHaveAttribute('aria-hidden', 'true');
  }
  expect(await geolocationCalls(page)).toBe(0);
  expect(requests.some((url) => url.includes('open-meteo.com'))).toBe(false);
  expect(requests.some((url) => /\/assets\/screensaver\/backgrounds\/(?!clock\/)/u.test(url))).toBe(
    false,
  );
  await page.screenshot({ path: testInfo.outputPath('screensaver-clock-only-1280x720.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
});

test('closes on a double-click anywhere but not on a single click', async ({ page }) => {
  await openHost(page);
  await seedMusic(page, 'Ambient');
  const child = await openScreensaver(page);
  await expect(child.locator('#opticalClockCanvas')).toHaveAttribute(
    'aria-label',
    /^\d{2}:\d{2}:\d{2}$/u,
  );
  await page.mouse.click(400, 500);
  await page.waitForTimeout(900);
  await expect(page.locator('#screensaver-overlay')).toHaveCount(1);
  await expect(child.locator('body')).not.toHaveClass(/chrome-hidden/u);
  // Separate clicks slower than a double-click keep it open too.
  await page.mouse.click(900, 300);
  await page.waitForTimeout(700);
  await page.mouse.click(900, 300);
  await page.waitForTimeout(400);
  await expect(page.locator('#screensaver-overlay')).toHaveCount(1);

  await page.mouse.dblclick(640, 600);
  await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('double-tap closes without zooming, a single tap only reveals the controls', async ({
    page,
  }, testInfo) => {
    await openHost(page);
    await disableFullscreenForLayoutProbe(page);
    await page.locator('#nav-guide').tap();
    const button = page.locator('#btn-screensaver-mobile');
    await button.scrollIntoViewIfNeeded();
    await expect(button).toHaveText('Turn on screensaver');
    await button.tap();
    const child = await waitForScreensaver(page);
    await expect(child.locator('body')).toHaveCSS('touch-action', 'manipulation');
    await expect(child.locator('#opticalClockCanvas')).toHaveAttribute(
      'aria-label',
      /^\d{2}:\d{2}:\d{2}$/u,
    );
    const scale = () => page.evaluate(() => window.visualViewport?.scale ?? 1);
    expect(await scale()).toBe(1);

    await page.touchscreen.tap(195, 600);
    await page.waitForTimeout(700);
    await expect(page.locator('#screensaver-overlay')).toHaveCount(1);
    await expect(child.locator('body')).not.toHaveClass(/chrome-hidden/u);
    await page.screenshot({ path: testInfo.outputPath('screensaver-touch-390x844.png') });
    // Two taps far apart are not a double-tap.
    await page.touchscreen.tap(60, 200);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(330, 700);
    await page.waitForTimeout(700);
    await expect(page.locator('#screensaver-overlay')).toHaveCount(1);

    await page.touchscreen.tap(195, 600);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(197, 602);
    await expect(page.locator('#screensaver-overlay')).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(await scale()).toBe(1);
  });
});

test('brightens visibly and smoothly with ordinary bass while a file plays, except with reduced motion', async ({
  page,
}, testInfo) => {
  await openHost(page);
  // Feed the shared analyser a deterministic kick pattern on top of real file playback.
  await page.evaluate(() => {
    const original = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function (array: Float32Array<ArrayBuffer>) {
      original.call(this, array);
      const bass = (window as unknown as { __syntheticBassDb?: number }).__syntheticBassDb;
      if (typeof bass === 'number')
        for (let i = 0; (i * this.context.sampleRate) / this.fftSize < 140; i++) array[i] = bass;
    };
    Object.assign(window, { __syntheticBassDb: -100 });
  });
  await uploadFixture(page, 'test01');
  await waitForFilePlaybackReady(page);
  if ((await readState(page, 'playback.activity')) !== 'playing') await clickPlayButton(page);
  await waitForState(page, 'playback.activity', 'playing');
  await openScreensaver(page);
  const frame = page.locator('#screensaver-overlay iframe');
  await expect(frame).toHaveCSS('filter', 'none');

  const samples = await page.evaluate(async () => {
    const node = document.querySelector<HTMLIFrameElement>('#screensaver-overlay iframe')!;
    const values: { t: number; kick: boolean; brightness: number }[] = [];
    const start = performance.now();
    let kick = false;
    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        const t = now - start;
        // Three 150 ms kicks, 750 ms apart, then silence.
        kick = t < 2_250 && t % 750 < 150;
        Object.assign(window, { __syntheticBassDb: kick ? -60 : -100 });
        const match = /brightness\(([\d.]+)\)/u.exec(node.style.filter);
        values.push({ t, kick, brightness: match ? Number(match[1]) : 1 });
        if (t < 4_000) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    return values;
  });
  await testInfo.attach('bass-brightness-samples', {
    body: JSON.stringify(samples),
    contentType: 'application/json',
  });
  const peak = Math.max(...samples.map((sample) => sample.brightness));
  expect(peak).toBeGreaterThan(1.06);
  expect(peak).toBeLessThanOrEqual(1.16);
  let largestStep = 0;
  for (let i = 1; i < samples.length; i++)
    largestStep = Math.max(
      largestStep,
      Math.abs(samples[i]!.brightness - samples[i - 1]!.brightness),
    );
  // Eased per frame: the lift never lands in one step.
  expect(largestStep).toBeLessThan(0.04);
  // Fast attack: most of a kick's lift arrives within about 100 ms, not instantly.
  const firstPeak = Math.max(
    ...samples.filter((sample) => sample.t < 750).map((sample) => sample.brightness),
  );
  const riseAt = samples.find((sample) => sample.brightness - 1 >= (firstPeak - 1) * 0.8)!.t;
  expect(riseAt).toBeGreaterThan(30);
  expect(riseAt).toBeLessThan(220);
  const firstKickEnd = samples.find((sample) => sample.t >= 150)!;
  const beforeSecondKick = samples.filter((sample) => sample.t < 750).at(-1)!;
  expect(beforeSecondKick.brightness).toBeLessThan(firstKickEnd.brightness);
  expect(beforeSecondKick.brightness).toBeGreaterThan(1);
  await expect(frame).toHaveCSS('filter', 'none');
  expect(await readState(page, 'playback.activity')).toBe('playing');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => Object.assign(window, { __syntheticBassDb: -60 }));
  await page.waitForTimeout(600);
  await expect(frame).toHaveCSS('filter', 'none');
  await page.keyboard.press('Escape');
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
    await disableFullscreenForLayoutProbe(page);
    const child = await openScreensaver(page);
    await page.setViewportSize(viewport);
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    for (const id of ['displayBack', 'displayMusicInfo']) {
      const control = child.locator(`#${id}`);
      await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(control).toHaveCSS('text-shadow', 'none');
      await expect(control).toHaveCSS('box-shadow', 'none');
      if (id === 'displayBack') {
        await control.hover();
        await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    for (const id of ['displayBack', 'musicTitle', 'musicSubtitle']) {
      const control = child.locator(`#${id}`);
      await expect(control).toHaveCSS('text-shadow', 'none');
      await expect(control).toHaveCSS('box-shadow', 'none');
      await expect(control).toHaveCSS('filter', 'none');
    }
    await expect(child.locator('#musicTitle')).toHaveText('Ambient');
    const titleBox = await child.locator('#musicTitle').boundingBox();
    const subtitleBox = await child.locator('#musicSubtitle').boundingBox();
    expect(titleBox).not.toBeNull();
    expect(subtitleBox).not.toBeNull();
    expect(titleBox!.y + titleBox!.height).toBeLessThanOrEqual(subtitleBox!.y);
    expect(titleBox!.height).toBeLessThan(25);
    expect(subtitleBox!.height).toBeLessThan(22);
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
