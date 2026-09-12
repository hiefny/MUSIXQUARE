import { test, expect, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  useAnonymousAccountSession,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixtures } from './helpers/file-upload.ts';
import { readQueueSnapshot, waitForCurrentQueueItemId } from './helpers/queue-state.ts';
import {
  navigateToTab,
  readState,
  waitForFilePlaybackReady,
  waitForPlaylistCount,
} from './helpers/wait.ts';
import {
  installSyntheticSystemAudio,
  readSyntheticSystemAudio,
} from './helpers/system-audio-source.ts';

const TRANSPORT_CONTROLS = ['btn-prev', 'play-btn', 'btn-next'] as const;

async function readControlAvailability(page: Page) {
  return page.evaluate(
    (ids) =>
      ids.map((id) => {
        const button = document.getElementById(id) as HTMLButtonElement;
        return {
          id,
          disabled: button.disabled,
          ariaDisabled: button.getAttribute('aria-disabled'),
        };
      }),
    TRANSPORT_CONTROLS,
  );
}

test('system audio disables keyboard transport and restores controls after sharing', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  const { hostPage: host, guestPage: guest } = pair;
  try {
    await Promise.all([installSyntheticSystemAudio(host), installSyntheticSystemAudio(guest)]);
    await useAnonymousAccountSession(host, guest);
    await connectHostAndGuest(host, guest);
    await uploadFixtures(host, ['test01', 'test02']);
    await waitForPlaylistCount(guest, 2);
    await Promise.all([waitForFilePlaybackReady(host), waitForFilePlaybackReady(guest)]);
    await Promise.all([navigateToTab(host, 'play'), navigateToTab(guest, 'play')]);
    const queue = await readQueueSnapshot(host);
    const baseline = await Promise.all([
      readControlAvailability(host),
      readControlAvailability(guest),
    ]);

    await host.locator('#btn-media-source').click();
    await host.locator('#btn-system-audio').click();
    await expect.poll(() => readState(guest, 'systemAudio.isReceiving')).toBe(true);
    await expect
      .poll(async () => (await readSyntheticSystemAudio(guest)).liveAudioReceivers)
      .toBe(1);

    for (const page of [host, guest]) {
      for (const id of TRANSPORT_CONTROLS) {
        const button = page.locator(`#${id}`);
        // aria-disabled alone does not prevent native keyboard activation.
        await expect(button).toHaveJSProperty('disabled', true);
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        for (const key of ['Enter', 'Space']) {
          // A disabled button must reject focus. Blur the stop-sharing button
          // first so the key cannot accidentally activate that previous focus.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await button.focus();
          await expect(button).not.toBeFocused();
          await page.keyboard.press(key);
        }
      }
    }
    for (const page of [host, guest]) {
      expect(await readState(page, 'playback.mode')).toBe('system-audio');
      expect(await readState(page, 'playlist.currentQueueItemId')).toBe(queue.currentQueueItemId);
    }
    expect((await readSyntheticSystemAudio(host)).activeCaptures).toBe(1);
    expect(await readState(guest, 'systemAudio.isReceiving')).toBe(true);
    expect((await readSyntheticSystemAudio(guest)).liveAudioReceivers).toBe(1);

    await host.locator('#btn-media-source').click();
    await expect.poll(async () => (await readSyntheticSystemAudio(host)).activeCaptures).toBe(0);
    await expect.poll(() => readState(guest, 'systemAudio.isReceiving')).toBe(false);
    await expect
      .poll(() => Promise.all([readControlAvailability(host), readControlAvailability(guest)]))
      .toEqual(baseline);

    // File restoration can leave a guest idle until the next host command.
    // Its original authority restrictions must survive the temporary lock.
    await host.locator('#btn-next').click();
    await Promise.all(
      [host, guest].map((page) => waitForCurrentQueueItemId(page, queue.items[1].queueItemId)),
    );
    await expect
      .poll(() => Promise.all([host, guest].map((page) => readState(page, 'playback.activity'))))
      .toEqual(['playing', 'playing']);
  } finally {
    await cleanupContexts(pair);
  }
});
