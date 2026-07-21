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
  vi.useRealTimers();
});

describe('standard-room prerequisite cache', () => {
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
    mocks.fetchWithCapability.mockImplementationOnce(
      (_input: RequestInfo | URL, _scope: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const hung = getStandardRoomTurnCredentials();
    await vi.advanceTimersByTimeAsync(
      __standardRoomPrerequisitesForTests.turnRequestTimeoutMs,
    );
    await expect(hung).resolves.toBeNull();

    mocks.fetchWithCapability.mockResolvedValueOnce(turnResponse());
    await expect(getStandardRoomTurnCredentials()).resolves.toMatchObject({
      provider: 'cloudflare',
    });
    expect(mocks.fetchWithCapability).toHaveBeenCalledTimes(2);
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
});
