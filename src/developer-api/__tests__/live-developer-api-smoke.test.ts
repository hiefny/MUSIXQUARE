import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertDeveloperApiCanary } from '../../../scripts/live-developer-api-smoke.mjs';

const ROOM = '000001';
const OTHER_ROOM = '000000';
const API_KEY = `mxqr_live_${'A'.repeat(16)}.${'B'.repeat(43)}`;
const YOUTUBE_ITEM_ID = '123e4567-e89b-42d3-a456-426614174001';
const AUDIO_ITEM_ID = '123e4567-e89b-42d3-a456-426614174002';
const ASSET_ID = `asset_${'C'.repeat(24)}`;

function queue(items: Array<Record<string, unknown>> = [], playlistRevision = 1) {
  return {
    schemaVersion: 1,
    view: 'queue',
    roomCode: ROOM,
    playlistRevision,
    currentQueueItemId: null,
    items,
  };
}

function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Developer API live canary smoke', () => {
  it('exercises scoped reads, queue mutations, direct upload, completion, and cleanup', async () => {
    let youtubePresent = false;
    let audioPresent = false;
    let uploadBytes = 0;
    const calls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const method = init.method || 'GET';
        calls.push(`${method} ${url.origin}${url.pathname}`);

        if (url.origin === 'https://storage.example') {
          const body = init.body as Uint8Array;
          uploadBytes = body.byteLength;
          expect(method).toBe('PUT');
          expect(new Headers(init.headers).get('content-length')).toBe('46');
          return new Response(null, { status: 200 });
        }

        if (url.pathname === `/v1/rooms/${OTHER_ROOM}`) {
          return new Response(null, { status: 404 });
        }
        if (url.pathname === `/v1/rooms/${ROOM}` && new Headers(init.headers).has('origin')) {
          return new Response(null, { status: 403 });
        }
        if (
          url.pathname === `/v1/rooms/${ROOM}` &&
          new Headers(init.headers).get('if-none-match') === '"room-etag"'
        ) {
          return new Response(null, { status: 304 });
        }
        if (method === 'GET' && url.pathname === `/v1/rooms/${ROOM}`) {
          return json(
            {
              schemaVersion: 1,
              view: 'room',
              roomCode: ROOM,
              status: 'active',
              runtime: 'sleeping',
              revision: 1,
              participantCount: 0,
              controlAvailable: false,
              quota: {
                limitBytes: 1_073_741_824,
                perAssetLimitBytes: 209_715_200,
                usedBytes: 0,
                reservedBytes: 0,
              },
            },
            200,
            { ETag: '"room-etag"' },
          );
        }
        if (method === 'GET' && url.pathname === `/v1/rooms/${ROOM}/playback`) {
          return json({
            schemaVersion: 1,
            view: 'playback',
            roomCode: ROOM,
            revision: 1,
            playlistRevision: 1,
            state: 'idle',
            queueItemId: null,
            positionSeconds: 0,
            observedAtMs: Date.now(),
            item: null,
          });
        }
        if (method === 'GET' && url.pathname === `/v1/rooms/${ROOM}/queue`) {
          return json(queue());
        }
        if (method === 'GET' && url.pathname === `/v1/rooms/${ROOM}/effects`) {
          return json(
            {
              schemaVersion: 1,
              view: 'effects',
              roomCode: ROOM,
              revision: 1,
              updatedAtMs: Date.now(),
              effects: {
                reverb: {
                  mixPercent: 0,
                  decaySeconds: 5,
                  preDelaySeconds: 0.1,
                  lowCutPercent: 0,
                  highCutPercent: 0,
                },
                equalizer: { bandsDb: [0, 0, 0, 0, 0] },
                virtualBass: { strengthPercent: 0 },
                virtualSurround: { widthPercent: 100 },
              },
            },
            200,
            { ETag: '"effects-etag"' },
          );
        }
        if (method === 'GET' && url.pathname === `/v1/rooms/${ROOM}/queue-mode`) {
          return json(
            {
              schemaVersion: 1,
              view: 'queue-mode',
              roomCode: ROOM,
              revision: 0,
              playlistRevision: 1,
              updatedAtMs: 0,
              repeatMode: 'off',
              shuffleEnabled: false,
            },
            200,
            { ETag: '"queue-mode-etag"' },
          );
        }
        if (method === 'POST' && url.pathname === `/v1/rooms/${ROOM}/queue/items`) {
          youtubePresent = true;
          return json(
            queue(
              [
                {
                  queueItemId: YOUTUBE_ITEM_ID,
                  kind: 'youtube',
                  name: 'MUSIXQUARE API smoke',
                },
              ],
              2,
            ),
            201,
          );
        }
        if (method === 'PUT' && url.pathname === `/v1/rooms/${ROOM}/queue/order`) {
          expect(youtubePresent).toBe(true);
          return json(
            queue(
              [
                {
                  queueItemId: YOUTUBE_ITEM_ID,
                  kind: 'youtube',
                  name: 'MUSIXQUARE API smoke',
                },
              ],
              3,
            ),
          );
        }
        if (
          method === 'DELETE' &&
          url.pathname === `/v1/rooms/${ROOM}/queue/items/${YOUTUBE_ITEM_ID}`
        ) {
          youtubePresent = false;
          return json(queue([], 4));
        }
        if (method === 'POST' && url.pathname === `/v1/rooms/${ROOM}/media/uploads`) {
          return json(
            {
              schemaVersion: 1,
              roomCode: ROOM,
              assetId: ASSET_ID,
              queueItemId: AUDIO_ITEM_ID,
              byteLength: 46,
              uploadExpiresAtMs: Date.now() + 60_000,
              completionExpiresAtMs: Date.now() + 120_000,
              upload: {
                method: 'PUT',
                url: 'https://storage.example/upload',
                headers: { 'content-type': 'audio/wav', 'content-length': '46' },
              },
              quota: { limitBytes: 1_073_741_824, usedBytes: 0, reservedBytes: 46 },
            },
            201,
          );
        }
        if (
          method === 'POST' &&
          url.pathname === `/v1/rooms/${ROOM}/media/uploads/${ASSET_ID}/complete`
        ) {
          audioPresent = true;
          return json(
            {
              schemaVersion: 1,
              roomCode: ROOM,
              asset: {
                kind: 'pro-r2',
                assetId: ASSET_ID,
                version: 1,
                byteLength: 46,
                mime: 'audio/wav',
              },
              queueItem: {
                queueItemId: AUDIO_ITEM_ID,
                kind: 'audio',
                name: 'musixquare-api-smoke.wav',
                byteLength: 46,
              },
              playlistRevision: 5,
              quota: { limitBytes: 1_073_741_824, usedBytes: 46, reservedBytes: 0 },
            },
            201,
          );
        }
        if (
          method === 'DELETE' &&
          url.pathname === `/v1/rooms/${ROOM}/queue/items/${AUDIO_ITEM_ID}`
        ) {
          audioPresent = false;
          return json(queue([], 6));
        }
        throw new Error(`Unexpected smoke request: ${method} ${url}`);
      }),
    );

    await expect(assertDeveloperApiCanary(API_KEY, ROOM)).resolves.toBeUndefined();
    expect(uploadBytes).toBe(46);
    expect(youtubePresent).toBe(false);
    expect(audioPresent).toBe(false);
    expect(calls).toContain(`GET https://api.musixquare.com/v1/rooms/${ROOM}/effects`);
    expect(calls).toContain(`GET https://api.musixquare.com/v1/rooms/${ROOM}/queue-mode`);
    expect(calls).toContain('PUT https://storage.example/upload');
    expect(calls.at(-1)).toBe(
      `DELETE https://api.musixquare.com/v1/rooms/${ROOM}/queue/items/${AUDIO_ITEM_ID}`,
    );
  });
});
