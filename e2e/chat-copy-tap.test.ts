import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

interface ClipboardCall {
  text: string;
  at: number;
}

interface InteractionObservation {
  clipboardCalls: ClipboardCall[];
  execCommands: string[];
  focusTargets: string[];
  temporaryTextareas: number;
  scrollEvents: number;
  viewportEvents: number;
  youtubeClicks: number;
  timestampClicks: number;
  pointerUpAt: number | null;
}

interface StabilitySnapshot {
  activeId: string;
  scrollX: number;
  scrollY: number;
  viewport: {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
    scale: number;
  } | null;
}

async function installClipboardMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const root = window as typeof window & {
      __chatCopyClipboardCalls?: ClipboardCall[];
    };
    root.__chatCopyClipboardCalls = [];
    const clipboard = {
      writeText(text: string): Promise<void> {
        root.__chatCopyClipboardCalls?.push({ text, at: performance.now() });
        return Promise.resolve();
      },
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    });
  });
}

async function openReadyApp(page: Page): Promise<void> {
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);
  await page.evaluate(() => {
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
  });
}

async function mountChatCopyHarness(page: Page): Promise<StabilitySnapshot> {
  return page.evaluate(() => {
    const root = window as typeof window & {
      __chatCopyClipboardCalls?: ClipboardCall[];
      __chatCopyObservation?: InteractionObservation;
    };
    const observation: InteractionObservation = {
      clipboardCalls: root.__chatCopyClipboardCalls ?? [],
      execCommands: [],
      focusTargets: [],
      temporaryTextareas: 0,
      scrollEvents: 0,
      viewportEvents: 0,
      youtubeClicks: 0,
      timestampClicks: 0,
      pointerUpAt: null,
    };
    root.__chatCopyObservation = observation;

    const fixture = document.createElement('section');
    fixture.id = 'chat-copy-e2e-fixture';
    fixture.style.cssText = [
      'position:fixed',
      'inset:20px 20px auto 20px',
      'z-index:2147483647',
      'padding:16px',
      'background:#222',
      'color:#fff',
    ].join(';');

    const sentinel = document.createElement('button');
    sentinel.id = 'chat-copy-focus-sentinel';
    sentinel.type = 'button';
    sentinel.textContent = 'focus sentinel';
    fixture.appendChild(sentinel);

    const bubble = document.createElement('div');
    bubble.id = 'chat-copy-bubble';
    bubble.className = 'chat-bubble';
    bubble.dataset.chatCopyText = 'first line\nsecond line';
    bubble.tabIndex = 0;
    bubble.setAttribute('role', 'group');
    bubble.style.cssText = 'display:block;margin-top:12px;padding:20px;touch-action:manipulation';
    bubble.innerHTML = `
      <span id="chat-copy-body" class="chat-text">tap this message</span>
      <button id="chat-copy-youtube" type="button" class="chat-youtube-btn"
              data-youtube-url="">YouTube</button>
      <span id="chat-copy-timestamp" class="chat-timestamp" role="button"
            tabindex="0" data-seek="15">0:15</span>
    `;
    fixture.appendChild(bubble);
    document.body.appendChild(fixture);

    bubble.addEventListener('pointerup', () => {
      observation.pointerUpAt = performance.now();
    });

    document.getElementById('chat-copy-youtube')?.addEventListener('click', () => {
      observation.youtubeClicks += 1;
    });
    document.getElementById('chat-copy-timestamp')?.addEventListener('click', () => {
      observation.timestampClicks += 1;
    });

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('textarea')) observation.temporaryTextareas += 1;
          observation.temporaryTextareas += node.querySelectorAll('textarea').length;
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value(command: string): boolean {
        observation.execCommands.push(command);
        return false;
      },
    });
    document.addEventListener('focusin', (event) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        observation.focusTargets.push(target.id || target.tagName.toLowerCase());
      }
    });
    window.addEventListener('scroll', () => {
      observation.scrollEvents += 1;
    });
    window.visualViewport?.addEventListener('resize', () => {
      observation.viewportEvents += 1;
    });
    window.visualViewport?.addEventListener('scroll', () => {
      observation.viewportEvents += 1;
    });

    sentinel.focus({ preventScroll: true });
    observation.focusTargets.length = 0;
    window.scrollTo(0, 0);
    observation.scrollEvents = 0;

    const viewport = window.visualViewport;
    return {
      activeId: document.activeElement?.id ?? '',
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewport: viewport
        ? {
            width: viewport.width,
            height: viewport.height,
            offsetLeft: viewport.offsetLeft,
            offsetTop: viewport.offsetTop,
            scale: viewport.scale,
          }
        : null,
    };
  });
}

async function readObservation(page: Page): Promise<InteractionObservation> {
  return page.evaluate(() => {
    const observation = (
      window as typeof window & { __chatCopyObservation?: InteractionObservation }
    ).__chatCopyObservation;
    if (!observation) throw new Error('Chat copy observation is unavailable');
    return structuredClone(observation);
  });
}

async function readStabilitySnapshot(page: Page): Promise<StabilitySnapshot> {
  return page.evaluate(() => {
    const viewport = window.visualViewport;
    return {
      activeId: document.activeElement?.id ?? '',
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewport: viewport
        ? {
            width: viewport.width,
            height: viewport.height,
            offsetLeft: viewport.offsetLeft,
            offsetTop: viewport.offsetTop,
            scale: viewport.scale,
          }
        : null,
    };
  });
}

test('single mobile tap copies immediately without the iOS focus-and-scroll fallback', async ({
  page,
}) => {
  await installClipboardMock(page);
  await openReadyApp(page);
  const before = await mountChatCopyHarness(page);

  await page.locator('#chat-copy-body').tap();
  const immediatelyAfterTap = await readObservation(page);
  const after = await readStabilitySnapshot(page);

  expect(immediatelyAfterTap.clipboardCalls).toHaveLength(1);
  expect(immediatelyAfterTap.clipboardCalls[0]?.text).toBe('first line\nsecond line');
  expect(immediatelyAfterTap.pointerUpAt).not.toBeNull();
  expect(immediatelyAfterTap.clipboardCalls[0]!.at - immediatelyAfterTap.pointerUpAt!).toBeLessThan(
    100,
  );
  expect(immediatelyAfterTap.execCommands).toEqual([]);
  expect(immediatelyAfterTap.temporaryTextareas).toBe(0);
  // Chromium focuses a tabindex-enabled bubble as the native result of a
  // trusted tap; iOS WebKit may retain the prior focus. Neither engine may
  // focus a temporary form control as part of the clipboard implementation.
  expect(immediatelyAfterTap.focusTargets.every((target) => target === 'chat-copy-bubble')).toBe(
    true,
  );
  expect(immediatelyAfterTap.scrollEvents).toBe(0);
  expect(immediatelyAfterTap.viewportEvents).toBe(0);
  expect(['chat-copy-focus-sentinel', 'chat-copy-bubble']).toContain(after.activeId);
  expect({ ...after, activeId: before.activeId }).toEqual(before);

  await page.waitForTimeout(550);
  expect((await readObservation(page)).clipboardCalls).toHaveLength(1);

  // Isolate application code from the browser's native tap-focus policy: a
  // click dispatched while another control is focused must not move focus.
  await page.evaluate(() => {
    const root = window as typeof window & { __chatCopyObservation?: InteractionObservation };
    document.getElementById('chat-copy-focus-sentinel')?.focus({ preventScroll: true });
    if (root.__chatCopyObservation) root.__chatCopyObservation.focusTargets.length = 0;
    document.getElementById('chat-copy-bubble')?.click();
  });
  const applicationClick = await readObservation(page);
  expect(applicationClick.clipboardCalls).toHaveLength(2);
  expect(applicationClick.focusTargets).toEqual([]);
  expect((await readStabilitySnapshot(page)).activeId).toBe('chat-copy-focus-sentinel');
  expect(applicationClick.temporaryTextareas).toBe(0);
});

test('nested YouTube and timestamp taps remain actions and never copy the bubble', async ({
  page,
}) => {
  await installClipboardMock(page);
  await openReadyApp(page);
  await mountChatCopyHarness(page);

  await page.locator('#chat-copy-youtube').tap();
  let observation = await readObservation(page);
  expect(observation.youtubeClicks).toBe(1);
  expect(observation.clipboardCalls).toEqual([]);

  await page.locator('#chat-copy-timestamp').tap();
  observation = await readObservation(page);
  expect(observation.timestampClicks).toBe(1);
  expect(observation.clipboardCalls).toEqual([]);
});
