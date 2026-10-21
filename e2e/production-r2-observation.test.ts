import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { acceptLargeRoomUploadConsent } from './helpers/production-r2-dialogs.ts';
import {
  observeRemoteDownloads,
  waitForTrackPlaybackProgress,
} from './helpers/production-r2-observation.ts';

for (const scenario of [
  'expected-guidance',
  'unexpected-consent',
  'unexpected-followup',
] as const) {
  test(`R2 consent dialog handling: ${scenario}`, async ({ page }) => {
    await page.setContent(`<!doctype html>
      <div id="dialog-overlay" class="dialog-overlay show">
        <h2 id="dialog-title">File sharing in a large room</h2>
        <p id="dialog-message">Direct transfer supports 8 guests; larger rooms use Cloudflare R2.</p>
        <button id="btn-dialog-ok">Continue</button>
      </div>`);
    await page.evaluate((kind) => {
      const overlay = document.getElementById('dialog-overlay')!;
      const title = document.getElementById('dialog-title')!;
      const message = document.getElementById('dialog-message')!;
      const button = document.getElementById('btn-dialog-ok')!;
      if (kind === 'unexpected-consent') title.textContent = 'Unexpected permission request';
      let clicks = 0;
      button.addEventListener('click', () => {
        clicks += 1;
        overlay.dataset.clicks = String(clicks);
        if (clicks === 1) {
          // Reuse the still-open overlay, as the production dialog queue does.
          title.textContent =
            kind === 'unexpected-followup' ? 'Upload failed' : 'Please keep the app open';
          message.textContent = 'Switching apps or turning off the screen can stop the sound.';
          button.textContent = 'Got it';
        } else {
          overlay.classList.remove('show');
        }
      });
    }, scenario);

    const dialog = page.locator('#dialog-overlay');
    if (scenario === 'expected-guidance') {
      await acceptLargeRoomUploadConsent(page, 1_000);
      await expect(dialog).toHaveAttribute('data-clicks', '2');
      await expect(dialog).not.toHaveClass(/\bshow\b/u);
    } else {
      await expect(acceptLargeRoomUploadConsent(page, 500)).rejects.toThrow('toHaveText');
      await expect(dialog).toHaveClass(/\bshow\b/u);
      if (scenario === 'unexpected-consent') {
        await expect(dialog).not.toHaveAttribute('data-clicks');
      } else {
        await expect(dialog).toHaveAttribute('data-clicks', '1');
        await expect(page.locator('#dialog-title')).toHaveText('Upload failed');
      }
    }
  });
}

test('R2 monitoring rejects incomplete and failed bodies but accepts a completed retry', async ({
  context,
  page,
}) => {
  const pending = new Map<string, ServerResponse>();
  const server = createServer((request, response) => {
    if (request.url === '/download/http-error') {
      response.writeHead(503).end('unavailable');
    } else if (request.url?.startsWith('/download/')) {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': '8192',
      });
      response.write(Buffer.alloc(4096));
      response.flushHeaders();
      if (request.url === '/download/current') response.end(Buffer.alloc(4096));
      else pending.set(request.url, response);
    } else {
      response.end('<!doctype html><title>Local download probe</title>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const downloads = observeRemoteDownloads(context, '127.0.0.1', 'local regression');
  const requestDownload = async (path: string): Promise<void> => {
    await Promise.all([
      page.waitForResponse((response) => response.url() === `${origin}${path}`),
      page.evaluate((url) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.responseType = 'arraybuffer';
        xhr.send();
      }, `${origin}${path}`),
    ]);
  };

  try {
    await page.goto(origin);
    await requestDownload('/download/current');
    await expect.poll(() => downloads.completed.size).toBe(1);
    await requestDownload('/download/preload');
    // Both 200 responses have arrived, but the second body is still held open.
    expect(downloads.requestCount).toBe(2);
    expect(downloads.completed.has('/download/preload')).toBe(false);

    pending.get('/download/preload')!.destroy();
    await expect.poll(() => downloads.failures.has('/download/preload')).toBe(true);
    expect(downloads.completed.size).toBe(1);

    await requestDownload('/download/http-error');
    await expect.poll(() => downloads.failures.get('/download/http-error')).toBe('HTTP 503');
    expect(downloads.completed.size).toBe(1);

    await requestDownload('/download/preload');
    expect(downloads.completed.size).toBe(1);
    pending.get('/download/preload')!.end(Buffer.alloc(4096));
    await expect.poll(() => downloads.completed.size).toBe(2);
    expect(downloads.failures.has('/download/preload')).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('successor title needs a ready advancing media timeline to pass', async ({ page }) => {
  const audio = await readFile(new URL('./fixtures/test-01.mp3', import.meta.url));
  const server = createServer((request, response) => {
    if (request.url === '/audio.mp3') {
      response.writeHead(200, { 'content-type': 'audio/mpeg' }).end(audio);
      return;
    }
    response.end(`<!doctype html>
      <div id="track-title">r2-live-preload</div>
      <button id="play-btn" aria-busy="false"></button>
      <input id="seek-slider" type="range" min="0" max="90" step="0.1" value="0">
      <audio src="/audio.mp3"></audio>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await expect(waitForTrackPlaybackProgress(page, 'r2-live-preload', 750)).rejects.toThrow(
      'timeline must advance',
    );
    await page.evaluate(async () => {
      const audio = document.querySelector('audio')!;
      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      audio.addEventListener('timeupdate', () => {
        slider.max = String(audio.duration);
        slider.value = String(audio.currentTime);
      });
      document.getElementById('play-btn')!.setAttribute('aria-busy', 'true');
      await audio.play();
    });
    // Even a moving timeline cannot satisfy the check while media is loading.
    await expect(waitForTrackPlaybackProgress(page, 'r2-live-preload', 3_000)).rejects.toThrow(
      'timeline must advance',
    );
    await page.locator('#play-btn').evaluate((button) => button.setAttribute('aria-busy', 'false'));
    await waitForTrackPlaybackProgress(page, 'r2-live-preload', 10_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
