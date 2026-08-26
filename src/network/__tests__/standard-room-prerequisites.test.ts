/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWithCapability: vi.fn(),
  warmCapabilitySilently: vi.fn(async () => true),
}));

vi.mock('../../core/capability.ts', () => ({
  fetchWithCapability: mocks.fetchWithCapability,
  isCapabilityChallengeCancelled: (error: unknown) =>
    error instanceof Error && error.name === 'CapabilityChallengeCancelled',
  warmCapabilitySilently: mocks.warmCapabilitySilently,
}));

vi.mock('../transport/config.ts', () => ({
  getRuntimeTransportConfig: () => ({
    provider: 'cloudflare' as const,
    signalingUrl: 'wss://signal.musixquare.com/api/rooms',
  }),
}));

import {
  __standardRoomPrerequisitesForTests,
  getStandardRoomTurnCredentials,
  prepareStandardRoomNetworkRouteRetry,
  scheduleStandardRoomPrerequisiteWarmup,
} from '../standard-room-prerequisites.ts';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function turnResponse(ttl = 120): Response {
  return Response.json({
    provider: 'cloudflare',
    ttl,
    iceServers: [
      {
        urls: ['turn:turn.example.test:3478', 'turns:turn.example.test:5349'],
        username: 'user',
        credential: 'secret',
      },
    ],
  });
}

beforeEach(() => {
  __standardRoomPrerequisitesForTests.reset();
  vi.clearAllMocks();
  mocks.warmCapabilitySilently.mockResolvedValue(true);
  mocks.fetchWithCapability.mockResolvedValue(turnResponse());
});

afterEach(() => {
  __standardRoomPrerequisitesForTests.reset();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('standard-room prerequisite cache', () => {
  it('deduplicates the production-relative TURN retry while preserving local fallback', () => {
    expect(
      __standardRoomPrerequisitesForTests.requestEndpoints(
        'https://musixquare.com/setup?source=landing',
      ),
    ).toEqual(['/api/get-turn-config']);
    expect(__standardRoomPrerequisitesForTests.requestEndpoints('http://localhost:5173/')).toEqual([
      '/api/get-turn-config',
      'https://musixquare.com/api/get-turn-config',
    ]);
  });

  it('shares one in-flight TURN request and reuses it until the server TTL refresh window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const pending = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pending.promise);

    const host = getStandardRoomTurnCredentials();
    const guest = getStandardRoomTurnCredentials();
    expect(mocks.fetchWithCapability).toHaveBeenCalledOnce();
    expect(mocks.fetchWithCapability.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);

    pending.resolve(turnResponse(120));
    await expect(host).resolves.toMatchObject({ provider: 'cloudflare' });
    await expect(guest).resolves.toMatchObject({ provider: 'cloudflare' });

    await expect(getStandardRoomTurnCredentials()).resolves.toMatchObject({
      source: '/api/get-turn-config',
    });
    expect(mocks.fetchWithCapability).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_001);
    await getStandardRoomTurnCredentials();
    expect(mocks.fetchWithCapability).toHaveBeenCalledTimes(2);
  });

  it('lets one setup abort its wait without cancelling the shared fetch', async () => {
    const pending = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();

    const cancelledHost = getStandardRoomTurnCredentials(controller.signal);
    const successorGuest = getStandardRoomTurnCredentials();
    controller.abort();

    await expect(cancelledHost).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.fetchWithCapability.mock.calls[0]?.[2]?.signal).not.toBe(controller.signal);

    pending.resolve(turnResponse());
    await expect(successorGuest).resolves.toMatchObject({ provider: 'cloudflare' });
    expect(mocks.fetchWithCapability).toHaveBeenCalledOnce();
  });

  it('re-adopts a fresh TURN generation at a route boundary and fences the late result', async () => {
    const stale = deferred<Response>();
    mocks.fetchWithCapability
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(turnResponse());

    const firstRoute = getStandardRoomTurnCredentials();
    __standardRoomPrerequisitesForTests.invalidateNetworkRoute();
    const replacementRoute = getStandardRoomTurnCredentials();
    stale.resolve(turnResponse(600));
    await expect(firstRoute).resolves.toMatchObject({ provider: 'cloudflare' });
    await expect(replacementRoute).resolves.toMatchObject({ provider: 'cloudflare' });
    expect(mocks.fetchWithCapability).toHaveBeenCalledTimes(2);
  });

  it('proves an uncached signaling route before returning refreshed TURN configuration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T02:47:40.000Z'));
    const routeFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', routeFetch);
    const controller = new AbortController();

    scheduleStandardRoomPrerequisiteWarmup();
    expect(
      document.head.querySelectorAll('link[data-mxqr-standard-signaling-preconnect]'),
    ).toHaveLength(1);

    const preparation = prepareStandardRoomNetworkRouteRetry(controller.signal);
    expect(document.head.querySelector('link[data-mxqr-standard-signaling-preconnect]')).toBeNull();
    await vi.advanceTimersByTimeAsync(150);
    const configuration = await preparation;

    expect(routeFetch).toHaveBeenCalledOnce();
    const [routeUrl, init] = routeFetch.mock.calls[0]!;
    expect(String(routeUrl)).toMatch(/^https:\/\/signal\.musixquare\.com\/\?_mxqr_route=/);
    expect(init).toMatchObject({
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
    });
    expect(configuration?.iceServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ urls: 'stun:stun.cloudflare.com:3478' }),
        expect.objectContaining({ urls: expect.arrayContaining(['turn:turn.example.test:3478']) }),
      ]),
    );
  });

  it('retries normally after an opportunistic warmup failure', async () => {
    mocks.fetchWithCapability
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(turnResponse());

    await expect(getStandardRoomTurnCredentials()).resolves.toBeNull();
    await expect(getStandardRoomTurnCredentials()).resolves.toMatchObject({
      provider: 'cloudflare',
    });
    expect(mocks.fetchWithCapability).toHaveBeenCalledTimes(3);
  });

  it('bounds a hung shared request and lets the next setup retry', async () => {
    vi.useFakeTimers();
    let stalledSignal: AbortSignal | null = null;
    mocks.fetchWithCapability.mockImplementationOnce(
      (_input: RequestInfo | URL, _scope: string, init?: RequestInit) => {
        stalledSignal = init?.signal ?? null;
        return new Promise<Response>(() => undefined);
      },
    );

    const hung = getStandardRoomTurnCredentials();
    await vi.advanceTimersByTimeAsync(__standardRoomPrerequisitesForTests.turnRequestTimeoutMs);
    await expect(hung).resolves.toBeNull();
    expect(stalledSignal).not.toBeNull();
    expect((stalledSignal as AbortSignal | null)?.aborted).toBe(true);

    mocks.fetchWithCapability.mockResolvedValueOnce(turnResponse());
    await expect(getStandardRoomTurnCredentials()).resolves.toMatchObject({
      provider: 'cloudflare',
    });
    expect(mocks.fetchWithCapability).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized TURN control responses without waiting for cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    mocks.fetchWithCapability.mockImplementation(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          headers: { 'content-length': String(64 * 1024 + 1) },
        }),
    );

    await expect(getStandardRoomTurnCredentials()).resolves.toBeNull();
    expect(mocks.fetchWithCapability).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('preconnects signaling but skips TURN when capability cannot warm silently', async () => {
    mocks.warmCapabilitySilently.mockResolvedValueOnce(false);

    await __standardRoomPrerequisitesForTests.warm();

    const preconnect = document.head.querySelector<HTMLLinkElement>(
      'link[data-mxqr-standard-signaling-preconnect]',
    );
    expect(preconnect?.rel).toBe('preconnect');
    expect(preconnect?.href).toBe('https://signal.musixquare.com/');
    expect(mocks.warmCapabilitySilently).toHaveBeenCalledWith('/api/get-turn-config', ['turn']);
    expect(mocks.fetchWithCapability).not.toHaveBeenCalled();
  });

  it('preconnects on setup entry but waits for room intent before capability and TURN', async () => {
    const capability = deferred<boolean>();
    mocks.warmCapabilitySilently.mockReturnValueOnce(capability.promise);
    document.body.innerHTML = `
      <button id="unrelated">Settings</button>
      <button id="btn-setup-host">Create room</button>
    `;

    scheduleStandardRoomPrerequisiteWarmup();
    await Promise.resolve();
    expect(mocks.warmCapabilitySilently).not.toHaveBeenCalled();
    expect(mocks.fetchWithCapability).not.toHaveBeenCalled();
    expect(
      document.head.querySelectorAll('link[data-mxqr-standard-signaling-preconnect]'),
    ).toHaveLength(1);

    document
      .getElementById('unrelated')
      ?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await Promise.resolve();
    expect(mocks.warmCapabilitySilently).not.toHaveBeenCalled();
    expect(mocks.fetchWithCapability).not.toHaveBeenCalled();

    document
      .getElementById('btn-setup-host')
      ?.dispatchEvent(new Event('pointerover', { bubbles: true }));
    document
      .getElementById('btn-setup-host')
      ?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(
      document.head.querySelectorAll('link[data-mxqr-standard-signaling-preconnect]'),
    ).toHaveLength(1);
    expect(mocks.warmCapabilitySilently).toHaveBeenCalledOnce();
    expect(mocks.fetchWithCapability).not.toHaveBeenCalled();

    capability.resolve(true);
    await vi.waitFor(() => expect(mocks.fetchWithCapability).toHaveBeenCalledOnce());
    expect(mocks.warmCapabilitySilently).toHaveBeenCalledOnce();
    expect(mocks.fetchWithCapability).toHaveBeenCalledOnce();
  });

  it('retries a silent capability warm that initially returned false on room intent', async () => {
    mocks.warmCapabilitySilently.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await __standardRoomPrerequisitesForTests.warm();
    expect(mocks.fetchWithCapability).not.toHaveBeenCalled();

    await __standardRoomPrerequisitesForTests.warm();

    expect(mocks.fetchWithCapability).toHaveBeenCalledOnce();
    expect(mocks.warmCapabilitySilently).toHaveBeenCalledTimes(2);
  });

  it('starts one explicit shared TURN request on touch activation without a silent warm race', async () => {
    document.body.innerHTML = '<button id="btn-setup-host">Create room</button>';
    scheduleStandardRoomPrerequisiteWarmup();
    const button = document.getElementById('btn-setup-host')!;
    const touchOver = new Event('pointerover', { bubbles: true });
    Object.defineProperty(touchOver, 'pointerType', { value: 'touch' });
    button.dispatchEvent(touchOver);
    expect(mocks.warmCapabilitySilently).not.toHaveBeenCalled();
    expect(mocks.fetchWithCapability).not.toHaveBeenCalled();

    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const clickFlow = getStandardRoomTurnCredentials();

    await expect(clickFlow).resolves.toMatchObject({ provider: 'cloudflare' });
    expect(mocks.warmCapabilitySilently).not.toHaveBeenCalled();
    expect(mocks.fetchWithCapability).toHaveBeenCalledOnce();
  });
});
