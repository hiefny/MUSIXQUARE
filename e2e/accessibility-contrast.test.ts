import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import {
  installSyntheticSystemAudio,
  readSyntheticSystemAudio,
} from './helpers/system-audio-source.ts';
import { navigateToTab } from './helpers/wait.ts';

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

function normalizeHexColorTokens<Key extends string>(
  tokens: Record<Key, string>,
): Record<Key, string> {
  const normalized = { ...tokens };
  // CSS custom properties preserve text spelling. Compare exact colors even
  // when the minifier shortens #000000 to #000 or #ffffff to #fff.
  for (const key in normalized) {
    normalized[key] = normalized[key].replace(/^#([\da-f])([\da-f])([\da-f])$/iu, '#$1$1$2$2$3$3');
  }
  return normalized;
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
  return normalizeHexColorTokens(tokens.body);
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
  return normalizeHexColorTokens(tokens.body);
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
  return normalizeHexColorTokens(hierarchy.body);
}

async function firstContrastMutation(page: Page): Promise<ContrastFirstMutation | null> {
  return page.evaluate(() => (window as ContrastProbeWindow).__mxqrContrastFirstMutation ?? null);
}

async function controlStyles(page: Page, selector: string): Promise<ControlStyles> {
  return page.locator(selector).evaluate((element): ControlStyles => {
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

/** Colours the authored literals give outside the palette tokens. */
interface AccentNoticeColors {
  /** Text of each accent action except Track info, which reads --primary. */
  accent: string[];
  /** Icon fill of every accent action, Track info included. */
  accentIcons: string[];
  trackInfo: string;
  /** Pinned notice label, time and dismiss X. */
  notice: string[];
}

async function accentNoticeColors(page: Page): Promise<AccentNoticeColors> {
  return page.evaluate((): AccentNoticeColors => {
    const actions = Array.from(document.querySelectorAll<HTMLElement>('.accent-action-btn'));
    const trackInfo = document.querySelector<HTMLElement>('.accent-action-btn.demo-link-button')!;
    return {
      accent: actions
        .filter((action) => action !== trackInfo)
        .map((action) => getComputedStyle(action).color),
      accentIcons: actions.map((action) => getComputedStyle(action.querySelector('svg')!).fill),
      trackInfo: getComputedStyle(trackInfo).color,
      notice: [
        '#chat-pinned-notice-label',
        '#chat-pinned-notice-time',
        '.chat-pinned-notice-close',
      ].map((selector) => getComputedStyle(document.querySelector(selector)!).color),
    };
  });
}

function distinctColors(colors: AccentNoticeColors): AccentNoticeColors {
  return {
    accent: [...new Set(colors.accent)],
    accentIcons: [...new Set(colors.accentIcons)],
    trackInfo: colors.trackInfo,
    notice: [...new Set(colors.notice)],
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
      divider: '#e4e6e8',
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

    // Owner decision (2026-11-03): red is not shown here, so a wrong value
    // also thickens the field's edge from 1px to 2px while it is not focused.
    await setupInput.evaluate((input) => {
      (input as HTMLInputElement).blur();
      input.setAttribute('aria-invalid', 'true');
    });
    await expect(setupInput).not.toBeFocused();
    const inputInvalid = await controlStyles(page, '#setup-join-code');
    expect(inputInvalid.outlineStyle).toBe('solid');
    expect(parseFloat(inputInvalid.outlineWidth)).toBeGreaterThanOrEqual(2);

    // While joining, the digits take the system's disabled colour. Chromium
    // forces color but not -webkit-text-fill-color, which paints the digits.
    const joining = await setupInput.evaluate((input) => {
      const element = input as HTMLInputElement;
      element.removeAttribute('aria-invalid');
      element.value = '000000';
      element.disabled = true;
      const probe = document.createElement('span');
      probe.style.color = 'GrayText';
      document.body.append(probe);
      const grayText = getComputedStyle(probe).color;
      probe.remove();
      const style = getComputedStyle(element);
      return {
        color: style.color,
        fill: style.getPropertyValue('-webkit-text-fill-color'),
        grayText,
      };
    });
    expect(joining.color).toBe(joining.grayText);
    expect(joining.fill).toBe(joining.grayText);
  });
});

test.describe('Forced colors while sharing system audio', () => {
  const TRANSPORT = ['#btn-prev', '#play-btn', '#btn-next'] as const;

  for (const theme of ['dark', 'light'] as const) {
    test(`shows the transport at full strength and keeps the seek bar dimmed in ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({
        colorScheme: theme,
        contrast: 'no-preference',
        forcedColors: 'active',
      });
      await page.addInitScript((storedTheme) => {
        try {
          localStorage.setItem('musixquare-theme', storedTheme);
        } catch {
          /* The preview origin provides storage; retain a safe fallback for harness startup. */
        }
      }, theme);
      await injectPeerServer(page);
      await installSyntheticSystemAudio(page);
      await useAnonymousAccountSession(page);
      await setupHostAndStart(page);
      await navigateToTab(page, 'play');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      await page.locator('#btn-media-source').click();
      await page.locator('#btn-system-audio').click();
      await expect.poll(async () => (await readSyntheticSystemAudio(page)).activeCaptures).toBe(1);
      await expect(page.locator('body')).toHaveClass(/\bmode-system-audio\b/);
      await expect(page.locator('#play-btn')).not.toHaveClass(/\bis-loading\b/);

      const grayText = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'GrayText';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      for (const selector of [...TRANSPORT, '#seek-slider']) {
        await expect(page.locator(selector)).toHaveCSS('color', grayText);
      }
      // Like the other buttons that cannot be pressed, the transport keeps
      // its GrayText at full strength. The seek bar's track and thumb take
      // the usable colours here, so it stays dimmed and does not look usable.
      for (const selector of TRANSPORT) {
        await expect(page.locator(selector)).toHaveCSS('opacity', '1');
      }
      await expect(page.locator('#seek-slider')).toHaveCSS('opacity', '0.3');

      // The ordinary palette keeps all four dimmed while sharing.
      await page.emulateMedia({ forcedColors: 'none' });
      for (const selector of [...TRANSPORT, '#seek-slider']) {
        await expect(page.locator(selector)).toHaveCSS('opacity', '0.3');
      }
    });
  }
});

test.describe('More contrast for the accent actions and the pinned notice', () => {
  // Owner decision (2026-11-15): with more contrast, the accent actions take
  // the palette's blue in both themes and the light pinned notice its warning
  // brown. The ordinary palettes keep their colours.
  const MORE_CONTRAST = {
    dark: { accent: 'rgb(138, 180, 255)', notice: 'rgb(255, 193, 7)' },
    light: { accent: 'rgb(0, 71, 168)', notice: 'rgb(107, 65, 0)' },
  } as const;

  for (const theme of ['dark', 'light'] as const) {
    test(`recolours the accent actions and the pinned notice in ${theme}`, async ({ page }) => {
      await page.emulateMedia({
        colorScheme: theme,
        contrast: 'no-preference',
        forcedColors: 'none',
      });
      await installPreferenceAndFirstPaintProbe(page, 'auto', theme);
      await openApp(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      expect(distinctColors(await accentNoticeColors(page))).toEqual({
        accent: ['rgb(0, 122, 255)'],
        accentIcons: ['rgb(0, 122, 255)'],
        trackInfo: 'rgb(59, 130, 246)',
        notice: ['rgb(255, 193, 7)'],
      });

      const { accent, notice } = MORE_CONTRAST[theme];
      const more = { accent: [accent], accentIcons: [accent], trackInfo: accent, notice: [notice] };
      await page.locator('html').evaluate((root) => root.setAttribute('data-contrast', 'more'));
      await expect.poll(async () => distinctColors(await accentNoticeColors(page))).toEqual(more);

      await page.locator('html').evaluate((root) => root.removeAttribute('data-contrast'));
      await page.emulateMedia({ contrast: 'more' });
      await expect.poll(async () => distinctColors(await accentNoticeColors(page))).toEqual(more);
    });

    test(`keeps the forced-colors accent and notice colours with more contrast in ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({
        colorScheme: theme,
        contrast: 'no-preference',
        forcedColors: 'active',
      });
      await installPreferenceAndFirstPaintProbe(page, 'auto', theme);
      await openApp(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).not.toHaveAttribute('data-contrast');
      expect(await page.evaluate(() => matchMedia('(prefers-contrast: more)').matches)).toBe(false);

      const forcedAlone = await accentNoticeColors(page);
      const linkText = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'LinkText';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      expect(forcedAlone.trackInfo).toBe(linkText);

      await page.locator('html').evaluate((root) => root.setAttribute('data-contrast', 'more'));
      expect(await accentNoticeColors(page)).toEqual(forcedAlone);

      await page.locator('html').evaluate((root) => root.removeAttribute('data-contrast'));
      await page.emulateMedia({ contrast: 'more' });
      expect(await page.evaluate(() => matchMedia('(prefers-contrast: more)').matches)).toBe(true);
      expect(await accentNoticeColors(page)).toEqual(forcedAlone);
    });
  }
});
