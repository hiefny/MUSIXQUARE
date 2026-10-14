import { test, expect, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  useAnonymousAccountSession,
} from './helpers/context-factory.ts';
import { connectHostAndGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { uploadFixtures } from './helpers/file-upload.ts';
import { readQueueSnapshot, waitForCurrentQueueItemId } from './helpers/queue-state.ts';
import {
  navigateToSubtab,
  navigateToTab,
  readState,
  waitForDeviceCount,
  waitForFilePlaybackReady,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';
import {
  installSyntheticSystemAudio,
  readSyntheticSystemAudio,
} from './helpers/system-audio-source.ts';
import {
  installLocalYouTube,
  submitYouTubeSource,
  waitForYouTubePlayback,
} from './helpers/youtube-source.ts';

const TRANSPORT_CONTROLS = ['btn-prev', 'play-btn', 'btn-next'] as const;

test('sharing surfaces do not acquire hover merely by expanding under a stationary pointer', async ({
  page,
}, testInfo) => {
  await injectPeerServer(page);
  await installSyntheticSystemAudio(page);
  await useAnonymousAccountSession(page);
  await setupHostAndStart(page);
  await navigateToTab(page, 'play');
  const row = page.locator('.play-action-buttons');
  const media = page.locator('#btn-media-source');
  const sync = page.locator('#btn-sync');
  await sync.hover();
  const syncBox = await sync.boundingBox();
  if (!syncBox) throw new Error('Sync must be visible before sharing');
  const leftPoint = { x: syncBox.x + syncBox.width / 2, y: syncBox.y + syncBox.height / 2 };

  await media.click();
  // Opening by pointer schedules focus onto the dialog itself. Wait for that
  // handoff before selecting a keyboard target, otherwise it can steal Enter.
  await expect(page.locator('#media-source-overlay')).toBeFocused();
  await page.locator('#btn-system-audio').focus();
  await expect(page.locator('#btn-system-audio')).toBeFocused();
  await page.mouse.move(leftPoint.x, leftPoint.y);
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('data-sharing', 'true');
  await expect(row).not.toHaveAttribute('data-morphing', 'true');
  const stopContent = media.locator('.play-action-stop-content');
  await expect(stopContent).toBeVisible();
  await expect(stopContent).toHaveCSS('opacity', '1');
  await expect(stopContent.locator('.play-action-label')).toHaveText('Stop Sharing');
  await expect(stopContent.locator('.play-action-label')).toHaveCSS('color', 'rgb(255, 59, 48)');
  await expect(stopContent.locator('svg')).toHaveCSS('fill', 'rgb(255, 59, 48)');
  // Some engines retain the old :hover target until pointer movement; others
  // update it as geometry changes. The visible surface must be stable in both.
  const colors = await row.evaluate((element) => {
    const probe = document.createElement('span');
    element.appendChild(probe);
    const resolve = (token: string) => {
      probe.style.backgroundColor = `var(${token})`;
      return getComputedStyle(probe).backgroundColor;
    };
    const result = {
      stop: resolve('--play-action-stop-surface'),
      normal: resolve('--play-action-surface'),
      hover: resolve('--surface-3'),
    };
    probe.remove();
    return result;
  });
  await expect(media).toHaveCSS('background-color', colors.stop);
  await page.screenshot({ path: testInfo.outputPath('sharing-expanded.png') });

  // Click the newly expanded half. On split this same physical point becomes
  // Sync; it must not flash a hover surface until the pointer actually moves.
  await page.mouse.click(leftPoint.x, leftPoint.y);
  await expect(row).toHaveAttribute('data-sharing', 'false');
  await expect(row).not.toHaveAttribute('data-morphing', 'true');
  await expect(media).toHaveCSS('background-color', colors.normal);
  await expect(sync).toHaveCSS('background-color', colors.normal);
  await page.screenshot({ path: testInfo.outputPath('sharing-restored.png') });
  await page.mouse.move(leftPoint.x + 2, leftPoint.y);
  await expect(row).not.toHaveAttribute('data-hover-locked', 'true');
  // No track remains after stopping this capture-only session: Sync retains
  // its existing unavailable explanation and therefore its resting surface.
  await expect(sync).toHaveAttribute('aria-disabled', 'true');
  await expect(sync).toHaveCSS('background-color', colors.normal);
  await media.hover();
  await expect(media).toHaveCSS('background-color', colors.hover);
});

type PendingPickerWindow = Window & {
  __releasePendingSystemAudioPicker?: () => void;
};

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
    const actionRows = [host, guest].map((page) => page.locator('.play-action-buttons'));
    const initialActionWidths = await Promise.all(
      [host, guest].map((page) =>
        page
          .locator('#btn-media-source')
          .evaluate((button) => button.getBoundingClientRect().width),
      ),
    );

    await host.locator('#btn-media-source').click();
    await host.locator('#btn-system-audio').click();
    await expect.poll(() => readState(guest, 'systemAudio.isReceiving')).toBe(true);
    await expect
      .poll(async () => (await readSyntheticSystemAudio(guest)).liveAudioReceivers)
      .toBe(1);

    // Only the local publisher owns the merged stop action. A receiver keeps
    // both explanatory controls, including the keyboard-accessible Sync toast.
    await expect(actionRows[0]!).toHaveAttribute('data-sharing', 'true');
    await expect(actionRows[1]!).toHaveAttribute('data-sharing', 'false');
    const hostSync = host.locator('#btn-sync');
    const hostMedia = host.locator('#btn-media-source');
    await expect(hostSync).toBeDisabled();
    await expect(hostSync).toHaveAttribute('inert', '');
    await expect(hostSync).toHaveAttribute('aria-hidden', 'true');
    await expect(hostMedia.locator('.play-action-stop-content .play-action-label')).toHaveAttribute(
      'data-i18n',
      'system_audio.stop',
    );
    await expect(hostMedia).toHaveAccessibleName(
      (await hostMedia.locator('.play-action-stop-content .play-action-label').innerText()).trim(),
    );
    await expect
      .poll(() =>
        hostMedia.evaluate((button) => {
          const row = button.closest('.play-action-buttons')!;
          return Math.abs(button.getBoundingClientRect().width - row.getBoundingClientRect().width);
        }),
      )
      .toBeLessThanOrEqual(0.75);
    await expect
      .poll(() =>
        guest
          .locator('#btn-media-source')
          .evaluate((button) => button.getBoundingClientRect().width),
      )
      .toBeCloseTo(initialActionWidths[1]!, 1);
    await hostMedia.focus();
    await hostSync.focus();
    await expect(hostMedia).toBeFocused();
    const guestSync = guest.locator('#btn-sync');
    await expect(guestSync).toHaveJSProperty('disabled', false);
    await expect(guestSync).toHaveAttribute('aria-disabled', 'true');
    await expect(guestSync).toHaveAttribute('title', /\S/);
    await expect(guest.locator('#btn-media-source')).toHaveAttribute('aria-disabled', 'true');
    await expect(guest.locator('.play-action-media-content')).toHaveCSS('opacity', '1');
    await guestSync.focus();
    await expect(guestSync).toBeFocused();
    await guest.keyboard.press('Enter');
    await expect(guest.locator('#manual-sync-overlay')).not.toHaveClass(/show/);

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

    // The combined surface must preserve the original button's native
    // keyboard activation rather than depending on a pointer-only overlay.
    await hostMedia.focus();
    await host.keyboard.press('Enter');
    await expect.poll(async () => (await readSyntheticSystemAudio(host)).activeCaptures).toBe(0);
    await expect.poll(() => readState(guest, 'systemAudio.isReceiving')).toBe(false);
    await expect(actionRows[0]!).toHaveAttribute('data-sharing', 'false');
    await expect(hostSync).toHaveJSProperty('disabled', false);
    await expect(hostSync).not.toHaveAttribute('inert', '');
    await expect(hostSync).not.toHaveAttribute('aria-hidden', 'true');
    await expect
      .poll(() => hostMedia.evaluate((button) => button.getBoundingClientRect().width))
      .toBeCloseTo(initialActionWidths[0]!, 1);
    await hostSync.focus();
    await expect(hostSync).toBeFocused();
    await host.keyboard.press('Tab');
    await expect(hostMedia).toBeFocused();
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

test('remote YouTube selection supersedes a pending system audio picker', async ({ browser }) => {
  const pair = await createHostGuestContexts(browser);
  const { hostPage: host, guestPage: guest } = pair;
  try {
    await Promise.all(
      [host, guest].flatMap((page) => [
        installSyntheticSystemAudio(page),
        installLocalYouTube(page),
      ]),
    );
    await useAnonymousAccountSession(host, guest);
    await connectHostAndGuest(host, guest);
    await submitYouTubeSource(host, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
    await Promise.all([host, guest].map((page) => waitForYouTubePlayback(page, 'aaaaaaaaaaa')));
    await submitYouTubeSource(host, 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
    await waitForPlaylistCount(guest, 2);
    await Promise.all([host, guest].map((page) => waitForYouTubePlayback(page, 'bbbbbbbbbbb')));
    const queue = await readQueueSnapshot(host);
    const successor = queue.items.find((item) => item.queueItemId !== queue.currentQueueItemId)!;

    // Grant beforehand: the remote administrator remains usable even while a
    // real native picker blocks interaction with the host's browser window.
    await navigateToTab(host, 'settings');
    await navigateToSubtab(host, 'connect');
    await waitForDeviceCount(host, 2);
    await host.locator('.d-op-btn:visible').first().click();
    await waitForState(guest, 'network.isOperator', true);

    // Delegate creation to the shared fixture so capture/cleanup still use
    // real MediaStreamTracks; hold only the browser picker promise boundary.
    await host.evaluate(() => {
      const selectDisplay = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async (options?: DisplayMediaStreamOptions) => {
          const stream = await selectDisplay(options);
          return new Promise<MediaStream>((resolve) => {
            (window as PendingPickerWindow).__releasePendingSystemAudioPicker = () => {
              delete (window as PendingPickerWindow).__releasePendingSystemAudioPicker;
              resolve(stream);
            };
          });
        },
      });
    });
    await navigateToTab(host, 'play');
    await host.locator('#btn-media-source').click();
    await host.locator('#btn-system-audio').click();
    await host.waitForFunction(
      () => typeof (window as PendingPickerWindow).__releasePendingSystemAudioPicker === 'function',
    );

    await navigateToTab(guest, 'playlist');
    await guest.locator(`.track-item[data-queue-item-id="${successor.queueItemId}"]`).click();
    await Promise.all(
      [host, guest].map((page) => waitForCurrentQueueItemId(page, successor.queueItemId)),
    );
    await Promise.all([host, guest].map((page) => waitForYouTubePlayback(page, 'aaaaaaaaaaa')));
    await host.evaluate(() => {
      const release = (window as PendingPickerWindow).__releasePendingSystemAudioPicker;
      if (!release) throw new Error('System audio picker is not pending');
      release();
    });

    await expect.poll(async () => (await readSyntheticSystemAudio(host)).activeCaptures).toBe(0);
    for (const page of [host, guest]) {
      expect(await readState(page, 'playlist.currentQueueItemId')).toBe(successor.queueItemId);
      expect(await readState(page, 'playback.mode')).toBe('youtube');
      expect(await readState(page, 'player.currentTrackMeta')).toMatchObject({
        videoId: 'aaaaaaaaaaa',
      });
    }
    expect(await readState(guest, 'systemAudio.isReceiving')).toBe(false);
    for (const page of [host, guest]) {
      await expect(page.locator('.play-action-buttons')).toHaveAttribute('data-sharing', 'false');
      await expect(page.locator('#btn-sync')).toHaveJSProperty('disabled', false);
      await expect(page.locator('#btn-sync')).not.toHaveAttribute('inert', '');
    }
  } finally {
    await cleanupContexts(pair);
  }
});
