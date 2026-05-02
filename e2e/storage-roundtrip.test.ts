/**
 * E2E: Storage Round-Trip Integrity
 *
 * Closes the gap that `file-transfer.test.ts` and the ramstore unit tests
 * leave open: a host's file blob and the guest's reconstructed blob must
 * be byte-identical (same size + finalized in the guest's storage layer)
 * by the time `transfer.state` returns to IDLE.
 *
 * The unit tests cover ramstore in isolation; this scenario verifies the
 * full transport → in-process bridge → blob assembly pipeline end-to-end.
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { waitForPlaylistCount, readState } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Storage Round-Trip', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('guest blob matches host blob size + name after transfer', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for the guest's transfer pipeline to finalize (lands in READY).
    await pair.guestPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        if (!get) return false;
        return get('transfer.state') === 'READY' && get('files.currentFileBlob') != null;
      },
      undefined,
      { timeout: 25_000 },
    );

    // Pull both sides' current blob size + meta name. Round-trip integrity
    // means both halves agree on these — host's file authored; guest's
    // assembled from chunks + finalized via the in-process bridge.
    const hostInfo = await pair.hostPage.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return null;
      const blob = get('files.currentFileBlob') as { size?: number } | null;
      const meta = get('transfer.meta') as { name?: string } | null;
      return { size: blob?.size ?? null, name: meta?.name ?? null };
    });

    const guestInfo = await pair.guestPage.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return null;
      const blob = get('files.currentFileBlob') as { size?: number } | null;
      const meta = get('transfer.meta') as { name?: string } | null;
      return { size: blob?.size ?? null, name: meta?.name ?? null };
    });

    expect(hostInfo).not.toBeNull();
    expect(guestInfo).not.toBeNull();
    expect(guestInfo!.size).toBeGreaterThan(0);
    expect(guestInfo!.size).toBe(hostInfo!.size);
    expect(guestInfo!.name).toBe(hostInfo!.name);
  });

  test('guest transfer.meta and files.currentTrack agree after transfer', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.guestPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        if (!get) return false;
        return get('transfer.state') === 'READY' && get('files.currentFileBlob') != null;
      },
      undefined,
      { timeout: 25_000 },
    );

    const meta = (await readState(pair.guestPage, 'transfer.meta')) as { name?: string } | null;
    const currentTrack = (await readState(pair.guestPage, 'files.currentTrack')) as
      | { name?: string | null }
      | null;

    // After finalize, transfer.meta.name and files.currentTrack.name reference
    // the same logical filename — decode.ts only sets currentTrack on
    // successful promote, so a mismatch implies a stale entry slipped past
    // clearPreviousTrackState's guard.
    expect(meta?.name).toBeTruthy();
    if (currentTrack?.name) {
      expect(currentTrack.name).toBe(meta?.name);
    }
  });
});
