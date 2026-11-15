import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHost, setupHostAndStart } from './helpers/setup-flow.ts';

// Arabic is one of the four right-to-left languages (ar, fa, he, ur). These
// rows open the real app in it and expect what the left-to-right layout does,
// on the mirrored side.

const TOLERANCE_PX = 1;

async function openInLanguage(
  page: Page,
  language: string,
  width: number,
  height: number,
): Promise<void> {
  await injectPeerServer(page);
  await page.addInitScript((code) => {
    try {
      localStorage.setItem('musixquare-lang', code);
    } catch {
      // Opaque documents such as about:blank have no storage.
    }
  }, language);
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('https://demo.musixquare.com/linelight/*.m4a', (route) =>
    route.fulfill({
      path: fileURLToPath(new URL('./fixtures/demo-track.mp3', import.meta.url)),
      contentType: 'audio/mpeg',
    }),
  );
}

async function openInArabic(page: Page, width: number, height: number): Promise<void> {
  await openInLanguage(page, 'ar', width, height);
}

async function openStartScreen(page: Page): Promise<void> {
  await page.goto('/');
  await waitForBootstrapReady(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.waitForSelector('#btn-setup-host', { state: 'visible', timeout: 15_000 });
}

// The share of the carousel viewport that a slide covers.
function slideShare(page: Page, index: number): Promise<number> {
  return page.evaluate((slideIndex) => {
    const viewport = document.getElementById('ob-slider-viewport')!.getBoundingClientRect();
    const slide = document
      .querySelectorAll('#ob-slider-track .ob-slide')
      [slideIndex]!.getBoundingClientRect();
    const overlap = Math.max(
      0,
      Math.min(slide.right, viewport.right) - Math.max(slide.left, viewport.left),
    );
    return overlap / viewport.width;
  }, index);
}

// The rendered right edge of an element's text, where right-to-left text starts.
function textStart(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().right;
  });
}

// The same reading twice in a row, after a tab switch has finished moving.
async function settledTextStart(page: Page, selector: string): Promise<number> {
  let previous = Number.NaN;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await textStart(page, selector);
    if (current !== 0 && Math.abs(current - previous) <= 0.5) return current;
    previous = current;
    await page.waitForTimeout(100);
  }
  return previous;
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
]) {
  test(`the welcome carousel shows each slide it moves to (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    await openInArabic(page, viewport.width, viewport.height);
    await openStartScreen(page);
    for (const index of [1, 2, 3, 0]) {
      await page.locator(`#ob-dots .ob-dot[data-idx="${index}"]`).click();
      await expect
        .poll(() => slideShare(page, index), { message: `slide ${index + 1} is in view` })
        .toBeGreaterThan(0.95);
    }
  });
}

test('the setup brand column starts its line under the heading where the heading starts', async ({
  page,
}) => {
  await openInArabic(page, 1024, 768);
  await openStartScreen(page);
  await expect(page.locator('#desktop-step-header .setup-role-prompt')).toBeVisible();
  const headingStart = await textStart(page, '#desktop-step-header .setup-greeting-text');
  const lineStart = await textStart(page, '#desktop-step-header .setup-role-prompt');
  expect(Math.abs(lineStart - headingStart)).toBeLessThanOrEqual(4);
});

test('a running room mirrors the Playlist title, the password switch and the demo panel', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openInArabic(page, 1024, 768);
  await setupHostAndStart(page);
  await page
    .waitForFunction(
      () => !document.querySelector('.app-entrance, .app-chat-entrance'),
      undefined,
      {
        timeout: 8_000,
      },
    )
    .catch(() => undefined);

  // The Playlist title starts where the other tab titles start.
  await page.locator('#nav-connect').click();
  const otherTitleStart = await settledTextStart(page, '#tab-connect .tab-header > .tab-title');
  await page.locator('#nav-playlist').click();
  await expect(page.locator('#btn-playlist-switch')).toBeVisible();
  const playlistTitleStart = await settledTextStart(page, '#playlist-switch-label');
  // Soft checks: each part of this row reports on its own.
  expect
    .soft(Math.abs(playlistTitleStart - otherTitleStart), 'Playlist title start')
    .toBeLessThanOrEqual(TOLERANCE_PX);

  // Switched on, the room password knob travels to the inline end and stays
  // inside its pill. The on state is set the way the Connect tab renders it.
  await page.locator('#nav-connect').click();
  const toggle = page.locator('#room-password-toggle');
  await toggle.scrollIntoViewIfNeeded();
  await toggle.evaluate((node) => {
    node.classList.add('active');
    node.setAttribute('aria-checked', 'true');
    node.querySelector<HTMLElement>('.room-password-toggle-knob')!.style.transform =
      'translateX(20px)';
  });
  await page.waitForTimeout(400);
  expect
    .soft(
      await toggle.evaluate((node) => {
        const pill = node.getBoundingClientRect();
        const knob = node.querySelector('.room-password-toggle-knob')!.getBoundingClientRect();
        return {
          inside: knob.left >= pill.left - 1 && knob.right <= pill.right + 1,
          atInlineEnd: knob.left + knob.width / 2 < pill.left + pill.width / 2,
        };
      }),
      'the switched-on knob',
    )
    .toEqual({ inside: true, atInlineEnd: true });
  await toggle.evaluate((node) => {
    node.classList.remove('active');
    node.setAttribute('aria-checked', 'false');
    node.querySelector<HTMLElement>('.room-password-toggle-knob')!.style.transform = '';
  });

  // The administrator permission switch, on, as its dialog renders it: the
  // knob also travels to the inline end and stays inside its pill.
  await page.evaluate(() => {
    const overlay = document.getElementById('administrator-permissions-overlay')!;
    overlay.classList.add('show');
    overlay.querySelector('.administrator-permission-row')!.setAttribute('aria-checked', 'true');
  });
  await page.waitForTimeout(400);
  expect
    .soft(
      await page.evaluate(() => {
        const overlay = document.getElementById('administrator-permissions-overlay')!;
        const row = overlay.querySelector('.administrator-permission-row')!;
        const pill = row.querySelector('.administrator-permission-toggle')!.getBoundingClientRect();
        const knob = row
          .querySelector('.administrator-permission-toggle-knob')!
          .getBoundingClientRect();
        row.setAttribute('aria-checked', 'false');
        overlay.classList.remove('show');
        return {
          shown: pill.width > 0,
          inside: knob.left >= pill.left - 1 && knob.right <= pill.right + 1,
          atInlineEnd: knob.left + knob.width / 2 < pill.left + pill.width / 2,
        };
      }),
      'the switched-on administrator permission knob',
    )
    .toEqual({ shown: true, inside: true, atInlineEnd: true });

  // The demo's control panel reaches the screen edge on its own side and
  // keeps the column gap to the stage, as it does on the right in English.
  await page.locator('#nav-play').click();
  await page.evaluate(() => {
    (
      window as unknown as { __MUSIXQUARE_BUS__: { emit(event: string): void } }
    ).__MUSIXQUARE_BUS__.emit('demo:enter');
  });
  await expect(page.locator('#demo-overlay')).toHaveClass(/active/);
  await page.waitForTimeout(1_500);
  expect
    .soft(
      await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.demo-mobile-shell')!;
        const control = document.querySelector('.demo-control-stage')!.getBoundingClientRect();
        const visual = document.querySelector('.demo-visual-stage')!.getBoundingClientRect();
        const gap = Number.parseFloat(getComputedStyle(shell).columnGap);
        return {
          // + 0 turns a rounded -0 into 0.
          edge: Math.round(control.left) + 0,
          gap: Math.round(visual.left - control.right - gap) + 0,
        };
      }),
      'the demo control panel',
    )
    .toEqual({ edge: 0, gap: 0 });

  // On a short screen the panel scrolls; its scrollbar sits on the panel.
  await page.setViewportSize({ width: 864, height: 303 });
  await page.waitForTimeout(1_000);
  expect
    .soft(
      await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('.demo-control-stage')!;
        const panel = stage.getBoundingClientRect();
        const track = document
          .querySelector('.demo-mobile-shell > .cscroll-track')!
          .getBoundingClientRect();
        return {
          scrolls: stage.scrollHeight > stage.clientHeight,
          onThePanel: track.left >= panel.left - 1 && track.right <= panel.right + 1,
        };
      }),
      'the demo panel scrollbar',
    )
    .toEqual({ scrolls: true, onThePanel: true });
});

// The skip link appears on focus 16px from the screen edge where reading
// starts: the right in Arabic, the left in English.
for (const { language, width, height } of [
  { language: 'ar', width: 390, height: 844 },
  { language: 'ar', width: 1440, height: 900 },
  { language: 'en', width: 390, height: 844 },
  { language: 'en', width: 1440, height: 900 },
]) {
  test(`the skip link appears at the reading-start corner (${language} ${width}x${height})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const rtl = language === 'ar';
    await openInLanguage(page, language, width, height);
    await setupHostAndStart(page);
    await expect(page.locator('html')).toHaveAttribute('dir', rtl ? 'rtl' : 'ltr');
    await page
      .waitForFunction(() => !document.querySelector('.app-entrance'), undefined, {
        timeout: 8_000,
      })
      .catch(() => undefined);

    // Focused directly: after the setup clicks, the first Tab need not reach it.
    const link = page.locator('.skip-link');
    await link.focus();
    await expect(link).toBeFocused();
    await expect(link).toHaveCSS('top', '0px');
    const edgeGap = await link.evaluate((node, fromRight) => {
      const rect = node.getBoundingClientRect();
      return fromRight ? innerWidth - rect.right : rect.left;
    }, rtl);
    expect(Math.abs(edgeGap - 16)).toBeLessThanOrEqual(TOLERANCE_PX);
  });
}

// On desktop the settings column's parts slide in as a room opens, from the
// screen edge beside the column: the right in English, the left in Arabic.
// Until then each part waits 30px out toward that edge.
const SETTINGS_ENTRANCE_TARGETS = [
  '#tab-settings > .tab-header',
  '#tab-settings > .settings-subtab-nav',
  '#settings-language-section',
  '#theme-section',
  '#ui-sounds-section',
  '#settings-sync-section',
];

async function expectSettingsEntranceOffset(page: Page, offset: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (selectors) =>
          selectors.map(
            (selector) =>
              `${selector}: ${getComputedStyle(document.querySelector(selector)!).transform}`,
          ),
        SETTINGS_ENTRANCE_TARGETS,
      ),
    )
    .toEqual(
      SETTINGS_ENTRANCE_TARGETS.map((selector) => `${selector}: matrix(1, 0, 0, 1, ${offset}, 0)`),
    );
}

for (const { language, width, height, offset } of [
  { language: 'ar', width: 1440, height: 900, offset: -30 },
  { language: 'ar', width: 1280, height: 720, offset: -30 },
  { language: 'en', width: 1440, height: 900, offset: 30 },
]) {
  test(`the desktop settings column waits at its own screen edge before a room opens (${language} ${width}x${height})`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Desktop entrance rows run in the Chromium lane.');
    await openInLanguage(page, language, width, height);
    await setupHost(page);
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    await expectSettingsEntranceOffset(page, offset);
  });
}

for (const { from, to, offset } of [
  { from: 'ar', to: 'en', offset: 30 },
  { from: 'en', to: 'ar', offset: -30 },
]) {
  test(`the desktop settings column follows a language switch on the start screen (${from} to ${to})`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Desktop entrance rows run in the Chromium lane.');
    await openInLanguage(page, from, 1440, 900);
    await page.goto('/');
    await waitForBootstrapReady(page);
    await page.waitForSelector('#btn-setup-host', { state: 'visible', timeout: 15_000 });
    await page.locator('[data-setup-language-trigger]:visible').first().click();
    await page.locator(`.language-option[data-lang="${to}"]`).click();
    await page.locator('#btn-language-dialog-done').click();
    await expect(page.locator('html')).toHaveAttribute('dir', to === 'ar' ? 'rtl' : 'ltr');
    await expectSettingsEntranceOffset(page, offset);
  });
}
