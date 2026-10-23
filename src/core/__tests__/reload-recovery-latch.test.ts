import { describe, expect, it, vi } from 'vitest';
import { createReloadRecoveryLatch } from '../reload-recovery-latch.ts';

describe('reload recovery latch', () => {
  // The navigation owner reports a reload's recovery at most once per attempt
  // (C6-4), so the latch no longer guards against a repeated callback (C6-13):
  // the owner's sequence test and the harness lazy-feature pin cover that.
  it('deduplicates a prompt until its reload reports recovery, then prompts again', async () => {
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
    // While the reload is pending, a further failure joins the same attempt.
    report('while-reloading');
    expect(present).toHaveBeenCalledOnce();
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
