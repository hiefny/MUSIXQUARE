import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { navigateToSubtab, navigateToTab } from './helpers/wait.ts';

interface DescribedSetting {
  description: string;
  control: string;
}

const GENERAL_SETTINGS: DescribedSetting[] = [
  { description: '#settings-language-description', control: '#grid-lang' },
  { description: '#settings-theme-description', control: '#grid-theme' },
  { description: '#settings-ui-sounds-description', control: '#grid-ui-sounds' },
  { description: '#settings-visualizer-description', control: '#grid-visualizer' },
];

const AUDIO_SETTINGS: DescribedSetting[] = [
  { description: '#settings-sync-description', control: '#grid-settings-sync' },
  { description: '#settings-reverb-description', control: '#grid-reverb' },
  { description: '#settings-eq-description', control: '#grid-eq' },
  { description: '#settings-surround-description', control: '#grid-surround' },
  { description: '#settings-bass-description', control: '#grid-vbass' },
  { description: '#settings-exciter-description', control: '#grid-exciter' },
];

const ALL_SETTINGS = [...GENERAL_SETTINGS, ...AUDIO_SETTINGS];

async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);
  await page.locator('#btn-setup-host').waitFor({ state: 'visible' });

  // Layout checks target the initialized app, while transport/session behavior
  // remains covered by the connection suites.
  await page.evaluate(() => {
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
  });

  await navigateToTab(page, 'settings');
  await page.waitForFunction(
    (selectors) =>
      selectors.every((selector) => document.querySelector(selector)?.textContent?.trim()),
    ALL_SETTINGS.map(({ description }) => description),
  );
}

async function expectDesktopAlignment(page: Page, settings: DescribedSetting[]): Promise<void> {
  for (const { description, control } of settings) {
    const geometry = await page
      .locator(description)
      .evaluate((descriptionElement, controlSelector) => {
        const section = descriptionElement.closest('.section-group');
        const title = section?.querySelector<HTMLElement>('.section-title');
        const control = section?.querySelector<HTMLElement>(controlSelector);
        const firstControl = control?.querySelector<HTMLElement>('.ch-opt') ?? control;

        if (!section || !title || !control || !firstControl) return null;

        const sectionRect = section.getBoundingClientRect();
        const titleRect = title.getBoundingClientRect();
        const descriptionRect = descriptionElement.getBoundingClientRect();
        const firstControlRect = firstControl.getBoundingClientRect();

        return {
          titleLeft: titleRect.left,
          descriptionLeft: descriptionRect.left,
          firstControlLeft: firstControlRect.left,
          descriptionRight: descriptionRect.right,
          sectionRight: sectionRect.right,
          clientWidth: descriptionElement.clientWidth,
          scrollWidth: descriptionElement.scrollWidth,
          visible: descriptionRect.width > 0 && descriptionRect.height > 0,
        };
      }, control);

    expect(
      geometry,
      `${description} should have a title and control in its section`,
    ).not.toBeNull();
    expect(geometry?.visible, `${description} should be rendered`).toBe(true);
    expect(
      Math.abs((geometry?.descriptionLeft ?? 0) - (geometry?.titleLeft ?? 0)),
      `${description} should align with its title`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((geometry?.descriptionLeft ?? 0) - (geometry?.firstControlLeft ?? 0)),
      `${description} should align with its first control`,
    ).toBeLessThanOrEqual(1);
    expect(
      geometry?.descriptionRight ?? Number.POSITIVE_INFINITY,
      `${description} should remain inside its section`,
    ).toBeLessThanOrEqual((geometry?.sectionRight ?? 0) + 1);
    expect(
      geometry?.scrollWidth ?? Number.POSITIVE_INFINITY,
      `${description} should not overflow horizontally`,
    ).toBeLessThanOrEqual((geometry?.clientWidth ?? 0) + 1);
  }
}

async function expectMobileDescriptions(page: Page, requireWrapping: boolean): Promise<void> {
  const results = await page.evaluate(
    ({ settings, shouldWrap }) =>
      settings.map(({ description, control }) => {
        const descriptionElement = document.querySelector<HTMLElement>(description);
        const controlElement = document.querySelector<HTMLElement>(control);
        const section = descriptionElement?.closest<HTMLElement>('.section-group');
        if (!descriptionElement || !controlElement || !section) return null;

        const descriptionRect = descriptionElement.getBoundingClientRect();
        const controlRect = controlElement.getBoundingClientRect();
        const sectionRect = section.getBoundingClientRect();
        const computed = getComputedStyle(descriptionElement);
        const lineHeight = Number.parseFloat(computed.lineHeight);

        return {
          description,
          hasText: Boolean(descriptionElement.textContent?.trim()),
          isRendered: descriptionRect.width > 0 && descriptionRect.height > 0,
          horizontallyContained:
            descriptionRect.left >= sectionRect.left - 1 &&
            descriptionRect.right <= sectionRect.right + 1,
          aboveControl: descriptionRect.bottom <= controlRect.top + 1,
          horizontalOverflow: descriptionElement.scrollWidth - descriptionElement.clientWidth,
          verticalOverflow: descriptionElement.scrollHeight - descriptionElement.clientHeight,
          wrapped:
            !shouldWrap ||
            (Number.isFinite(lineHeight) && descriptionRect.height >= lineHeight * 1.75),
        };
      }),
    { settings: ALL_SETTINGS, shouldWrap: requireWrapping },
  );

  expect(results).toHaveLength(10);
  for (const result of results) {
    expect(
      result,
      'every settings description should resolve to a section and control',
    ).not.toBeNull();
    expect(result?.hasText, `${result?.description} should contain translated text`).toBe(true);
    expect(result?.isRendered, `${result?.description} should participate in layout`).toBe(true);
    expect(
      result?.horizontallyContained,
      `${result?.description} should stay inside its section`,
    ).toBe(true);
    expect(result?.aboveControl, `${result?.description} should remain above its controls`).toBe(
      true,
    );
    expect(
      result?.horizontalOverflow ?? Number.POSITIVE_INFINITY,
      `${result?.description} should not overflow horizontally`,
    ).toBeLessThanOrEqual(1);
    expect(
      result?.verticalOverflow ?? Number.POSITIVE_INFINITY,
      `${result?.description} should not be clipped vertically`,
    ).toBeLessThanOrEqual(1);
    expect(result?.wrapped, `${result?.description} should wrap at enlarged text size`).toBe(true);
  }
}

test.describe('settings description layout', () => {
  test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('aligns supporting copy and keeps role, sync, and reverb in order', async ({ page }) => {
      await openSettings(page);

      await expectDesktopAlignment(page, GENERAL_SETTINGS);
      await navigateToSubtab(page, 'audio');
      await expectDesktopAlignment(page, AUDIO_SETTINGS);

      const order = await page.evaluate(() => {
        const role = document.querySelector('#grid-standard')?.closest('.section-group');
        const sync = document.querySelector('#settings-sync-section');
        const reverb = document.querySelector('#grid-reverb')?.closest('.section-group');
        if (!role || !sync || !reverb) return null;

        const roleRect = role.getBoundingClientRect();
        const syncRect = sync.getBoundingClientRect();
        const reverbRect = reverb.getBoundingClientRect();

        return {
          dom:
            Boolean(role.compareDocumentPosition(sync) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            Boolean(sync.compareDocumentPosition(reverb) & Node.DOCUMENT_POSITION_FOLLOWING),
          rendered: roleRect.bottom <= syncRect.top + 1 && syncRect.bottom <= reverbRect.top + 1,
        };
      });

      expect(order).toEqual({ dom: true, rendered: true });
    });
  });

  test.describe('mobile', () => {
    test('keeps all descriptions contained at 390px', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openSettings(page);
      await expectMobileDescriptions(page, false);
    });

    test('wraps all descriptions at 320px with 200% description text', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 844 });
      await openSettings(page);
      await page.addStyleTag({
        content: '.settings-option-description { font-size: 26px !important; }',
      });
      await expectMobileDescriptions(page, true);
    });
  });
});
