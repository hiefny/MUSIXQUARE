import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

type ContrastPreference = 'auto' | 'on' | 'off';

interface ContrastFirstMutation {
  operation: 'set' | 'remove';
  value: string | null;
  readyState: DocumentReadyState;
}

interface ContrastProbeWindow extends Window {
  __mxqrContrastFirstMutation?: ContrastFirstMutation;
}

interface ContrastTokens {
  bg: string;
  primary: string;
  textMuted: string;
}

interface SemanticFillTokens {
  danger: string;
  primary: string;
  success: string;
  warning: string;
  youtube: string;
}

interface LightContrastHierarchy {
  bg: string;
  divider: string;
  surface1: string;
  surface2: string;
  surface3: string;
  textMain: string;
}

interface ControlStyles {
  backgroundColor: string;
  borderRadius: string;
  borderStyle: string;
  borderWidth: string;
  boxShadow: string;
  caretColor: string;
  filter: string;
  forcedColorAdjust: string;
  opacity: string;
  outlineOffset: string;
  outlineStyle: string;
  outlineWidth: string;
}

type ControlStructure = Pick<
  ControlStyles,
  | 'borderRadius'
  | 'borderStyle'
  | 'borderWidth'
  | 'boxShadow'
  | 'filter'
  | 'opacity'
  | 'outlineOffset'
  | 'outlineStyle'
  | 'outlineWidth'
>;

async function installPreferenceAndFirstPaintProbe(
  page: Page,
  preference: ContrastPreference,
  theme: 'dark' | 'light' = 'dark',
): Promise<void> {
  await page.addInitScript(
    ({ storedPreference, storedTheme }) => {
      const probeWindow = window as ContrastProbeWindow;
      const nativeSetAttribute = Element.prototype.setAttribute;
      const nativeRemoveAttribute = Element.prototype.removeAttribute;

      const record = (operation: 'set' | 'remove', value: string | null): void => {
        if (probeWindow.__mxqrContrastFirstMutation) return;
        probeWindow.__mxqrContrastFirstMutation = {
          operation,
          value,
          readyState: document.readyState,
        };
      };

      Element.prototype.setAttribute = function (this: Element, name: string, value: string): void {
        if (this === document.documentElement && name === 'data-contrast') record('set', value);
        nativeSetAttribute.call(this, name, value);
      };
      Element.prototype.removeAttribute = function (this: Element, name: string): void {
        if (this === document.documentElement && name === 'data-contrast') record('remove', null);
        nativeRemoveAttribute.call(this, name);
      };

      try {
        localStorage.setItem('musixquare-theme', storedTheme);
        if (storedPreference === 'auto') localStorage.removeItem('musixquare-contrast');
        else localStorage.setItem('musixquare-contrast', storedPreference);
      } catch {
        /* The preview origin provides storage; retain a safe fallback for harness startup. */
      }
    },
    { storedPreference: preference, storedTheme: theme },
  );
}

async function openApp(page: Page): Promise<void> {
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page);
}

async function contrastTokens(page: Page): Promise<ContrastTokens> {
  const tokens = await page.evaluate<{ root: ContrastTokens; body: ContrastTokens }>(() => {
    const readTokens = (element: Element): ContrastTokens => {
      const style = getComputedStyle(element);
      return {
        bg: style.getPropertyValue('--bg').trim(),
        primary: style.getPropertyValue('--primary').trim(),
        textMuted: style.getPropertyValue('--text-muted').trim(),
      };
    };
    return {
      root: readTokens(document.documentElement),
      body: readTokens(document.body),
    };
  });
  expect(tokens.body).toEqual(tokens.root);
  return tokens.body;
}

async function semanticFillTokens(page: Page): Promise<SemanticFillTokens> {
  const tokens = await page.evaluate<{ root: SemanticFillTokens; body: SemanticFillTokens }>(() => {
    const readTokens = (element: Element): SemanticFillTokens => {
      const style = getComputedStyle(element);
      return {
        danger: style.getPropertyValue('--danger-filled').trim(),
        primary: style.getPropertyValue('--primary-filled').trim(),
        success: style.getPropertyValue('--success-filled').trim(),
        warning: style.getPropertyValue('--warning-filled').trim(),
        youtube: style.getPropertyValue('--youtube-filled').trim(),
      };
    };
    return {
      root: readTokens(document.documentElement),
      body: readTokens(document.body),
    };
  });
  expect(tokens.body).toEqual(tokens.root);
  return tokens.body;
}

async function lightContrastHierarchy(page: Page): Promise<LightContrastHierarchy> {
  const hierarchy = await page.evaluate<{
    root: LightContrastHierarchy;
    body: LightContrastHierarchy;
  }>(() => {
    const readHierarchy = (element: Element): LightContrastHierarchy => {
      const style = getComputedStyle(element);
      return {
        bg: style.getPropertyValue('--bg').trim(),
        divider: style.getPropertyValue('--divider').trim(),
        surface1: style.getPropertyValue('--surface-1').trim(),
        surface2: style.getPropertyValue('--surface-2').trim(),
        surface3: style.getPropertyValue('--surface-3').trim(),
        textMain: style.getPropertyValue('--text-main').trim(),
      };
    };
    return {
      root: readHierarchy(document.documentElement),
      body: readHierarchy(document.body),
    };
  });
  expect(hierarchy.body).toEqual(hierarchy.root);
  return hierarchy.body;
}

async function firstContrastMutation(page: Page): Promise<ContrastFirstMutation | null> {
  return page.evaluate(() => (window as ContrastProbeWindow).__mxqrContrastFirstMutation ?? null);
}

async function controlStyles(page: Page, selector: string): Promise<ControlStyles> {
  return page.locator(selector).evaluate<ControlStyles>((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderStyle: style.borderStyle,
      borderWidth: style.borderWidth,
      boxShadow: style.boxShadow,
      caretColor: style.caretColor,
      filter: style.filter,
      forcedColorAdjust: style.forcedColorAdjust,
      opacity: style.opacity,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
}

function controlStructure(styles: ControlStyles): ControlStructure {
  return {
    borderRadius: styles.borderRadius,
    borderStyle: styles.borderStyle,
    borderWidth: styles.borderWidth,
    boxShadow: styles.boxShadow,
    filter: styles.filter,
    opacity: styles.opacity,
    outlineOffset: styles.outlineOffset,
    outlineStyle: styles.outlineStyle,
    outlineWidth: styles.outlineWidth,
  };
}

test.describe('OS contrast CSS integration', () => {
  test('keeps normal tokens and follows prefers-contrast changes live in auto mode', async ({
    page,
  }) => {
    await page.emulateMedia({
      colorScheme: 'dark',
      contrast: 'no-preference',
      forcedColors: 'none',
    });
    await installPreferenceAndFirstPaintProbe(page, 'auto');
    await openApp(page);

    await expect(page.locator('html')).not.toHaveAttribute('data-contrast');
    expect(await contrastTokens(page)).toEqual({
      bg: '#121212',
      primary: '#3b82f6',
      textMuted: '#71717a',
    });
    const buttonStructure = controlStructure(await controlStyles(page, '#ob-next'));
    const flatControlStructure = controlStructure(
      await controlStyles(page, '#setup-role-grid .ch-opt:first-child'),
    );

    await page.emulateMedia({ contrast: 'more' });
    await expect
      .poll(() => contrastTokens(page))
      .toEqual({ bg: '#000000', primary: '#8ab4ff', textMuted: '#d0d0d0' });
    expect(await semanticFillTokens(page)).toEqual({
      danger: '#a4001d',
      primary: '#0047a8',
      success: '#006b3c',
      warning: '#6b4100',
      youtube: '#a4001d',
    });
    await expect(page.locator('html')).not.toHaveAttribute('data-contrast');
    expect(controlStructure(await controlStyles(page, '#ob-next'))).toEqual(buttonStructure);
    expect(
      controlStructure(await controlStyles(page, '#setup-role-grid .ch-opt:first-child')),
    ).toEqual(flatControlStructure);

    const setupButton = page.locator('#ob-next');
    await setupButton.focus();
    const focused = await controlStyles(page, '#ob-next');
    expect(focused.outlineStyle).toBe('solid');
    expect(parseFloat(focused.outlineWidth)).toBeGreaterThanOrEqual(2);
    expect(parseFloat(focused.outlineWidth)).toBeLessThan(3);

    await page.emulateMedia({ contrast: 'no-preference' });
    await expect
      .poll(() => contrastTokens(page))
      .toEqual({ bg: '#121212', primary: '#3b82f6', textMuted: '#71717a' });
  });

  test('inherits the ordinary light palette from the document root', async ({ page }) => {
    await page.emulateMedia({
      colorScheme: 'light',
      contrast: 'no-preference',
      forcedColors: 'none',
    });
    await installPreferenceAndFirstPaintProbe(page, 'auto', 'light');
    await openApp(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).not.toHaveAttribute('data-contrast');
    expect(await lightContrastHierarchy(page)).toEqual({
      bg: '#f8f9fa',
      divider: '#d4d6d8',
      surface1: '#ffffff',
      surface2: '#eff1f3',
      surface3: '#b7b9bb',
      textMain: '#303540',
    });
    expect(
      await page.locator('body').evaluate((body) => ({
        backgroundColor: getComputedStyle(body).backgroundColor,
        color: getComputedStyle(body).color,
      })),
    ).toEqual({ backgroundColor: 'rgb(248, 249, 250)', color: 'rgb(48, 53, 64)' });
  });

  test('persisted off suppresses authored contrast even when the OS requests more', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark', contrast: 'more', forcedColors: 'none' });
    await installPreferenceAndFirstPaintProbe(page, 'off');
    await openApp(page);

    await expect(page.locator('html')).toHaveAttribute('data-contrast', 'normal');
    expect(await contrastTokens(page)).toEqual({
      bg: '#121212',
      primary: '#3b82f6',
      textMuted: '#71717a',
    });
    expect(await firstContrastMutation(page)).toEqual({
      operation: 'set',
      value: 'normal',
      readyState: 'loading',
    });
  });

  test('persisted on applies the same color-only contrast before paint', async ({ page }) => {
    await page.emulateMedia({
      colorScheme: 'dark',
      contrast: 'no-preference',
      forcedColors: 'none',
    });
    await installPreferenceAndFirstPaintProbe(page, 'on');
    await openApp(page);

    await expect(page.locator('html')).toHaveAttribute('data-contrast', 'more');
    expect(await contrastTokens(page)).toEqual({
      bg: '#000000',
      primary: '#8ab4ff',
      textMuted: '#d0d0d0',
    });
    expect(await semanticFillTokens(page)).toEqual({
      danger: '#a4001d',
      primary: '#0047a8',
      success: '#006b3c',
      warning: '#6b4100',
      youtube: '#a4001d',
    });
    expect(await firstContrastMutation(page)).toEqual({
      operation: 'set',
      value: 'more',
      readyState: 'loading',
    });

    const buttonWithOverride = controlStructure(await controlStyles(page, '#ob-next'));
    const flatControlWithOverride = controlStructure(
      await controlStyles(page, '#setup-role-grid .ch-opt:first-child'),
    );
    await page.locator('html').evaluate((root) => root.setAttribute('data-contrast', 'normal'));
    expect(controlStructure(await controlStyles(page, '#ob-next'))).toEqual(buttonWithOverride);
    expect(
      controlStructure(await controlStyles(page, '#setup-role-grid .ch-opt:first-child')),
    ).toEqual(flatControlWithOverride);

    const setupButton = page.locator('#ob-next');
    await setupButton.focus();
    const focusedWithoutOverride = controlStructure(await controlStyles(page, '#ob-next'));
    await page.locator('html').evaluate((root) => root.setAttribute('data-contrast', 'more'));
    expect(controlStructure(await controlStyles(page, '#ob-next'))).toEqual(focusedWithoutOverride);
  });

  test('persisted on preserves the light palette surface hierarchy', async ({ page }) => {
    await page.emulateMedia({
      colorScheme: 'light',
      contrast: 'no-preference',
      forcedColors: 'none',
    });
    await installPreferenceAndFirstPaintProbe(page, 'on', 'light');
    await openApp(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-contrast', 'more');
    expect(await lightContrastHierarchy(page)).toEqual({
      bg: '#f2f2f2',
      divider: '#d4d6d8',
      surface1: '#ffffff',
      surface2: '#d4d4d4',
      surface3: '#a8a8a8',
      textMain: '#000000',
    });
    expect(await semanticFillTokens(page)).toEqual({
      danger: '#a4001d',
      primary: '#0047a8',
      success: '#006b3c',
      warning: '#6b4100',
      youtube: '#a4001d',
    });
    expect(await page.locator('body').evaluate((body) => getComputedStyle(body).color)).toBe(
      'rgb(0, 0, 0)',
    );
    expect(
      await page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor),
    ).toBe('rgb(242, 242, 242)');
  });

  test('OS auto contrast applies the same light palette to the rendered body', async ({ page }) => {
    await page.emulateMedia({
      colorScheme: 'light',
      contrast: 'more',
      forcedColors: 'none',
    });
    await installPreferenceAndFirstPaintProbe(page, 'auto', 'light');
    await openApp(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).not.toHaveAttribute('data-contrast');
    expect(await lightContrastHierarchy(page)).toEqual({
      bg: '#f2f2f2',
      divider: '#d4d6d8',
      surface1: '#ffffff',
      surface2: '#d4d4d4',
      surface3: '#a8a8a8',
      textMain: '#000000',
    });
    expect(
      await page.locator('body').evaluate((body) => ({
        backgroundColor: getComputedStyle(body).backgroundColor,
        color: getComputedStyle(body).color,
      })),
    ).toEqual({ backgroundColor: 'rgb(242, 242, 242)', color: 'rgb(0, 0, 0)' });
  });

  test('forced colors outranks authored contrast and preserves control structure', async ({
    page,
  }) => {
    await page.emulateMedia({
      colorScheme: 'dark',
      contrast: 'more',
      forcedColors: 'active',
    });
    await installPreferenceAndFirstPaintProbe(page, 'on', 'light');
    await openApp(page);

    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-contrast', 'more');
    expect(await contrastTokens(page)).toEqual({
      bg: 'Canvas',
      primary: 'LinkText',
      textMuted: 'CanvasText',
    });

    const setupButton = page.locator('#ob-next');
    await expect(setupButton).toBeVisible();
    const buttonBase = await controlStyles(page, '#ob-next');
    expect(buttonBase.outlineStyle).toBe('solid');
    expect(parseFloat(buttonBase.outlineWidth)).toBeGreaterThanOrEqual(1);
    expect(buttonBase.forcedColorAdjust).toBe('auto');

    await setupButton.evaluate((button) => button.setAttribute('aria-pressed', 'true'));
    await expect(setupButton).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => (await controlStyles(page, '#ob-next')).backgroundColor)
      .not.toBe(buttonBase.backgroundColor);
    const buttonSelected = await controlStyles(page, '#ob-next');
    expect(buttonSelected.outlineStyle).toBe('solid');
    expect(parseFloat(buttonSelected.outlineWidth)).toBeGreaterThanOrEqual(1);

    const setupInput = page.locator('#setup-join-code');
    await setupInput.evaluate((input) => {
      const element = input as HTMLInputElement;
      document.body.appendChild(element);
      Object.assign(element.style, {
        display: 'block',
        position: 'fixed',
        inset: '24px auto auto 24px',
        zIndex: '10000',
      });
    });
    await expect(setupInput).toBeVisible();

    const inputBase = await controlStyles(page, '#setup-join-code');
    expect(inputBase.outlineStyle).toBe('solid');
    expect(parseFloat(inputBase.outlineWidth)).toBeGreaterThanOrEqual(1);
    expect(inputBase.forcedColorAdjust).toBe('auto');

    await setupInput.focus();
    await expect(setupInput).toBeFocused();
    const inputFocused = await controlStyles(page, '#setup-join-code');
    expect(inputFocused.outlineStyle).toBe('solid');
    expect(parseFloat(inputFocused.outlineWidth)).toBeGreaterThanOrEqual(3);
    expect(parseFloat(inputFocused.outlineOffset)).toBeGreaterThanOrEqual(2);
    expect(inputFocused.caretColor).not.toBe('rgba(0, 0, 0, 0)');
  });
});
