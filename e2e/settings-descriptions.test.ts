import { expect, test, type Locator, type Page } from '@playwright/test';
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
  { description: '#settings-role-description', control: '#grid-standard' },
  { description: '#settings-sync-description', control: '#grid-settings-sync' },
  { description: '#settings-reverb-description', control: '#grid-reverb' },
  { description: '#settings-eq-description', control: '#grid-eq' },
  { description: '#settings-virtual-effects-description', control: '#grid-virtual-effects' },
];

const ALL_SETTINGS = [...GENERAL_SETTINGS, ...AUDIO_SETTINGS];

const SYNCHRONIZED_EFFECT_TITLE_IDS = [
  'settings-reverb-title',
  'settings-eq-title',
  'settings-virtual-effects-title',
] as const;

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

async function expectRenderedDirectSvgPath(svg: Locator, label: string): Promise<void> {
  await svg.scrollIntoViewIfNeeded();
  await expect(svg, `${label} SVG should be visible`).toBeVisible();

  const rendering = await svg.evaluate((svgElement) => {
    const svgRoot = svgElement as SVGSVGElement;
    const svgRect = svgRoot.getBoundingClientRect();
    const directPaths = Array.from(svgRoot.children).filter(
      (child): child is SVGPathElement => child.tagName.toLowerCase() === 'path',
    );

    const paths = directPaths.map((path) => {
      const box = path.getBBox();
      const matrix = path.getScreenCTM();
      const style = getComputedStyle(path);
      const opacity = Number.parseFloat(style.opacity || '1');
      const fillOpacity = Number.parseFloat(style.fillOpacity || '1');
      const strokeOpacity = Number.parseFloat(style.strokeOpacity || '1');
      const hasPaint =
        (style.fill !== 'none' && style.fill !== 'transparent' && fillOpacity > 0) ||
        (style.stroke !== 'none' && style.stroke !== 'transparent' && strokeOpacity > 0);

      if (!matrix) {
        return {
          geometryWidth: box.width,
          geometryHeight: box.height,
          screenWidth: 0,
          screenHeight: 0,
          visible: false,
          intersectsSvg: false,
          intersectsViewport: false,
        };
      }

      const corners = [
        new DOMPoint(box.x, box.y),
        new DOMPoint(box.x + box.width, box.y),
        new DOMPoint(box.x, box.y + box.height),
        new DOMPoint(box.x + box.width, box.y + box.height),
      ].map((point) => point.matrixTransform(matrix));
      const left = Math.min(...corners.map(({ x }) => x));
      const right = Math.max(...corners.map(({ x }) => x));
      const top = Math.min(...corners.map(({ y }) => y));
      const bottom = Math.max(...corners.map(({ y }) => y));

      return {
        geometryWidth: box.width,
        geometryHeight: box.height,
        screenWidth: right - left,
        screenHeight: bottom - top,
        visible:
          style.display !== 'none' && style.visibility !== 'hidden' && opacity > 0 && hasPaint,
        intersectsSvg:
          right > svgRect.left &&
          bottom > svgRect.top &&
          left < svgRect.right &&
          top < svgRect.bottom,
        intersectsViewport:
          right > 0 &&
          bottom > 0 &&
          left < document.documentElement.clientWidth &&
          top < document.documentElement.clientHeight,
      };
    });

    return {
      svgWidth: svgRect.width,
      svgHeight: svgRect.height,
      directPathCount: directPaths.length,
      descendantUseCount: svgRoot.querySelectorAll('use').length,
      paths,
    };
  });

  expect(rendering.svgWidth, `${label} SVG should have layout width`).toBeGreaterThan(0);
  expect(rendering.svgHeight, `${label} SVG should have layout height`).toBeGreaterThan(0);
  expect(rendering.directPathCount, `${label} should contain a direct child path`).toBeGreaterThan(
    0,
  );
  expect(rendering.descendantUseCount, `${label} should not depend on a fragment use`).toBe(0);
  expect(
    rendering.paths.some(
      ({
        geometryWidth,
        geometryHeight,
        screenWidth,
        screenHeight,
        visible,
        intersectsSvg,
        intersectsViewport,
      }) =>
        geometryWidth > 0 &&
        geometryHeight > 0 &&
        screenWidth > 0 &&
        screenHeight > 0 &&
        visible &&
        intersectsSvg &&
        intersectsViewport,
    ),
    `${label} direct path should paint inside both the SVG and the visible viewport`,
  ).toBe(true);
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

async function expectVirtualEffectsTwoByTwo(page: Page): Promise<void> {
  const buttons = page.locator('#grid-virtual-effects [data-virtual-effect]');
  await expect(buttons).toHaveCount(4);

  const layout = await buttons.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        effect: (element as HTMLElement).dataset.virtualEffect,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    }),
  );

  expect(layout.map(({ effect }) => effect)).toEqual(['bass', 'treble', 'surround', 'off']);
  for (const button of layout) {
    expect(button.width, `${button.effect} should have layout width`).toBeGreaterThan(0);
    expect(button.height, `${button.effect} should have layout height`).toBeGreaterThan(0);
  }

  expect(Math.abs(layout[0].top - layout[1].top)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout[2].top - layout[3].top)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout[0].left - layout[2].left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout[1].left - layout[3].left)).toBeLessThanOrEqual(1);
  expect(layout[0].right).toBeLessThan(layout[1].left);
  expect(layout[0].bottom).toBeLessThan(layout[2].top);
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

  expect(results).toHaveLength(ALL_SETTINGS.length);
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
      await page.addInitScript(() => localStorage.setItem('musixquare-lang', 'en'));
      await openSettings(page);

      await expectDesktopAlignment(page, GENERAL_SETTINGS);
      await navigateToSubtab(page, 'audio');
      await expectDesktopAlignment(page, AUDIO_SETTINGS);
      await expectVirtualEffectsTwoByTwo(page);

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
          roleDividerWidth: Number.parseFloat(getComputedStyle(role).borderBottomWidth),
        };
      });

      expect(order?.dom).toBe(true);
      expect(order?.rendered).toBe(true);
      expect(order?.roleDividerWidth).toBeGreaterThan(0);

      const roleDescriptionGap = await page.locator('#settings-role-description').evaluate((el) => {
        const diagram = el.parentElement?.querySelector<HTMLElement>('.settings-role-diagram');
        if (!diagram) return null;
        return diagram.getBoundingClientRect().top - el.getBoundingClientRect().bottom;
      });
      expect(roleDescriptionGap).not.toBeNull();
      expect(roleDescriptionGap ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(23);
      expect(roleDescriptionGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(25);

      const roleDescriptionLayout = await page
        .locator('#settings-role-description')
        .evaluate((el) => {
          const computed = getComputedStyle(el);
          const lineHeight = Number.parseFloat(computed.lineHeight);
          return {
            whiteSpace: computed.whiteSpace,
            renderedLines: el.getBoundingClientRect().height / lineHeight,
          };
        });
      expect(roleDescriptionLayout.whiteSpace).toBe('pre-line');
      expect(roleDescriptionLayout.renderedLines).toBeGreaterThanOrEqual(1.75);

      const roleCases = [
        {
          mode: '-1',
          key: 'settings.role_left_desc',
          text: 'This device is acting as the left speaker.\nPlace it on the left.',
        },
        {
          mode: '0',
          key: 'settings.role_center_desc',
          text: 'This device is acting as the center speaker.\nPlace it in the center.',
        },
        {
          mode: '1',
          key: 'settings.role_right_desc',
          text: 'This device is acting as the right speaker.\nPlace it on the right.',
        },
        {
          mode: '2',
          key: 'settings.role_subwoofer_desc',
          text: 'This device is acting as the subwoofer.\nPlace it where the bass carries well.',
        },
      ] as const;

      const roleDescription = page.locator('#settings-role-description');
      for (const { mode, key, text } of roleCases) {
        await page.locator(`#grid-standard .ch-opt[data-ch="${mode}"]`).click();
        await expect(roleDescription).toHaveAttribute('data-i18n', key);
        expect(await roleDescription.textContent()).toBe(text);
      }
    });
  });

  test.describe('mobile', () => {
    test('keeps all descriptions contained at 390px', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openSettings(page);
      await expectMobileDescriptions(page, false);
      await expectVirtualEffectsTwoByTwo(page);
    });

    test('wraps all descriptions at 320px with 200% description text', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 844 });
      await openSettings(page);
      await page.addStyleTag({
        content: '.settings-option-description { font-size: 26px !important; }',
      });
      await expectMobileDescriptions(page, true);
    });

    test('projects settings sync only onto synchronized effect headers at 320px', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 844 });
      await page.addInitScript(() => {
        localStorage.setItem('musixquare-lang', 'en');
        localStorage.setItem('musixquare-settings-sync', 'on');
      });
      await openSettings(page);

      const audioPanel = page.locator('.settings-subtab-panel[data-panel="audio"]');
      await expect(
        audioPanel.locator(
          '.badge-host-ctrl, [data-i18n="settings.host_ctrl"], [data-i18n="settings.self_ctrl"]',
        ),
      ).toHaveCount(0);

      const roleHeader = page
        .locator('.section-header-row')
        .filter({ has: page.locator('#settings-role-title') });
      await expect(roleHeader).toHaveCount(1);
      await expect(roleHeader.locator('[data-settings-sync-indicator]')).toHaveCount(0);

      const syncTitle = (await page.locator('#settings-sync-title').textContent())?.trim() || '';
      expect(syncTitle).not.toBe('');

      const syncOnIcon = page.locator('#grid-settings-sync [data-settings-sync="on"] svg');
      await expectRenderedDirectSvgPath(syncOnIcon, 'settings sync ON button icon');

      const indicators = SYNCHRONIZED_EFFECT_TITLE_IDS.map((titleId) => {
        const header = page
          .locator('.section-header-row')
          .filter({ has: page.locator(`#${titleId}`) });
        return { titleId, header, indicator: header.locator('[data-settings-sync-indicator]') };
      });
      await expect(audioPanel.locator('[data-settings-sync-indicator]')).toHaveCount(3);

      for (const { titleId, header, indicator } of indicators) {
        await expect(header, `${titleId} should have one rendered header`).toHaveCount(1);
        await expect(indicator, `${titleId} should have one settings-sync icon`).toHaveCount(1);
        await expect(
          indicator,
          `${titleId} should show sync while the default is ON`,
        ).toBeVisible();
        await expect(indicator).toHaveAttribute('type', 'button');
        await expect(indicator).toHaveAttribute('aria-label', /\S/);
        await expect(indicator).toHaveAttribute(
          'data-i18n-aria-label',
          'toast.settings_sync_enabled',
        );
        await expect(indicator.locator('svg')).toHaveAttribute('aria-hidden', 'true');
        await expect(indicator).toHaveText('');
        await expectRenderedDirectSvgPath(
          indicator.locator('svg'),
          `${titleId} settings-sync indicator`,
        );

        const geometry = await header.evaluate((headerElement) => {
          const section = headerElement.closest<HTMLElement>('.section-group');
          const title = headerElement.querySelector<HTMLElement>('.section-title');
          const icon = headerElement.querySelector<HTMLElement>('[data-settings-sync-indicator]');
          if (!section || !title || !icon) return null;

          const headerRect = headerElement.getBoundingClientRect();
          const sectionRect = section.getBoundingClientRect();
          const titleRect = title.getBoundingClientRect();
          const iconRect = icon.getBoundingClientRect();
          return {
            headerLeft: headerRect.left,
            headerRight: headerRect.right,
            sectionLeft: sectionRect.left,
            sectionRight: sectionRect.right,
            titleRight: titleRect.right,
            iconLeft: iconRect.left,
            iconRight: iconRect.right,
            headerClientWidth: headerElement.clientWidth,
            headerScrollWidth: headerElement.scrollWidth,
            viewportWidth: document.documentElement.clientWidth,
          };
        });

        expect(geometry, `${titleId} should resolve its section, title, and icon`).not.toBeNull();
        expect(geometry?.headerLeft ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(
          (geometry?.sectionLeft ?? 0) - 1,
        );
        expect(geometry?.headerRight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
          (geometry?.sectionRight ?? 0) + 1,
        );
        expect(geometry?.titleRight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
          geometry?.iconLeft ?? 0,
        );
        expect(geometry?.iconRight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
          geometry?.viewportWidth ?? 0,
        );
        expect(
          geometry?.headerScrollWidth ?? Number.POSITIVE_INFINITY,
          `${titleId} header should not overflow horizontally`,
        ).toBeLessThanOrEqual((geometry?.headerClientWidth ?? 0) + 1);
      }

      const syncIndicator = indicators[0].indicator;
      const syncToastText = (await syncIndicator.getAttribute('aria-label'))?.trim() || '';
      expect(syncToastText).not.toBe('');
      await syncIndicator.click();
      await expect(page.locator('#toast')).toHaveClass(/show/);
      await expect(page.locator('#toast-msg')).toHaveText(syncToastText);

      const syncOff = page.locator('#grid-settings-sync [data-settings-sync="off"]');
      const syncOn = page.locator('#grid-settings-sync [data-settings-sync="on"]');
      await syncOff.click();
      await expect(syncOff).toHaveAttribute('aria-pressed', 'true');
      await expect(syncOn).toHaveAttribute('aria-pressed', 'false');
      for (const { titleId, indicator } of indicators) {
        await expect(indicator, `${titleId} sync icon should hide while sync is OFF`).toBeHidden();
        await expect(indicator).toHaveAttribute('hidden', '');
      }

      await syncOn.click();
      await expect(syncOn).toHaveAttribute('aria-pressed', 'true');
      await expect(syncOff).toHaveAttribute('aria-pressed', 'false');
      for (const { titleId, indicator } of indicators) {
        await expect(indicator, `${titleId} sync icon should return when sync is ON`).toBeVisible();
        await expect(indicator).not.toHaveAttribute('hidden', '');
      }
    });
  });
});
