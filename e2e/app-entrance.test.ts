import { expect, test, type Page } from '@playwright/test';
import { setupHost } from './helpers/setup-flow.ts';

interface EntranceExpectation {
  selector: string;
  direction: 'up' | 'left';
  delay: string;
}

async function entranceDelay(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate((element) =>
      (element as HTMLElement).style.getPropertyValue('--entrance-delay').trim(),
    );
}

test.describe('app entrance choreography', () => {
  test('reveals metadata and desktop settings as separate 1200ms cascades', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupHost(page);

    const expectations: EntranceExpectation[] = [
      { selector: '.track-title-wrapper', direction: 'up', delay: '100ms' },
      { selector: '#track-artist', direction: 'up', delay: '150ms' },
      { selector: '#tab-settings > .tab-header', direction: 'left', delay: '100ms' },
      { selector: '#tab-settings > .settings-subtab-nav', direction: 'left', delay: '125ms' },
      { selector: '#settings-language-section', direction: 'left', delay: '150ms' },
      { selector: '#theme-section', direction: 'left', delay: '230ms' },
      { selector: '#ui-sounds-section', direction: 'left', delay: '310ms' },
      { selector: '#settings-sync-section', direction: 'left', delay: '400ms' },
    ];

    for (const { selector, direction, delay } of expectations) {
      await expect(page.locator(selector)).toHaveClass(
        new RegExp(`\\bapp-entrance-${direction}\\b`, 'u'),
      );
      expect(await entranceDelay(page, selector), selector).toBe(delay);
    }
    await expect(page.locator('.track-box')).not.toHaveClass(/\bapp-entrance\b/u);
    await expect(page.locator('#tab-settings')).not.toHaveClass(/\bapp-entrance\b/u);

    await page.click('#btn-setup-confirm');
    await expect(page.locator('#setup-overlay')).not.toHaveClass(/\bactive\b/u);
    await expect(page.locator('#settings-sync-section')).toHaveClass(/\bapp-entered\b/u);

    await expect(page.locator('#settings-sync-section')).not.toHaveClass(/\bapp-entrance\b/u, {
      timeout: 2_000,
    });
    for (const { selector } of expectations) {
      await expect(page.locator(selector)).not.toHaveClass(/\bapp-entrance\b/u);
      expect(await entranceDelay(page, selector), selector).toBe('');
    }

    expect(
      await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    ).toEqual({ clientWidth: 1440, scrollWidth: 1440 });
  });
});
