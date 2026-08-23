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

interface ControlStyles {
  backgroundColor: string;
  caretColor: string;
  forcedColorAdjust: string;
  outlineOffset: string;
  outlineStyle: string;
  outlineWidth: string;
}

async function installPreferenceAndFirstPaintProbe(
  page: Page,
  preference: ContrastPreference,
): Promise<void> {
  await page.addInitScript((storedPreference: ContrastPreference) => {
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
      localStorage.setItem('musixquare-theme', 'dark');
      if (storedPreference === 'auto') localStorage.removeItem('musixquare-contrast');
      else localStorage.setItem('musixquare-contrast', storedPreference);
    } catch {
      /* The preview origin provides storage; retain a safe fallback for harness startup. */
    }
  }, preference);
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
  return page.locator('html').evaluate<ContrastTokens>((root) => {
    const style = getComputedStyle(root);
    return {
      bg: style.getPropertyValue('--bg').trim(),
      primary: style.getPropertyValue('--primary').trim(),
      textMuted: style.getPropertyValue('--text-muted').trim(),
    };
  });
}

async function firstContrastMutation(page: Page): Promise<ContrastFirstMutation | null> {
  return page.evaluate(() => (window as ContrastProbeWindow).__mxqrContrastFirstMutation ?? null);
}

async function controlStyles(page: Page, selector: string): Promise<ControlStyles> {
  return page.locator(selector).evaluate<ControlStyles>((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      caretColor: style.caretColor,
      forcedColorAdjust: style.forcedColorAdjust,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
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

    await page.emulateMedia({ contrast: 'more' });
    await expect
      .poll(() => contrastTokens(page))
      .toEqual({ bg: '#000000', primary: '#8ab4ff', textMuted: '#d0d0d0' });
    await expect(page.locator('html')).not.toHaveAttribute('data-contrast');

    await page.emulateMedia({ contrast: 'no-preference' });
    await expect
      .poll(() => contrastTokens(page))
      .toEqual({ bg: '#121212', primary: '#3b82f6', textMuted: '#71717a' });
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

  test('persisted on applies authored contrast before paint on a normal OS', async ({ page }) => {
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
    expect(await firstContrastMutation(page)).toEqual({
      operation: 'set',
      value: 'more',
      readyState: 'loading',
    });
  });

  test('forced colors preserves setup control structure, focus, and selection', async ({
    page,
  }) => {
    await page.emulateMedia({
      colorScheme: 'dark',
      contrast: 'no-preference',
      forcedColors: 'active',
    });
    await installPreferenceAndFirstPaintProbe(page, 'auto');
    await openApp(page);

    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await expect(page.locator('html')).not.toHaveAttribute('data-contrast');

    const setupButton = page.locator('#ob-next');
    await expect(setupButton).toBeVisible();
    const buttonBase = await controlStyles(page, '#ob-next');
    expect(buttonBase.outlineStyle).toBe('solid');
    expect(parseFloat(buttonBase.outlineWidth)).toBeGreaterThanOrEqual(1);
    expect(buttonBase.forcedColorAdjust).toBe('auto');

    await setupButton.evaluate((button) => button.setAttribute('aria-pressed', 'true'));
    await expect(setupButton).toHaveAttribute('aria-pressed', 'true');
    const buttonSelected = await controlStyles(page, '#ob-next');
    expect(buttonSelected.backgroundColor).not.toBe(buttonBase.backgroundColor);
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
