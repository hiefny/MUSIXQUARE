import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import cascadeLayers from '@csstools/postcss-cascade-layers';
import isPseudoClass from '@csstools/postcss-is-pseudo-class';
import { APP_FONT_SHEETS } from '../src/i18n/app-font-contract.ts';

// These are synthetic platform insets, not measurements from a physical iPad.
// Keep the real app markup, font bytes and lowered production cascade. Only
// runtime state is staged: no account, room, camera or external server is used.
const ASSET_ORIGIN = 'https://safe-area-layout.test';
const source = readFileSync('index.html', 'utf8');
const body = source
  .match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)![1]!
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
const compiledCss = postcss([cascadeLayers(), isPseudoClass({ preserve: false })])
  .process(
    ['style', 'desktop', 'rtl', 'playback-actions']
      .map((name) => readFileSync(`css/${name}.css`, 'utf8'))
      .join('\n'),
    { from: undefined },
  )
  .then((result) => result.css);

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface ViewportCase {
  name: string;
  width: number;
  height: number;
  insets: Insets;
  direction?: 'ltr' | 'rtl';
}

const none: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const ipad: Insets = { top: 24, right: 0, bottom: 20, left: 0 };
const phoneLandscape: Insets = { top: 0, right: 47, bottom: 21, left: 47 };
const cases: ViewportCase[] = [
  { name: 'compact iPad landscape', width: 1024, height: 768, insets: ipad },
  { name: 'compact iPad portrait', width: 768, height: 1024, insets: ipad },
  { name: 'taller status area', width: 1180, height: 820, insets: { ...ipad, top: 32 } },
  { name: 'wide iPad', width: 1366, height: 1024, insets: ipad },
  { name: 'short wide iPad', width: 1366, height: 768, insets: ipad },
  { name: 'short compact window', width: 1024, height: 400, insets: ipad },
  { name: 'phone landscape', width: 844, height: 390, insets: phoneLandscape },
  {
    name: 'RTL phone landscape',
    width: 844,
    height: 390,
    insets: phoneLandscape,
    direction: 'rtl',
  },
  {
    name: 'RTL left-only cutout',
    width: 844,
    height: 390,
    insets: { ...phoneLandscape, right: 0 },
    direction: 'rtl',
  },
  {
    name: 'right-only cutout',
    width: 844,
    height: 390,
    insets: { ...phoneLandscape, left: 0 },
  },
  {
    name: 'phone portrait',
    width: 390,
    height: 844,
    insets: { top: 47, right: 0, bottom: 34, left: 0 },
  },
  { name: 'compact zero-inset baseline', width: 1024, height: 768, insets: none },
  { name: 'wide zero-inset baseline', width: 1366, height: 1024, insets: none },
  {
    name: 'scaled desktop with asymmetric insets',
    width: 2560,
    height: 1440,
    insets: { top: 32, right: 47, bottom: 21, left: 0 },
    direction: 'rtl',
  },
];

test.use({ serviceWorkers: 'block' });

async function mount(page: Page, sample: ViewportCase, motion = false): Promise<void> {
  await page.setViewportSize({ width: sample.width, height: sample.height });
  await page.emulateMedia({ reducedMotion: motion ? 'no-preference' : 'reduce' });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ASSET_ORIGIN && /^\/(?:css\/fonts|fonts)\//.test(url.pathname)) {
      await route.fulfill({
        path: resolve(url.pathname.slice(1)),
        contentType: url.pathname.endsWith('.css') ? 'text/css' : 'font/woff2',
        headers: { 'access-control-allow-origin': '*' },
      });
      return;
    }
    await route.abort();
  });
  const css = (await compiledCss).replace(
    /env\(safe-area-inset-(top|right|bottom|left)(?:\s*,[^)]*)?\)/g,
    (_, side: keyof Insets) => `${sample.insets[side]}px`,
  );
  await page.setContent(`<!doctype html>
    <html class="ios ios-standalone standalone" lang="en" dir="${sample.direction ?? 'ltr'}">
    <head><meta name="viewport" content="width=device-width, initial-scale=1">
      <base href="${ASSET_ORIGIN}/">
      ${APP_FONT_SHEETS.map(({ path }) => `<link rel="stylesheet" href="/${path}">`).join('\n')}
      <style>${css}</style>
    </head><body class="fouc-loaded mode-youtube">${body}</body></html>`);
  await page.evaluate(async (height) => {
    document.documentElement.style.setProperty('--app-height', `${height}px`);
    await document.fonts.ready;
  }, sample.height);
}

async function assertSafe(locator: Locator, sample: ViewportCase): Promise<void> {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  const label = `${sample.name}: ${locator}`;
  expect(box.x, `${label} left`).toBeGreaterThanOrEqual(sample.insets.left - 1);
  expect(box.y, `${label} top`).toBeGreaterThanOrEqual(sample.insets.top - 1);
  expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(
    sample.width - sample.insets.right + 1,
  );
  expect(box.y + box.height, `${label} bottom`).toBeLessThanOrEqual(
    sample.height - sample.insets.bottom + 1,
  );
}

async function activateTab(page: Page, tab: string): Promise<void> {
  await page.evaluate((id) => {
    document.querySelectorAll('.tab-content').forEach((node) => node.classList.remove('active'));
    document.getElementById(`tab-${id}`)!.classList.add('active');
  }, tab);
}

// Scrolled text never enters the top or side insets. Below the safe bottom a
// pane may paint text while it scrolls, because from 720px wide the panes
// reach the bottom edge of the screen, but not at the end of the scroll.
async function assertScrolledText(page: Page, tab: string, sample: ViewportCase) {
  await activateTab(page, tab);
  const observed = await page.locator(`#tab-${tab} .tab-body`).evaluate((content, insets) => {
    const fixture = document.createElement('section');
    for (let index = 0; index < 40; index += 1) {
      const row = document.createElement('p');
      row.textContent = `Visible scrolling content ${index + 1}`;
      row.style.paddingBlock = '12px';
      fixture.append(row);
    }
    content.append(fixture);
    const owners: HTMLElement[] = [];
    for (let node: HTMLElement | null = content as HTMLElement; node; node = node.parentElement) {
      if (
        /auto|scroll/.test(getComputedStyle(node).overflowY) &&
        node.scrollHeight > node.clientHeight + 1
      ) {
        owners.push(node);
      }
    }
    const crossings: string[] = [];
    const passingUnderBottom: string[] = [];
    let visibleRows = 0;
    for (const owner of owners) {
      for (const fraction of [0, 0.37, 1]) {
        owner.scrollTop = (owner.scrollHeight - owner.clientHeight) * fraction;
        for (const row of fixture.children) {
          const range = document.createRange();
          range.selectNodeContents(row);
          for (const rect of range.getClientRects()) {
            let top = Math.max(0, rect.top);
            let bottom = Math.min(innerHeight, rect.bottom);
            let left = Math.max(0, rect.left);
            let right = Math.min(innerWidth, rect.right);
            for (let parent = row.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              const clip = parent.getBoundingClientRect();
              if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                top = Math.max(top, clip.top);
                bottom = Math.min(bottom, clip.bottom);
              }
              if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                left = Math.max(left, clip.left);
                right = Math.min(right, clip.right);
              }
            }
            if (bottom <= top || right <= left) continue;
            visibleRows += 1;
            // A mobile navigation/header can cover otherwise unclipped text.
            // Count only a painted fragment that can actually be hit in the
            // unsafe strip, not a text range behind opaque app chrome.
            const points: Array<[number, number]> = [];
            if (top < insets.top - 1)
              points.push([(left + right) / 2, (top + Math.min(bottom, insets.top)) / 2]);
            if (bottom > innerHeight - insets.bottom + 1)
              points.push([
                (left + right) / 2,
                (Math.max(top, innerHeight - insets.bottom) + bottom) / 2,
              ]);
            if (left < insets.left - 1)
              points.push([(left + Math.min(right, insets.left)) / 2, (top + bottom) / 2]);
            if (right > innerWidth - insets.right + 1)
              points.push([
                (Math.max(left, innerWidth - insets.right) + right) / 2,
                (top + bottom) / 2,
              ]);
            if (points.some(([x, y]) => row.contains(document.elementFromPoint(x, y)))) {
              // Below the safe bottom a pane may paint text while it scrolls;
              // what counts there is the end of the scroll.
              const onlyBottom =
                top >= insets.top - 1 &&
                left >= insets.left - 1 &&
                right <= innerWidth - insets.right + 1;
              const list = onlyBottom && fraction < 1 ? passingUnderBottom : crossings;
              list.push(
                `${owner.id || owner.className}@${fraction}: ${left},${top}..${right},${bottom}`,
              );
            }
          }
        }
      }
      owner.scrollTop = 0;
    }
    // The strip between the safe bottom and the screen edge, under the middle
    // of the innermost scroll owner: is it that scroll owner that is painted
    // there, or what lies under or around it?
    let scrollOwnsBottomStrip = false;
    const innermost = owners[0];
    if (innermost && insets.bottom > 0) {
      const box = innermost.getBoundingClientRect();
      const hit = document.elementFromPoint(
        (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2,
        innerHeight - insets.bottom / 2,
      );
      scrollOwnsBottomStrip = hit !== null && innermost.contains(hit);
    }
    fixture.remove();
    return {
      ownerCount: owners.length,
      visibleRows,
      crossings,
      passingUnderBottom,
      scrollOwnsBottomStrip,
    };
  }, sample.insets);
  expect(observed.ownerCount, `${tab} must really scroll`).toBeGreaterThan(0);
  expect(observed.visibleRows, `${tab} must paint content`).toBeGreaterThan(0);
  expect(observed.crossings, `${sample.name} ${tab} painted text enters a system inset`).toEqual(
    [],
  );
  // From 720px wide the scroll areas reach the bottom edge of the screen,
  // under the home indicator. The phone layout ends at its navigation bar.
  if (sample.width >= 720 && sample.insets.bottom > 0) {
    expect(
      observed.scrollOwnsBottomStrip,
      `${sample.name} ${tab} scrolls down to the bottom edge of the screen`,
    ).toBe(true);
  } else {
    expect(
      observed.passingUnderBottom,
      `${sample.name} ${tab} paints text below the safe bottom`,
    ).toEqual([]);
  }
}

async function showSetup(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('setup-overlay')!.classList.add('active');
    const welcome = document.getElementById('setup-welcome-area')!;
    welcome.hidden = false;
    welcome.style.display = 'flex';
    if (innerWidth >= 720) {
      document.getElementById('desktop-step-header')!.innerHTML =
        document.getElementById('setup-welcome-header')!.innerHTML;
      document
        .getElementById('desktop-diagram-area')!
        .append(document.getElementById('ob-slider-area')!);
    }
    document.getElementById('setup-actions')!.innerHTML =
      '<button class="btn-ob-secondary">Back</button><button class="btn-ob-primary">Continue</button>';
    document.querySelectorAll('.setup-brand-greeting-stage').forEach((node) => {
      node.classList.add('is-greeting-visible');
    });
    document.querySelectorAll('.setup-greeting-row').forEach((node) => {
      node.classList.add('is-visible');
    });
  });
}

for (const sample of cases) {
  test(`keeps main content safe and scrolled text out of the top and side insets (${sample.name})`, async ({
    page,
  }) => {
    await mount(page, sample);
    await assertSafe(page.locator('#app-logo'), sample);
    await assertSafe(page.locator('.video-wrapper'), sample);
    await page.locator('#main-header').evaluate((header) => header.classList.add('loading'));
    await page.waitForFunction(() => {
      const style = getComputedStyle(document.getElementById('header-loading-text')!);
      return Number(style.opacity) === 1 && new DOMMatrixReadOnly(style.transform).m42 === 0;
    });
    await assertSafe(page.locator('#header-loading-text .header-loading-text-content'), sample);
    await page.locator('#main-header').evaluate((header) => header.classList.remove('loading'));
    // Wide dashboards embed Connect/Guide in Settings; their mobile tab roots
    // are deliberately display:none even if a stale `active` class is present.
    const tabs =
      sample.width >= 1280 && sample.height >= 720
        ? ['settings']
        : ['settings', 'connect', 'guide'];
    for (const tab of tabs) {
      await assertScrolledText(page, tab, sample);
    }
    await activateTab(page, 'playlist');
    await page.locator('#tab-playlist').evaluate((panel) => {
      const locator = document.createElement('button');
      locator.id = 'btn-playlist-current-track';
      locator.className = 'chat-scroll-down-btn playlist-current-jump-btn show';
      locator.textContent = '↓';
      panel.append(locator);
    });
    await assertSafe(page.locator('#btn-playlist-current-track'), sample);
  });

  test(`keeps setup and media actions inside system insets (${sample.name})`, async ({ page }) => {
    await mount(page, sample);
    await showSetup(page);
    await assertSafe(page.locator('#setup-actions .btn-ob-primary'), sample);
    await assertSafe(page.locator('#setup-actions .btn-ob-secondary'), sample);
    const welcomeHeader = sample.width >= 720 ? '#desktop-step-header' : '#setup-welcome-header';
    await assertSafe(page.locator(`${welcomeHeader} .setup-language-button`), sample);
    await page.locator('#setup-overlay').evaluate((node) => node.classList.remove('active'));
    for (const overlay of ['media-source-overlay', 'youtube-url-overlay']) {
      await page.locator(`#${overlay}`).evaluate((node) => node.classList.add('active'));
      await assertSafe(page.locator(`#${overlay} h2`), sample);
      for (const action of await page.locator(`#${overlay} .ob-actions button:visible`).all()) {
        await assertSafe(action, sample);
      }
      await page.locator(`#${overlay}`).evaluate((node) => node.classList.remove('active'));
    }
  });

  test(`keeps dialogs and fullscreen controls safe while backgrounds bleed (${sample.name})`, async ({
    page,
  }) => {
    await mount(page, sample);
    await page.locator('#dialog-overlay').evaluate((overlay) => {
      overlay.classList.add('show', 'dialog-reading');
      document.getElementById('dialog-message')!.textContent =
        'A long notice must scroll without covering its title or actions. '.repeat(100);
    });
    await assertSafe(page.locator('#dialog-title'), sample);
    await assertSafe(page.locator('#btn-dialog-ok'), sample);
    await page.locator('#dialog-overlay').evaluate((node) => node.classList.remove('show'));
    await page.evaluate(() => {
      document.body.classList.add('has-fake-fullscreen');
      document.querySelector('.video-wrapper')!.classList.add('fake-fullscreen');
    });
    await page.waitForFunction(() => {
      for (let node = document.querySelector('.video-wrapper'); node; node = node.parentElement) {
        if (
          node
            .getAnimations()
            .some(
              (animation) =>
                animation.effect?.getComputedTiming().iterations !== Infinity &&
                !['finished', 'idle'].includes(animation.playState),
            )
        )
          return false;
      }
      return true;
    });
    const video = (await page.locator('.video-wrapper').boundingBox())!;
    expect(video.x).toBeCloseTo(0, 0);
    expect(video.y).toBeCloseTo(0, 0);
    expect(video.width).toBeCloseTo(sample.width, 0);
    expect(video.height).toBeCloseTo(sample.height, 0);
    await assertSafe(page.locator('#btn-fullscreen'), sample);
  });
}

// In the sidebar layout every pane reaches the bottom edge of the screen,
// under the home indicator. Its end padding grows by the same inset, so the
// end of the scroll still clears the indicator, and so does its scroll
// padding, which focus scrolling reads. The Playlist pane scrolls in its body
// instead: the body takes the inset as end padding, which keeps the sticky
// selection bar above the indicator, and as scroll padding, which the
// current-track follow reads; the pane keeps the 8px it has under the body.
for (const sample of cases.filter((sample) =>
  [
    'compact iPad landscape',
    'compact iPad portrait',
    'phone landscape',
    'compact zero-inset baseline',
  ].includes(sample.name),
)) {
  test(`lets every sidebar-layout pane reach the bottom edge (${sample.name})`, async ({
    page,
  }) => {
    await mount(page, sample);
    for (const tab of ['play', 'connect', 'settings', 'guide']) {
      await activateTab(page, tab);
      const pane = page.locator(`#tab-${tab}`);
      const box = (await pane.boundingBox())!;
      expect(box.y, `${tab} top`).toBeCloseTo(sample.insets.top, 0);
      expect(box.y + box.height, `${tab} bottom`).toBeCloseTo(sample.height, 0);
      const endPadding = await pane.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node).paddingBottom),
      );
      expect(endPadding, `${tab} end padding`).toBeCloseTo(8 + sample.insets.bottom, 0);
      const scrollPadding = await pane.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node).scrollPaddingBottom),
      );
      expect(scrollPadding, `${tab} scroll padding`).toBeCloseTo(sample.insets.bottom, 0);
    }

    await activateTab(page, 'playlist');
    const playlist = page.locator('#tab-playlist');
    const paneBox = (await playlist.boundingBox())!;
    expect(paneBox.y, 'playlist top').toBeCloseTo(sample.insets.top, 0);
    expect(paneBox.y + paneBox.height, 'playlist bottom').toBeCloseTo(sample.height, 0);
    const body = playlist.locator('.tab-body');
    const bodyBox = (await body.boundingBox())!;
    expect(bodyBox.y + bodyBox.height, 'playlist body bottom').toBeCloseTo(sample.height - 8, 0);
    const bodyEnds = await body.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        padding: Number.parseFloat(style.paddingBottom),
        scrollPadding: Number.parseFloat(style.scrollPaddingBottom),
      };
    });
    expect(bodyEnds.padding, 'playlist body end padding').toBeCloseTo(8 + sample.insets.bottom, 0);
    expect(bodyEnds.scrollPadding, 'playlist body scroll padding').toBeCloseTo(
      sample.insets.bottom,
      0,
    );
  });
}

// The media source and YouTube address screens open over the Play pane in the
// sidebar layout. They cover it down to the bottom edge of the screen, so the
// Play pane's last row does not show under the home indicator, and their end
// padding takes the bottom inset: their content box is the safe box.
for (const sample of cases.filter((sample) =>
  [
    'compact iPad landscape',
    'compact iPad portrait',
    'phone landscape',
    'RTL phone landscape',
    'RTL left-only cutout',
    'compact zero-inset baseline',
  ].includes(sample.name),
)) {
  test(`covers the sidebar-layout Play pane under the media screens (${sample.name})`, async ({
    page,
  }) => {
    await mount(page, sample);
    await activateTab(page, 'play');
    const playBox = (await page.locator('#tab-play').boundingBox())!;
    for (const id of ['media-source-overlay', 'youtube-url-overlay']) {
      const overlay = page.locator(`#${id}`);
      await overlay.evaluate((node) => node.classList.add('active'));
      const box = (await overlay.boundingBox())!;
      expect(box.y, `${id} top`).toBeCloseTo(sample.insets.top, 0);
      expect(box.y + box.height, `${id} bottom`).toBeCloseTo(sample.height, 0);
      expect(box.y + box.height, `${id} covers the Play pane`).toBeGreaterThanOrEqual(
        playBox.y + playBox.height - 0.5,
      );
      expect(box.x, `${id} left`).toBeCloseTo(playBox.x, 0);
      expect(box.width, `${id} width`).toBeCloseTo(playBox.width, 0);
      const endPadding = await overlay.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node).paddingBottom),
      );
      expect(endPadding, `${id} end padding`).toBeCloseTo(sample.insets.bottom, 0);
      const card = (await overlay.locator('.onboarding-card').boundingBox())!;
      expect(card.y + card.height, `${id} content end`).toBeLessThanOrEqual(
        sample.height - sample.insets.bottom + 1,
      );
      if (id === 'media-source-overlay') {
        // The close button keeps the options' inset from the pane edge, on
        // the side the writing direction puts it.
        const close = (await overlay.locator('#btn-close-media-popup').boundingBox())!;
        const option = (await overlay.locator('#btn-local-file').boundingBox())!;
        const outerEdge = (edge: { x: number; width: number }): number =>
          sample.direction === 'rtl' ? edge.x : edge.x + edge.width;
        expect(outerEdge(close), `${id} close button inset`).toBeCloseTo(outerEdge(option), 0);
      }
      await overlay.evaluate((node) => node.classList.remove('active'));
    }
  });
}

// In the wide layout the Play and Settings panels reach the bottom edge of the
// screen as well. Their bodies scroll under the home indicator and take its
// inset as end padding, so the end of the scroll still clears it.
for (const sample of cases.filter((sample) =>
  [
    'wide iPad',
    'short wide iPad',
    'scaled desktop with asymmetric insets',
    'wide zero-inset baseline',
  ].includes(sample.name),
)) {
  test(`lets the wide-layout Play and Settings bodies reach the bottom edge (${sample.name})`, async ({
    page,
  }) => {
    await mount(page, sample);
    for (const selector of ['#tab-play .tab-body', '#tab-settings > .tab-body']) {
      const body = page.locator(selector);
      await expect(body).toBeVisible();
      const ends = await body.evaluate((node) => {
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        // The dashboard may be scaled: turn the CSS padding into screen pixels.
        const scale = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
        const style = getComputedStyle(element);
        const padding = Number.parseFloat(style.paddingBottom) * scale;
        return {
          bottom: rect.bottom,
          contentEnd: rect.bottom - padding,
          scrollPadding: Number.parseFloat(style.scrollPaddingBottom) * scale,
        };
      });
      expect(ends.bottom, `${selector} bottom`).toBeCloseTo(sample.height, 0);
      expect(ends.contentEnd, `${selector} end of the content`).toBeLessThanOrEqual(
        sample.height - sample.insets.bottom + 1,
      );
      expect(ends.scrollPadding, `${selector} scroll padding`).toBeCloseTo(sample.insets.bottom, 0);
    }
  });
}

const veryShortCases: ViewportCase[] = [
  {
    name: 'super-compact RTL with a right-only cutout',
    width: 844,
    height: 280,
    insets: { top: 0, right: 47, bottom: 21, left: 0 },
    direction: 'rtl',
  },
  {
    name: 'very short landscape with top and bottom insets',
    width: 844,
    height: 170,
    insets: { top: 24, right: 0, bottom: 20, left: 0 },
  },
];

for (const sample of veryShortCases) {
  test(`keeps short-landscape navigation and its content scrollbar aligned (${sample.name})`, async ({
    page,
  }) => {
    await mount(page, sample);
    const buttons = page.locator('.bottom-nav button:visible');
    await expect(buttons).toHaveCount(4);
    for (const button of await buttons.all()) await assertSafe(button, sample);
    await assertSafe(page.locator('#role-badge'), sample);
    await assertSafe(page.locator('#btn-help-compact'), sample);
    // The decorative brand deliberately disappears below 180px. Navigation
    // and account/help actions must still fit in the remaining safe height.
    const nav = (await page.locator('.bottom-nav').boundingBox())!;
    const role = (await page.locator('#role-badge').boundingBox())!;
    expect(nav.y + nav.height).toBeLessThanOrEqual(role.y + 1);
    const centers = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return box.x + box.width / 2;
      }),
    );
    const header = (await page.locator('#main-header').boundingBox())!;
    const safeSidebarCenter = (header.x + sample.width - sample.insets.right) / 2;
    expect(centers.reduce((sum, value) => sum + value, 0) / centers.length).toBeCloseTo(
      safeSidebarCenter,
      0,
    );

    await activateTab(page, 'settings');
    // Match the viewport-owned track that custom-scrollbar.ts appends to
    // body. Runtime owns its vertical geometry; CSS owns width/physical edge.
    await page.locator('#tab-settings').evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      const track = document.createElement('div');
      track.className = 'cscroll-track';
      track.id = 'safe-area-test-scrollbar';
      track.style.top = `${bounds.top}px`;
      track.style.height = `${bounds.height}px`;
      track.innerHTML =
        '<div class="cscroll-thumb" style="height:30px"><div class="cscroll-thumb-visual"></div></div>';
      document.body.append(track);
    });
    const panel = (await page.locator('#tab-settings').boundingBox())!;
    const track = (await page.locator('#safe-area-test-scrollbar').boundingBox())!;
    expect(track.width).toBeCloseTo(8, 0);
    expect(track.x + track.width).toBeCloseTo(panel.x + panel.width, 0);
    // The track takes the pane's box (set above as the runtime would): clear
    // of the top and side insets, with the pane down to the bottom edge.
    expect(track.y).toBeGreaterThanOrEqual(sample.insets.top - 1);
    expect(track.x).toBeGreaterThanOrEqual(sample.insets.left - 1);
    expect(track.x + track.width).toBeLessThanOrEqual(sample.width - sample.insets.right + 1);
    expect(track.y + track.height).toBeCloseTo(panel.y + panel.height, 0);
    expect(panel.y + panel.height).toBeCloseTo(sample.height, 0);

    // Insets move the center of the available vertical rail by half their
    // difference, including each of the <=300px and <=180px media branches.
    await mount(page, { ...sample, insets: none });
    const baseline = (await page.locator('.bottom-nav').boundingBox())!;
    expect(nav.y + nav.height / 2 - (baseline.y + baseline.height / 2)).toBeCloseTo(
      (sample.insets.top - sample.insets.bottom) / 2,
      0,
    );
  });
}

async function changeLoadingAndMeasureClipping(page: Page, active: boolean, sample: ViewportCase) {
  return page.evaluate(
    async ({ active, insets }) => {
      const header = document.getElementById('main-header')!;
      const targets = [
        document.getElementById('app-logo')!,
        document.getElementById('header-loading-text')!,
      ];
      header.classList.toggle('loading', active);
      const crossings: string[] = [];
      let paintedSamples = 0;
      for (let frame = 0; frame < 180; frame += 1) {
        await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
        for (const target of targets) {
          if (Number(getComputedStyle(target).opacity) === 0) continue;
          const rect = target.getBoundingClientRect();
          let top = Math.max(0, rect.top);
          let bottom = Math.min(innerHeight, rect.bottom);
          let left = Math.max(0, rect.left);
          let right = Math.min(innerWidth, rect.right);
          for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            const clip = ancestor.getBoundingClientRect();
            if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
              top = Math.max(top, clip.top);
              bottom = Math.min(bottom, clip.bottom);
            }
            if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
              left = Math.max(left, clip.left);
              right = Math.min(right, clip.right);
            }
          }
          if (bottom <= top || right <= left) continue;
          paintedSamples += 1;
          if (
            top < insets.top - 1 ||
            left < insets.left - 1 ||
            bottom > innerHeight - insets.bottom + 1 ||
            right > innerWidth - insets.right + 1
          ) {
            crossings.push(`${target.id}: ${left},${top}..${right},${bottom}`);
          }
        }
        if (
          targets.every((target) =>
            target
              .getAnimations()
              .every((animation) => ['finished', 'idle'].includes(animation.playState)),
          )
        )
          break;
      }
      return { crossings, paintedSamples };
    },
    { active, insets: sample.insets },
  );
}

for (const sample of cases.filter((sample) =>
  [
    'compact iPad landscape',
    'short compact window',
    'phone portrait',
    'scaled desktop with asymmetric insets',
  ].includes(sample.name),
)) {
  test(`keeps account and list-dialog actions reachable (${sample.name})`, async ({ page }) => {
    await mount(page, sample);
    for (const id of [
      'account-dialog-overlay',
      'administrator-permissions-overlay',
      'language-dialog-overlay',
      'playlist-slots-overlay',
      'playlist-transfer-overlay',
    ]) {
      const overlay = page.locator(`#${id}`);
      await overlay.evaluate((root) => {
        root.classList.add('show');
        const title = root.querySelector('.dialog-title')!;
        if (!title.textContent?.trim()) title.textContent = 'Choose an option';
        const list = root.querySelector('.language-list');
        if (list) {
          list.innerHTML = Array.from(
            { length: 40 },
            (_, index) => `<button class="language-option">Option ${index + 1}</button>`,
          ).join('');
        }
        if (root.id === 'account-dialog-overlay') {
          root.querySelector<HTMLElement>('.account-dialog')!.dataset.accountView = 'login';
          root.querySelector('#account-dialog-message')!.textContent =
            'Sign in to manage your account.';
          root.querySelector('#account-google-label')!.textContent = 'Continue with Google';
          root.querySelector('#btn-account-login-close')!.textContent = 'Close';
          for (const selector of [
            '#account-dialog-login-actions',
            '#btn-account-google',
            '#btn-account-login-close',
            '#account-legal-links',
          ]) {
            root.querySelector<HTMLElement>(selector)!.hidden = false;
          }
        }
      });
      await page.waitForFunction(
        (id) =>
          document
            .getElementById(id)!
            .getAnimations({ subtree: true })
            .every(
              (animation) =>
                animation.effect?.getComputedTiming().iterations === Infinity ||
                ['finished', 'idle'].includes(animation.playState),
            ),
        id,
      );
      await assertSafe(overlay.locator('.dialog-title:visible').first(), sample);
      const actions = overlay.locator(
        '.dialog-actions button:visible, .account-dialog-login-actions button:visible, .account-google-button:visible',
      );
      expect(await actions.count()).toBeGreaterThan(0);
      for (const action of await actions.all()) await assertSafe(action, sample);
      await overlay.evaluate((root) => root.classList.remove('show'));
    }
  });
}

for (const sample of [cases[0]!, cases.find((sample) => sample.name === 'phone portrait')!]) {
  test(`preserves loading motion and returns to the same safe brand rail (${sample.name})`, async ({
    page,
  }) => {
    await mount(page, sample, true);
    const logo = page.locator('#app-logo');
    const loader = page.locator('#header-loading-text');
    const before = (await logo.boundingBox())!;
    const idle = await loader.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        translateY: new DOMMatrixReadOnly(style.transform).m42,
        opacity: Number(style.opacity),
        transitions: style.transitionDuration.split(',').map((duration) => duration.trim()),
      };
    });
    expect(idle.opacity).toBe(0);
    expect(idle.translateY * (sample.width >= 720 ? -1 : 1)).toBeGreaterThan(0);
    expect(idle.transitions).toEqual(['1s', '0.5s']);
    const entering = await changeLoadingAndMeasureClipping(page, true, sample);
    expect(entering.paintedSamples).toBeGreaterThan(0);
    expect(entering.crossings, 'entering content must be clipped before the unsafe strip').toEqual(
      [],
    );
    await page.waitForFunction(() => {
      const node = document.getElementById('header-loading-text')!;
      return (
        Number(getComputedStyle(node).opacity) === 1 &&
        node.getAnimations().every((animation) => animation.playState === 'finished')
      );
    });
    await assertSafe(page.locator('#header-loading-text .header-loading-text-content'), sample);
    expect(await logo.evaluate((node) => Number(getComputedStyle(node).opacity))).toBe(0);
    const leaving = await changeLoadingAndMeasureClipping(page, false, sample);
    expect(leaving.paintedSamples).toBeGreaterThan(0);
    expect(leaving.crossings, 'leaving content must be clipped before the unsafe strip').toEqual(
      [],
    );
    await page.waitForFunction(() => {
      const logo = document.getElementById('app-logo')!;
      const loader = document.getElementById('header-loading-text')!;
      return (
        Number(getComputedStyle(logo).opacity) === 1 &&
        Number(getComputedStyle(loader).opacity) === 0 &&
        [...logo.getAnimations(), ...loader.getAnimations()].every(
          (animation) => animation.playState === 'finished',
        )
      );
    });
    await assertSafe(logo, sample);
    const after = (await logo.boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });
}
