import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

const VIEWPORTS = [
  { name: 'mobile portrait', width: 390, height: 844 },
  { name: 'short landscape', width: 844, height: 390 },
  { name: 'wide desktop', width: 1_920, height: 1_080 },
] as const;

const EDGE_TOLERANCE_PX = 1;

async function expectSettledHero(page: Page): Promise<void> {
  const hero = page.locator('.lp-hero');
  await hero.scrollIntoViewIfNeeded();
  await expect(hero).toBeVisible();
  await expect(hero).toHaveClass(/is-visible/);
  await expect(hero).toHaveCSS('opacity', '1');
  await expect(page.locator('html')).not.toHaveClass(/static-lang-page-locked/);
}

async function expectEnglishAboutHead(page: Page): Promise<void> {
  await expect(page).toHaveTitle('About · MUSIXQUARE');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'https://musixquare.com/about',
  );
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    'https://musixquare.com/about',
  );
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'MUSIXQUARE turns multiple phones, tablets, and laptops into one synchronized sound system. Browser-native. No install.',
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    'About · MUSIXQUARE',
  );
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    'content',
    'Every device, one system. Multi-device synchronized audio, no install.',
  );
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'en_US');
}

async function expectAppEntryLinks(page: Page, expectedPath: string): Promise<void> {
  for (const selector of [
    '.lp-try',
    '.lp-cta .lp-btn--lg',
    '.lp-footer a[data-i18n="footer.app"]',
  ]) {
    await expect(page.locator(selector)).toHaveAttribute('href', expectedPath);
  }
}

test.describe('About page closing divider', () => {
  for (const viewport of VIEWPORTS) {
    test(`matches the full-width footer rule without overflow in ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/about.html');

      const cta = page.locator('.lp-cta');
      const divider = page.locator('hr.lp-divider.lp-divider--full');
      const footer = page.locator('.lp-footer');

      await expect(cta).toBeVisible();
      await expect(divider).toHaveCount(1);
      await expect(footer).toBeVisible();

      const geometry = await page.evaluate(() => {
        const ctaElement = document.querySelector<HTMLElement>('.lp-cta');
        const dividerElement = document.querySelector<HTMLElement>(
          'hr.lp-divider.lp-divider--full',
        );
        const footerElement = document.querySelector<HTMLElement>('.lp-footer');
        if (!ctaElement || !dividerElement || !footerElement) {
          throw new Error('Missing About closing geometry target');
        }
        if (ctaElement.previousElementSibling !== dividerElement) {
          throw new Error('The full-width divider must immediately precede the CTA');
        }

        const dividerRect = dividerElement.getBoundingClientRect();
        const footerRuleWidth = Number.parseFloat(
          getComputedStyle(footerElement, '::before').width,
        );

        return {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          divider: {
            left: dividerRect.left,
            right: dividerRect.right,
            width: dividerRect.width,
          },
          footerRuleWidth,
        };
      });

      expect(geometry.clientWidth).toBe(viewport.width);
      expect(geometry.divider.left).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
      expect(geometry.divider.right).toBeLessThanOrEqual(geometry.clientWidth + EDGE_TOLERANCE_PX);
      expect(Math.abs(geometry.divider.width - geometry.clientWidth)).toBeLessThanOrEqual(
        EDGE_TOLERANCE_PX,
      );
      expect(Math.abs(geometry.divider.width - geometry.footerRuleWidth)).toBeLessThanOrEqual(
        EDGE_TOLERANCE_PX,
      );
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + EDGE_TOLERANCE_PX);
      expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(
        geometry.clientWidth + EDGE_TOLERANCE_PX,
      );
    });
  }
});

test.describe('About language route intent', () => {
  test.use({ locale: 'ko-KR' });

  test('adapts a fresh Korean browser at the shared About URL with a settled reveal', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const documentRequests: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documentRequests.push(request.url());
      }
    });
    const response = await page.goto('/about?campaign=browser#top');

    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.locator('h1')).toHaveText(/모든 기기를\s*하나의 시스템으로/u);
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/about' && url.search === '?campaign=browser' && url.hash === '#top',
    );
    await expectEnglishAboutHead(page);
    await expectAppEntryLinks(page, '/');
    await expectSettledHero(page);
    expect(documentRequests).toHaveLength(1);
  });

  test('prefers the saved app language over stale static and browser preferences without changing its search head', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mxqr-landing-lang', 'en');
      localStorage.setItem('musixquare-lang', 'ja');
    });
    await page.goto('/about');

    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.locator('h1')).toHaveText(/すべての端末を\s*ひとつの音へ/u);
    await expect(page).toHaveURL((url) => url.pathname === '/about');
    await expectEnglishAboutHead(page);
    await expectAppEntryLinks(page, '/');
    await expectSettledHero(page);
    expect(
      await page.evaluate(() => ({
        about: localStorage.getItem('mxqr-landing-lang'),
        app: localStorage.getItem('musixquare-lang'),
      })),
    ).toEqual({ about: 'en', app: 'ja' });
  });

  test('ignores a stale static preference when shared About follows the browser language', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mxqr-landing-lang', 'ja');
      localStorage.setItem('musixquare-lang', 'system');
    });
    await page.goto('/about');

    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.locator('h1')).toHaveText(/모든 기기를\s*하나의 시스템으로/u);
    await expectEnglishAboutHead(page);
    await expectAppEntryLinks(page, '/');
    await expectSettledHero(page);
  });

  test('serves explicit English About without a redirect and preserves English app entry intent', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mxqr-landing-lang', 'ko');
      localStorage.setItem('musixquare-lang', 'ko');
    });
    const documentRequests: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documentRequests.push(request.url());
      }
    });
    const response = await page.goto('/en/about');

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL((url) => url.pathname === '/en/about');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toHaveText(/Every device,\s*one system\./u);
    await expectEnglishAboutHead(page);
    await expectAppEntryLinks(page, '/en/');
    await expectSettledHero(page);
    expect(documentRequests).toHaveLength(1);

    const activeAboutTab = page.locator('.editorial-site-tab[aria-current="page"]');
    await expect(activeAboutTab).toHaveAttribute('href', '/en/about');
    await Promise.all([page.waitForEvent('domcontentloaded'), activeAboutTab.click()]);
    await expect(page).toHaveURL((url) => url.pathname === '/en/about');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expectEnglishAboutHead(page);
    await expectAppEntryLinks(page, '/en/');
    await expectSettledHero(page);
    expect(documentRequests).toHaveLength(2);

    await page.locator('.lp-try').click();
    await waitForBootstrapReady(page);
    await expect(page).toHaveURL((url) => url.pathname === '/en/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#btn-setup-host')).toHaveText('Create a Room');
    expect(await page.evaluate(() => localStorage.getItem('musixquare-lang'))).toBe('ko');
  });

  test('keeps footer language selection as document navigation with an explicit English destination', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem('musixquare-lang')) localStorage.setItem('musixquare-lang', 'ja');
      if (!localStorage.getItem('mxqr-landing-lang'))
        localStorage.setItem('mxqr-landing-lang', 'en');
    });
    const documentRequests: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documentRequests.push(request.url());
      }
    });
    await page.goto('/about?campaign=picker#top');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expectSettledHero(page);
    await page.evaluate(() => {
      (document as Document & { __aboutPickerSentinel?: boolean }).__aboutPickerSentinel = true;
    });

    await page.locator('[data-static-lang-trigger]').click();
    await expect(page.locator('[data-static-lang-menu]')).toBeVisible();
    await expect(page.locator('[data-lang-set="en"]')).toHaveAttribute(
      'href',
      '/en/about?campaign=picker#top',
    );
    await page.locator('[data-lang-set="ko"]').click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/ko/about' && url.search === '?campaign=picker' && url.hash === '#top',
    );
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page).toHaveTitle('MUSIXQUARE 소개');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://musixquare.com/ko/about',
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      'content',
      'https://musixquare.com/ko/about',
    );
    await expectAppEntryLinks(page, '/ko/');
    await expectSettledHero(page);
    expect(
      await page.evaluate(
        () => (document as Document & { __aboutPickerSentinel?: boolean }).__aboutPickerSentinel,
      ),
    ).toBeUndefined();

    await page.locator('[data-static-lang-trigger]').click();
    await page.locator('[data-lang-set="en"]').click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/en/about' && url.search === '?campaign=picker' && url.hash === '#top',
    );
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expectEnglishAboutHead(page);
    await expectAppEntryLinks(page, '/en/');
    await expectSettledHero(page);
    expect(documentRequests).toHaveLength(3);
  });
});
