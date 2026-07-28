import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  cleanupContexts,
  createHostGuestContexts,
  getPageErrors,
  type HostGuestPair,
} from '../helpers/context-factory.ts';
import { installUniversalNetworkStubs } from './network-stubs.ts';
import {
  UNIVERSAL_LIFECYCLE_KINDS,
  captureUniversalConsole,
  endUniversalProductRoom,
  expectUniversalLifecycleOccupancy,
  expectUniversalRoom,
  injectForcedUniversalLifecycleRetirement,
  logUniversalDiagnostics,
  readUniversalRuntime,
  stopUniversalProductPlayback,
  universalLifecycleOccupancy,
  waitForBoundedPlayback,
  type UniversalLifecycleSnapshot,
  type UniversalLifecycleOccupancy,
} from './runtime-assertions.ts';

const FLAC_FIXTURE = resolve('.vite/universal-fixtures/bounded-tone.flac');
const KIND_COUNTER_KEYS = Object.freeze([
  'live',
  'retiring',
  'unconfirmed',
  'acquiredTotal',
  'releasedTotal',
  'highWater',
] as const);
const PHYSICAL_PLAYBACK_KINDS = Object.freeze([
  'playbackSources',
  'encodedSources',
  'decoderGenerations',
  'workers',
  'ports',
  'rings',
] as const);

let pair: HostGuestPair;

function expectPiiFreeFixedLifecycleSnapshot(snapshot: UniversalLifecycleSnapshot): void {
  expect(Object.keys(snapshot).sort()).toEqual(
    ['forcedRetirements', 'invariantFaults', 'kinds', 'quiescent', 'sequence'].sort(),
  );
  expect(Object.keys(snapshot.kinds)).toEqual(UNIVERSAL_LIFECYCLE_KINDS);
  expect(typeof snapshot.quiescent).toBe('boolean');
  for (const value of [snapshot.sequence, snapshot.invariantFaults, snapshot.forcedRetirements]) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  for (const kind of UNIVERSAL_LIFECYCLE_KINDS) {
    const counters = snapshot.kinds[kind];
    expect(Object.keys(counters)).toEqual(KIND_COUNTER_KEYS);
    for (const value of Object.values(counters)) {
      expect(typeof value).toBe('number');
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(counters.acquiredTotal).toBe(
      counters.releasedTotal + counters.live + counters.retiring + counters.unconfirmed,
    );
  }
  const serialized = JSON.stringify(snapshot);
  expect(serialized).not.toMatch(
    /(?:queueItem|peer|participant|filename|identity|label|error|message|stack)/i,
  );
}

function expectPhysicalPlaybackOwnership(snapshot: UniversalLifecycleSnapshot): void {
  for (const kind of PHYSICAL_PLAYBACK_KINDS) {
    const counters = snapshot.kinds[kind];
    expect(
      counters.live + counters.retiring,
      `${kind} must remain physically owned while playback is active`,
    ).toBeGreaterThan(0);
  }
}

function withRetainedEncodedSources(
  baseline: UniversalLifecycleOccupancy,
  retainedLiveSources: number,
): UniversalLifecycleOccupancy {
  return Object.freeze({
    ...baseline,
    encodedSources: Object.freeze({
      ...baseline.encodedSources,
      live: baseline.encodedSources.live + retainedLiveSources,
    }),
  });
}

async function navigateOnce(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('#btn-setup-host').waitFor({ state: 'visible' });
}

async function connectWithoutDocumentNavigation(hostPage: Page, guestPage: Page): Promise<void> {
  await hostPage.click('#btn-setup-host');
  await hostPage.locator('#setup-code-area').waitFor({ state: 'visible' });
  await hostPage.waitForFunction(() => {
    const element = document.getElementById('setup-code');
    const value =
      element instanceof HTMLInputElement ? element.value : (element?.textContent ?? '');
    return /^\d{6}$/.test(value.trim());
  });
  const code = await hostPage
    .locator('#setup-code')
    .inputValue()
    .catch(async () => {
      return (await hostPage.locator('#setup-code').textContent()) ?? '';
    });
  await hostPage.locator('#btn-setup-confirm:not([disabled])').click();
  await expect(hostPage.locator('#setup-overlay')).not.toHaveClass(/active/);

  await guestPage.click('#btn-setup-guest');
  await guestPage.locator('#setup-join-area').waitFor({ state: 'visible' });
  await guestPage.fill('#setup-join-code', code.trim());
  await guestPage.click('#btn-setup-confirm');
  await expect(guestPage.locator('#setup-overlay')).not.toHaveClass(/active/);
}

async function selectUniqueFlacOccurrence(hostPage: Page, cycle: number): Promise<void> {
  await hostPage.locator('#file-input').setInputFiles({
    name: `bounded-lifecycle-${cycle + 1}.flac`,
    mimeType: 'audio/flac',
    buffer: await readFile(FLAC_FIXTURE),
  });
  await expect(hostPage.locator('#playlist-ui .playlist-entry')).toHaveCount(cycle + 1, {
    timeout: 15_000,
  });
  if (cycle > 0) {
    // stopCurrent() retires only the product renderer; it intentionally keeps
    // the selected queue occurrence. A later file selection therefore warms
    // the new row instead of auto-playing it. Exercise the real playlist
    // command so every cycle creates a distinct product playback lifetime.
    const row = hostPage
      .locator('.playlist-entry[data-queue-item-id] .track-item[data-queue-item-id]')
      .nth(cycle);
    await row.click();
    await expect(row).toHaveClass(/active/);
  }
}

test.describe('universal physical lifecycle retirement', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    captureUniversalConsole(pair.hostPage, 'host');
    captureUniversalConsole(pair.guestPage, 'guest');
    await Promise.all([
      installUniversalNetworkStubs(pair.hostContext),
      installUniversalNetworkStubs(pair.guestContext),
    ]);
  });

  test.afterEach(async () => {
    const hostErrors = getPageErrors(pair.hostPage);
    const guestErrors = getPageErrors(pair.guestPage);
    await cleanupContexts(pair);
    expect(hostErrors, 'host page had an uncaught error').toHaveLength(0);
    expect(guestErrors, 'guest page had an uncaught error').toHaveLength(0);
  });

  test('returns three playback lifetimes and one room lifetime to exact same-document baselines', async () => {
    await Promise.all([navigateOnce(pair.hostPage), navigateOnce(pair.guestPage)]);
    const [hostPageSnapshot, guestPageSnapshot] = await Promise.all([
      readUniversalRuntime(pair.hostPage),
      readUniversalRuntime(pair.guestPage),
    ]);
    expectPiiFreeFixedLifecycleSnapshot(hostPageSnapshot.lifecycle);
    expectPiiFreeFixedLifecycleSnapshot(guestPageSnapshot.lifecycle);
    expect(hostPageSnapshot.lifecycle.quiescent).toBe(true);
    expect(guestPageSnapshot.lifecycle.quiescent).toBe(true);
    const hostPageBaseline = universalLifecycleOccupancy(hostPageSnapshot.lifecycle);
    const guestPageBaseline = universalLifecycleOccupancy(guestPageSnapshot.lifecycle);

    await connectWithoutDocumentNavigation(pair.hostPage, pair.guestPage);
    await Promise.all([
      expectUniversalRoom(pair.hostPage, 'host'),
      expectUniversalRoom(pair.guestPage, 'guest'),
    ]);
    const [hostRoomSnapshot, guestRoomSnapshot] = await Promise.all([
      readUniversalRuntime(pair.hostPage),
      readUniversalRuntime(pair.guestPage),
    ]);
    const hostRoomBaseline = universalLifecycleOccupancy(hostRoomSnapshot.lifecycle);
    const guestRoomBaseline = universalLifecycleOccupancy(guestRoomSnapshot.lifecycle);
    expect(hostRoomSnapshot.lifecycle.kinds.roomOwners.live).toBe(1);
    expect(guestRoomSnapshot.lifecycle.kinds.roomOwners.live).toBe(1);
    expect(hostRoomSnapshot.lifecycle.kinds.connectionOwners.live).toBe(1);
    expect(guestRoomSnapshot.lifecycle.kinds.connectionOwners.live).toBe(1);
    let priorHostLifecycle = hostRoomSnapshot.lifecycle;
    let priorGuestLifecycle = guestRoomSnapshot.lifecycle;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await selectUniqueFlacOccurrence(pair.hostPage, cycle);
      const playing = await waitForBoundedPlayback(pair.hostPage, pair.guestPage, {
        timeout: 45_000,
      });
      expectPiiFreeFixedLifecycleSnapshot(playing.host.lifecycle);
      expectPiiFreeFixedLifecycleSnapshot(playing.guest.lifecycle);
      expectPhysicalPlaybackOwnership(playing.host.lifecycle);
      expectPhysicalPlaybackOwnership(playing.guest.lifecycle);
      for (const kind of PHYSICAL_PLAYBACK_KINDS) {
        expect(
          playing.host.lifecycle.kinds[kind].acquiredTotal,
          `host ${kind} did not create a new physical lifetime in cycle ${cycle + 1}`,
        ).toBeGreaterThan(priorHostLifecycle.kinds[kind].acquiredTotal);
        expect(
          playing.guest.lifecycle.kinds[kind].acquiredTotal,
          `guest ${kind} did not create a new physical lifetime in cycle ${cycle + 1}`,
        ).toBeGreaterThan(priorGuestLifecycle.kinds[kind].acquiredTotal);
      }

      await stopUniversalProductPlayback(pair.hostPage);
      // Stopping a renderer retires decoder/worker/port/ring ownership on both
      // peers, but it deliberately does not evict reusable room assets. The
      // host and guest registries retain each distinct queue asset for replay
      // until its queue occurrence is removed or the room ends.
      const hostPlaybackBaseline = withRetainedEncodedSources(hostRoomBaseline, cycle + 1);
      const guestPlaybackBaseline = withRetainedEncodedSources(guestRoomBaseline, cycle + 1);
      try {
        await Promise.all([
          expectUniversalLifecycleOccupancy(pair.hostPage, hostPlaybackBaseline),
          expectUniversalLifecycleOccupancy(pair.guestPage, guestPlaybackBaseline),
        ]);
      } catch (error) {
        await logUniversalDiagnostics(
          `lifecycle-retirement-cycle-${cycle + 1}`,
          pair.hostPage,
          pair.guestPage,
        );
        throw error;
      }
      const [hostRetired, guestRetired] = await Promise.all([
        readUniversalRuntime(pair.hostPage),
        readUniversalRuntime(pair.guestPage),
      ]);
      expect(hostRetired.lifecycle.invariantFaults).toBe(0);
      expect(guestRetired.lifecycle.invariantFaults).toBe(0);
      expect(hostRetired.lifecycle.forcedRetirements).toBe(0);
      expect(guestRetired.lifecycle.forcedRetirements).toBe(0);
      priorHostLifecycle = hostRetired.lifecycle;
      priorGuestLifecycle = guestRetired.lifecycle;
    }

    await Promise.all([
      endUniversalProductRoom(pair.guestPage),
      endUniversalProductRoom(pair.hostPage),
    ]);
    await Promise.all([
      expectUniversalLifecycleOccupancy(pair.hostPage, hostPageBaseline),
      expectUniversalLifecycleOccupancy(pair.guestPage, guestPageBaseline),
    ]);
  });

  test('forced cleanup remains visibly unconfirmed instead of reporting a false zero', async () => {
    await navigateOnce(pair.hostPage);
    const before = (await readUniversalRuntime(pair.hostPage)).lifecycle;
    const after = await injectForcedUniversalLifecycleRetirement(pair.hostPage);

    expectPiiFreeFixedLifecycleSnapshot(after);
    expect(after.kinds.timers.unconfirmed).toBe(before.kinds.timers.unconfirmed + 1);
    expect(after.kinds.timers.live).toBe(before.kinds.timers.live);
    expect(after.kinds.timers.retiring).toBe(before.kinds.timers.retiring);
    expect(after.forcedRetirements).toBe(before.forcedRetirements + 1);
    expect(after.invariantFaults).toBe(before.invariantFaults);
    expect(after.quiescent).toBe(false);
  });
});
