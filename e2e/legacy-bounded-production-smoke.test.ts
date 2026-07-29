import { expect, test } from '@playwright/test';
import {
  cleanupContexts,
  createHostGuestContexts,
  getPageErrors,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  clickPlayButton,
  openChatDrawer,
  sendChat,
  waitForChatMessage,
  waitForDeviceCount,
} from './helpers/wait.ts';

const PRODUCTION_GATE_MARKER = '__MXQR_PRODUCTION_LEGACY_BOUNDED_GATE_MATCHES_LATCH_V2_FALSE__';

let pair: HostGuestPair | undefined;

async function readMainArtifact(page: HostGuestPair['hostPage']): Promise<string> {
  return page.evaluate(async () => {
    const mainScript = Array.from(document.scripts)
      .map((script) => script.src)
      .find((source) => /\/assets\/main-[^/]+\.js$/u.test(source));
    if (!mainScript) throw new Error('Production candidate main artifact was not found');
    const response = await fetch(mainScript, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Production candidate artifact request failed (${response.status})`);
    }
    return response.text();
  });
}

async function readSeekSeconds(page: HostGuestPair['hostPage']): Promise<number> {
  return page.locator('#seek-slider').evaluate((element) => {
    const value = Number.parseFloat((element as HTMLInputElement).value);
    if (!Number.isFinite(value)) throw new Error('Seek slider did not expose a finite value');
    return value;
  });
}

async function waitForSeekAtLeast(
  page: HostGuestPair['hostPage'],
  minimumSeconds: number,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (minimum) => {
      const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
      const value = Number.parseFloat(slider?.value ?? '');
      return Number.isFinite(value) && value >= minimum;
    },
    minimumSeconds,
    { timeout },
  );
}

async function waitForPlaylistRows(
  page: HostGuestPair['hostPage'],
  expectedCount: number,
  timeout = 20_000,
): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('#playlist-ui .playlist-entry').length === expected,
    expectedCount,
    { timeout },
  );
}

async function seekFromHost(page: HostGuestPair['hostPage'], targetSeconds: number): Promise<void> {
  await page.locator('#seek-slider').evaluate((element, target) => {
    const slider = element as HTMLInputElement;
    slider.value = String(target);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }, targetSeconds);
}

async function waitForPlayIcon(
  page: HostGuestPair['hostPage'],
  playing: boolean,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (expectedPlaying) => {
      const path =
        document.querySelector<SVGPathElement>('#play-btn path')?.getAttribute('d') ?? '';
      return expectedPlaying ? path.startsWith('M6 19h4V5H6') : path.startsWith('M8 5v14');
    },
    playing,
    { timeout },
  );
}

async function waitForTerminalStop(page: HostGuestPair['hostPage']): Promise<void> {
  await page.waitForFunction(
    () => {
      const playlist = document.getElementById('playlist-ui');
      const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
      const playButton = document.getElementById('play-btn');
      const position = Number.parseFloat(slider?.value ?? '');
      const playPath =
        document.querySelector<SVGPathElement>('#play-btn path')?.getAttribute('d') ?? '';
      return (
        playlist?.querySelectorAll('.playlist-entry').length === 0 &&
        Number.isFinite(position) &&
        position <= 0.05 &&
        playButton?.getAttribute('aria-disabled') === 'true' &&
        playPath.startsWith('M8 5v14')
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

test.describe('bounded V1 production candidate', () => {
  test.afterEach(async () => {
    if (pair) await cleanupContexts(pair);
    pair = undefined;
  });

  test('keeps stable room services live when local publication falls back', async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    const hostConsoleMessages: string[] = [];
    pair.hostPage.on('console', (message) => hostConsoleMessages.push(message.text()));

    const code = await connectHostAndGuest(pair.hostPage, pair.guestPage);
    expect(code).toMatch(/^[1-9]\d{5}$/u);

    // The exact production artifact embeds and executes this invariant before
    // app bootstrap: bounded V1 must match its tracked latch and retired V2
    // must remain OFF. Static presence also pins the tested preview directory.
    const artifact = await readMainArtifact(pair.hostPage);
    expect(artifact.split(PRODUCTION_GATE_MARKER)).toHaveLength(2);

    await Promise.all([
      waitForDeviceCount(pair.hostPage, 2),
      waitForDeviceCount(pair.guestPage, 2),
    ]);

    // localhost intentionally has no remote-share endpoint. A supported file
    // therefore exercises the bounded publication/negotiation failure lane
    // and its per-peer stable-V1 fallback without mutating production R2.
    await uploadFixture(pair.hostPage, 'test01');
    await Promise.all([
      waitForPlaylistRows(pair.hostPage, 1),
      waitForPlaylistRows(pair.guestPage, 1),
    ]);
    await expect
      .poll(
        () =>
          hostConsoleMessages.some((message) =>
            message.includes('[LegacyBoundedV1Product] Runtime failure at host-publication'),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    // The publication failure must fall back to the existing stable V1 path,
    // not merely leave a connected but unusable room. Exercise the complete
    // user-visible transport lifecycle on both peers. This is an exact
    // production artifact, so assertions intentionally use public DOM
    // evidence rather than production-disabled internal state hooks.
    await clickPlayButton(pair.hostPage, 20_000);
    await Promise.all([
      waitForPlayIcon(pair.hostPage, true, 20_000),
      waitForPlayIcon(pair.guestPage, true, 30_000),
    ]);
    await Promise.all([
      waitForSeekAtLeast(pair.hostPage, 0.35, 10_000),
      waitForSeekAtLeast(pair.guestPage, 0.2, 15_000),
    ]);

    const seekTargetSeconds = 6;
    await seekFromHost(pair.hostPage, seekTargetSeconds);
    await Promise.all([
      waitForSeekAtLeast(pair.hostPage, seekTargetSeconds - 0.25),
      waitForSeekAtLeast(pair.guestPage, seekTargetSeconds - 0.75, 20_000),
    ]);

    await clickPlayButton(pair.hostPage);
    await Promise.all([
      waitForPlayIcon(pair.hostPage, false),
      waitForPlayIcon(pair.guestPage, false, 20_000),
    ]);
    const pausedHostSeconds = await readSeekSeconds(pair.hostPage);
    const pausedGuestSeconds = await readSeekSeconds(pair.guestPage);
    await pair.hostPage.waitForTimeout(700);
    expect(Math.abs((await readSeekSeconds(pair.hostPage)) - pausedHostSeconds)).toBeLessThan(0.2);
    expect(Math.abs((await readSeekSeconds(pair.guestPage)) - pausedGuestSeconds)).toBeLessThan(
      0.3,
    );

    await clickPlayButton(pair.hostPage);
    await Promise.all([
      waitForPlayIcon(pair.hostPage, true),
      waitForPlayIcon(pair.guestPage, true, 20_000),
    ]);
    await Promise.all([
      waitForSeekAtLeast(pair.hostPage, pausedHostSeconds + 0.3, 10_000),
      waitForSeekAtLeast(pair.guestPage, pausedGuestSeconds + 0.2, 15_000),
    ]);

    // Removing the final row is the terminal STOP path. It must retire the
    // resident file and converge both peers to an empty, idle projection.
    const removeButton = pair.hostPage.locator('#playlist-ui .btn-playlist-remove').first();
    await expect(removeButton).toBeVisible();
    await removeButton.click();
    await pair.hostPage.locator('.playlist-selection-delete').click();
    await Promise.all([waitForTerminalStop(pair.hostPage), waitForTerminalStop(pair.guestPage)]);

    // Check generic room protocols after terminal retirement, not only before
    // it. A playback fallback/STOP must never close the host connection.
    await Promise.all([openChatDrawer(pair.hostPage), openChatDrawer(pair.guestPage)]);
    const guestMessage = `bounded-fallback-guest-${code}`;
    const hostMessage = `bounded-fallback-host-${code}`;

    await sendChat(pair.guestPage, guestMessage);
    await waitForChatMessage(pair.hostPage, guestMessage);
    await sendChat(pair.hostPage, hostMessage);
    await waitForChatMessage(pair.guestPage, hostMessage);

    // Recheck after publication settlement. A bounded failure must not invoke
    // the old room-fatal connection path or strand generic room protocols.
    await Promise.all([
      waitForDeviceCount(pair.hostPage, 2),
      waitForDeviceCount(pair.guestPage, 2),
    ]);
    await expect(pair.hostPage.locator('#playlist-ui .playlist-entry')).toHaveCount(0);
    await expect(pair.guestPage.locator('#playlist-ui .playlist-entry')).toHaveCount(0);
    expect(getPageErrors(pair.hostPage)).toEqual([]);
    expect(getPageErrors(pair.guestPage)).toEqual([]);
  });
});
