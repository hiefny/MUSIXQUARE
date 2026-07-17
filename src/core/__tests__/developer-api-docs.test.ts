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
      '/rooms/{roomCode}/effects',
      '/rooms/{roomCode}/queue',
      '/rooms/{roomCode}/commands',
      '/rooms/{roomCode}/commands/{commandId}',
      '/rooms/{roomCode}/queue/items',
      '/rooms/{roomCode}/queue/items/batch',
      '/rooms/{roomCode}/queue/items/owned',
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
      '/v1/rooms/{roomCode}/effects:',
      '/v1/rooms/{roomCode}/queue:',
      '/v1/rooms/{roomCode}/commands:',
      '/v1/rooms/{roomCode}/commands/{commandId}:',
      '/v1/rooms/{roomCode}/queue/items:',
      '/v1/rooms/{roomCode}/queue/items/batch:',
      '/v1/rooms/{roomCode}/queue/items/owned:',
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

  it('documents persistent room-wide effects, scopes, ranges, and partial commands', async () => {
    const [html, spec] = await Promise.all([
      readFile(DOC_PATH, 'utf8'),
      readFile(OPENAPI_PATH, 'utf8'),
    ]);

    expect(html).toContain('<code>effects:read</code>');
    expect(html).toContain('<code>effects:control</code>');
    expect(html).toContain('/rooms/{roomCode}/effects');
    expect(html).toContain("type: 'set_effects'");
    expect(html).toContain('every supplied nested object must contain at least one field');
    expect(html).toContain('persisted across PRO room sleep/wake cycles and coordinator handoffs');
    expect(html).toMatch(/requires an awake room with a compatible active\s+coordinator/);

    for (const example of [
      'mixPercent: 40',
      '{ mixPercent: 0 }',
      '[0, -2, 0, 4, 6]',
      '[0, 0, 0, 0, 0]',
      'on value is <code>60</code>; off is\n              <code>0</code>',
      'on value is <code>120</code>; neutral/off is <code>100</code>',
    ]) {
      expect(html).toContain(example);
    }
    expect(html).toContain('YouTube playback is unaffected');
    expect(html).toContain('do not control device-local volume, channel roles');

    expect(spec).toContain('operationId: getEffects');
    expect(spec).toContain('EffectsState:');
    expect(spec).toContain('RoomEffects:');
    expect(spec).toContain('SetEffectsCommand:');
    expect(spec).toContain('EffectsPatch:');
    expect(spec).toContain('type: { const: set_effects }');
    expect(spec).toContain('minProperties: 1');
    expect(spec).toContain(
      'required: [schemaVersion, view, roomCode, revision, updatedAtMs, effects]',
    );
    expect(spec).toContain('required: [reverb, equalizer, virtualBass, virtualSurround]');
    expect(spec).toContain(
      'required: [mixPercent, decaySeconds, preDelaySeconds, lowCutPercent, highCutPercent]',
    );
    expect(spec).toContain('items: { type: number, minimum: -12, maximum: 12 }');
    expect(spec).toContain('strengthPercent: { type: number, minimum: 0, maximum: 100 }');
    expect(spec).toContain('widthPercent: { type: number, minimum: 0, maximum: 200 }');

    const numberedHeadings = [...html.matchAll(/<h2>(\d+)\./g)].map((match) => Number(match[1]));
    expect(numberedHeadings).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('documents atomic YouTube batches and bounded non-atomic audio upload concurrency', async () => {
    const [html, spec] = await Promise.all([
      readFile(DOC_PATH, 'utf8'),
      readFile(OPENAPI_PATH, 'utf8'),
    ]);

    expect(html).toContain('/rooms/{roomCode}/queue/items/batch');
    expect(html).toContain('Atomically add 1&ndash;100 YouTube items');
    expect(html).toContain('whichever comes first: 100 items or a 64 KiB');
    expect(html).toContain('Math.min(2, pending.length)');
    expect(html).toContain('Multi-file audio upload is intentionally not atomic');
    expect(spec).toContain('operationId: addYouTubeQueueItemsBatch');
    expect(spec).toContain('YouTubeQueueItemBatchCreate:');
    expect(spec).toContain('maxItems: 100');
    expect(spec).toContain('whichever is reached first: 100 items or a 64 KiB');
  });

  it('distinguishes full clear, credential-owned cleanup, and one-item deletion', async () => {
    const [html, spec] = await Promise.all([
      readFile(DOC_PATH, 'utf8'),
      readFile(OPENAPI_PATH, 'utf8'),
    ]);

    expect(html).toContain(
      '<span class="api-method">DELETE</span><span class="api-path">/rooms/{roomCode}/queue/items</span>',
    );
    expect(html).toContain(
      '<span class="api-method">DELETE</span><span class="api-path">/rooms/{roomCode}/queue/items/owned</span>',
    );
    expect(html).toContain(
      '<span class="api-method">DELETE</span><span class="api-path">/rooms/{roomCode}/queue/items/{queueItemId}</span>',
    );
    expect(html).toContain("method: 'DELETE'");
    expect(html).toContain("'Idempotency-Key': crypto.randomUUID()");
    expect(html).toContain('clearedQueue.currentQueueItemId); // null');
    expect(html).toContain('clearedQueue.items.length); // 0');
    expect(html).toContain('Safe bot cleanup: human tracks and tracks from other API keys remain.');
    expect(html).toContain('removes tracks added by');

    expect(spec).toContain('operationId: clearQueue');
    expect(spec).toContain('operationId: deleteQueueItemsOwnedByCurrentApiKey');
    expect(spec).toContain('operationId: deleteQueueItem');
    expect(spec).toContain('Atomically stops current playback');
    expect(spec).toContain('currentQueueItemId set to null');
    expect(spec).toContain("- $ref: '#/components/parameters/IdempotencyKey'");
  });

  it('documents privacy-preserving queue provenance as an additive optional field', async () => {
    const [html, spec] = await Promise.all([
      readFile(DOC_PATH, 'utf8'),
      readFile(OPENAPI_PATH, 'utf8'),
    ]);

    for (const value of ['participant', 'current_api_key', 'another_api_key']) {
      expect(html).toContain(`<code>${value}</code>`);
      expect(spec).toContain(value);
    }
    expect(html).toContain('before provenance tracking may omit this optional field');
    expect(html).toContain('Raw API key IDs are');
    expect(spec).toContain('QueueItemAddedBy:');
    expect(spec).toContain("addedBy: { $ref: '#/components/schemas/QueueItemAddedBy' }");
    expect(spec).not.toMatch(/required: \[[^\]]*addedBy/);
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
