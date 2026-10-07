import { expect, test } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  navigateToTab,
  navigateToSubtab,
  waitForDeviceCount,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';

test('administrator multi-file upload preserves a late expanded playlist focus owner', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  const { hostPage: host, guestPage: guest } = pair;
  try {
    await connectHostAndGuest(host, guest);
    await navigateToTab(host, 'settings');
    await navigateToSubtab(host, 'connect');
    await waitForDeviceCount(host, 2);
    await host.locator('.d-op-btn[data-administrator-state="inactive"]:visible').first().click();
    await waitForState(guest, 'network.isOperator', true);
    await navigateToTab(host, 'playlist');

    // Seed only a cached playlist at the supported sub-item limit. The following
    // queue mutations use one native file selection and the normal upload path.
    await host.evaluate(() => {
      const set = (window as unknown as Record<string, unknown>).__MUSIXQUARE_SET_STATE__ as (
        path: string,
        value: unknown,
      ) => void;
      const queueItemId = '00000000-0000-4000-8000-000000000001';
      set('youtube.subItemsMap', {
        PL_focus: {
          ids: Array.from({ length: 5000 }, (_, index) => `v${String(index).padStart(10, '0')}`),
          titles: [],
        },
      });
      set('playlist.items', [
        {
          queueItemId,
          type: 'youtube',
          name: 'Cached 5000-track playlist',
          videoId: 'v0000000000',
          playlistId: 'PL_focus',
          isExpanded: true,
        },
      ]);
      set('playlist.currentQueueItemId', queueItemId);
    });
    await expect(host.locator('.sub-track-item')).toHaveCount(5000);
    const target = host.locator('.sub-track-item[data-sub-index="4999"]');
    await target.evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
    await expect(target).toBeFocused();

    // Two valid one-second mono PCM WAVs finish sequentially through uploadOne.
    const wave = Buffer.alloc(16044);
    wave.write('RIFF', 0);
    wave.writeUInt32LE(wave.length - 8, 4);
    wave.write('WAVEfmt ', 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(8000, 24);
    wave.writeUInt32LE(16000, 28);
    wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34);
    wave.write('data', 36);
    wave.writeUInt32LE(16000, 40);
    await guest.locator('#file-input').setInputFiles([
      { name: 'first.wav', mimeType: 'audio/wav', buffer: wave },
      { name: 'second.wav', mimeType: 'audio/wav', buffer: wave },
    ]);
    await waitForPlaylistCount(host, 3);
    await expect(host.locator('.sub-track-item')).toHaveCount(5000);
    await expect(target).toBeFocused();
  } finally {
    await cleanupContexts(pair);
  }
});
