import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertDeveloperApiCanary,
  DEVELOPER_API_CANARY_RETRY_DELAYS_MS,
  DEVELOPER_API_READINESS_RETRY_DELAYS_MS,
  runDeveloperApiSmoke,
  waitForDeveloperApiReady,
} from '../../../scripts/live-developer-api-smoke.mts';

const ROOM = '000001';
const OTHER_ROOM = '000000';
const API_KEY = `mxqr_live_${'A'.repeat(16)}.${'B'.repeat(43)}`;
const YOUTUBE_ITEM_ID = '123e4567-e89b-42d3-a456-426614174001';
const AUDIO_ITEM_ID = '123e4567-e89b-42d3-a456-426614174002';
const ASSET_ID = `asset_${'C'.repeat(24)}`;
const WORKER_VERSION = 'developer-api-version-1';
const FACADE_VERSION = 'developer-api-facade-version-1';
const VERSION_HEADERS = {
  'X-MXQR-Developer-API-Version': WORKER_VERSION,
  'X-MXQR-Developer-API-Facade-Version': FACADE_VERSION,
};

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

function roomProjection() {
  return {
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
  };
}

function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers });
}

function apiError(code: string, status = 503, retryable = true) {
  return json(
    {
      error: {
        code,
        message: 'The request could not be completed.',
        requestId: `req_${'R'.repeat(22)}`,
        retryable,
      },
    },
    status,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Developer API live canary smoke', () => {
  it('fails closed before network access unless both canary versions are pinned', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      runDeveloperApiSmoke({
        env: {
          MXQR_DEVELOPER_API_SMOKE_KEY: API_KEY,
          MXQR_EXPECTED_DEVELOPER_API_VERSION: WORKER_VERSION,
        },
      }),
    ).rejects.toThrow(
      'Developer API canary smoke requires exact public and facade Worker versions',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the exact-version readiness fence long enough for edge propagation', async () => {
    expect(
      DEVELOPER_API_READINESS_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0),
    ).toBeGreaterThanOrEqual(120_000);

    const read = vi
      .fn()
      .mockResolvedValueOnce({
        service: 'musixquare-developer-api',
        workerVersionId: 'previous-version',
      })
      .mockResolvedValueOnce({
        service: 'musixquare-developer-api',
        workerVersionId: 'expected-version',
      });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForDeveloperApiReady('expected-version', {
        read,
        retryDelaysMs: [0, 1_000],
        wait,
      }),
    ).resolves.toEqual({
      service: 'musixquare-developer-api',
      expectedVersion: 'expected-version',
      actualVersion: 'expected-version',
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(1_000);
  });

  it('bounds initial read-only canary convergence without retrying non-retryable errors', async () => {
    expect(
      DEVELOPER_API_CANARY_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0),
    ).toBeGreaterThanOrEqual(50_000);

    const retryableFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(apiError('BACKEND_UNAVAILABLE')));
    vi.stubGlobal('fetch', retryableFetch);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      assertDeveloperApiCanary(API_KEY, ROOM, {
        retryDelaysMs: [0, 1_000, 2_000],
        wait,
      }),
    ).rejects.toThrow(
      'Developer API /room smoke remained unavailable after 3 attempts: HTTP 503 (BACKEND_UNAVAILABLE)',
    );
    expect(retryableFetch).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[1_000], [2_000]]);

    const staleFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        json(roomProjection(), 200, {
          'X-MXQR-Developer-API-Version': 'stale-worker-version',
          'X-MXQR-Developer-API-Facade-Version': 'stale-facade-version',
        }),
      ),
    );
    vi.stubGlobal('fetch', staleFetch);
    const staleWait = vi.fn().mockResolvedValue(undefined);
    await expect(
      assertDeveloperApiCanary(API_KEY, ROOM, {
        expectedWorkerVersion: WORKER_VERSION,
        expectedFacadeVersion: FACADE_VERSION,
        retryDelaysMs: [0, 1_000],
        wait: staleWait,
      }),
    ).rejects.toThrow(
      'Developer API /room smoke remained unavailable after 2 attempts: data-plane version mismatch',
    );
    expect(staleFetch).toHaveBeenCalledTimes(2);
    expect(staleWait).toHaveBeenCalledExactlyOnceWith(1_000);

    const rejectedFetch = vi
      .fn()
      .mockImplementation(() => Promise.reject(new TypeError('simulated edge reset')));
    vi.stubGlobal('fetch', rejectedFetch);
    const rejectedWait = vi.fn().mockResolvedValue(undefined);
    await expect(
      assertDeveloperApiCanary(API_KEY, ROOM, {
        retryDelaysMs: [0, 1_000],
        wait: rejectedWait,
      }),
    ).rejects.toThrow(
      'Developer API /room smoke remained unavailable after 2 attempts: request failed (TypeError)',
    );
    expect(rejectedFetch).toHaveBeenCalledTimes(2);
    expect(rejectedWait).toHaveBeenCalledExactlyOnceWith(1_000);

    for (const [code, status, retryable] of [
      ['INTERNAL_RESPONSE_INVALID', 503, true],
      ['API_DISABLED', 503, true],
      ['RATE_LIMITED', 429, true],
      ['UNAUTHORIZED', 401, false],
    ] as const) {
      const nonRetryableFetch = vi
        .fn()
        .mockImplementation(() => Promise.resolve(apiError(code, status, retryable)));
      vi.stubGlobal('fetch', nonRetryableFetch);
      const nonRetryableWait = vi.fn().mockResolvedValue(undefined);

      await expect(
        assertDeveloperApiCanary(API_KEY, ROOM, {
          retryDelaysMs: [0, 1_000],
          wait: nonRetryableWait,
        }),
      ).rejects.toThrow(`Developer API /room smoke returned HTTP ${status} (${code})`);
      expect(nonRetryableFetch).toHaveBeenCalledOnce();
      expect(nonRetryableWait).not.toHaveBeenCalled();
    }

    const malformedFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('unavailable', { status: 503 })));
    vi.stubGlobal('fetch', malformedFetch);
    await expect(
      assertDeveloperApiCanary(API_KEY, ROOM, {
        retryDelaysMs: [0, 1_000],
        wait: vi.fn(),
      }),
    ).rejects.toThrow('Developer API /room smoke returned invalid JSON');
    expect(malformedFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['stale data-plane convergence', 'success', null, 'stale'],
    ['backend convergence', 'success', null, 'backend'],
    ['mixed backend and network convergence', 'success', null, 'mixed'],
    ['post-commit timeout', 'timeout', 'simulated post-commit timeout', 'maintenance'],
    ['post-commit damaged response', 'damaged', 'returned invalid JSON', 'network'],
    ['YouTube post-commit timeout', 'youtube-timeout', 'YouTube response lost', 'stale'],
    ['YouTube post-commit damaged response', 'youtube-damaged', 'returned invalid JSON', 'stale'],
    ['concurrent queue insertion', 'youtube-concurrent', null, 'stale'],
  ] as const)(
    'exercises scoped reads, queue mutations, direct upload, completion, and cleanup: %s',
    async (_label, completionMode, expectedError, convergenceMode) => {
      let youtubePresent = false;
      let youtubeName = '';
      let competingPresent = false;
      const currentYouTubeItems = () => [
        ...(youtubePresent
          ? [
              {
                queueItemId: YOUTUBE_ITEM_ID,
                kind: 'youtube',
                name: youtubeName,
                addedBy: 'current_api_key',
              },
            ]
          : []),
        ...(competingPresent
          ? [
              {
                queueItemId: '123e4567-e89b-42d3-a456-426614174003',
                kind: 'youtube',
                name: youtubeName,
                addedBy: 'another_api_key',
              },
              {
                queueItemId: '123e4567-e89b-42d3-a456-426614174004',
                kind: 'youtube',
                name: 'Another operation',
                addedBy: 'current_api_key',
              },
            ]
          : []),
      ];
      let audioPresent = false;
      let uploadBytes = 0;
      let roomReadAttempts = 0;
      const calls: string[] = [];

      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          expect(init.signal).toBeInstanceOf(AbortSignal);
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
            roomReadAttempts += 1;
            if (convergenceMode === 'mixed' && roomReadAttempts === 2) {
              throw new TypeError('simulated edge reset');
            }
            if (roomReadAttempts === 1) {
              if (convergenceMode === 'stale') {
                return json({ stale: true }, 200, {
                  'X-MXQR-Developer-API-Version': 'stale-worker-version',
                  'X-MXQR-Developer-API-Facade-Version': 'stale-facade-version',
                });
              }
              if (convergenceMode === 'backend' || convergenceMode === 'mixed') {
                return apiError('BACKEND_UNAVAILABLE');
              }
              if (convergenceMode === 'maintenance') {
                return json(
                  {
                    error: 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE',
                    maintenance: true,
                    revision: 0,
                    activatedAt: null,
                    settlesAt: null,
                  },
                  503,
                );
              }
              throw new TypeError('simulated edge reset');
            }
            return json(roomProjection(), 200, { ETag: '"room-etag"', ...VERSION_HEADERS });
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
            return json(queue(currentYouTubeItems(), youtubePresent ? 2 : 1));
          }
          if (method === 'GET' && url.pathname === `/v1/rooms/${ROOM}/effects`) {
            const effectsVersion = new Headers(init.headers).get('x-mxqr-effects-version');
            return json(
              {
                schemaVersion: effectsVersion === '2' ? 2 : 1,
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
                  ...(effectsVersion === '2' ? { virtualTreble: { enabled: false } } : {}),
                },
              },
              200,
              {
                ETag: effectsVersion === '2' ? '"effects-v2-etag"' : '"effects-etag"',
                ...(effectsVersion === '2' ? { Vary: 'X-MXQR-Effects-Version' } : {}),
              },
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
            youtubeName = JSON.parse(String(init.body)).name;
            competingPresent = completionMode === 'youtube-concurrent';
            if (completionMode === 'youtube-timeout')
              throw new DOMException('YouTube response lost', 'TimeoutError');
            if (completionMode === 'youtube-damaged')
              return new Response('{"committed":', { status: 201 });
            return json(queue(currentYouTubeItems(), 2), 201);
          }
          if (method === 'PUT' && url.pathname === `/v1/rooms/${ROOM}/queue/order`) {
            expect(youtubePresent).toBe(true);
            expect(JSON.parse(String(init.body)).queueItemIds).toEqual(
              currentYouTubeItems().map((item) => item.queueItemId),
            );
            return json(queue(currentYouTubeItems(), 3));
          }
          if (
            method === 'DELETE' &&
            url.pathname === `/v1/rooms/${ROOM}/queue/items/${YOUTUBE_ITEM_ID}`
          ) {
            youtubePresent = false;
            return json(queue(currentYouTubeItems(), 4));
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
            if (completionMode === 'timeout') {
              throw new DOMException('simulated post-commit timeout', 'TimeoutError');
            }
            if (completionMode === 'damaged') {
              return new Response('{"committed":', {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
              });
            }
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
            return json(queue(currentYouTubeItems(), 6));
          }
          throw new Error(`Unexpected smoke request: ${method} ${url}`);
        }),
      );

      const convergenceWait = vi.fn().mockResolvedValue(undefined);
      const smoke = assertDeveloperApiCanary(API_KEY, ROOM, {
        expectedWorkerVersion: WORKER_VERSION,
        expectedFacadeVersion: FACADE_VERSION,
        retryDelaysMs: [0, 1_000, 2_000],
        wait: convergenceWait,
      });
      if (expectedError) {
        await expect(smoke).rejects.toThrow(expectedError);
      } else {
        await expect(smoke).resolves.toBeUndefined();
      }
      const youtubeFailed =
        completionMode === 'youtube-timeout' || completionMode === 'youtube-damaged';
      expect(uploadBytes).toBe(youtubeFailed ? 0 : 46);
      const expectedRoomReadAttempts = convergenceMode === 'mixed' ? 3 : 2;
      expect(roomReadAttempts).toBe(expectedRoomReadAttempts);
      expect(convergenceWait.mock.calls).toEqual(
        convergenceMode === 'mixed' ? [[1_000], [2_000]] : [[1_000]],
      );
      expect(youtubePresent).toBe(false);
      expect(competingPresent).toBe(completionMode === 'youtube-concurrent');
      expect(audioPresent).toBe(false);
      expect(calls).toContain(`GET https://api.musixquare.com/v1/rooms/${ROOM}/effects`);
      expect(
        calls.filter((call) => call === `GET https://api.musixquare.com/v1/rooms/${ROOM}/effects`),
      ).toHaveLength(1);
      expect(calls).toContain(`GET https://api.musixquare.com/v1/rooms/${ROOM}/queue-mode`);
      if (!youtubeFailed) expect(calls).toContain('PUT https://storage.example/upload');
      const mutationCalls = calls.filter((call) => /^(?:POST|PUT|DELETE) /u.test(call));
      expect(mutationCalls.length).toBeGreaterThan(0);
      expect(new Set(mutationCalls).size).toBe(mutationCalls.length);
      expect(calls.at(-1)).toBe(
        `DELETE https://api.musixquare.com/v1/rooms/${ROOM}/queue/items/${youtubeFailed ? YOUTUBE_ITEM_ID : AUDIO_ITEM_ID}`,
      );
    },
  );
});
