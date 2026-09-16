import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  observeRemoteDownloads,
  waitForTrackPlaybackProgress,
} from './helpers/production-r2-observation.ts';

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
