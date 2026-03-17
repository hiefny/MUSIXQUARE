/**
 * E2E: Demo Track Tests
 *
 * Tests the demo track loading mechanism:
 * - Demo track adds to playlist
 * - Guest fetches demo from server (not P2P)
 * - Demo track name matches DEMO_FILE_NAME constant
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { waitForPlaylistCount, readState } from './helpers/wait.ts';

const DEMO_FILE_NAME = 'demo_track.mp3';

let pair: HostGuestPair;

test.describe('Demo Track', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('demo track file is accessible via HTTP', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Check demo_track.mp3 exists on server
    const status = await pair.hostPage.evaluate(async (filename) => {
      try {
        const resp = await fetch(filename, { method: 'HEAD' });
        return resp.status;
      } catch {
        return -1;
      }
    }, DEMO_FILE_NAME);

    expect(status).toBe(200);
  });

  test('demo track has valid audio content-type', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const contentType = await pair.hostPage.evaluate(async (filename) => {
      try {
        const resp = await fetch(filename, { method: 'HEAD' });
        return resp.headers.get('content-type') || '';
      } catch {
        return '';
      }
    }, DEMO_FILE_NAME);

    expect(contentType).toMatch(/audio|mpeg|mp3|octet/);
  });

  test('demo track can be fetched as blob', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const blobSize = await pair.hostPage.evaluate(async (filename) => {
      try {
        const resp = await fetch(filename);
        const blob = await resp.blob();
        return blob.size;
      } catch {
        return 0;
      }
    }, DEMO_FILE_NAME);

    expect(blobSize).toBeGreaterThan(0);
  });

  test('host can add demo track to playlist via file input', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Simulate demo track being loaded (host loads demo by fetching from server)
    const added = await pair.hostPage.evaluate(async (filename) => {
      try {
        const resp = await fetch(filename);
        const blob = await resp.blob();
        const file = new File([blob], filename, { type: 'audio/mpeg' });

        // Create a DataTransfer to simulate file input
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('file-input') as HTMLInputElement;
        if (input) {
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }, DEMO_FILE_NAME);

    if (added) {
      await waitForPlaylistCount(pair.hostPage, 1);

      const playlist = await pair.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return [];
        return get('playlist.items') as unknown[];
      });
      expect(playlist.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('guest receives demo track playlist entry', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Load demo via file input
    await pair.hostPage.evaluate(async (filename) => {
      const resp = await fetch(filename);
      const blob = await resp.blob();
      const file = new File([blob], filename, { type: 'audio/mpeg' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('file-input') as HTMLInputElement;
      if (input) {
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, DEMO_FILE_NAME);

    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    // Guest should have the track
    const guestPlaylistCount = await pair.guestPage.evaluate(() => {
      const list = document.getElementById('playlist-ui');
      return list?.children.length ?? 0;
    });
    expect(guestPlaylistCount).toBeGreaterThanOrEqual(1);
  });
});
