import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const DOC_PATH = '.workshop/developers/developers.html';
const OPENAPI_PATH = 'public/developers/openapi.yaml';

describe('Developer API public documentation', () => {
  it('uses the shared policy-page shell and canonical public URL', async () => {
    const html = await readFile(DOC_PATH, 'utf8');

    expect(html).toContain('<link rel="canonical" href="https://musixquare.com/developers">');
    expect(html).toContain('<link rel="stylesheet" href="/css/pretendard.css">');
    expect(html).toContain('<link rel="stylesheet" href="/legal-pages.css">');
    expect(html).toContain('<header class="policy-header">');
    expect(html).toContain('<main class="policy-shell">');
    expect(html).toContain('<article class="policy-doc">');
    expect(html).toContain('<footer class="policy-footer">');
    expect(html).toContain('href="/developers/openapi.yaml"');
  });

  it('documents every enabled public route and the server-only security boundary', async () => {
    const html = await readFile(DOC_PATH, 'utf8');
    const expectedRoutes = [
      '/rooms/{roomCode}',
      '/rooms/{roomCode}/playback',
      '/rooms/{roomCode}/queue',
      '/rooms/{roomCode}/commands',
      '/rooms/{roomCode}/commands/{commandId}',
      '/rooms/{roomCode}/queue/items',
      '/rooms/{roomCode}/queue/items/{queueItemId}',
      '/rooms/{roomCode}/queue/order',
      '/rooms/{roomCode}/media/uploads',
      '/rooms/{roomCode}/media/uploads/{assetId}/complete',
    ];

    for (const route of expectedRoutes) expect(html).toContain(route);
    expect(html).toContain('server-to-server API');
    expect(html).toContain('Calls made directly from browser pages are rejected');
    expect(html).toContain('Every mutation requires a unique <code>Idempotency-Key</code>');
    expect(html).toContain('directly to a short-lived signed R2 URL');
  });

  it('contains placeholders rather than a deployable Developer API credential', async () => {
    const html = await readFile(DOC_PATH, 'utf8');
    const liveKeyPattern = /mxqr_live_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}/;

    expect(html).not.toMatch(liveKeyPattern);
    expect(html).toContain('mxqr_live_&lt;key-id&gt;.&lt;secret&gt;');
    expect(html).not.toContain("const roomCode = '000001'");
  });

  it('publishes an OpenAPI 3.1 contract for the same route surface', async () => {
    const spec = await readFile(OPENAPI_PATH, 'utf8');
    const expectedPaths = [
      '/health:',
      '/v1/rooms/{roomCode}:',
      '/v1/rooms/{roomCode}/playback:',
      '/v1/rooms/{roomCode}/queue:',
      '/v1/rooms/{roomCode}/commands:',
      '/v1/rooms/{roomCode}/commands/{commandId}:',
      '/v1/rooms/{roomCode}/queue/items:',
      '/v1/rooms/{roomCode}/queue/items/{queueItemId}:',
      '/v1/rooms/{roomCode}/queue/order:',
      '/v1/rooms/{roomCode}/media/uploads:',
      '/v1/rooms/{roomCode}/media/uploads/{assetId}/complete:',
    ];

    expect(spec).toMatch(/^openapi: 3\.1\.0/m);
    expect(spec).toContain('url: https://api.musixquare.com');
    expect(spec).toContain('developerApiKey: []');
    expect(spec).toContain('Idempotency-Key');
    expect(spec).toContain('queueItemIds');
    expect(spec).toContain('sha256:');
    for (const path of expectedPaths) expect(spec).toContain(path);
    expect(spec).not.toContain('/internal/');
  });

  it('links to the Developer API page from each shared document footer', async () => {
    const files = [
      '.workshop/privacy/privacy.html',
      '.workshop/terms/terms.html',
      '.workshop/faq/faq.html',
    ];

    for (const file of files) {
      const html = await readFile(file, 'utf8');
      expect(html).toContain('<a href="/developers">Developers</a>');
    }
  });
});
