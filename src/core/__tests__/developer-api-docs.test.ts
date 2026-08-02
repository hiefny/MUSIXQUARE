import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const DOC_PATH = '.workshop/developers/developers.html';
const OPENAPI_PATH = 'public/developers/openapi.yaml';
const WORKER_PATH = 'cloudflare/developer-api-worker.js';

const PUBLIC_ERROR_CONTRACT = [
  ['API_DISABLED', 503, true],
  ['API_NOT_CONFIGURED', 503, true],
  ['ASSET_CAPACITY_EXCEEDED', 409, false],
  ['BACKEND_UNAVAILABLE', 503, true],
  ['BROWSER_ORIGIN_FORBIDDEN', 403, false],
  ['COMMAND_CAPACITY_EXCEEDED', 409, false],
  ['COORDINATOR_INCOMPATIBLE', 409, false],
  ['FORBIDDEN', 403, false],
  ['IDEMPOTENCY_CONFLICT', 409, false],
  ['IDEMPOTENCY_KEY_REQUIRED', 400, false],
  ['INTERNAL_RESPONSE_INVALID', 503, true],
  ['INVALID_REQUEST', 400, false],
  ['NOT_FOUND', 404, false],
  ['NO_MEDIA', 409, false],
  ['PLAYLIST_CAPACITY_EXCEEDED', 409, false],
  ['PLAYLIST_REVISION_CONFLICT', 409, false],
  ['QUEUE_MODE_REVISION_CONFLICT', 409, false],
  ['RATE_LIMITED', 429, true],
  ['RESERVATION_CAPACITY_EXCEEDED', 409, false],
  ['ROOM_QUOTA_EXCEEDED', 409, false],
  ['ROOM_SLEEPING', 409, false],
  ['ROOM_STATE_CAPACITY_EXCEEDED', 409, false],
  ['UNAUTHORIZED', 401, false],
  ['UPLOAD_INCOMPLETE', 409, true],
  ['UPLOAD_MISMATCH', 409, false],
] as const;

function extractDeclarationBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex + start.length, endIndex);
}

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
    expect(html).toContain('<p class="policy-kicker">PUBLIC API</p>');
    expect(html).not.toMatch(/private beta/i);
  });

  it('documents every enabled public route and the server-only security boundary', async () => {
    const html = await readFile(DOC_PATH, 'utf8');
    const expectedRoutes = [
      '/rooms/{roomCode}',
      '/rooms/{roomCode}/playback',
      '/rooms/{roomCode}/effects',
      '/rooms/{roomCode}/queue-mode',
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
    expect(html).toContain('Authority and attribution');
    expect(html).toContain('highest-privilege room credential within its assigned scopes');
    expect(html).toContain('separately identify the requesting user');
    expect(html).toMatch(
      /Require explicit confirmation for destructive or broadly scoped\s+actions/,
    );
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
      '/v1/rooms/{roomCode}/queue-mode:',
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
    expect(spec).toMatch(/^  version: 1\.0\.0$/m);
    expect(spec).not.toMatch(/^  version: .*beta/im);
    expect(spec).toContain('url: https://api.musixquare.com');
    expect(spec).toContain('developerApiKey: []');
    expect(spec).toContain('highest-privilege room credential within its assigned scopes');
    expect(spec).toContain('MUSIXQUARE does not verify the human requester');
    expect(spec).toContain('must confirm destructive or broadly scoped actions explicitly');
    expect(spec).toContain('Idempotency-Key');
    expect(spec).toContain('queueItemIds');
    expect(spec).toContain('sha256:');
    for (const path of expectedPaths) expect(spec).toContain(path);
    expect(spec).not.toContain('/internal/');
  });

  it('keeps the internal authority design aligned with the public API principal', async () => {
    const [identityDesign, proDesign] = await Promise.all([
      readFile('docs/design/account-identity-and-room-authority.md', 'utf8'),
      readFile('docs/design/pro-room-architecture-and-operations.md', 'utf8'),
    ]);
    expect(identityDesign).toContain('separate server-to-server principal');
    expect(proDesign).toMatch(/independent room-authoritative\s+principals/);
    for (const design of [identityDesign, proDesign]) {
      expect(design).not.toMatch(
        /BOT and\s+Developer API commands are checked as the initiating room member/,
      );
    }
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
    expect(html).toMatch(/applied directly by the room server while the room is\s+active/);
    expect(html).toContain('does not wait for a browser coordinator');
    expect(spec).toContain(
      'set_effects is applied directly by the room server while the room is active',
    );
    expect(html).not.toMatch(/effect command still requires an awake room/i);

    for (const example of [
      'mixPercent: 40',
      '{ mixPercent: 0 }',
      '[0, -2, 0, 4, 6]',
      '[0, 0, 0, 0, 0]',
      'on value is <code>60</code>; off is\n              <code>0</code>',
      'on value is <code>120</code>; neutral/off is <code>100</code>',
      'virtualTreble: { enabled: true }',
      '<code>X-MXQR-Effects-Version: 2</code>',
      '<code>enabled</code> is a boolean',
    ]) {
      expect(html).toContain(example);
    }
    expect(html).toContain('YouTube playback is unaffected');
    expect(html).toContain('do not control device-local volume, channel roles');

    expect(spec).toContain('operationId: getEffects');
    expect(spec).toContain('EffectsState:');
    expect(spec).toContain('RoomEffects:');
    expect(spec).not.toContain('EffectsStateV2:');
    expect(spec).not.toContain('RoomEffectsV2:');
    expect(spec).toContain('SetEffectsCommand:');
    expect(spec).toContain('EffectsPatch:');
    expect(spec).toContain('type: { const: set_effects }');
    expect(spec).toContain('minProperties: 1');
    expect(spec).toContain(
      'required: [schemaVersion, view, roomCode, revision, updatedAtMs, effects]',
    );
    expect(spec).toContain(
      'required: [reverb, equalizer, virtualBass, virtualSurround, virtualTreble]',
    );
    expect(spec).toContain('virtualTreble: { $ref:');
    expect(spec).toContain('X-MXQR-Effects-Version: 2 is required');
    const effectsVersion = extractDeclarationBlock(
      spec,
      '    EffectsVersion:\n',
      '    IdempotencyKey:\n',
    );
    expect(effectsVersion).toContain('required: true');
    expect(effectsVersion).toContain("const: '2'");
    expect(effectsVersion).not.toContain('default:');
    expect(effectsVersion).not.toContain('enum:');
    expect(spec).toContain(
      "'304':\n          description: Representation is unchanged.\n          headers:\n            Vary: { schema: { const: X-MXQR-Effects-Version } }",
    );
    expect(spec).toContain(
      'required: [mixPercent, decaySeconds, preDelaySeconds, lowCutPercent, highCutPercent]',
    );
    expect(spec).toContain('items: { type: number, minimum: -12, maximum: 12 }');
    expect(spec).toContain('strengthPercent: { type: number, minimum: 0, maximum: 100 }');
    expect(spec).toContain('widthPercent: { type: number, minimum: 0, maximum: 200 }');

    const numberedHeadings = [...html.matchAll(/<h2>(\d+)\./g)].map((match) => Number(match[1]));
    expect(numberedHeadings).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('documents optimistic, explicit queue-mode control without exposing shuffle order', async () => {
    const [html, spec] = await Promise.all([
      readFile(DOC_PATH, 'utf8'),
      readFile(OPENAPI_PATH, 'utf8'),
    ]);

    expect(html).toContain('/rooms/{roomCode}/queue-mode');
    expect(html).toContain('Queue mode is an explicit setter, not a toggle');
    expect(html).toContain('<code>409 QUEUE_MODE_REVISION_CONFLICT</code>');
    expect(html).toContain('work while the PRO room is sleeping');
    expect(html).toContain('The exact shuffle order is server-owned and intentionally hidden');
    expect(html).toContain("repeatMode: 'all'");
    expect(html).toContain('baseRevision: queueMode.revision');

    expect(spec).toContain('operationId: getQueueMode');
    expect(spec).toContain('operationId: updateQueueMode');
    expect(spec).toContain('QueueModeState:');
    expect(spec).toContain('QueueModeUpdate:');
    expect(spec).toContain('required: [baseRevision, repeatMode, shuffleEnabled]');
    expect(spec).toContain('repeatMode: { enum: [off, all, one] }');
    expect(spec).toContain('Requires playback:read');
    expect(spec).toContain('Requires playback:control');
    expect(spec).toContain('QUEUE_MODE_REVISION_CONFLICT');
    expect(spec).not.toMatch(/^\s+shuffleOrder:/m);
  });

  it('documents atomic YouTube batches and bounded non-atomic audio upload concurrency', async () => {
    const [html, spec] = await Promise.all([
      readFile(DOC_PATH, 'utf8'),
      readFile(OPENAPI_PATH, 'utf8'),
    ]);

    expect(html).toContain('/rooms/{roomCode}/queue/items/batch');
    expect(html).toContain('Atomically add 1&ndash;100 YouTube items');
    expect(html).toContain('whichever comes first: 100 items or a 128 KiB');
    expect(html).toContain('A manifest accepts 1&ndash;5,000 IDs, preserves duplicates');
    expect(html).toContain('Math.min(2, pending.length)');
    expect(html).toContain('Multi-file audio upload is intentionally not atomic');
    expect(spec).toContain('operationId: addYouTubeQueueItemsBatch');
    expect(spec).toContain('YouTubeQueueItemBatchCreate:');
    expect(spec).toContain('maxItems: 100');
    expect(spec).toContain('whichever is reached first: 100 items or a 128 KiB');
    expect(spec).toContain('videoIds: [playlistId]');
    expect(spec).toContain('maxItems: 5000');
    expect(spec).toContain('Duplicates are significant and preserved');
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

  it('documents privacy-preserving queue provenance as a required field', async () => {
    const [html, spec] = await Promise.all([
      readFile(DOC_PATH, 'utf8'),
      readFile(OPENAPI_PATH, 'utf8'),
    ]);

    for (const value of ['participant', 'current_api_key', 'another_api_key']) {
      expect(html).toContain(`<code>${value}</code>`);
      expect(spec).toContain(value);
    }
    expect(html).toContain('<code>addedBy</code> is always present');
    expect(html).not.toMatch(/addedBy<\/code>[^.]*optional/i);
    expect(html).toMatch(/Raw API key IDs\s+are/);
    expect(spec).toContain('QueueItemAddedBy:');
    expect(spec).toContain("addedBy: { $ref: '#/components/schemas/QueueItemAddedBy' }");
    expect(spec).toContain('required: [queueItemId, kind, name, addedBy]');
    expect(spec).toContain('required: [queueItemId, kind, name, byteLength, addedBy]');
    expect(spec).not.toContain('consumers must treat an omitted value as participant');
  });

  it('publishes the complete runtime error and asynchronous command result catalogs', async () => {
    const [html, spec, worker] = await Promise.all([
      readFile(DOC_PATH, 'utf8'),
      readFile(OPENAPI_PATH, 'utf8'),
      readFile(WORKER_PATH, 'utf8'),
    ]);

    const errorMessages = extractDeclarationBlock(
      worker,
      'const ERROR_MESSAGES = Object.freeze({',
      '\n});',
    );
    const runtimeErrorCodes = [...errorMessages.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)]
      .map((match) => match[1])
      .sort();
    expect(runtimeErrorCodes).toEqual(PUBLIC_ERROR_CONTRACT.map(([code]) => code).sort());

    for (const [code, status, retryable] of PUBLIC_ERROR_CONTRACT) {
      expect(html).toContain(`data-api-error-code="${code}"`);
      expect(html).toContain(
        `<dt><code>${code}</code> &middot; ${status} &middot; retryable: ${retryable}</dt>`,
      );
      expect(spec).toContain(`        - ${code}`);
      expect(spec).toContain(`        ${code}: { httpStatus: ${status}, retryable: ${retryable} }`);
    }

    const resultCodesBlock = extractDeclarationBlock(
      worker,
      'const COMMAND_RESULT_CODES = new Set([',
      '\n]);',
    );
    const runtimeResultCodes = [...resultCodesBlock.matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
    const documentedResultCodes = [...html.matchAll(/data-command-result-code="([a-z_]+)"/g)].map(
      (match) => match[1],
    );
    expect(documentedResultCodes).toEqual(runtimeResultCodes);
    for (const code of runtimeResultCodes) expect(spec).toContain(`        - ${code}`);

    expect(html).toContain('Immediate non-2xx responses use the uppercase codes below');
    expect(html).toContain('inspect its lowercase <code>resultCode</code>');
    expect(spec).toContain("code: { $ref: '#/components/schemas/ApiErrorCode' }");
    expect(spec).toContain("resultCode: { $ref: '#/components/schemas/CommandResultCode' }");
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
