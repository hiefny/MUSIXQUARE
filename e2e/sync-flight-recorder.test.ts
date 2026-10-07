import { expect, test } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { openChatDrawer, readState, sendChat } from './helpers/wait.ts';

test('native Standard host and guest diagnostic reports identify their room domain', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  try {
    const code = await connectHostAndGuest(pair.hostPage, pair.guestPage);
    for (const [role, page] of [
      ['host', pair.hostPage],
      ['guest', pair.guestPage],
    ] as const) {
      expect(await readState(page, 'setup.sessionStarted')).toBe(true);
      expect(await readState(page, 'network.appRole')).toBe(role);
      // Standard lifecycle intentionally leaves the persistent-room context idle.
      expect(await readState(page, 'room.context')).toMatchObject({
        kind: 'standard',
        roomId: null,
        role: 'idle',
      });
      await openChatDrawer(page);
      await sendChat(page, '/debug sync');
      const overlay = page.locator('#debug-sync-flight-overlay');
      await expect(overlay).toBeVisible();
      await expect(overlay.locator('pre')).toContainText('user-incident-marker');
      const report = await overlay.locator('pre').textContent();
      expect(report).not.toContain(code);
      const sample = JSON.parse(report!.trim().split('\n').at(-1)!) as { room: string };
      expect(sample.room).toBe('standard');
      await page.keyboard.press('Escape');
      await expect(overlay).toHaveCount(0);
    }
  } finally {
    await cleanupContexts(pair);
  }
});
