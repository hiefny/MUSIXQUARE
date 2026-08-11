/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertCapabilityServiceReady: vi.fn<
    (input?: RequestInfo | URL, signal?: AbortSignal) => Promise<void>
  >(async () => undefined),
  fetchWithCapability: vi.fn(),
  warmCapabilitySilently: vi.fn(async () => true),
}));

vi.mock('../../core/capability.ts', () => ({
  assertCapabilityServiceReady: mocks.assertCapabilityServiceReady,
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
  scheduleStandardRoomPrerequisiteWarmup,
  waitForStandardRoomReadiness,
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
  mocks.assertCapabilityServiceReady.mockResolvedValue(undefined);
  mocks.fetchWithCapability.mockResolvedValue(turnResponse());
});

afterEach(() => {
  __standardRoomPrerequisitesForTests.reset();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('standard-room prerequisite cache', () => {
  it('bypasses API-less local/E2E modes while production keeps the strict probe', async () => {
    const e2eProgress = vi.fn();
    await expect(
      __standardRoomPrerequisitesForTests.waitForReadinessInMode('e2e', undefined, e2eProgress),
    ).resolves.toBeUndefined();
    expect(e2eProgress).not.toHaveBeenCalled();
    expect(mocks.assertCapabilityServiceReady).not.toHaveBeenCalled();

    const developmentProgress = vi.fn();
    await expect(
      __standardRoomPrerequisitesForTests.waitForReadinessInMode(
        'development',
        undefined,
        developmentProgress,
      ),
    ).resolves.toBeUndefined();
    expect(developmentProgress).not.toHaveBeenCalled();
    expect(mocks.assertCapabilityServiceReady).not.toHaveBeenCalled();

    await expect(
      __standardRoomPrerequisitesForTests.waitForReadinessInMode('production'),
    ).resolves.toBeUndefined();
    expect(mocks.assertCapabilityServiceReady).toHaveBeenCalledOnce();
    expect(mocks.assertCapabilityServiceReady).toHaveBeenCalledWith(
      '/api/security-config',
      expect.any(AbortSignal),
    );
  });

  it('retries only the read-only same-origin readiness probe before succeeding', async () => {
    vi.useFakeTimers();
    mocks.assertCapabilityServiceReady
      .mockRejectedValueOnce(new Error('half-open'))
      .mockRejectedValueOnce(new Error('still half-open'))
      .mockResolvedValueOnce(undefined);
    const progress: Array<[number, number]> = [];

    const ready = waitForStandardRoomReadiness(undefined, (attempt, maxAttempts) =>
      progress.push([attempt, maxAttempts]),
    );
    await vi.advanceTimersByTimeAsync(
      __standardRoomPrerequisitesForTests.readinessRetryDelaysMs.reduce<number>(
        (total, delay) => total + delay,
        0,
      ),
    );

    await expect(ready).resolves.toBeUndefined();
    expect(mocks.assertCapabilityServiceReady).toHaveBeenCalledTimes(3);
    expect(mocks.assertCapabilityServiceReady.mock.calls.map(([input]) => input)).toEqual([
      '/api/security-config',
      '/api/security-config',
      '/api/security-config',
    ]);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('cancels readiness during backoff without starting another probe', async () => {
    vi.useFakeTimers();
    mocks.assertCapabilityServiceReady.mockRejectedValueOnce(new Error('offline'));
    const controller = new AbortController();
    const ready = waitForStandardRoomReadiness(controller.signal);
    await vi.waitFor(() => expect(mocks.assertCapabilityServiceReady).toHaveBeenCalledOnce());

    controller.abort(new DOMException('Back', 'AbortError'));

    await expect(ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.assertCapabilityServiceReady).toHaveBeenCalledOnce();
  });

  it('bounds all stalled readiness attempts', async () => {
    vi.useFakeTimers();
    mocks.assertCapabilityServiceReady.mockImplementation(() => new Promise<void>(() => undefined));

    const ready = waitForStandardRoomReadiness();
    const rejection = expect(ready).rejects.toThrow('STANDARD_ROOM_READINESS_UNAVAILABLE');
    const totalMs =
      __standardRoomPrerequisitesForTests.readinessAttemptTimeoutMs * 3 +
      __standardRoomPrerequisitesForTests.readinessRetryDelaysMs.reduce<number>(
        (total, delay) => total + delay,
        0,
      );
    await vi.advanceTimersByTimeAsync(totalMs);

    await rejection;
    expect(mocks.assertCapabilityServiceReady).toHaveBeenCalledTimes(3);
  });

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
      document.head.querySelector('link[data-mxqr-standard-signaling-preconnect]'),
    ).not.toBeNull();

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
