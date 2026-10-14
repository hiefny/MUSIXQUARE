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

type MotionFailureWindow = Window & { __sharingMotionObserveFailures?: number };

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`sharing controls survive optional motion failure at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    // Narrow Chromium checks the mobile layout with a synthetic capture;
    // it does not emulate an OS picker or mobile system-audio support.
    await page.setViewportSize(viewport);
    const motionWarnings: string[] = [];
    page.on('console', (message) => {
      if (
        message.type() === 'warning' &&
        message.text().includes('[SharingAction] Optional motion failed')
      ) {
        motionWarnings.push(message.text());
      }
    });
    await page.addInitScript(() => {
      const win = window as MotionFailureWindow;
      win.__sharingMotionObserveFailures = 0;
      const observe = ResizeObserver.prototype.observe;
      ResizeObserver.prototype.observe = function (target, options) {
        if (target.classList.contains('play-action-buttons')) {
          win.__sharingMotionObserveFailures! += 1;
          // This runs after the real factory installs listeners and measures
          // the row, exercising partial-initialization cleanup as well.
          throw new Error('Injected sharing-action observer failure');
        }
        observe.call(this, target, options);
      };
    });
    await injectPeerServer(page);
    await installSyntheticSystemAudio(page);
    await useAnonymousAccountSession(page);
    await setupHostAndStart(page);
    await navigateToTab(page, 'play');
    const row = page.locator('.play-action-buttons');
    const media = page.locator('#btn-media-source');
    const sync = page.locator('#btn-sync');
    const stopContent = media.locator('.play-action-stop-content');
    await expect
      .poll(() =>
        page.evaluate(() => (window as MotionFailureWindow).__sharingMotionObserveFailures),
      )
      .toBeGreaterThan(0);
    await expect.poll(() => motionWarnings.length).toBeGreaterThan(0);
    const failures = await page.evaluate(
      () => (window as MotionFailureWindow).__sharingMotionObserveFailures,
    );
    // A non-default gap exposes any remaining hard-coded 12px arithmetic.
    await row.evaluate((element) =>
      (element as HTMLElement).style.setProperty('--play-action-gap', '24px'),
    );
    await expect(row).toHaveCSS('column-gap', '24px');
    await expect(row).toHaveCSS('--play-action-slot-width', '');
    const readGeometry = () =>
      row.evaluate((element) => {
        const media = element.querySelector<HTMLButtonElement>('#btn-media-source')!;
        const sync = element.querySelector<HTMLButtonElement>('#btn-sync')!;
        const content = media.querySelector<HTMLElement>('.play-action-stop-content')!;
        const label = content.querySelector<HTMLElement>('.play-action-label')!;
        const box = (target: Element) => {
          const { x, y, width, height } = target.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          row: box(element),
          media: box(media),
          sync: box(sync),
          content: box(content),
          label: box(label),
          rowLayoutWidth: (element as HTMLElement).offsetWidth,
          mediaLayoutWidth: media.offsetWidth,
          syncLayoutWidth: sync.offsetWidth,
          mediaOverflow: media.scrollHeight - media.clientHeight,
        };
      });
    // Wait for the gap-driven CSS width transition, without relying on motion
    // metadata from the controller deliberately unavailable in this fixture.
    await expect
      .poll(async () => {
        const { row, media, sync, rowLayoutWidth } = await readGeometry();
        const scale = row.width / rowLayoutWidth;
        return Math.abs(row.width - media.width - sync.width - 24 * scale);
      })
      .toBeLessThanOrEqual(0.75);
    const split = await readGeometry();
    expect(split.row.x).toBeGreaterThanOrEqual(0);
    expect(split.row.x + split.row.width).toBeLessThanOrEqual(viewport.width);
    if (viewport.width === 1440) {
      expect(split.rowLayoutWidth).toBe(344);
      expect(split.mediaLayoutWidth).toBe(160);
      expect(split.syncLayoutWidth).toBe(160);
    }

    await media.click();
    await page.locator('#btn-system-audio').click();
    await expect.poll(async () => (await readSyntheticSystemAudio(page)).activeCaptures).toBe(1);
    await expect(row).toHaveAttribute('data-sharing', 'true');
    await expect(media).toHaveAccessibleName('Stop Sharing');
    await expect(stopContent.locator('.play-action-label')).toHaveText('Stop Sharing');
    await expect(stopContent).toBeVisible();
    await expect(stopContent).toHaveCSS('opacity', '1');
    await expect(media.locator('.play-action-media-content')).toHaveCSS('opacity', '0');
    await expect(sync).toBeDisabled();
    await expect(sync).toHaveAttribute('inert', '');
    await expect(sync).toHaveAttribute('aria-hidden', 'true');
    await media.focus();
    await sync.focus();
    await expect(media).toBeFocused();
    await expect
      .poll(async () => {
        const { row, media, content } = await readGeometry();
        return Math.max(Math.abs(row.width - media.width), Math.abs(row.width - content.width));
      })
      .toBeLessThanOrEqual(0.75);
    const expanded = await readGeometry();
    expect(expanded.label.x).toBeGreaterThanOrEqual(expanded.row.x);
    expect(expanded.label.x + expanded.label.width).toBeLessThanOrEqual(
      expanded.row.x + expanded.row.width,
    );
    expect(expanded.label.y).toBeGreaterThanOrEqual(expanded.media.y);
    expect(expanded.label.y + expanded.label.height).toBeLessThanOrEqual(
      expanded.media.y + expanded.media.height,
    );
    expect(expanded.mediaOverflow).toBeLessThanOrEqual(1);
    expect(expanded.media.height).toBeLessThanOrEqual(split.media.height + 0.75);
    await expect(row).toHaveCSS('--play-action-slot-width', '');
    await expect(row).not.toHaveAttribute('data-hover-locked', 'true');
    await expect(row).not.toHaveAttribute('data-motion-ready', 'true');
    await expect(page.locator('#toast')).not.toHaveClass(/\bshow\b/);
    await page.screenshot({ path: testInfo.outputPath('motion-failure-expanded.png') });

    // The rendered Stop action must terminate the real synthetic capture.
    await media.click();
    await expect.poll(async () => (await readSyntheticSystemAudio(page)).activeCaptures).toBe(0);
    await expect(row).toHaveAttribute('data-sharing', 'false');
    await expect(media).not.toHaveAccessibleName('Stop Sharing');
    await expect(media.locator('.play-action-media-content')).toHaveCSS('opacity', '1');
    await expect(stopContent).toHaveCSS('opacity', '0');
    await expect(sync).toHaveJSProperty('disabled', false);
    await expect(sync).not.toHaveAttribute('inert', '');
    await expect(sync).not.toHaveAttribute('aria-hidden', 'true');
    await expect
      .poll(async () => {
        const { media, sync } = await readGeometry();
        return Math.max(
          Math.abs(media.width - split.media.width),
          Math.abs(sync.width - split.sync.width),
        );
      })
      .toBeLessThanOrEqual(0.75);
    await sync.focus();
    await expect(sync).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(media).toBeFocused();
    await expect(row).toHaveCSS('--play-action-slot-width', '');
    expect(
      await page.evaluate(() => (window as MotionFailureWindow).__sharingMotionObserveFailures),
    ).toBe(failures);
    await page.screenshot({ path: testInfo.outputPath('motion-failure-restored.png') });
    await testInfo.attach('motion-failure-evidence', {
      body: JSON.stringify(
        { viewport, failures, motionWarnings, split, expanded, restored: await readGeometry() },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  });
}

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
