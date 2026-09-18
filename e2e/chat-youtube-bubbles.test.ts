import { expect, test, type Locator, type Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { readState } from './helpers/wait.ts';

const FIRST_URL = 'https://youtu.be/dQw4w9WgXc';
const SECOND_URL = 'https://youtu.be/aqz-KE-bpKQ';
const BUBBLES = '#chat-messages .chat-bubble[data-chat-copy-text]';

interface ChatObservation {
  copies: string[];
  renderedMessages: string[];
  youtubeActions: string[];
  trustedCardClicks: number;
  trustedTimestampClicks: number;
}

type ChatTestWindow = typeof window & {
  __chatBubbleObservation: ChatObservation;
  __MUSIXQUARE_BUS__: {
    emit(type: string, ...args: unknown[]): void;
    on(type: string, callback: (...args: unknown[]) => void): void;
  };
};

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

async function prepareChat(page: Page, theme: string): Promise<void> {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'www.youtube.com' && url.pathname === '/oembed') {
      return route.fulfill({ json: { title: 'Sample track' } });
    }
    return route.abort();
  });
  await page.addInitScript(() => {
    const root = window as ChatTestWindow;
    root.__chatBubbleObservation = {
      copies: [],
      renderedMessages: [],
      youtubeActions: [],
      trustedCardClicks: 0,
      trustedTimestampClicks: 0,
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(text: string): Promise<void> {
          root.__chatBubbleObservation.copies.push(text);
          return Promise.resolve();
        },
      },
    });
    document.addEventListener('click', (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      if (event.target.closest('.chat-youtube-btn')) {
        root.__chatBubbleObservation.trustedCardClicks += 1;
      }
      if (event.target.closest('.chat-timestamp')) {
        root.__chatBubbleObservation.trustedTimestampClicks += 1;
      }
    });
  });
  await injectPeerServer(page);
  await setupHostAndStart(page);
  // Freeze wall-clock labels only; normal animation/network timers keep running.
  await page.clock.setFixedTime(new Date('2026-09-19T12:00:00Z'));
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
    const root = window as ChatTestWindow;
    root.__MUSIXQUARE_BUS__.on('chat:message-rendered', (_sender, text) => {
      root.__chatBubbleObservation.renderedMessages.push(String(text));
    });
    root.__MUSIXQUARE_BUS__.on('youtube:load-from-chat', (url) => {
      root.__chatBubbleObservation.youtubeActions.push(String(url));
    });
  }, theme);
  await page.locator('#chat-preview-btn').click();
  await expect(page.locator('#chat-drawer')).toHaveClass(/open/);
  await expect(page.locator('#dialog-overlay.show')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

async function clearChat(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = window as ChatTestWindow;
    root.__MUSIXQUARE_BUS__.emit('chat:clear-all');
    root.__chatBubbleObservation.renderedMessages = [];
  });
  await expect(page.locator(BUBBLES)).toHaveCount(0);
}

async function sendChat(page: Page, text: string, expectedSegments: string[]): Promise<void> {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator(BUBBLES)).toHaveCount(expectedSegments.length);
  await expect
    .poll(() =>
      page
        .locator(BUBBLES)
        .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.chatCopyText)),
    )
    .toEqual(expectedSegments);
  await page.locator('#chat-input').blur();
  for (const title of await page.locator(`${BUBBLES} .chat-yt-title`).all()) {
    await expect(title).toHaveText('Sample track');
  }
  await page.locator('#chat-messages').evaluate(async (container) => {
    await Promise.all(
      container
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

async function visualMetrics(bubble: Locator) {
  return bubble.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: box.width,
      height: box.height,
      background: style.backgroundColor,
      color: style.color,
      padding: style.padding,
    };
  });
}

async function readObservation(page: Page): Promise<ChatObservation> {
  return page.evaluate(() => structuredClone((window as ChatTestWindow).__chatBubbleObservation));
}

for (const theme of ['light', 'dark']) {
  test(`mobile ${theme}: mixed YouTube messages keep ordered separate bubbles and existing styles`, async ({
    page,
  }) => {
    await prepareChat(page, theme);
    const baseline = new Map<string, Awaited<ReturnType<typeof visualMetrics>>>();
    for (const text of ['Before', FIRST_URL, 'After 0:15']) {
      await clearChat(page);
      await sendChat(page, text, [text]);
      baseline.set(text, await visualMetrics(page.locator(BUBBLES)));
    }

    const cases = [
      { text: `Before ${FIRST_URL}`, segments: ['Before', FIRST_URL] },
      { text: `${FIRST_URL} After 0:15`, segments: [FIRST_URL, 'After 0:15'] },
      { text: `Before ${FIRST_URL} After 0:15`, segments: ['Before', FIRST_URL, 'After 0:15'] },
      { text: `${FIRST_URL} ${SECOND_URL}`, segments: [FIRST_URL, SECOND_URL] },
    ];
    for (const example of cases) {
      await clearChat(page);
      await sendChat(page, example.text, example.segments);
      const group = page
        .locator('#chat-messages .chat-group')
        .filter({ has: page.locator('[data-chat-copy-text]') });
      await expect(group).toHaveCount(1);
      await expect(group.locator('.chat-sender')).toHaveCount(1);
      await expect(group.locator('.chat-row')).toHaveCount(example.segments.length);
      await expect(group.locator('.chat-time')).toHaveCount(1);
      await expect(group.locator('.chat-row').last().locator('.chat-time')).toHaveCount(1);
      expect((await readObservation(page)).renderedMessages).toEqual([example.text]);

      let previousBottom = -Infinity;
      for (let index = 0; index < example.segments.length; index += 1) {
        const bubble = page.locator(BUBBLES).nth(index);
        const text = example.segments[index]!;
        const isCard = text.startsWith('https://');
        await expect(bubble.locator('.chat-youtube-btn')).toHaveCount(isCard ? 1 : 0);
        if (isCard) await expect(bubble).toHaveClass(/has-youtube/);
        else await expect(bubble).not.toHaveClass(/has-youtube/);
        const box = await bubble.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThan(0);
        expect(box!.y).toBeGreaterThanOrEqual(previousBottom);
        previousBottom = box!.y + box!.height;
        const control = baseline.get(text === SECOND_URL ? FIRST_URL : text)!;
        expect(await visualMetrics(bubble)).toEqual(control);
      }
    }
  });

  test(`mobile ${theme}: split text, timestamp and YouTube card keep independent trusted taps`, async ({
    page,
  }, testInfo) => {
    await prepareChat(page, theme);
    const message = `Before ${FIRST_URL} After 0:15`;
    await sendChat(page, message, ['Before', FIRST_URL, 'After 0:15']);
    await expect(page.locator('#toast')).not.toHaveClass(/show/);
    await page.screenshot({ path: testInfo.outputPath(`chat-bubbles-${theme}.png`) });

    await page.locator(BUBBLES).first().locator('.chat-text').tap();
    expect(await readObservation(page)).toMatchObject({
      copies: ['Before'],
      youtubeActions: [],
      trustedCardClicks: 0,
      trustedTimestampClicks: 0,
    });

    const timestamp = page.locator(`${BUBBLES} .chat-timestamp`);
    expect((await timestamp.boundingBox())!.height).toBeGreaterThan(0);
    await timestamp.tap();
    await expect.poll(() => readState(page, 'player.pausedAt')).toBe(15);
    expect(await readObservation(page)).toMatchObject({
      copies: ['Before'],
      youtubeActions: [],
      trustedCardClicks: 0,
      trustedTimestampClicks: 1,
    });

    await page.locator(`${BUBBLES} .chat-youtube-btn`).tap();
    await expect
      .poll(async () => (await readObservation(page)).youtubeActions)
      .toEqual([FIRST_URL]);
    expect(await readObservation(page)).toMatchObject({
      copies: ['Before'],
      trustedCardClicks: 1,
      trustedTimestampClicks: 1,
    });
  });
}
