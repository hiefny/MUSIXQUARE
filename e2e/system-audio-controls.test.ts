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
  waitForAppFonts,
  waitForDeviceCount,
  waitForFilePlaybackReady,
  waitForPlaylistCount,
  waitForState,
  waitForViewTransitionEnd,
  waitUntilPressReaches,
} from './helpers/wait.ts';
import {
  cancelHeldSystemAudioPicker,
  holdSyntheticSystemAudioPicker,
  installSyntheticSystemAudio,
  readHeldSystemAudioPicker,
  readSyntheticSystemAudio,
  selectHeldSystemAudioPicker,
} from './helpers/system-audio-source.ts';
import {
  OWNER_RECOVERY_CLAIM,
  PARTICIPANT_ID,
  PRESENCE_INCARNATION_ID,
  PRO_ROOM_CODE,
  PRO_SIGNALING_ORIGIN,
  fulfillProJson,
  ownerSnapshot,
  proCorsHeaders,
  setProPlaylist,
} from './helpers/pro-room-fixture.ts';
import { installFakeYt } from './helpers/fake-yt.ts';
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
    // The picker closes once the capture holds live audio, a frame or two later.
    await expect(page.locator('#media-source-overlay')).not.toHaveClass(/\bactive\b/);
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
  await expect(page.locator('#media-source-overlay')).not.toHaveClass(/\bactive\b/);
  await expect(row).not.toHaveAttribute('data-morphing', 'true');
  const stopContent = media.locator('.play-action-stop-content');
  await expect(stopContent).toBeVisible();
  await expect(stopContent).toHaveCSS('opacity', '1');
  await expect(stopContent.locator('.play-action-label')).toHaveText('Stop Sharing');
  // Stop sharing reads the danger foreground, #ff3b30 in both default palettes
  // (owner decision 2026-10-27, evening).
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
  // Starting the share closed the source popup in a cross-fade, and the raw
  // click must not land in it.
  await waitUntilPressReaches(media, leftPoint);
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
    await expect(host.locator('#media-source-overlay')).not.toHaveClass(/\bactive\b/);

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
    await holdSyntheticSystemAudioPicker(host);
    await navigateToTab(host, 'play');
    await host.locator('#btn-media-source').click();
    await host.locator('#btn-system-audio').click();
    await expect.poll(async () => (await readHeldSystemAudioPicker(host)).open).toBe(1);

    await navigateToTab(guest, 'playlist');
    await guest.locator(`.track-item[data-queue-item-id="${successor.queueItemId}"]`).click();
    await Promise.all(
      [host, guest].map((page) => waitForCurrentQueueItemId(page, successor.queueItemId)),
    );
    await Promise.all([host, guest].map((page) => waitForYouTubePlayback(page, 'aaaaaaaaaaa')));
    await selectHeldSystemAudioPicker(host);

    await expect.poll(async () => (await readSyntheticSystemAudio(host)).activeCaptures).toBe(0);
    // The replaced share ends quietly: the host's picker stays open with the
    // option ready again.
    const hostOption = host.locator('#btn-system-audio');
    await expect(hostOption).toHaveAttribute('aria-busy', 'false');
    await expect(hostOption.locator('.media-source-label-text')).toHaveAttribute(
      'data-i18n',
      'system_audio.button',
    );
    await expect(host.locator('#media-source-overlay')).toHaveClass(/\bactive\b/);
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

// Owner proposal 2026-11-03: the media picker stays open while the browser's
// share window is open, as it stays open until a chosen file arrives, and the
// option reads "Preparing to share..." the same way in standard and PRO rooms.
// Owner decision 2026-11-17: once that window returns a capture with live
// audio, the picker closes and the start goes on under the play tab's title
// (the rows at the end of this file).
type PickerRecord = {
  key: string | null;
  open: boolean;
  /** The picker's hidden status that repeats toasts for screen readers. */
  status: string | null;
};

type PickerRecordWindow = Window & {
  __systemAudioPickerRecord?: PickerRecord[];
};

async function recordSystemAudioPicker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const option = document.getElementById('btn-system-audio')!;
    const overlay = document.getElementById('media-source-overlay')!;
    const label = option.querySelector('.media-source-label-text')!;
    const status = overlay.querySelector('[data-toast-echo]');
    const record: PickerRecord[] = [];
    (window as PickerRecordWindow).__systemAudioPickerRecord = record;
    // One entry per mutation batch, as a frame would paint it.
    const observer = new MutationObserver(() => {
      record.push({
        key: label.getAttribute('data-i18n'),
        open: overlay.classList.contains('active'),
        status: status?.textContent ?? null,
      });
    });
    observer.observe(option, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    if (status) {
      observer.observe(status, { characterData: true, childList: true, subtree: true });
    }
  });
}

async function openSystemAudioOption(page: Page) {
  const option = page.locator('#btn-system-audio');
  await page.locator('#btn-media-source').click();
  // A pointer open moves focus to the picker surface; wait for that handoff.
  await expect(page.locator('#media-source-overlay')).toBeFocused();
  return { option, label: option.locator('.media-source-label-text') };
}

type TrackTitleRecord = {
  title: string;
  subtitle: string;
  /** The row under the title takes its line; css/style.css hides it empty. */
  shown: boolean;
  /** The batch wrote an empty row, even if text came back in the same batch. */
  emptied: boolean;
};

type TrackTitleRecordWindow = Window & { __trackTitleRecord?: TrackTitleRecord[] };

/** Record the play tab's title and the row under it, one entry per batch. */
async function recordTrackTitle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const title = document.getElementById('track-title')!;
    const subtitle = document.getElementById('track-artist')!;
    const record: TrackTitleRecord[] = [];
    (window as TrackTitleRecordWindow).__trackTitleRecord = record;
    const observer = new MutationObserver((mutations) => {
      record.push({
        title: title.textContent ?? '',
        subtitle: subtitle.textContent ?? '',
        shown: getComputedStyle(subtitle).display !== 'none',
        emptied: mutations.some(
          (mutation) =>
            mutation.target === subtitle &&
            mutation.type === 'childList' &&
            mutation.removedNodes.length > 0 &&
            mutation.addedNodes.length === 0,
        ),
      });
    });
    for (const target of [title, subtitle]) {
      observer.observe(target, { characterData: true, childList: true, subtree: true });
    }
  });
}

function readTrackTitleRecord(page: Page): Promise<TrackTitleRecord[]> {
  return page.evaluate(() => (window as TrackTitleRecordWindow).__trackTitleRecord ?? []);
}

test('keeps the media picker open with the preparing label while the share window is open, and closes it once the shared audio is captured', async ({
  page,
}) => {
  await injectPeerServer(page);
  await installSyntheticSystemAudio(page);
  await useAnonymousAccountSession(page);
  await setupHostAndStart(page);
  await navigateToTab(page, 'play');
  await holdSyntheticSystemAudioPicker(page);
  const overlay = page.locator('#media-source-overlay');
  const { option, label } = await openSystemAudioOption(page);
  await recordSystemAudioPicker(page);
  await recordTrackTitle(page);

  await option.click();
  await expect.poll(async () => (await readHeldSystemAudioPicker(page)).open).toBe(1);
  // getDisplayMedia still runs inside the click's user activation.
  expect((await readHeldSystemAudioPicker(page)).activations).toEqual([true]);
  await expect(overlay).toHaveClass(/\bactive\b/);
  await expect(label).toHaveAttribute('data-i18n', 'system_audio.button_preparing');
  await expect(label).toHaveText('Preparing to share...');
  await expect(option).toHaveAttribute('aria-busy', 'true');
  await expect(option).toHaveAttribute('aria-disabled', 'true');
  await expect(option).toHaveJSProperty('disabled', false);
  await expect(option).toBeFocused();

  // A second press while it prepares opens nothing.
  await page.keyboard.press('Enter');
  expect((await readHeldSystemAudioPicker(page)).calls).toBe(1);

  await selectHeldSystemAudioPicker(page);
  await expect.poll(async () => (await readSyntheticSystemAudio(page)).activeCaptures).toBe(1);
  await expect(overlay).not.toHaveClass(/\bactive\b/);
  await expect(page.locator('.play-action-buttons')).toHaveAttribute('data-sharing', 'true');
  await expect(page.locator('#btn-media-source')).toBeFocused();
  const record = await page.evaluate(
    () => (window as PickerRecordWindow).__systemAudioPickerRecord ?? [],
  );
  const firstBusy = record.findIndex(({ key }) => key === 'system_audio.button_preparing');
  expect(firstBusy).toBeGreaterThanOrEqual(0);
  // From the preparing label until the picker closed, never System Audio.
  expect(
    record
      .slice(firstBusy)
      .filter(({ key, open }) => open && key !== 'system_audio.button_preparing'),
  ).toEqual([]);
  // The picker closed when the capture held live audio, a moment before a
  // standard share is on, so the page under it is no longer inert and its own
  // toast is the one status that gives screen readers the advice.
  const advice = 'Lower the source volume as much as possible';
  await expect(page.locator('#toast')).toContainText(advice);
  await expect(page.getByRole('status').filter({ hasText: advice })).toHaveCount(1);
  // The title reads the share over its profile label, and the row under the
  // title never emptied on the way (owner decision 2026-11-18).
  await expect(page.locator('#track-title')).toHaveText('Sharing System Audio');
  await expect(page.locator('#track-artist')).toHaveText('≤256 kbps · DISPLAY');
  expect(
    (await readTrackTitleRecord(page)).filter(({ emptied, shown }) => emptied || !shown),
  ).toEqual([]);

  await page.locator('#btn-media-source').click();
  await expect.poll(async () => (await readSyntheticSystemAudio(page)).activeCaptures).toBe(0);
});

test('a cancelled share dialog keeps the picker open and the option ready again', async ({
  page,
}) => {
  await injectPeerServer(page);
  await installSyntheticSystemAudio(page);
  await useAnonymousAccountSession(page);
  await setupHostAndStart(page);
  await navigateToTab(page, 'play');
  await holdSyntheticSystemAudioPicker(page);
  const overlay = page.locator('#media-source-overlay');
  const { option, label } = await openSystemAudioOption(page);

  await option.click();
  await expect.poll(async () => (await readHeldSystemAudioPicker(page)).open).toBe(1);
  await expect(option).toHaveAttribute('aria-busy', 'true');
  await cancelHeldSystemAudioPicker(page);

  await expect(option).toHaveAttribute('aria-busy', 'false');
  await expect(overlay).toHaveClass(/\bactive\b/);
  await expect(label).toHaveAttribute('data-i18n', 'system_audio.button');
  await expect(label).toHaveText('System Audio');
  await expect(option).not.toHaveAttribute('aria-disabled');
  await expect(option).toBeFocused();
  await expect(page.locator('#toast')).toContainText('Audio sharing was cancelled');
  // The picker stays on top, so the page under it, the toast included, is
  // hidden from screen readers; the picker's own status repeats the message.
  await expect(overlay.getByRole('status')).toHaveText('Audio sharing was cancelled');
  await expect(
    page.getByRole('status').filter({ hasText: 'Audio sharing was cancelled' }),
  ).toHaveCount(1);
  expect((await readSyntheticSystemAudio(page)).activeCaptures).toBe(0);

  // Ready at once: the next press opens the share window again.
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await readHeldSystemAudioPicker(page)).calls).toBe(2);
  await expect(option).toHaveAttribute('aria-busy', 'true');
  await expect(label).toHaveAttribute('data-i18n', 'system_audio.button_preparing');
  await cancelHeldSystemAudioPicker(page);
  await expect(option).toHaveAttribute('aria-busy', 'false');
  await expect(overlay).toHaveClass(/\bactive\b/);
  expect((await readHeldSystemAudioPicker(page)).activations).toEqual([true, true]);
});

type TouchSoundWindow = Window & { __uiTouchSounds?: number };

/** Turn UI sounds on and count the touch sounds src/audio/ui-sounds.ts plays. */
async function recordUiTouchSounds(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('musixquare-ui-sounds-enabled', '1');
    const win = window as TouchSoundWindow;
    win.__uiTouchSounds = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      this: AudioBufferSourceNode,
      ...args: Parameters<AudioBufferSourceNode['start']>
    ) {
      // The touch is the only short mono buffer the app plays (55 ms).
      if (this.buffer?.numberOfChannels === 1 && this.buffer.duration < 0.1) {
        win.__uiTouchSounds = (win.__uiTouchSounds ?? 0) + 1;
      }
      return start.apply(this, args);
    };
  });
}

function readUiTouchSounds(page: Page): Promise<number> {
  return page.evaluate(() => (window as TouchSoundWindow).__uiTouchSounds ?? 0);
}

test('the press that starts a share keeps the UI touch sound, and a press while it prepares stays silent', async ({
  page,
}) => {
  await injectPeerServer(page);
  await installSyntheticSystemAudio(page);
  await recordUiTouchSounds(page);
  await useAnonymousAccountSession(page);
  await setupHostAndStart(page);
  await navigateToTab(page, 'play');
  await holdSyntheticSystemAudioPicker(page);
  const { option } = await openSystemAudioOption(page);
  // Opening the picker was a press with its touch sound.
  await expect.poll(() => readUiTouchSounds(page)).toBeGreaterThan(0);
  const beforeShare = await readUiTouchSounds(page);

  // The option marks itself preparing in its own click, before the press
  // reaches the touch sound's listener on the document. As when the picker
  // closed at the tap, the press still answers with the sound.
  await option.click();
  await expect.poll(async () => (await readHeldSystemAudioPicker(page)).open).toBe(1);
  await expect(option).toHaveAttribute('aria-disabled', 'true');
  await expect.poll(() => readUiTouchSounds(page)).toBe(beforeShare + 1);

  // Past the touch sound's 35 ms repeat guard, a press on the preparing
  // option opens nothing and plays nothing.
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect((await readHeldSystemAudioPicker(page)).calls).toBe(1);
  expect(await readUiTouchSounds(page)).toBe(beforeShare + 1);

  await cancelHeldSystemAudioPicker(page);
  await expect(option).toHaveAttribute('aria-busy', 'false');
});

/** The drawn colours of the picker's icons and the preparing spinner, once
 *  every colour transition on the icon tiles has finished. */
function readPickerIconColours(page: Page) {
  return page.evaluate(async () => {
    const tiles = [...document.querySelectorAll('#media-source-overlay .btn-icon-bg')];
    // Reading the style starts any colour transition the last pointer move
    // caused, so the wait below sees it.
    for (const tile of tiles) getComputedStyle(tile).getPropertyValue('color');
    await Promise.all(
      tiles.flatMap((tile) =>
        tile.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    const fill = (selector: string) => {
      const svg = document.querySelector(`#media-source-overlay ${selector} .btn-icon-bg > svg`);
      return svg ? getComputedStyle(svg).fill : null;
    };
    const spinner = document.querySelector('#btn-system-audio .system-audio-loading-spinner');
    return {
      local: fill('.file-select-btn:first-of-type'),
      youtube: fill('.file-select-btn:has(.btn-icon-bg.youtube)'),
      system: fill('#btn-system-audio'),
      spinner: spinner ? getComputedStyle(spinner).color : null,
    };
  });
}

// Owner decision 2026-11-17: the picker's options already lighten their
// surface under the mouse, so their icons keep their own colour there, in the
// dark theme as in the light one, and the preparing spinner keeps it under the
// mouse that pressed the option. The YouTube mark stays brand red.
for (const theme of ['dark', 'light'] as const) {
  test.describe(`media picker icons in the ${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test('keep their own colour under the mouse and while pressed, the preparing spinner included', async ({
      page,
    }) => {
      await injectPeerServer(page);
      await installSyntheticSystemAudio(page);
      await useAnonymousAccountSession(page);
      await setupHostAndStart(page);
      await navigateToTab(page, 'play');
      await holdSyntheticSystemAudioPicker(page);
      const { option } = await openSystemAudioOption(page);
      const local = page.locator('#media-source-overlay .file-select-btn').first();
      await page.mouse.move(1, 1);
      const rest = await readPickerIconColours(page);
      expect(rest.local).toBe(rest.system);
      expect(rest.youtube).toBe('rgb(255, 0, 51)');

      await local.hover();
      expect(await readPickerIconColours(page)).toMatchObject({
        local: rest.local,
        youtube: rest.youtube,
      });

      // Held down, then released on the card's empty top corner, so the
      // press opens no file dialog and reaches no option.
      await page.mouse.down();
      expect((await readPickerIconColours(page)).local).toBe(rest.local);
      const card = (await page.locator('#media-source-overlay .setup-card').boundingBox())!;
      await page.mouse.move(card.x + 6, card.y + 6);
      await page.mouse.up();

      await option.hover();
      expect((await readPickerIconColours(page)).system).toBe(rest.system);

      await option.click();
      await expect.poll(async () => (await readHeldSystemAudioPicker(page)).open).toBe(1);
      await expect(option).toHaveAttribute('aria-busy', 'true');
      await option.hover();
      // The spinner draws with the icon's colour, so it matches the resting icon.
      expect((await readPickerIconColours(page)).spinner).toBe(rest.system);

      await cancelHeldSystemAudioPicker(page);
      await expect(option).toHaveAttribute('aria-busy', 'false');
    });
  });
}

test('a PRO owner sees the preparing label for the whole start and, after a cancel, until the room releases the lease', async ({
  page,
}) => {
  // The local harness has no PRO Worker or Realtime SFU, so the PRO API is
  // mocked as in critical-browser.test.ts. The PRO success path needs an SFU
  // publish; the capture's unit tests cover it.
  await injectPeerServer(page);
  await installSyntheticSystemAudio(page);
  await page.addInitScript((signalingUrl) => {
    (window as unknown as Record<string, unknown>).__MUSIXQUARE_TRANSPORT__ = {
      provider: 'cloudflare',
      signalingUrl,
    };
  }, `${PRO_SIGNALING_ORIGIN}/api/rooms`);
  await page.routeWebSocket(
    (url) => url.pathname.includes('/api/pro-rooms/'),
    (socket) => {
      socket.onMessage((raw) => {
        if (typeof raw !== 'string') return;
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame.type === 'pro-clock') {
          socket.send(JSON.stringify({ ...frame, serverTimeMs: Date.now() }));
        }
      });
    },
  );
  const idle = (generation: number) => ({
    generation,
    status: 'idle',
    ownerParticipantId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  });
  let systemAudio: Record<string, unknown> = idle(0);
  let generation = 0;
  const calls = { acquire: 0, acquired: 0, release: 0 };
  // Each release is answered only when the test lets it through.
  const releaseAnswers: Array<() => void> = [];
  const snapshot = ownerSnapshot();
  await page.route('**/api/pro-room/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const room = `/v1/rooms/${PRO_ROOM_CODE}`;
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: proCorsHeaders(page), body: '' });
    } else if (pathname.endsWith(`${room}/bootstrap`)) {
      await fulfillProJson(page, route, {
        roomCode: PRO_ROOM_CODE,
        status: 'pin_required',
        passwordRequired: true,
      });
    } else if (
      pathname.endsWith(`${room}/owner-recovery`) ||
      pathname.endsWith(`${room}/snapshot`)
    ) {
      await fulfillProJson(page, route, { snapshot });
    } else if (pathname.endsWith(`${room}/signaling-tickets`)) {
      await fulfillProJson(page, route, {
        ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
        expiresAtMs: Date.now() + 60_000,
        role: 'member',
        coordinatorEpoch: 2,
        presenceIncarnationId: PRESENCE_INCARNATION_ID,
        ticketSequence: 1,
        pendingPlaybackTransition: null,
      });
    } else if (pathname.endsWith(`${room}/presence/heartbeat`)) {
      await fulfillProJson(page, route, { snapshot, systemAudio });
    } else if (pathname.endsWith(`${room}/system-audio`)) {
      await fulfillProJson(page, route, { systemAudio });
    } else if (pathname.endsWith(`${room}/system-audio/acquire`)) {
      calls.acquire += 1;
      generation += 1;
      systemAudio = {
        generation,
        status: 'preparing',
        ownerParticipantId: PARTICIPANT_ID,
        claimExpiresAt: Date.now() + 45_000,
        liveExpiresAt: null,
        publication: null,
      };
      await fulfillProJson(page, route, { systemAudio, leaseId: 'L'.repeat(43) });
      calls.acquired += 1;
    } else if (pathname.endsWith(`${room}/system-audio/release`)) {
      calls.release += 1;
      await new Promise<void>((resolve) => releaseAnswers.push(resolve));
      systemAudio = idle(generation);
      await fulfillProJson(page, route, { systemAudio });
    } else {
      await fulfillProJson(page, route, { error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
    }
  });
  await page.goto(`/${PRO_ROOM_CODE}#pro-recovery=${OWNER_RECOVERY_CLAIM}`);
  await page.locator('#btn-setup-confirm:not([disabled])').click();
  await expect(page.locator('#setup-overlay')).not.toHaveClass(/active/);
  // Only the room owner may share system audio (src/pro-room/context.ts).
  await expect
    .poll(async () => {
      const context = (await readState(page, 'room.context')) as {
        kind?: string;
        capabilities?: string[];
      };
      return context?.kind === 'pro' && context.capabilities?.includes('system-audio.publish');
    })
    .toBe(true);
  await navigateToTab(page, 'play');
  await holdSyntheticSystemAudioPicker(page);
  const overlay = page.locator('#media-source-overlay');
  const { option, label } = await openSystemAudioOption(page);
  await expect(option).toBeVisible();
  await recordSystemAudioPicker(page);

  await option.click();
  await expect.poll(async () => (await readHeldSystemAudioPicker(page)).open).toBe(1);
  expect((await readHeldSystemAudioPicker(page)).activations).toEqual([true]);
  await expect(label).toHaveAttribute('data-i18n', 'system_audio.button_preparing');
  await expect(label).toHaveText('Preparing to share...');
  await expect(option).toHaveAttribute('aria-busy', 'true');

  // The server's lease answer is where the old label flashed back after about
  // 0.1 s. The share window is still open, so the start is still preparing.
  await expect.poll(() => calls.acquired).toBe(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(label).toHaveAttribute('data-i18n', 'system_audio.button_preparing');
  await expect(overlay).toHaveClass(/\bactive\b/);

  await cancelHeldSystemAudioPicker(page);
  await expect(page.locator('#toast')).toContainText('Audio sharing was cancelled');
  await expect(overlay.getByRole('status')).toHaveText('Audio sharing was cancelled');
  await expect.poll(() => calls.release).toBe(1);
  // The room holds the lease as preparing until it answers the release, so the
  // option keeps preparing, and a press meanwhile opens nothing and shows no
  // "Preparing to share system audio" toast.
  await expect(label).toHaveAttribute('data-i18n', 'system_audio.button_preparing');
  await expect(option).toHaveAttribute('aria-busy', 'true');
  await expect(overlay).toHaveClass(/\bactive\b/);
  await expect(option).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await readHeldSystemAudioPicker(page)).calls).toBe(1);
  await expect(page.locator('#toast')).toContainText('Audio sharing was cancelled');

  releaseAnswers.shift()!();
  await expect(label).toHaveAttribute('data-i18n', 'system_audio.button');
  await expect(option).toHaveAttribute('aria-busy', 'false');
  await expect(overlay).toHaveClass(/\bactive\b/);
  const record = await page.evaluate(
    () => (window as PickerRecordWindow).__systemAudioPickerRecord ?? [],
  );
  const firstBusy = record.findIndex(({ key }) => key === 'system_audio.button_preparing');
  const firstReady = record.findIndex(
    (entry, index) => index > firstBusy && entry.key === 'system_audio.button',
  );
  expect(firstBusy).toBeGreaterThanOrEqual(0);
  // From the press until the room answered the release the option read only
  // the preparing label.
  expect(
    record
      .slice(firstBusy, firstReady)
      .filter(({ key }) => key !== 'system_audio.button_preparing'),
  ).toEqual([]);

  // The room is idle again: the next press opens the share window.
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await readHeldSystemAudioPicker(page)).calls).toBe(2);
  expect((await readHeldSystemAudioPicker(page)).activations).toEqual([true, true]);
  await expect(label).toHaveAttribute('data-i18n', 'system_audio.button_preparing');
  await cancelHeldSystemAudioPicker(page);
  await expect.poll(() => calls.release).toBe(2);
  releaseAnswers.shift()!();
  await expect(label).toHaveAttribute('data-i18n', 'system_audio.button');
  expect(calls.acquire).toBe(2);
});

type HeldProAnswer = 'grant' | 'refuse';

/**
 * Open the page as the owner of a mocked PRO room, as the row above does,
 * where the room answers each system-audio acquire and commit only when the
 * test does. The owner is alone in the room, so a granted lease publishes
 * LAN-direct to no listener, and the room's live answer to that commit puts
 * the share on without an SFU.
 */
async function openHeldProShareRoom(page: Page) {
  await page.addInitScript((signalingUrl) => {
    (window as unknown as Record<string, unknown>).__MUSIXQUARE_TRANSPORT__ = {
      provider: 'cloudflare',
      signalingUrl,
    };
  }, `${PRO_SIGNALING_ORIGIN}/api/rooms`);
  await page.routeWebSocket(
    (url) => url.pathname.includes('/api/pro-rooms/'),
    (socket) => {
      socket.onMessage((raw) => {
        if (typeof raw !== 'string') return;
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame.type === 'pro-clock') {
          socket.send(JSON.stringify({ ...frame, serverTimeMs: Date.now() }));
        }
      });
    },
  );
  const idle = (generation: number) => ({
    generation,
    status: 'idle',
    ownerParticipantId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  });
  let generation = 0;
  let systemAudio: Record<string, unknown> = idle(0);
  const calls = { acquire: 0, commit: 0, release: 0 };
  const held: Record<'acquire' | 'commit', Array<(answer: HeldProAnswer) => void>> = {
    acquire: [],
    commit: [],
  };
  const answerOf = (kind: 'acquire' | 'commit') =>
    new Promise<HeldProAnswer>((resolve) => held[kind].push(resolve));
  const snapshot = ownerSnapshot();
  await page.route('**/api/pro-room/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const room = `/v1/rooms/${PRO_ROOM_CODE}`;
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: proCorsHeaders(page), body: '' });
    } else if (pathname.endsWith(`${room}/bootstrap`)) {
      await fulfillProJson(page, route, {
        roomCode: PRO_ROOM_CODE,
        status: 'pin_required',
        passwordRequired: true,
      });
    } else if (
      pathname.endsWith(`${room}/owner-recovery`) ||
      pathname.endsWith(`${room}/snapshot`)
    ) {
      await fulfillProJson(page, route, { snapshot });
    } else if (pathname.endsWith(`${room}/signaling-tickets`)) {
      await fulfillProJson(page, route, {
        ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
        expiresAtMs: Date.now() + 60_000,
        role: 'member',
        coordinatorEpoch: 2,
        presenceIncarnationId: PRESENCE_INCARNATION_ID,
        ticketSequence: 1,
        pendingPlaybackTransition: null,
      });
    } else if (pathname.endsWith(`${room}/presence/heartbeat`)) {
      await fulfillProJson(page, route, { snapshot, systemAudio });
    } else if (
      pathname.endsWith(`${room}/system-audio`) ||
      pathname.endsWith(`${room}/system-audio/heartbeat`)
    ) {
      await fulfillProJson(page, route, { systemAudio });
    } else if (pathname.endsWith(`${room}/system-audio/acquire`)) {
      calls.acquire += 1;
      if ((await answerOf('acquire')) === 'refuse') {
        await fulfillProJson(page, route, { error: 'TEST_ACQUIRE_REFUSED' }, 503);
        return;
      }
      generation += 1;
      systemAudio = {
        generation,
        status: 'preparing',
        ownerParticipantId: PARTICIPANT_ID,
        claimExpiresAt: Date.now() + 45_000,
        liveExpiresAt: null,
        publication: null,
      };
      await fulfillProJson(page, route, { systemAudio, leaseId: 'L'.repeat(43) });
    } else if (pathname.endsWith(`${room}/system-audio/commit`)) {
      calls.commit += 1;
      const { publication } = request.postDataJSON() as { publication: unknown };
      if ((await answerOf('commit')) === 'refuse') {
        await fulfillProJson(page, route, { error: 'TEST_COMMIT_REFUSED' }, 503);
        return;
      }
      systemAudio = {
        generation,
        status: 'live',
        ownerParticipantId: PARTICIPANT_ID,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication,
      };
      await fulfillProJson(page, route, { systemAudio });
    } else if (pathname.endsWith(`${room}/system-audio/release`)) {
      calls.release += 1;
      systemAudio = idle(generation);
      await fulfillProJson(page, route, { systemAudio });
    } else {
      await fulfillProJson(page, route, { error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
    }
  });
  await page.goto(`/${PRO_ROOM_CODE}#pro-recovery=${OWNER_RECOVERY_CLAIM}`);
  await page.locator('#btn-setup-confirm:not([disabled])').click();
  await expect(page.locator('#setup-overlay')).not.toHaveClass(/active/);
  await expect
    .poll(async () => {
      const context = (await readState(page, 'room.context')) as {
        kind?: string;
        capabilities?: string[];
      };
      return context?.kind === 'pro' && context.capabilities?.includes('system-audio.publish');
    })
    .toBe(true);
  return {
    calls,
    /** Let the oldest held request of that kind through, or refuse it. */
    answer(kind: 'acquire' | 'commit', answer: HeldProAnswer): void {
      const next = held[kind].shift();
      if (!next) throw new Error(`No ${kind} request is held`);
      next(answer);
    },
  };
}

type PlayTabLayout = {
  title: string;
  subtitle: string;
  subtitleShown: boolean;
  stageY: number;
  titleY: number;
  controlsY: number;
};

/** The play tab's title and row, and where its stage, title and controls sit. */
function readPlayTabLayout(page: Page): Promise<PlayTabLayout> {
  return page.evaluate(() => {
    const top = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().y;
    const subtitle = document.getElementById('track-artist')!;
    return {
      title: document.getElementById('track-title')!.textContent ?? '',
      subtitle: subtitle.textContent ?? '',
      subtitleShown: getComputedStyle(subtitle).display !== 'none',
      stageY: top('#tab-play .playback-stage'),
      titleY: top('#track-title'),
      controlsY: top('#tab-play .controls-area'),
    };
  });
}

/** The largest move of the stage, the title or the controls between two reads. */
function playTabMove(from: PlayTabLayout, to: PlayTabLayout): number {
  return Math.max(
    Math.abs(from.stageY - to.stageY),
    Math.abs(from.titleY - to.titleY),
    Math.abs(from.controlsY - to.controlsY),
  );
}

const PREPARING_TITLE = 'Preparing to share...';
const SHARING_TITLE = 'Sharing System Audio';
const PROFILE_LABEL = '≤256 kbps · DISPLAY';

// Owner decision 2026-11-17: once the browser's share window returns a capture
// with live audio, the media picker closes at once while the start goes on (a
// PRO lease and its LAN-direct or SFU publication), and the play tab's title
// reads "Preparing to share..." until the share is on. Owner decision
// 2026-11-18: from that moment the row under the title already shows the
// share's profile label, the text it keeps once the share is on, so the row
// never empties and nothing on the play tab moves (an empty row hides itself,
// which moved the stage 11 px and the title 17 px in the 2026-11-17 photos).
// The 1280 x 800 window is the one those photos measured.
test.describe('the play tab while a captured share gets ready', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a PRO capture with live audio closes the picker while the lease and the live answer are held, the title reads Preparing to share... over the profile label in place, and only the title changes when the share is on', async ({
    page,
  }, testInfo) => {
    await injectPeerServer(page);
    await installSyntheticSystemAudio(page);
    const room = await openHeldProShareRoom(page);
    await navigateToTab(page, 'play');
    await holdSyntheticSystemAudioPicker(page);
    await waitForAppFonts(page);
    const before = await readPlayTabLayout(page);
    expect(before).toMatchObject({
      title: 'No media playing',
      subtitle: 'Select a file or check the playlist',
      subtitleShown: true,
    });
    const overlay = page.locator('#media-source-overlay');
    const opener = page.locator('#btn-media-source');
    const title = page.locator('#track-title');
    const subtitle = page.locator('#track-artist');
    const { option, label } = await openSystemAudioOption(page);
    await recordTrackTitle(page);

    await option.click();
    await expect.poll(async () => (await readHeldSystemAudioPicker(page)).open).toBe(1);
    await expect.poll(() => room.calls.acquire).toBe(1);
    // While the browser's share window is open nothing changes.
    await expect(overlay).toHaveClass(/\bactive\b/);
    await expect(label).toHaveAttribute('data-i18n', 'system_audio.button_preparing');
    await expect(title).toHaveText('No media playing');

    await selectHeldSystemAudioPicker(page);
    await expect.poll(async () => (await readSyntheticSystemAudio(page)).activeCaptures).toBe(1);
    // The capture holds live audio while the room has not answered the lease:
    // the picker closes and focus returns to its opener, as the started close
    // did, and the start goes on with the option still preparing.
    await expect(overlay).not.toHaveClass(/\bactive\b/);
    await expect(opener).toBeFocused();
    await expect(option).toHaveAttribute('aria-busy', 'true');
    await expect(label).toHaveAttribute('data-i18n', 'system_audio.button_preparing');
    await expect(title).toHaveText(PREPARING_TITLE);
    await expect(subtitle).toHaveText(PROFILE_LABEL);
    await waitForViewTransitionEnd(page);
    const captured = await readPlayTabLayout(page);

    // The lease is granted: the share claims the player and publishes, and the
    // room's live answer to its commit is held. Still preparing.
    room.answer('acquire', 'grant');
    await expect.poll(() => room.calls.commit).toBe(1);
    await expect.poll(() => readState(page, 'playback.mode')).toBe('system-audio');
    await expect(title).toHaveText(PREPARING_TITLE);
    await expect(subtitle).toHaveText(PROFILE_LABEL);
    const claimed = await readPlayTabLayout(page);

    room.answer('commit', 'grant');
    await expect(title).toHaveText(SHARING_TITLE);
    await expect(subtitle).toHaveText(PROFILE_LABEL);
    await expect(option).toHaveAttribute('aria-busy', 'false');
    await expect(overlay).not.toHaveClass(/\bactive\b/);
    await expect(page.locator('#toast')).toContainText(
      'Lower the source volume as much as possible',
    );
    const shared = await readPlayTabLayout(page);
    await testInfo.attach('play-tab-layout', {
      body: JSON.stringify({ before, captured, claimed, shared }, null, 2),
      contentType: 'application/json',
    });

    // Measured in place: preparing sits exactly where the share then sits, as
    // the room before the start did with its own row.
    expect(playTabMove(captured, shared)).toBeLessThanOrEqual(0.5);
    expect(playTabMove(claimed, shared)).toBeLessThanOrEqual(0.5);
    expect(playTabMove(before, shared)).toBeLessThanOrEqual(0.5);
    expect([captured, claimed, shared].every(({ subtitleShown }) => subtitleShown)).toBe(true);

    const record = await readTrackTitleRecord(page);
    const firstPreparing = record.findIndex(({ title }) => title === PREPARING_TITLE);
    const firstShared = record.findIndex(({ title }) => title === SHARING_TITLE);
    expect(firstPreparing).toBeGreaterThanOrEqual(0);
    expect(firstShared).toBeGreaterThan(firstPreparing);
    // From the capture until the share is on, only the preparing title over the
    // profile label: no "Sharing System Audio" at the claim before the share.
    expect(
      record
        .slice(firstPreparing, firstShared)
        .filter((entry) => entry.title !== PREPARING_TITLE || entry.subtitle !== PROFILE_LABEL),
    ).toEqual([]);
    // When the share came on, only the title changed; the row never emptied.
    expect(record.slice(firstShared).filter(({ subtitle }) => subtitle !== PROFILE_LABEL)).toEqual(
      [],
    );
    expect(record.filter(({ emptied, shown }) => emptied || !shown)).toEqual([]);

    // Stop Sharing ends the share; the room answers its release.
    await opener.click();
    await expect.poll(async () => (await readSyntheticSystemAudio(page)).activeCaptures).toBe(0);
    await expect.poll(() => room.calls.release).toBe(1);
  });

  test('a PRO start refused after the capture closed the picker shows its toast, returns the title and the row to what they were and does not reopen the picker', async ({
    page,
  }) => {
    await injectPeerServer(page);
    await installSyntheticSystemAudio(page);
    const room = await openHeldProShareRoom(page);
    await navigateToTab(page, 'play');
    await holdSyntheticSystemAudioPicker(page);
    await waitForAppFonts(page);
    const before = await readPlayTabLayout(page);
    const overlay = page.locator('#media-source-overlay');
    const title = page.locator('#track-title');
    const subtitle = page.locator('#track-artist');
    const { option, label } = await openSystemAudioOption(page);
    await recordTrackTitle(page);

    await option.click();
    await expect.poll(async () => (await readHeldSystemAudioPicker(page)).open).toBe(1);
    await expect.poll(() => room.calls.acquire).toBe(1);
    await selectHeldSystemAudioPicker(page);
    await expect(overlay).not.toHaveClass(/\bactive\b/);
    await expect(title).toHaveText(PREPARING_TITLE);
    await expect(subtitle).toHaveText(PROFILE_LABEL);
    await waitForViewTransitionEnd(page);

    room.answer('acquire', 'refuse');
    await expect(page.locator('#toast')).toContainText('Could not start system audio sharing');
    await expect(title).toHaveText(before.title);
    await expect(subtitle).toHaveText(before.subtitle);
    await expect(option).toHaveAttribute('aria-busy', 'false');
    await expect(label).toHaveAttribute('data-i18n', 'system_audio.button');
    // The person already left the picker; a later failure does not reopen it.
    await expect(overlay).not.toHaveClass(/\bactive\b/);
    expect((await readSyntheticSystemAudio(page)).activeCaptures).toBe(0);
    expect(playTabMove(before, await readPlayTabLayout(page))).toBeLessThanOrEqual(0.5);
    expect(
      (await readTrackTitleRecord(page)).filter(({ emptied, shown }) => emptied || !shown),
    ).toEqual([]);
    // No lease was granted, so there is none to release.
    expect(room.calls.release).toBe(0);
  });
});

// The swallowed PRO share (owner report 2026-11-18). After this device's share
// ends over a paused YouTube item, the item comes back through a local re-apply
// whose iframe takes a moment to load. A press of System Audio then must start
// the share even when the re-apply is still preparing, and even when the
// person takes a few seconds in the browser's share window: the re-apply's own
// cancel once arrived after the press and read as a newer playback choice, so
// the capture was dropped with no toast (RO-21, src/pro-room/runtime.ts).
const SWALLOW_ROOM_LATENCY_MS = 150;
const SWALLOW_YT_ITEM = '11111111-1111-4111-8111-111111111111';
const SWALLOW_YT_VIDEO = 'dQw4w9WgXcQ';

/**
 * Open the page as the owner of a mocked PRO room on a paused YouTube item at
 * 42 s, whose iframe is ready 1.5 s after it loads. The room keeps one
 * system-audio lease as the Worker does and answers presence and lease
 * requests after SWALLOW_ROOM_LATENCY_MS.
 */
async function openProRoomOnPausedVideo(page: Page) {
  await installFakeYt(page, { readyDelayMs: 1_500 });
  await page.route(/https:\/\/www\.youtube\.com\/oembed(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ title: 'E2E fixture video', author_name: 'E2E' }),
    }),
  );
  await page.addInitScript((signalingUrl) => {
    (window as unknown as Record<string, unknown>).__MUSIXQUARE_TRANSPORT__ = {
      provider: 'cloudflare',
      signalingUrl,
    };
  }, `${PRO_SIGNALING_ORIGIN}/api/rooms`);
  await page.routeWebSocket(
    (url) => url.pathname.includes('/api/pro-rooms/'),
    (socket) => {
      socket.onMessage((raw) => {
        if (typeof raw !== 'string') return;
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame.type === 'pro-clock') {
          socket.send(JSON.stringify({ ...frame, serverTimeMs: Date.now() }));
        }
      });
    },
  );
  const idle = (generation: number) => ({
    generation,
    status: 'idle',
    ownerParticipantId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  });
  const snapshot = ownerSnapshot();
  setProPlaylist(snapshot, [
    {
      queueItemId: SWALLOW_YT_ITEM,
      name: 'Paused video',
      source: { kind: 'youtube', videoId: SWALLOW_YT_VIDEO },
    },
  ]);
  snapshot.currentQueueItemId = SWALLOW_YT_ITEM;
  snapshot.playback = {
    coordinatorEpoch: 2,
    revision: 1,
    state: 'paused',
    queueItemId: SWALLOW_YT_ITEM,
    positionSeconds: 42,
    youtubeVideoId: SWALLOW_YT_VIDEO,
    youtubeSubIndex: 0,
    updatedAtMs: Date.now(),
  };
  let generation = 0;
  let systemAudio: Record<string, unknown> = idle(0);
  const calls = { acquire: 0, commit: 0, release: 0 };
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, SWALLOW_ROOM_LATENCY_MS));
  await page.route('**/api/pro-room/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const room = `/v1/rooms/${PRO_ROOM_CODE}`;
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: proCorsHeaders(page), body: '' });
    } else if (pathname.endsWith(`${room}/bootstrap`)) {
      await fulfillProJson(page, route, {
        roomCode: PRO_ROOM_CODE,
        status: 'pin_required',
        passwordRequired: true,
      });
    } else if (
      pathname.endsWith(`${room}/owner-recovery`) ||
      pathname.endsWith(`${room}/snapshot`)
    ) {
      await fulfillProJson(page, route, { snapshot });
    } else if (pathname.endsWith(`${room}/signaling-tickets`)) {
      await fulfillProJson(page, route, {
        ticket: `${'c'.repeat(32)}.${'D'.repeat(43)}`,
        expiresAtMs: Date.now() + 60_000,
        role: 'member',
        coordinatorEpoch: 2,
        presenceIncarnationId: PRESENCE_INCARNATION_ID,
        ticketSequence: 1,
        pendingPlaybackTransition: null,
      });
    } else if (pathname.endsWith(`${room}/presence/heartbeat`)) {
      await later();
      await fulfillProJson(page, route, { snapshot, systemAudio });
    } else if (
      pathname.endsWith(`${room}/system-audio`) ||
      pathname.endsWith(`${room}/system-audio/heartbeat`)
    ) {
      await later();
      await fulfillProJson(page, route, { systemAudio });
    } else if (pathname.endsWith(`${room}/system-audio/acquire`)) {
      calls.acquire += 1;
      generation += 1;
      systemAudio = {
        generation,
        status: 'preparing',
        ownerParticipantId: PARTICIPANT_ID,
        claimExpiresAt: Date.now() + 45_000,
        liveExpiresAt: null,
        publication: null,
      };
      await later();
      await fulfillProJson(page, route, { systemAudio, leaseId: 'L'.repeat(43) });
    } else if (pathname.endsWith(`${room}/system-audio/commit`)) {
      calls.commit += 1;
      const { publication } = request.postDataJSON() as { publication: unknown };
      systemAudio = {
        generation,
        status: 'live',
        ownerParticipantId: PARTICIPANT_ID,
        claimExpiresAt: null,
        liveExpiresAt: null,
        publication,
      };
      await later();
      await fulfillProJson(page, route, { systemAudio });
    } else if (pathname.endsWith(`${room}/system-audio/release`)) {
      calls.release += 1;
      generation += 1;
      systemAudio = idle(generation);
      await later();
      await fulfillProJson(page, route, { systemAudio });
    } else {
      await fulfillProJson(page, route, { error: 'TEST_ADJUNCT_UNAVAILABLE' }, 503);
    }
  });
  await page.goto(`/${PRO_ROOM_CODE}#pro-recovery=${OWNER_RECOVERY_CLAIM}`);
  await page.locator('#btn-setup-confirm:not([disabled])').click();
  await expect(page.locator('#setup-overlay')).not.toHaveClass(/active/);
  await expect
    .poll(async () => {
      const context = (await readState(page, 'room.context')) as {
        kind?: string;
        capabilities?: string[];
      };
      return context?.kind === 'pro' && context.capabilities?.includes('system-audio.publish');
    })
    .toBe(true);
  await expect.poll(() => readState(page, 'playback.mode'), { timeout: 20_000 }).toBe('youtube');
  return { calls, status: () => systemAudio.status };
}

/** As the browser's own "Stop sharing" bar does: the track ends, then says so. */
async function endShareFromBrowserBar(page: Page): Promise<void> {
  const ended = await page.evaluate(() => {
    const fixture = (
      window as unknown as { __MUSIXQUARE_SYSTEM_AUDIO_FIXTURE__?: { streams: MediaStream[] } }
    ).__MUSIXQUARE_SYSTEM_AUDIO_FIXTURE__;
    let count = 0;
    for (const stream of fixture?.streams ?? []) {
      for (const track of stream.getAudioTracks()) {
        if (track.readyState !== 'live') continue;
        track.stop();
        track.dispatchEvent(new Event('ended'));
        count += 1;
      }
    }
    return count;
  });
  expect(ended).toBe(1);
}

test.describe('a PRO share pressed again while the paused video it replaced comes back', () => {
  for (const end of ['the browser bar', 'Stop Sharing'] as const) {
    test(`starts after a share that ended from ${end}, with the share window open for 3 s`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await injectPeerServer(page);
      await installSyntheticSystemAudio(page);
      const room = await openProRoomOnPausedVideo(page);
      await navigateToTab(page, 'play');
      await holdSyntheticSystemAudioPicker(page);
      const overlay = page.locator('#media-source-overlay');
      const actions = page.locator('.play-action-buttons');

      const first = await openSystemAudioOption(page);
      await first.option.click();
      await expect.poll(async () => (await readHeldSystemAudioPicker(page)).open).toBe(1);
      await selectHeldSystemAudioPicker(page);
      await expect.poll(async () => (await readSyntheticSystemAudio(page)).activeCaptures).toBe(1);
      await expect(actions).toHaveAttribute('data-sharing', 'true');
      await expect(overlay).not.toHaveClass(/\bactive\b/);
      await page.waitForTimeout(1_000);

      if (end === 'the browser bar') await endShareFromBrowserBar(page);
      else await page.locator('#btn-media-source').click();
      await expect.poll(() => room.calls.release).toBe(1);
      await expect.poll(() => room.status()).toBe('idle');
      // The release answer reaches the page, and the paused video starts to
      // come back: its iframe is ready 1.5 s after it loads.
      await page.waitForTimeout(SWALLOW_ROOM_LATENCY_MS + 30);
      await expect(actions).toHaveAttribute('data-sharing', 'false');

      const again = await openSystemAudioOption(page);
      await again.option.click();
      await expect.poll(async () => (await readHeldSystemAudioPicker(page)).calls).toBe(2);
      await expect.poll(async () => (await readHeldSystemAudioPicker(page)).open).toBe(1);
      // The person takes a few seconds in the browser's share window.
      await page.waitForTimeout(3_000);
      await selectHeldSystemAudioPicker(page);

      await expect.poll(async () => (await readSyntheticSystemAudio(page)).activeCaptures).toBe(1);
      await expect(actions).toHaveAttribute('data-sharing', 'true');
      await expect(overlay).not.toHaveClass(/\bactive\b/);
      await expect.poll(() => room.calls.commit).toBe(2);
      expect(room.calls.acquire).toBe(2);
      expect(await readState(page, 'playback.mode')).toBe('system-audio');
    });
  }
});
