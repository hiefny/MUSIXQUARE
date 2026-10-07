/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceWorkerGenerationResolver,
  createServiceWorkerUpdateLedger,
} from '../../sw-update-coordination.ts';

function generation(cacheVersion: string | null, promptIdentity = cacheVersion || 'unknown:sw') {
  return { cacheVersion, promptIdentity };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('service-worker update coordination', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('persists Later for one exact known generation and immediately admits a replacement', () => {
    const ledger = createServiceWorkerUpdateLedger();
    const v494 = generation('v494');
    const now = 1_000_000;

    ledger.rememberDismissal(v494, now);

    expect(createServiceWorkerUpdateLedger().isDismissed(v494, now + 23 * 60 * 60 * 1000)).toBe(
      true,
    );
    expect(createServiceWorkerUpdateLedger().isDismissed(generation('v495'), now + 1)).toBe(false);
    expect(createServiceWorkerUpdateLedger().isDismissed(v494, now + 24 * 60 * 60 * 1000)).toBe(
      false,
    );
  });

  it('bounds an unknown mixed-version worker dismissal to thirty minutes', () => {
    const ledger = createServiceWorkerUpdateLedger();
    const unknown = generation(null, 'unknown:https://musixquare.com/service-worker.js');
    const now = 2_000_000;

    ledger.rememberDismissal(unknown, now);

    expect(ledger.isDismissed(unknown, now + 29 * 60 * 1000)).toBe(true);
    expect(ledger.isDismissed(unknown, now + 30 * 60 * 1000)).toBe(false);
  });

  it('gives one client the prompt lease while allowing a newer generation to supersede it', () => {
    const first = createServiceWorkerUpdateLedger();
    const second = createServiceWorkerUpdateLedger();
    const now = 3_000_000;

    expect(first.claimPrompt(generation('v494'), now)).toBe(true);
    expect(second.claimPrompt(generation('v494'), now + 1)).toBe(false);
    expect(second.claimPrompt(generation('v495'), now + 2)).toBe(true);
  });

  it('deduplicates explicit update checks origin-wide for one hour', () => {
    const first = createServiceWorkerUpdateLedger();
    const second = createServiceWorkerUpdateLedger();
    const now = 4_000_000;

    expect(first.claimUpdateCheck(now)).toBe(true);
    expect(second.claimUpdateCheck(now + 1)).toBe(false);
    expect(second.claimUpdateCheck(now + 60 * 60 * 1000)).toBe(true);
  });

  it('holds one native prompt lock across documents even when storage is unavailable', async () => {
    const held = new Set<string>();
    const request = vi.fn(
      async (
        name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void> | void,
      ) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          await callback({ name });
        } finally {
          held.delete(name);
        }
      },
    );
    vi.stubGlobal('navigator', { locks: { request } });
    vi.stubGlobal('localStorage', undefined);
    const first = createServiceWorkerUpdateLedger();
    const second = createServiceWorkerUpdateLedger();
    const current = generation('v494');
    expect(await first.acquirePrompt(current, vi.fn())).toBe(true);
    expect(await second.acquirePrompt(current, vi.fn())).toBe(false);
    expect(held.size).toBe(1);
    first.releasePrompt(current);
    await Promise.resolve();
    expect(await second.acquirePrompt(current, vi.fn())).toBe(true);
    second.releasePrompt(current);
  });

  it('keeps updates available if Web Locks rejects and storage writes are denied', async () => {
    vi.stubGlobal('navigator', {
      locks: { request: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
    });
    const ledger = createServiceWorkerUpdateLedger();
    const current = generation('v494');
    expect(await ledger.acquirePrompt(current, vi.fn())).toBe(true);
    ledger.releasePrompt(current);
  });

  it('rejects a legacy race loser before presentation and leaves the winning lease intact', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {});
    const ledger = createServiceWorkerUpdateLedger();
    const current = generation('v494');
    const lost = vi.fn();
    const acquisition = ledger.acquirePrompt(current, lost);
    await vi.advanceTimersByTimeAsync(0);
    const key = 'mxqr-sw-update-prompt-lease-v1';
    const competing = JSON.stringify({
      identity: 'v494',
      owner: 'other-client',
      expiresAt: Date.now() + 300000,
    });
    localStorage.setItem(key, competing);
    window.dispatchEvent(new StorageEvent('storage', { key }));
    await vi.advanceTimersByTimeAsync(50);
    expect(await acquisition).toBe(false);
    expect(lost).toHaveBeenCalledOnce();
    expect(localStorage.getItem(key)).toBe(competing);
    expect(ledger.isDismissed(current)).toBe(false);
  });

  it('notifies late legacy ownership loss without suppressing the winner or another generation', async () => {
    vi.stubGlobal('navigator', {});
    const ledger = createServiceWorkerUpdateLedger();
    const current = generation('v494');
    const lost = vi.fn();
    expect(await ledger.acquirePrompt(current, lost)).toBe(true);
    const key = 'mxqr-sw-update-prompt-lease-v1';
    localStorage.setItem(
      key,
      JSON.stringify({ identity: 'v495', owner: 'new-generation', expiresAt: Date.now() + 300000 }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(lost).not.toHaveBeenCalled();
    const competing = JSON.stringify({
      identity: 'v494',
      owner: 'same-generation-winner',
      expiresAt: Date.now() + 300000,
    });
    localStorage.setItem(key, competing);
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(lost).toHaveBeenCalledOnce();
    ledger.releasePrompt(current);
    expect(localStorage.getItem(key)).toBe(competing);
    expect(ledger.isDismissed(current)).toBe(false);
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(lost).toHaveBeenCalledOnce();
  });

  it('resolves an exact cache generation through the waiting worker protocol', async () => {
    const resolver = createServiceWorkerGenerationResolver();
    const worker = {
      scriptURL: 'https://musixquare.com/service-worker.js',
      postMessage: vi.fn((message: { requestId: string }) => {
        resolver.consumeMessage({
          type: 'MXQR_SW_GENERATION_RESPONSE',
          requestId: message.requestId,
          cacheVersion: 'v494',
        });
      }),
    } as unknown as ServiceWorker;

    await expect(resolver.resolve(worker)).resolves.toEqual({
      cacheVersion: 'v494',
      promptIdentity: 'v494',
    });
  });

  it('falls back to a short-lived stable-script identity when an old worker cannot reply', async () => {
    vi.useFakeTimers();
    const resolver = createServiceWorkerGenerationResolver();
    const worker = {
      scriptURL: 'https://musixquare.com/service-worker.js',
      postMessage: vi.fn(),
    } as unknown as ServiceWorker;

    const pending = resolver.resolve(worker);
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toEqual({
      cacheVersion: null,
      promptIdentity: 'unknown:https://musixquare.com/service-worker.js',
    });
  });
});
