import { describe, expect, it, vi } from 'vitest';
import { createReloadRecoveryLatch } from '../reload-recovery-latch.ts';

describe('reload recovery latch', () => {
  it('deduplicates a prompt and bounds repeated no-op reload recovery callbacks', async () => {
    let resolvePresentation!: (choice: 'accept') => void;
    let onRecovered!: () => void;
    const present = vi.fn(
      () =>
        new Promise<'accept'>((resolve) => {
          resolvePresentation = resolve;
        }),
    );
    const recovered = vi.fn();
    const report = createReloadRecoveryLatch<string>({
      present,
      reload: vi.fn((_context, callback) => {
        onRecovered = callback;
      }),
      onDeclined: vi.fn(),
      onRecovered: recovered,
      onPresentationFailure: vi.fn(),
    });

    report('first');
    report('duplicate');
    expect(present).toHaveBeenCalledOnce();

    resolvePresentation('accept');
    await vi.waitFor(() => expect(onRecovered).toBeTypeOf('function'));
    onRecovered();
    onRecovered();
    expect(recovered).toHaveBeenCalledOnce();
    expect(recovered).toHaveBeenCalledWith('first');

    report('explicit-retry');
    expect(present).toHaveBeenCalledTimes(2);
  });

  it('releases the single-flight latch after a decline or presentation failure', async () => {
    const declined = vi.fn();
    const failed = vi.fn();
    const present = vi
      .fn<() => Promise<'accept' | 'decline'>>()
      .mockResolvedValueOnce('decline')
      .mockRejectedValueOnce(new Error('dialog unavailable'))
      .mockResolvedValue('accept');
    const report = createReloadRecoveryLatch<string>({
      present,
      reload: vi.fn(),
      onDeclined: declined,
      onRecovered: vi.fn(),
      onPresentationFailure: failed,
    });

    report('declined');
    await vi.waitFor(() => expect(declined).toHaveBeenCalledOnce());
    report('failed');
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    report('retry');

    expect(present).toHaveBeenCalledTimes(3);
  });
});
