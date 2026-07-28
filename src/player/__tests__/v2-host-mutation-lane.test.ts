import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelV2HostMutation, enqueueV2HostMutation } from '../v2-host-mutation-lane.ts';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  cancelV2HostMutation('V2 host mutation lane test teardown');
});

describe('V2 host mutation lane', () => {
  it('orders a request enqueued synchronously by a predecessor abort listener', async () => {
    const firstGate = deferred();
    const calls: string[] = [];
    let reentrant: Promise<string | undefined> | null = null;

    const first = enqueueV2HostMutation('first', async (intent) => {
      calls.push('first');
      intent.controller.signal.addEventListener(
        'abort',
        () => {
          reentrant = enqueueV2HostMutation('reentrant', async () => {
            calls.push('reentrant');
            return 'reentrant';
          });
        },
        { once: true },
      );
      await firstGate.promise;
      return 'first';
    });
    await vi.waitFor(() => {
      expect(calls).toEqual(['first']);
    });

    const superseded = enqueueV2HostMutation('superseded', async () => {
      calls.push('superseded');
      return 'superseded';
    });
    firstGate.resolve();

    await expect(first).resolves.toBe('first');
    await expect(superseded).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(reentrant).not.toBeNull();
    });
    await expect(reentrant as unknown as Promise<string | undefined>).resolves.toBe('reentrant');
    expect(calls).toEqual(['first', 'reentrant']);
  });
});
