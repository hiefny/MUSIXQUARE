import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';
import {
  handleProYouTubeDurationRequest,
  PRO_YOUTUBE_DURATION_PATH,
  resolveProYouTubeDuration,
} from '../../../cloudflare/pro-youtube-duration.ts';

const VIDEO_ID = 'dQw4w9WgXcQ';
const OTHER_VIDEO_ID = 'abcdefghijk';
const SECRET = 'test-only-shared-account-assertion-secret-000';
const INTERNAL_ORIGIN = 'https://pro-youtube-metadata.internal';
let apiKeySequence = 0;
let env: { YOUTUBE_API_KEY: string; MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: string };

function signedRequest(videoId = VIDEO_ID, timestamp = Date.now()): Request {
  const time = String(timestamp);
  const signature = createHmac('sha256', SECRET)
    .update(
      `MUSIXQUARE:pro-youtube-duration:v1\nGET\n${INTERNAL_ORIGIN}${PRO_YOUTUBE_DURATION_PATH}\n${videoId}\n${time}`,
    )
    .digest('base64url');
  return new Request(`${INTERNAL_ORIGIN}${PRO_YOUTUBE_DURATION_PATH}?videoId=${videoId}`, {
    headers: {
      'x-mxqr-youtube-metadata-signature': signature,
      'x-mxqr-youtube-metadata-time': time,
    },
  });
}

function metadata(duration = 'PT3M33S', overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    items: [
      {
        id: VIDEO_ID,
        snippet: { liveBroadcastContent: 'none' },
        contentDetails: { duration },
        ...overrides,
      },
    ],
  });
}

async function readResult(): Promise<unknown> {
  const response = await handleProYouTubeDurationRequest(signedRequest(), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}

beforeEach(() => {
  env = {
    YOUTUBE_API_KEY: `test-only-api-key-${++apiKeySequence}`,
    MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: SECRET,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('trusted PRO YouTube duration metadata', () => {
  it('uses the private signed App binding and existing key to resolve exact finite metadata', async () => {
    const upstream = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.origin).toBe('https://www.googleapis.com');
      expect(url.pathname).toBe('/youtube/v3/videos');
      expect(url.searchParams.get('id')).toBe(VIDEO_ID);
      expect(url.searchParams.get('key')).toBeNull();
      expect(request.headers.get('x-goog-api-key')).toBe(env.YOUTUBE_API_KEY);
      expect(request.redirect).toBe('error');
      return metadata();
    });
    vi.stubGlobal('fetch', upstream);
    const result = await resolveProYouTubeDuration(
      {
        MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: SECRET,
        PRO_YOUTUBE_METADATA: { fetch: (request) => appWorker.fetch(request, env) },
      },
      VIDEO_ID,
    );
    expect(result).toEqual({ kind: 'finite', durationSeconds: 213 });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each(['P1DT2H3M4S', 'PT2H', 'PT0.25S'])(
    'parses bounded ISO 8601 duration %s',
    async (duration) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => metadata(duration)),
      );
      const seconds = duration === 'P1DT2H3M4S' ? 93784 : duration === 'PT2H' ? 7200 : 0.25;
      expect(await readResult()).toEqual({
        videoId: VIDEO_ID,
        kind: 'finite',
        durationSeconds: seconds,
      });
    },
  );

  it.each([
    'PT0S',
    'PT',
    'P8DT0S',
    'PTInfinityS',
    '-PT3M',
    'PT3Mgarbage',
    'P99999999999999999999999999999999999DT0S',
  ])('does not arm an end from invalid or out-of-policy duration %s', async (duration) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => metadata(duration)),
    );
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'retry' });
  });

  it.each([
    { snippet: { liveBroadcastContent: 'live' } },
    { snippet: { liveBroadcastContent: 'upcoming' } },
    { liveStreamingDetails: {} },
    { liveStreamingDetails: { actualEndTime: 'invalid' } },
  ])('never treats a live/upcoming/growing duration as a finite end', async (overrides) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => metadata('PT4H', overrides)),
    );
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'live' });
  });

  it('accepts a completed livestream replay with a finite duration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        metadata('PT5M', {
          liveStreamingDetails: { actualEndTime: '2026-10-01T00:00:00Z' },
        }),
      ),
    );
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'finite', durationSeconds: 300 });
  });

  it.each([{ id: OTHER_VIDEO_ID }, { snippet: {} }, { contentDetails: null }])(
    'rejects a mismatched video or incomplete classification',
    async (overrides) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => metadata('PT5M', overrides)),
      );
      expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'retry' });
    },
  );

  it.each([
    { items: [{ id: VIDEO_ID, status: { privacyStatus: 'private' } }] },
    { items: [{ id: VIDEO_ID, status: { privacyStatus: 'private', embeddable: false } }] },
  ])('keeps private videos uncertain rather than declaring them unplayable', async (payload) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(payload)),
    );
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'unavailable' });
  });

  it('marks only an empty successful answer as not found, which PRO must still confirm', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: [] })),
    );
    // Older PRO Workers read only `kind`; the additive reason keeps them on
    // today's unavailable path during a rolling deploy or rollback.
    expect(await readResult()).toEqual({
      videoId: VIDEO_ID,
      kind: 'unavailable',
      reason: 'not-found',
    });
    expect(
      await resolveProYouTubeDuration(
        {
          ...env,
          PRO_YOUTUBE_METADATA: {
            fetch: (request) => appWorker.fetch(request, env),
          },
        },
        VIDEO_ID,
      ),
    ).toEqual({ kind: 'unavailable', reason: 'not-found' });
  });

  it.each([
    [{ videoId: VIDEO_ID, kind: 'unavailable' }, { kind: 'unavailable' }],
    [{ videoId: VIDEO_ID, kind: 'unavailable', reason: 'gone' }, { kind: 'unavailable' }],
    [{ videoId: VIDEO_ID, kind: 'live', reason: 'not-found' }, { kind: 'live' }],
    [{ videoId: VIDEO_ID, kind: 'retry', reason: 'not-found' }, { kind: 'retry' }],
  ])('never infers not found from an older App or another kind (%j)', async (payload, expected) => {
    expect(
      await resolveProYouTubeDuration(
        { ...env, PRO_YOUTUBE_METADATA: { fetch: async () => Response.json(payload) } },
        VIDEO_ID,
      ),
    ).toEqual(expected);
  });

  it.each([
    { embeddable: false },
    { uploadStatus: 'deleted' },
    { uploadStatus: 'rejected' },
    { uploadStatus: 'failed' },
  ])('declares a video unplayable only from an explicit provider status', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => metadata('PT3M', { status })),
    );
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'unplayable' });
    expect(
      await resolveProYouTubeDuration(
        {
          ...env,
          PRO_YOUTUBE_METADATA: {
            fetch: (request) => handleProYouTubeDurationRequest(request, env),
          },
        },
        VIDEO_ID,
      ),
    ).toEqual({ kind: 'unplayable' });
  });

  it.each([403, 429, 500, 503])(
    'retries upstream HTTP %s without treating it as an unavailable video',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ error: 'quotaExceeded' }, { status })),
      );
      expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'retry' });
    },
  );

  it('does not expose a browser endpoint or honor a reused account assertion', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const valid = signedRequest();
    const requests = [
      new Request(`https://musixquare.com${PRO_YOUTUBE_DURATION_PATH}?videoId=${VIDEO_ID}`, valid),
      new Request(valid.url),
      new Request(valid, { method: 'POST' }),
      signedRequest(VIDEO_ID, Date.now() - 31_000),
      signedRequest(VIDEO_ID, Date.now() + 31_000),
      new Request(valid.url.replace(VIDEO_ID, OTHER_VIDEO_ID), valid),
      new Request(`${valid.url}&videoId=${OTHER_VIDEO_ID}`, valid),
      new Request(valid, { headers: { 'x-mxqr-account-assertion': 'v1.unrelated.token' } }),
      new Request(valid, {
        headers: {
          ...Object.fromEntries(valid.headers),
          'x-mxqr-youtube-metadata-signature': 'A'.repeat(43),
        },
      }),
    ];
    for (const request of requests) {
      expect((await handleProYouTubeDurationRequest(request, env)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('caches finite metadata but never crosses video identity or API credentials', async () => {
    const upstream = vi.fn(async () => metadata());
    vi.stubGlobal('fetch', upstream);
    await readResult();
    await readResult();
    expect(upstream).toHaveBeenCalledTimes(1);
    env.YOUTUBE_API_KEY += '-rotated';
    await readResult();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('rechecks live metadata after its short cache expires', async () => {
    vi.useFakeTimers();
    const upstream = vi.fn(async () =>
      metadata('PT5M', { snippet: { liveBroadcastContent: 'live' } }),
    );
    vi.stubGlobal('fetch', upstream);
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'live' });
    upstream.mockImplementation(async () => metadata('PT5M'));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'finite', durationSeconds: 300 });
  });

  it('bounds a declared or streaming oversized JSON response', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(33 * 1024));
              },
              cancel,
            }),
          ),
      ),
    );
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'retry' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('ends a non-cooperative upstream fetch at the deadline', async () => {
    const upstream = vi.fn((_request: Request) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', upstream);
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'retry' });
    expect(upstream.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it('ends a non-cooperative upstream body at the deadline', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    expect(await readResult()).toEqual({ videoId: VIDEO_ID, kind: 'retry' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('retries missing binding or secret and refuses malformed video IDs without a service call', async () => {
    const service = { fetch: vi.fn() };
    expect(await resolveProYouTubeDuration({}, VIDEO_ID)).toEqual({ kind: 'retry' });
    expect(await resolveProYouTubeDuration({ PRO_YOUTUBE_METADATA: service }, VIDEO_ID)).toEqual({
      kind: 'retry',
    });
    expect(
      await resolveProYouTubeDuration(
        { ...env, PRO_YOUTUBE_METADATA: service },
        'https://attacker.test',
      ),
    ).toEqual({ kind: 'retry' });
    expect(service.fetch).not.toHaveBeenCalled();
  });

  it.each([
    () => new Response(null, { status: 404 }),
    () => Response.json({ videoId: OTHER_VIDEO_ID, kind: 'finite', durationSeconds: 15 }),
    () => Response.json({ videoId: VIDEO_ID, kind: 'finite', durationSeconds: 0 }),
    () => Response.json({ videoId: VIDEO_ID, kind: 'finite', durationSeconds: 700000 }),
    () => Response.json({ videoId: VIDEO_ID, kind: 'nonsense' }),
  ])(
    'retries a rolling old App or invalid service response without trusting it',
    async (response) => {
      expect(
        await resolveProYouTubeDuration(
          {
            ...env,
            PRO_YOUTUBE_METADATA: { fetch: async () => response() },
          },
          VIDEO_ID,
        ),
      ).toEqual({ kind: 'retry' });
    },
  );
});
