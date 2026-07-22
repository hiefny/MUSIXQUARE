import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// This contract depends on the browser's real CORS/network stack. The shared
// Playwright profile intentionally keeps web security enabled for every test,
// so release smoke and ordinary E2E cannot hide an origin-policy regression.

test('browser XHR supplies the exact Content-Length signed by the R2 URL', async ({ page }) => {
  let putHeaders: Record<string, string> | null = null;
  let preflightHeaders: Record<string, string> | null = null;
  const server = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    if (request.method === 'OPTIONS') {
      preflightHeaders = Object.fromEntries(
        Object.entries(request.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(',') : value]],
        ),
      );
      response.setHeader('access-control-allow-methods', 'PUT');
      response.setHeader('access-control-allow-headers', 'content-type,x-amz-meta-size-bytes');
      response.writeHead(204).end();
      return;
    }
    putHeaders = Object.fromEntries(
      Object.entries(request.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, Array.isArray(value) ? value.join(',') : value]],
      ),
    );
    request.on('data', () => undefined);
    request.on('end', () => {
      response.setHeader('etag', 'browser-upload');
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  try {
    await page.goto('/');
    const status = await page.evaluate(
      (url) =>
        new Promise<number>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', url);
          xhr.setRequestHeader('content-type', 'application/octet-stream');
          xhr.setRequestHeader('x-amz-meta-size-bytes', '4');
          xhr.onload = () => resolve(xhr.status);
          xhr.onerror = () => reject(new Error('XHR failed'));
          // Application code never sets Content-Length (a forbidden header).
          // Chromium must derive it from the known Blob body for SigV4 to match.
          xhr.send(new Blob([new Uint8Array([1, 2, 3, 4])]));
        }),
      `http://127.0.0.1:${port}/signed-put`,
    );

    expect(status).toBe(200);
    expect(putHeaders).not.toBeNull();
    expect(putHeaders?.['content-length']).toBe('4');
    expect(putHeaders?.['x-amz-meta-size-bytes']).toBe('4');
    const requestedHeaders = preflightHeaders?.['access-control-request-headers'] ?? '';
    expect(requestedHeaders).toContain('x-amz-meta-size-bytes');
    expect(requestedHeaders).not.toContain('content-length');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
