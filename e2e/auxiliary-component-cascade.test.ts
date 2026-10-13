import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { transform } from 'esbuild';

const readSource = (path: string): string => readFileSync(resolve(path), 'utf8');
const adminCss = readSource('public/admin.css');
const eventCss = readSource('public/events/event.css');
const editorialCss = readSource('public/editorial-base.css');
const aboutCss = readSource('public/editorial-about.css');
const designCss = readSource('public/editorial-design.css');
const blogCss = readSource('public/blog/index.html').match(/<style>([\s\S]*?)<\/style>/u)?.[1];
if (!blogCss) throw new Error('Missing blog component styles');

async function renderFixture(page: Page, css: string, body: string): Promise<void> {
  // These fixtures exercise the browser cascade with the production styles.
  // They do not need authenticated admin endpoints or the external blog feed.
  await page.route('**/*', (route) => route.abort());
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`,
  );
}

test('admin card and feedback components own their surface and typography', async ({ page }) => {
  await renderFixture(
    page,
    adminCss,
    `
    <section class="pro-grant-campaign-panel">
      <button id="action">Create event</button>
      <button class="pro-grant-campaign-item" aria-pressed="false">
        <strong>Music gathering</strong><span>Rooms 000001–000010</span>
        <span class="pro-grant-campaign-pending">Pending update</span>
      </button>
    </section>
    <form class="pro-room-transfer-form">
      <p id="copy">Transfer ownership</p>
      <p class="pro-room-transfer-note">Keep your recovery link.</p>
      <p class="pro-room-transfer-error">The room was not found.</p>
    </form>`,
  );
  const card = page.locator('.pro-grant-campaign-item');
  await expect(card).toHaveCSS('display', 'grid');
  await expect(card).toHaveCSS('min-height', '72px');
  await expect(card).toHaveCSS('padding', '12px 13px');
  await expect(card).toHaveCSS('border-radius', '8px');
  await expect(card).toHaveCSS('background-color', 'rgb(32, 32, 32)');
  // The inline-flex default is blockified because this button is a grid item.
  await expect(page.locator('#action')).toHaveCSS('display', 'flex');
  await expect(page.locator('.pro-grant-campaign-pending')).toHaveCSS('color', 'rgb(250, 204, 21)');
  await expect(page.locator('#copy')).toHaveCSS('font-size', '13px');
  await expect(page.locator('.pro-room-transfer-note')).toHaveCSS('font-size', '11px');
  await expect(page.locator('.pro-room-transfer-error')).toHaveCSS('color', 'rgb(248, 113, 113)');
  await card.hover();
  await expect(card).toHaveCSS('background-color', 'rgba(59, 130, 246, 0.04)');
  await card.evaluate((element) => element.setAttribute('aria-pressed', 'true'));
  await expect(card).toHaveCSS('background-color', 'rgba(59, 130, 246, 0.08)');
});

test('the admin clear-input affordance keeps its own surface inside a campaign form', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await renderFixture(
    page,
    adminCss,
    `
    <section class="pro-grant-campaign-panel"><form class="pro-grant-campaign-form">
      <div class="pro-grant-form-grid"><label class="pro-room-field pro-grant-form-wide">
        <span>Event title</span><input id="event-title" value="Cycling music" />
      </label></div>
    </form></section>`,
  );
  const script = await transform(readSource('browser/classic-runtime/clearable-editors.ts'), {
    loader: 'ts',
    target: 'es2018',
  });
  await page.addScriptTag({ content: script.code });
  const input = page.locator('#event-title');
  await input.focus();
  const clear = page.getByRole('button', { name: 'Clear input' });
  await expect(clear).toBeVisible();
  await expect(clear).toHaveCSS('width', '44px');
  await expect(clear).toHaveCSS('height', '44px');
  await expect(clear).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(clear).toHaveCSS('color', 'rgb(113, 113, 122)');
  await expect(clear).toHaveCSS('padding', '0px');
  await clear.click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.clearable-editor-button')).toBeHidden();
  await input.fill('Another gathering');
  await expect(clear).toBeVisible();
});

test('blog pagination hides grid cards and restores them without inline display priority', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = Array.from(
    { length: 12 },
    (_, index) => `
    <a class="soro-blog-card" href="#article-${index}">
      <img class="soro-blog-card-image" alt="" />
      <div class="soro-blog-card-content"><h3 class="soro-blog-card-title">Article ${index + 1}</h3></div>
    </a>`,
  ).join('');
  await renderFixture(
    page,
    `${editorialCss}\n${blogCss}`,
    `
    <section id="articles"><div id="soro-blog"><div class="soro-blog-list">${cards}</div>
      <div class="soro-blog-header"><a class="soro-blog-back" href="#articles">
        <span class="soro-blog-back-label">All articles</span>
      </a></div>
    </div></section>`,
  );
  const script = await transform(readSource('browser/classic-runtime/blog-pagination.ts'), {
    loader: 'ts',
    target: 'es2018',
  });
  await page.addScriptTag({ content: script.code });
  await expect(page.locator('.soro-blog-card:visible')).toHaveCount(10);
  await expect(page.locator('.soro-blog-card').nth(10)).toHaveCSS('display', 'none');
  const first = page.locator('.soro-blog-card').first();
  await expect(first).toHaveCSS('display', 'grid');
  await expect(first).toHaveCSS('padding', '14px');
  await expect(first).toHaveCSS('border-radius', '20px');
  await expect(page.locator('.soro-blog-back-label')).toHaveCSS(
    'text-decoration-thickness',
    'auto',
  );
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.soro-blog-card:visible')).toHaveCount(2);
  await expect(first).toHaveCSS('display', 'none');
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(first).toHaveCSS('display', 'grid');
  expect(
    await page
      .locator('.soro-blog-card')
      .evaluateAll((elements) =>
        elements.every((element) => !(element as HTMLElement).style.getPropertyValue('display')),
      ),
  ).toBe(true);
});

test('editorial components retain their own transform and single-column placement', async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 844 });
  await renderFixture(
    page,
    `${editorialCss}\n${aboutCss}\n${designCss}`,
    `
    <section class="lp-cta" data-animate>
      <svg class="lp-cta__wordmark lp-cta__wordmark--top"><rect width="10" height="10" /></svg>
      <div id="copy">Start listening</div>
    </section>
    <div class="grid-2 component-grid">
      <div class="component-control-layout">Controls</div><div class="messaging-comp">Chat</div>
      <div class="component-row-divider"></div><div class="nav-comp">Navigation</div>
    </div>`,
  );
  const wordmark = page.locator('.lp-cta__wordmark');
  await expect(wordmark).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 12, 0)');
  await expect(page.locator('#copy')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 16)');
  await page.locator('.lp-cta').evaluate((element) => element.classList.add('is-visible'));
  await expect(page.locator('#copy')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(wordmark).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 12, 0)');
  for (const component of await page.locator('.component-grid > *').all()) {
    await expect(component).toHaveCSS('grid-column', 'auto');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.lp-cta').evaluate((element) => element.classList.remove('is-visible'));
  await expect(wordmark).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 12, 0)');
  await expect(page.locator('#copy')).toHaveCSS('transform', 'none');
});

test('clear affordances reserve space over component and inline padding in both directions', async ({
  page,
}) => {
  for (const css of [adminCss, eventCss]) {
    for (const direction of ['ltr', 'rtl']) {
      await renderFixture(
        page,
        css,
        `
        <form class="pro-room-transfer-form" dir="${direction}"><label class="pro-room-transfer-field">
          <input class="clearable-editor-active clearable-editor-centered" value="Music"
            style="padding: 0 13px; --clearable-editor-base-padding-inline-start: 13px; --clearable-editor-base-padding-inline-end: 13px; --clearable-editor-reserved-space: 48px" />
        </label></form>`,
      );
      await expect(page.locator('input')).toHaveCSS('padding-inline-start', '61px');
      await expect(page.locator('input')).toHaveCSS('padding-inline-end', '61px');
    }
  }
});
