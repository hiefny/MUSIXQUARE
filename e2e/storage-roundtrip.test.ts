/**
 * E2E: Storage Round-Trip Integrity
 *
 * Closes the gap that `file-transfer.test.ts` and the ramstore unit tests
 * leave open: a host's file blob and the guest's reconstructed blob must
 * be byte-identical (same size and SHA-256 digest after guest finalization)
 * by the time `transfer.state` reaches READY.
 *
 * The unit tests cover ramstore in isolation; this scenario verifies the
 * full transport → in-process bridge → blob assembly pipeline end-to-end.
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { readState, waitForPlaylistCount } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Storage Round-Trip', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('guest blob matches host bytes and identity after transfer', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.guestPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        if (!get) return false;
        return get('transfer.state') === 'READY' && get('files.current') != null;
      },
      undefined,
      { timeout: 25_000 },
    );

    // Digest the actual residents inside each browser. Equal metadata alone
    // cannot detect reordered or corrupted chunks of the same total size.
    const hostInfo = await pair.hostPage.evaluate(async () => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return null;
      const current = get('files.current') as {
        blob?: Blob;
        name?: string;
        queueItemId?: string;
      } | null;
      return {
        size: current?.blob?.size ?? null,
        name: current?.name ?? null,
        queueItemId: current?.queueItemId ?? null,
        digest: current?.blob
          ? Array.from(
              new Uint8Array(
                await crypto.subtle.digest('SHA-256', await current.blob.arrayBuffer()),
              ),
            )
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join('')
          : null,
      };
    });

    const guestInfo = await pair.guestPage.evaluate(async () => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return null;
      const current = get('files.current') as {
        blob?: Blob;
        name?: string;
        queueItemId?: string;
      } | null;
      return {
        size: current?.blob?.size ?? null,
        name: current?.name ?? null,
        queueItemId: current?.queueItemId ?? null,
        digest: current?.blob
          ? Array.from(
              new Uint8Array(
                await crypto.subtle.digest('SHA-256', await current.blob.arrayBuffer()),
              ),
            )
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join('')
          : null,
      };
    });

    expect(hostInfo).not.toBeNull();
    expect(guestInfo).not.toBeNull();
    expect(guestInfo!.size).toBeGreaterThan(0);
    expect(guestInfo!.size).toBe(hostInfo!.size);
    expect(guestInfo!.name).toBe(hostInfo!.name);
    expect(guestInfo!.queueItemId).toBe(hostInfo!.queueItemId);
    expect(hostInfo!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(guestInfo!.digest).toBe(hostInfo!.digest);
  });

  test('guest transfer metadata and atomic resident agree after transfer', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.guestPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        if (!get) return false;
        return get('transfer.state') === 'READY' && get('files.current') != null;
      },
      undefined,
      { timeout: 25_000 },
    );

    const meta = (await readState(pair.guestPage, 'transfer.meta')) as {
      name?: string;
      queueItemId?: string;
    } | null;
    // Project Blob properties inside the page. Playwright does not preserve a
    // browser Blob's properties when the containing state object is serialized.
    const current = await pair.guestPage.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      const resident = get?.('files.current') as
        | { name?: string; queueItemId?: string; blob?: Blob }
        | null
        | undefined;
      if (!resident) return null;
      return {
        name: resident.name,
        queueItemId: resident.queueItemId,
        size: resident.blob?.size,
      };
    });

    // Finalization publishes Blob and ownership as one resident snapshot.
    // The resident and transfer metadata must describe the same occurrence.
    // A mismatch implies stale metadata crossed the queue-item/session gate.
    expect(meta?.name).toBeTruthy();
    expect(current?.size).toBeGreaterThan(0);
    expect(current?.name).toBe(meta?.name);
    expect(current?.queueItemId).toBe(meta?.queueItemId);
  });
});
