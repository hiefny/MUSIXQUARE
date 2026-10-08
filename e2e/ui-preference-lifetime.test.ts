import { expect, test } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { useAnonymousAccountSession } from './helpers/context-factory.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { navigateToTab, waitForFilePlaybackReady } from './helpers/wait.ts';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    return route.abort();
  });
  await useAnonymousAccountSession(page);
  await injectPeerServer(page);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`Sync supports opening focus and first Escape with motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await setupHostAndStart(page);
    await uploadFixture(page, 'test01');
    await waitForFilePlaybackReady(page, 20_000);
    const opener = page.locator('#btn-sync');
    const overlay = page.locator('#manual-sync-overlay');
    await expect(opener).toHaveAttribute('aria-disabled', 'false');
    await opener.focus();
    await page.keyboard.press('Space');
    await expect(overlay).toHaveClass(/show/);
    await expect(page.locator('#manual-sync-value')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(overlay).not.toHaveClass(/show/);
    await expect(opener).toBeFocused();
  });
}

for (const disablePending of [false, true]) {
  test(`delayed UI sound preview respects the latest choice: disabled=${disablePending}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const Native = window.AudioContext;
      const contexts: AudioContext[] = [];
      Reflect.set(window, '__previewContexts', contexts);
      window.AudioContext = class extends Native {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args);
          contexts.push(this);
        }
      };
      const start = AudioBufferSourceNode.prototype.start;
      Reflect.set(window, '__previewStarts', 0);
      AudioBufferSourceNode.prototype.start = function (...args) {
        Reflect.set(window, '__previewStarts', Reflect.get(window, '__previewStarts') + 1);
        return start.apply(this, args);
      };
    });
    await setupHostAndStart(page);
    await navigateToTab(page, 'settings');
    await page.evaluate(async () => {
      const contexts = Reflect.get(window, '__previewContexts') as AudioContext[];
      if (!contexts.length) throw new Error('Expected the app AudioContext');
      for (const context of contexts) await context.suspend();
      const gate = new Promise<void>((resolve) => Reflect.set(window, '__releasePreview', resolve));
      Reflect.set(window, '__previewResumes', 0);
      Reflect.set(window, '__previewStarts', 0);
      for (const context of contexts) {
        const resume = context.resume.bind(context);
        context.resume = async () => {
          Reflect.set(window, '__previewResumes', Reflect.get(window, '__previewResumes') + 1);
          await gate;
          await resume();
        };
      }
    });
    await page.locator('#grid-ui-sounds [data-ui-sounds="on"]').focus();
    await page.keyboard.press('Space');
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__previewResumes')))
      .toBeGreaterThan(0);
    if (disablePending) {
      await page.locator('#grid-ui-sounds [data-ui-sounds="off"]').focus();
      await page.keyboard.press('Space');
    }
    await page.evaluate(() => Reflect.get(window, '__releasePreview')());
    await expect
      .poll(() =>
        page.evaluate(() =>
          (Reflect.get(window, '__previewContexts') as AudioContext[]).every(
            (context) => context.state === 'running',
          ),
        ),
      )
      .toBe(true);
    // Give all promise continuations a browser task before checking the absence of a source.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(await page.evaluate(() => Reflect.get(window, '__previewStarts'))).toBe(
      disablePending ? 0 : 1,
    );
    expect(await page.evaluate(() => localStorage.getItem('musixquare-ui-sounds-enabled'))).toBe(
      disablePending ? '0' : '1',
    );
  });
}
