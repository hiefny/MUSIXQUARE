import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import {
  navigateToSubtab,
  navigateToTab,
  readState,
  waitForDeviceCount,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';

type PendingReadWindow = Window & {
  __releaseOperatorFileRead?: () => void;
  __operatorFileReadReturned?: boolean;
};

test('administrator can upload again after revocation while the cancelled file read is pending', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  const { hostPage: host, guestPage: guest } = pair;
  try {
    await connectHostAndGuest(host, guest);
    await navigateToTab(host, 'settings');
    await navigateToSubtab(host, 'connect');
    await waitForDeviceCount(host, 2);
    const grant = host.locator('.d-op-btn[data-administrator-state="inactive"]:visible').first();
    await grant.click();
    await waitForState(guest, 'network.isOperator', true);
    const guestId = String(await readState(guest, 'network.myId'));

    // Keep the real file bytes and chunk pump. Hold only the first transfer
    // slice's asynchronous read, as a slow disk/cloud-backed file could do.
    await guest.evaluate(() => {
      const originalSlice = File.prototype.slice;
      File.prototype.slice = function (this: File, ...args: Parameters<Blob['slice']>) {
        const chunk = originalSlice.apply(this, args);
        if (this.name === 'test-01.mp3' && chunk.size === 64 * 1024) {
          File.prototype.slice = originalSlice;
          const read = chunk.arrayBuffer.bind(chunk);
          Object.defineProperty(chunk, 'arrayBuffer', {
            value: async () => {
              const bytes = await read();
              await new Promise<void>((resolve) => {
                (window as PendingReadWindow).__releaseOperatorFileRead = resolve;
              });
              (window as PendingReadWindow).__operatorFileReadReturned = true;
              return bytes;
            },
          });
        }
        return chunk;
      };
    });
    await uploadFixture(guest, 'test01');
    await guest.waitForFunction(
      () => typeof (window as PendingReadWindow).__releaseOperatorFileRead === 'function',
    );

    await host
      .locator(`.administrator-list [data-member-id="peer:${guestId}"] .revoke:visible`)
      .click();
    await expect(host.locator('#dialog-overlay.show')).toBeVisible();
    await host.locator('#btn-dialog-ok').click();
    await waitForState(guest, 'network.isOperator', false);
    await grant.click();
    await waitForState(guest, 'network.isOperator', true);

    await uploadFixture(guest, 'test02');
    await waitForPlaylistCount(host, 1);
    await waitForPlaylistCount(guest, 1);
    await expect
      .poll(() => readState(host, 'playlist.items'))
      .toMatchObject([{ name: 'test-02.mp3' }]);

    await guest.evaluate(() => {
      const release = (window as PendingReadWindow).__releaseOperatorFileRead;
      if (!release) throw new Error('Old operator file read is not pending');
      release();
    });
    await guest.waitForFunction(
      () => (window as PendingReadWindow).__operatorFileReadReturned === true,
    );
    // The retired read cannot append its old file after the replacement won.
    for (const page of [host, guest]) {
      await expect
        .poll(() => readState(page, 'playlist.items'))
        .toMatchObject([{ name: 'test-02.mp3' }]);
    }
  } finally {
    await cleanupContexts(pair);
  }
});
