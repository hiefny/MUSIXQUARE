/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceWorkerGenerationResolver,
  createServiceWorkerUpdateLedger,
} from '../../sw-update-coordination.ts';

function generation(cacheVersion: string | null, promptIdentity = cacheVersion || 'unknown:sw') {
  return { cacheVersion, promptIdentity };
}

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
