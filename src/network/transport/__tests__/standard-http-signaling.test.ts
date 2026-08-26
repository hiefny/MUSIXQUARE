/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../core/capability.ts', () => ({
  fetchWithCapability: vi.fn(),
}));

import { fetchWithCapability } from '../../../core/capability.ts';
import { StandardHttpSignalingSocket } from '../standard-http-signaling.ts';

const SESSION_TOKEN = `session.${'a'.repeat(48)}`;
const fetchWithCapabilityMock = vi.mocked(fetchWithCapability);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function openResponse(): Response {
  return jsonResponse({ sessionToken: SESSION_TOKEN });
}

function sendResponse(ack: number): Response {
  return jsonResponse({ v: 1, ack });
}

function pollResponse(
  events: Array<{ sseq: number; data: string }> = [],
  terminal?: { code: number; reason: string },
): Response {
  return jsonResponse({ v: 1, events, ...(terminal ? { terminal } : {}) });
}

function closeResponse(): Response {
  return jsonResponse({ ok: true });
}

function abortablePendingFetch(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('StandardHttpSignalingSocket', () => {
  beforeEach(() => {
    fetchWithCapabilityMock.mockReset();
    fetchWithCapabilityMock.mockImplementation(async () => openResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens through capability and relays split send/poll lanes without exposing its bearer', async () => {
    let pollCalls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/send')) return Promise.resolve(sendResponse(1));
      if (url.endsWith('/poll')) {
        pollCalls += 1;
        if (pollCalls === 1) {
          return Promise.resolve(
            pollResponse([
              {
                sseq: 1,
                data: JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
              },
            ]),
          );
        }
        return abortablePendingFetch(init);
      }
      if (url.endsWith('/close')) return Promise.resolve(closeResponse());
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const socket = new StandardHttpSignalingSocket({
      roomId: '123456',
      role: 'host',
      peerId: '123456',
    });
    const hostAuth = JSON.stringify({ type: 'host-auth', secret: 'host-secret' });
    const messages: string[] = [];
    socket.addEventListener('open', () => socket.send(hostAuth));
    socket.addEventListener('message', (event) => {
      messages.push((event as MessageEvent).data as string);
    });

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(fetchWithCapabilityMock).toHaveBeenCalledWith(
      '/api/standard-signaling/v1/bridge/open',
      'standard-signaling',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    const openInit = fetchWithCapabilityMock.mock.calls[0]?.[2];
    expect(JSON.parse(String(openInit?.body))).toEqual({
      roomId: '123456',
      role: 'host',
      peerId: '123456',
    });

    const sendCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/send'));
    expect(sendCall).toBeDefined();
    const [sendUrl, sendInit] = sendCall!;
    expect(String(sendUrl)).toBe('/api/standard-signaling/v1/bridge/send');
    expect(String(sendUrl)).not.toContain(SESSION_TOKEN);
    expect(new Headers(sendInit?.headers).get('Authorization')).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(JSON.parse(String(sendInit?.body))).toEqual({ v: 1, cseq: 1, frame: hostAuth });

    const pollCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/poll'));
    expect(pollCall).toBeDefined();
    expect(JSON.parse(String(pollCall?.[1]?.body))).toEqual({
      v: 1,
      requestEpoch: 1,
      ack: 0,
      waitMs: 15_000,
    });
    expect(messages[0]).toContain('peer-open');
    socket.close();
  });

  it('keeps one idle poll while the independent uplink sends on its own cseq', async () => {
    const firstPoll = deferred<Response>();
    const polls: Array<{ body: Record<string, unknown>; signal: AbortSignal | null }> = [];
    const sends: Record<string, unknown>[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/poll')) {
        polls.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          signal: init?.signal ?? null,
        });
        if (polls.length === 1) return firstPoll.promise;
        return abortablePendingFetch(init);
      }
      if (url.endsWith('/send')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sends.push(body);
        return Promise.resolve(sendResponse(Number(body.cseq)));
      }
      if (url.endsWith('/close')) return Promise.resolve(closeResponse());
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const socket = new StandardHttpSignalingSocket({
      roomId: '123456',
      role: 'guest',
      peerId: 'guest-one',
    });

    await vi.waitFor(() => expect(polls).toHaveLength(1));
    const guestAuth = JSON.stringify({
      type: 'guest-auth',
      password: '',
      reconnectSecret: 'proof',
    });
    socket.send(guestAuth);

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(polls).toHaveLength(1);
    expect(polls[0]?.signal?.aborted).toBe(false);
    expect(polls[0]?.body).toMatchObject({ v: 1, requestEpoch: 1, ack: 0 });
    expect(sends[0]).toEqual({ v: 1, cseq: 1, frame: guestAuth });

    firstPoll.resolve(pollResponse());
    await vi.waitFor(() => expect(polls).toHaveLength(2));
    expect(polls[1]?.body).toMatchObject({ v: 1, requestEpoch: 2, ack: 0 });
    socket.close();
  });

  it('retries a failed outbound send once with the exact same cseq and body', async () => {
    const sendBodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/send')) {
        sendBodies.push(String(init?.body ?? ''));
        if (sendBodies.length === 1) return Promise.reject(new TypeError('route changed'));
        return Promise.resolve(sendResponse(1));
      }
      if (url.endsWith('/poll')) return abortablePendingFetch(init);
      if (url.endsWith('/close')) return Promise.resolve(closeResponse());
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const socket = new StandardHttpSignalingSocket({
      roomId: '123456',
      role: 'host',
      peerId: '123456',
    });
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'host-auth', secret: 'stable-proof' }));
    });

    await vi.waitFor(() => expect(sendBodies).toHaveLength(2));
    expect(sendBodies[0]).toBe(sendBodies[1]);
    expect(JSON.parse(sendBodies[0]!)).toMatchObject({ v: 1, cseq: 1 });
    socket.close();
  });

  it('bounds its RAM queue and measures frame limits in UTF-8 bytes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/send') || url.endsWith('/poll')) return abortablePendingFetch(init);
      if (url.endsWith('/close')) return Promise.resolve(closeResponse());
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const socket = new StandardHttpSignalingSocket({
      roomId: '123456',
      role: 'host',
      peerId: '123456',
    });
    await new Promise<void>((resolve) =>
      socket.addEventListener('open', () => resolve(), { once: true }),
    );

    expect(() => socket.send('가'.repeat(22_000))).toThrowError(DOMException);
    const sensitiveFrame = JSON.stringify({
      type: 'host-auth',
      secret: 'host-secret',
      password: 'room-password',
      reconnectSecret: 'reconnect-proof',
    });
    socket.send(sensitiveFrame);
    for (let index = 1; index < 64; index += 1) socket.send(`frame-${index}`);
    expect(socket.bufferedAmount).toBeGreaterThan(0);
    expect(() => socket.send('overflow')).toThrowError(DOMException);
    const serializedSocket = JSON.stringify(socket);
    expect(serializedSocket).not.toContain(SESSION_TOKEN);
    expect(serializedSocket).not.toContain('host-secret');
    expect(serializedSocket).not.toContain('room-password');
    expect(serializedSocket).not.toContain('reconnect-proof');
    expect(serializedSocket).not.toContain('123456');
    socket.close();
  });

  it('enforces the total pending-frame byte budget independently of frame count', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/send') || url.endsWith('/poll')) return abortablePendingFetch(init);
      if (url.endsWith('/close')) return Promise.resolve(closeResponse());
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const socket = new StandardHttpSignalingSocket({
      roomId: '123456',
      role: 'host',
      peerId: '123456',
    });
    await new Promise<void>((resolve) =>
      socket.addEventListener('open', () => resolve(), { once: true }),
    );
    socket.send('a'.repeat(60 * 1024));
    expect(() => socket.send('b'.repeat(40 * 1024))).toThrowError(DOMException);
    socket.close();
  });

  it('deduplicates replayed poll events and fails closed on a server sequence gap', async () => {
    let pollCalls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/poll')) {
        pollCalls += 1;
        if (pollCalls === 1) {
          return Promise.resolve(
            pollResponse([
              { sseq: 1, data: JSON.stringify({ type: 'first' }) },
              { sseq: 1, data: JSON.stringify({ type: 'duplicate' }) },
              { sseq: 2, data: JSON.stringify({ type: 'second' }) },
            ]),
          );
        }
        return Promise.resolve(pollResponse([{ sseq: 4, data: JSON.stringify({ type: 'gap' }) }]));
      }
      if (url.endsWith('/close')) return Promise.resolve(closeResponse());
      return abortablePendingFetch(init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const socket = new StandardHttpSignalingSocket({
      roomId: '123456',
      role: 'guest',
      peerId: 'guest-one',
    });
    const messages: string[] = [];
    const errors: Event[] = [];
    socket.addEventListener('message', (event) => {
      messages.push((event as MessageEvent).data as string);
    });
    socket.addEventListener('error', (event) => errors.push(event));

    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
    expect(messages).toEqual([
      JSON.stringify({ type: 'first' }),
      JSON.stringify({ type: 'second' }),
    ]);
    expect(errors).toHaveLength(1);
    expect(socket.diagnostic).toEqual({ phase: 'poll', status: 200 });
  });

  it('delivers poll messages before a terminal marker and closes with exact metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/poll')) {
        return Promise.resolve(
          pollResponse(
            [{ sseq: 1, data: JSON.stringify({ type: 'error', errorType: 'room-full' }) }],
            { code: 1008, reason: 'ROOM_FULL' },
          ),
        );
      }
      if (url.endsWith('/close')) return Promise.resolve(closeResponse());
      return abortablePendingFetch(init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const socket = new StandardHttpSignalingSocket({
      roomId: '123456',
      role: 'guest',
      peerId: 'guest-one',
    });
    const order: string[] = [];
    socket.addEventListener('message', () => order.push('message'));
    socket.addEventListener('close', (event) => {
      order.push(`close:${(event as CloseEvent).code}:${(event as CloseEvent).reason}`);
    });

    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual(['message', 'close:1008:ROOM_FULL']);
  });

  it('rejects non-canonical bridge responses', async () => {
    fetchWithCapabilityMock.mockResolvedValueOnce(
      jsonResponse({ sessionToken: SESSION_TOKEN, expiresAt: Date.now() + 60_000 }),
    );
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
    const socket = new StandardHttpSignalingSocket({
      roomId: '123456',
      role: 'host',
      peerId: '123456',
    });
    const errors: Event[] = [];
    socket.addEventListener('error', (event) => errors.push(event));

    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
    expect(errors).toHaveLength(1);
    expect(socket.diagnostic).toEqual({ phase: 'open', status: 200 });
  });

  it('aborts provisional work and never stores the bearer outside memory', async () => {
    const pendingOpen = deferred<Response>();
    fetchWithCapabilityMock.mockReturnValueOnce(pendingOpen.promise);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const socket = new StandardHttpSignalingSocket({
      roomId: '123456',
      role: 'host',
      peerId: '123456',
    });
    const onOpen = vi.fn();
    socket.addEventListener('open', onOpen);

    await flushAsync();
    socket.close();
    pendingOpen.resolve(openResponse());
    await flushAsync();

    expect(onOpen).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(socket)).not.toContain(SESSION_TOKEN);
  });
});
