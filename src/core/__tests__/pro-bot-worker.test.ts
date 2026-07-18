import { afterEach, describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.js';
import { proBotInternalsForTests } from '../../../cloudflare/pro-bot.js';

const ROOM_CODE = '000001';
const REQUEST_ID = 'bot-request-00000001';
const LEASE_TOKEN = 'l'.repeat(32);
const GEMINI_KEY = 'test-gemini-key-'.padEnd(32, 'g');
const YOUTUBE_KEY = 'test-youtube-key';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function botRequest(
  options: {
    roomCode?: string;
    origin?: string | null;
    body?: unknown;
    idempotencyKey?: string | null;
    cookie?: string;
  } = {},
): Request {
  const roomCode = options.roomCode ?? ROOM_CODE;
  const origin = options.origin === undefined ? 'https://musixquare.com' : options.origin;
  const body = options.body ?? { prompt: 'Add one test song', requestId: REQUEST_ID };
  const idempotencyKey = options.idempotencyKey === undefined ? REQUEST_ID : options.idempotencyKey;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin !== null) headers.set('origin', origin);
  if (idempotencyKey !== null) headers.set('idempotency-key', idempotencyKey);
  if (options.cookie) headers.set('cookie', options.cookie);
  headers.set('x-mxqr-pro-participant-id', 'p'.repeat(43));
  headers.set('x-mxqr-pro-presence-incarnation', 'i'.repeat(43));
  return new Request(`https://musixquare.com/api/pro-room/v1/rooms/${roomCode}/bot/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function roomNamespace(handler: (request: Request) => Response | Promise<Response>): {
  binding: Record<string, unknown>;
  requests: Request[];
} {
  const requests: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    requests.push(request.clone());
    return handler(request);
  });
  return {
    binding: {
      idFromName: vi.fn((value: string) => value),
      get: vi.fn(() => ({ fetch })),
    },
    requests,
  };
}

function roomContextResponse(): Response {
  return Response.json({
    leaseToken: LEASE_TOKEN,
    actorName: 'Peer 1',
    room: {
      playlistRevision: 3,
      currentQueueItemId: null,
      playbackState: 'idle',
      repeatMode: 'off',
      shuffleEnabled: false,
      playlist: [],
    },
  });
}

function geminiPlanResponse(args: Record<string, unknown>): Response {
  return Response.json({
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: 'execute_music_request', args } }],
        },
      },
    ],
  });
}

describe('server-only PRO BOT app boundary', () => {
  it('fails closed on cross-origin, non-beta-room, malformed body, or mismatched idempotency', async () => {
    const namespace = roomNamespace(() => roomContextResponse());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = { PRO_ROOM_ADMIN_ROOMS: namespace.binding };

    const cases = [
      botRequest({ origin: null }),
      botRequest({ origin: 'https://evil.example' }),
      botRequest({ roomCode: '000002' }),
      botRequest({ body: { prompt: 'hello', requestId: REQUEST_ID, extra: true } }),
      botRequest({ body: { prompt: 'x'.repeat(501), requestId: REQUEST_ID } }),
      botRequest({ idempotencyKey: 'bot-request-00000002' }),
      botRequest({ idempotencyKey: null }),
    ];

    for (const request of cases) {
      const response = await appWorker.fetch(request, env);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: request.url.includes('/000002/') ? 'BOT_ROOM_ONLY' : 'INVALID_REQUEST',
      });
    }
    expect(namespace.requests).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards only the scoped PRO session boundary and fails before fetch without a server key', async () => {
    const namespace = roomNamespace(() => roomContextResponse());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await appWorker.fetch(
      botRequest({
        cookie: [
          '__Secure-mxqr_pro_session_000001=session-secret',
          '__Secure-mxqr_pro_owner_000001=owner-secret',
          '__Secure-mxqr_pro_session_000002=other-room-secret',
          '__Host-mxqr_admin=admin-secret',
        ].join('; '),
      }),
      { PRO_ROOM_ADMIN_ROOMS: namespace.binding },
    );

    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({ error: 'BOT_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(namespace.requests).toHaveLength(1);
    const forwarded = namespace.requests[0]!;
    expect(new URL(forwarded.url).pathname).toBe('/internal/bot/context');
    expect(forwarded.headers.get('cookie')).toBe(
      '__Host-mxqr_pro_session_000001=session-secret; __Host-mxqr_pro_owner_000001=owner-secret',
    );
    expect(forwarded.headers.get('origin')).toBeNull();
    expect(forwarded.headers.get('authorization')).toBeNull();
    expect(forwarded.headers.get('x-goog-api-key')).toBeNull();
    await expect(forwarded.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      requestId: REQUEST_ID,
      prompt: 'Add one test song',
    });
    expect(responseText).not.toContain('session-secret');
    expect(responseText).not.toContain('admin-secret');
  });

  it('returns a terminal room receipt and rejects an in-flight duplicate before provider calls', async () => {
    const terminalResult = {
      ok: true,
      summary: 'Added one track.',
      addedCount: 1,
      playbackChanged: false,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const terminal = roomNamespace(() => Response.json({ replay: terminalResult }));
    const terminalResponse = await appWorker.fetch(botRequest(), {
      PRO_ROOM_ADMIN_ROOMS: terminal.binding,
      GEMINI_API_KEY: GEMINI_KEY,
      YOUTUBE_API_KEY: YOUTUBE_KEY,
    });
    expect(terminalResponse.status).toBe(200);
    await expect(terminalResponse.json()).resolves.toEqual(terminalResult);

    const pending = roomNamespace(() =>
      Response.json(
        { error: 'BOT_REQUEST_IN_PROGRESS' },
        { status: 409, headers: { 'retry-after': '30' } },
      ),
    );
    const pendingResponse = await appWorker.fetch(botRequest(), {
      PRO_ROOM_ADMIN_ROOMS: pending.binding,
      GEMINI_API_KEY: GEMINI_KEY,
      YOUTUBE_API_KEY: YOUTUBE_KEY,
    });
    expect(pendingResponse.status).toBe(409);
    expect(pendingResponse.headers.get('retry-after')).toBe('30');
    await expect(pendingResponse.json()).resolves.toEqual({ error: 'BOT_REQUEST_IN_PROGRESS' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when required current-music grounding is unavailable', async () => {
    const namespace = roomNamespace(() => roomContextResponse());
    const fetchMock = vi.fn(async () => Response.json({ error: 'busy' }, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await appWorker.fetch(
      botRequest({
        body: { prompt: '오늘 한국 인기곡 3개 추가해줘', requestId: REQUEST_ID },
      }),
      {
        PRO_ROOM_ADMIN_ROOMS: namespace.binding,
        GEMINI_API_KEY: GEMINI_KEY,
        YOUTUBE_API_KEY: YOUTUBE_KEY,
      },
    );

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(namespace.requests).toHaveLength(1);
  });

  it('keeps Gemini and YouTube secrets on outbound server calls and sends resolved tracks only to the room', async () => {
    const namespace = roomNamespace(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/internal/bot/context') return roomContextResponse();
      if (path === '/internal/bot/execute') {
        return Response.json({
          ok: true,
          summary: 'Added one song.',
          addedCount: 1,
          playbackChanged: false,
        });
      }
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname === 'generativelanguage.googleapis.com') {
        expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(GEMINI_KEY);
        return geminiPlanResponse({
          intent: 'add_youtube',
          trackQueries: ['Artist Test Song official audio'],
          playAddedIndex: -1,
          answer: 'Added one song.',
        });
      }
      if (url.hostname === 'www.googleapis.com') {
        expect(url.searchParams.has('key')).toBe(false);
        expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(YOUTUBE_KEY);
        expect(url.searchParams.get('q')).toBe('Artist Test Song official audio');
        return Response.json({
          items: [
            {
              id: { videoId: 'dQw4w9WgXcQ' },
              snippet: {
                title: 'Test &amp; Song',
                channelTitle: 'Test Artist',
                thumbnails: { high: { url: 'https://i.ytimg.com/vi/test/hqdefault.jpg' } },
              },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await appWorker.fetch(botRequest(), {
      PRO_ROOM_ADMIN_ROOMS: namespace.binding,
      GEMINI_API_KEY: GEMINI_KEY,
      YOUTUBE_API_KEY: YOUTUBE_KEY,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      summary: 'Added one song.',
      addedCount: 1,
      playbackChanged: false,
    });
    expect(namespace.requests).toHaveLength(2);
    const execution = namespace.requests[1]!;
    const executionText = await execution.clone().text();
    expect(executionText).not.toContain(GEMINI_KEY);
    expect(executionText).not.toContain(YOUTUBE_KEY);
    await expect(execution.json()).resolves.toEqual({
      roomCode: ROOM_CODE,
      requestId: REQUEST_ID,
      leaseToken: LEASE_TOKEN,
      plan: {
        intent: 'add_youtube',
        trackQueries: ['Artist Test Song official audio'],
        playAddedIndex: -1,
        answer: 'Added one song.',
      },
      tracks: [
        {
          videoId: 'dQw4w9WgXcQ',
          name: 'Test & Song',
          title: 'Test & Song',
          artist: 'Test Artist',
          thumbnail: 'https://i.ytimg.com/vi/test/hqdefault.jpg',
        },
      ],
    });
  });
});

describe('PRO BOT Gemini plan and YouTube normalization', () => {
  it('recognizes explicit playback requests across supported UI languages without matching 재생목록', () => {
    const { explicitlyRequestsPlayback } = proBotInternalsForTests;
    for (const prompt of [
      'play this song',
      'listen to this track',
      '이 노래 틀어줘',
      '播放这首歌',
      'この曲を再生して',
      'reproducir esta canción',
      'jouer cette chanson',
      'dieses Lied abspielen',
      'putar lagu ini',
      'riproduci questa canzone',
      'speel dit nummer',
      'odtwórz ten utwór',
      'reproduzir esta música',
      'включи эту песню',
      'เล่นเพลงนี้',
      'bu şarkıyı çal',
      'phát bài hát này',
    ]) {
      expect(explicitlyRequestsPlayback(prompt), prompt).toBe(true);
    }
    expect(explicitlyRequestsPlayback('재생목록에 이 곡을 추가해줘')).toBe(false);
  });

  it('accepts at most three exact track queries and rejects a fourth instead of truncating it', () => {
    const { parsePlan } = proBotInternalsForTests;
    expect(
      parsePlan({
        intent: 'add_youtube',
        trackQueries: ['one', 'two', 'three'],
        playAddedIndex: 2,
        answer: 'ok',
      }),
    ).toEqual({
      intent: 'add_youtube',
      trackQueries: ['one', 'two', 'three'],
      playAddedIndex: 2,
      answer: 'ok',
    });
    expect(
      parsePlan({
        intent: 'add_youtube',
        trackQueries: ['one', 'two', 'three', 'four'],
        playAddedIndex: -1,
        answer: 'too many',
      }),
    ).toBeNull();
  });

  it('resolves bounded YouTube candidates without exposing the API key in the result', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      expect(url.hostname).toBe('www.googleapis.com');
      expect(url.searchParams.get('maxResults')).toBe('1');
      expect(url.searchParams.get('videoEmbeddable')).toBe('true');
      return Response.json({
        items: [
          {
            id: { videoId: 'M7lc1UVf-VE' },
            snippet: {
              title: 'Track &quot;One&quot;',
              channelTitle: 'Artist One',
              thumbnails: { medium: { url: 'https://i.ytimg.com/vi/test/mqdefault.jpg' } },
            },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await proBotInternalsForTests.resolveTracks(
      {
        intent: 'add_youtube',
        trackQueries: ['Track One Artist One'],
        playAddedIndex: -1,
      },
      { YOUTUBE_API_KEY: YOUTUBE_KEY },
      new AbortController().signal,
    );

    expect(resolved).toEqual({
      playAddedIndex: -1,
      tracks: [
        {
          videoId: 'M7lc1UVf-VE',
          name: 'Track "One"',
          title: 'Track "One"',
          artist: 'Artist One',
          thumbnail: 'https://i.ytimg.com/vi/test/mqdefault.jpg',
        },
      ],
    });
    expect(JSON.stringify(resolved)).not.toContain(YOUTUBE_KEY);
  });
});
