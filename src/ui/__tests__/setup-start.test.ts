import { beforeEach, describe, expect, it, vi } from 'vitest';
import { YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS } from '../../youtube/constants.ts';

const mocks = vi.hoisted(() => ({
  markAppUsed: vi.fn(),
  emit: vi.fn(),
  activateNoSleep: vi.fn(),
  prime: vi.fn<(options?: { retryPending?: boolean }) => boolean>(),
  waitForProof: vi.fn<(timeoutMs?: number) => Promise<boolean>>(),
}));

vi.mock('../../core/events.ts', () => ({ bus: { emit: mocks.emit } }));
vi.mock('../../core/wake-lock.ts', () => ({ activateNoSleep: mocks.activateNoSleep }));
vi.mock('../../demo/storage.ts', () => ({ markAppUsed: mocks.markAppUsed }));
vi.mock('../../youtube/player.ts', () => ({ primeYouTubePlayer: mocks.prime }));
vi.mock('../../youtube/iframe.ts', () => ({
  waitForPendingYouTubePrimeBounce: mocks.waitForProof,
}));

import { prepareSetupStartFromGesture } from '../setup-start.ts';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.prime.mockReturnValue(false);
  mocks.waitForProof.mockResolvedValue(false);
});

describe('setup start gesture activation', () => {
  it('activates media synchronously and returns the pending full-budget prime proof', async () => {
    let finishProof!: (primed: boolean) => void;
    const proof = new Promise<boolean>((resolve) => {
      finishProof = resolve;
    });
    mocks.prime.mockReturnValue(true);
    mocks.waitForProof.mockReturnValue(proof);

    const result = prepareSetupStartFromGesture();

    // No await/microtask boundary may precede these gesture-sensitive calls.
    expect(mocks.markAppUsed).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('audio:activate');
    expect(mocks.prime).toHaveBeenCalledExactlyOnceWith({ retryPending: true });
    expect(mocks.activateNoSleep).toHaveBeenCalledOnce();
    expect(mocks.waitForProof).toHaveBeenCalledExactlyOnceWith(YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS);
    expect(mocks.prime.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.waitForProof.mock.invocationCallOrder[0],
    );
    expect(result).toBe(proof);

    finishProof(true);
    await expect(result).resolves.toBe(true);
  });

  it('returns null without waiting when no prime bounce is pending', () => {
    expect(prepareSetupStartFromGesture()).toBeNull();
    expect(mocks.markAppUsed).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('audio:activate');
    expect(mocks.prime).toHaveBeenCalledExactlyOnceWith({ retryPending: true });
    expect(mocks.activateNoSleep).toHaveBeenCalledOnce();
    expect(mocks.waitForProof).not.toHaveBeenCalled();
  });

  it('preserves false proof for the normal tap-to-play fallback without retrying asynchronously', async () => {
    mocks.prime.mockReturnValue(true);
    mocks.waitForProof.mockResolvedValue(false);

    await expect(prepareSetupStartFromGesture()).resolves.toBe(false);
    expect(mocks.prime).toHaveBeenCalledExactlyOnceWith({ retryPending: true });
    expect(mocks.waitForProof).toHaveBeenCalledExactlyOnceWith(YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS);
  });
});
