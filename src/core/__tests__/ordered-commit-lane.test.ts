import { describe, expect, it, vi } from 'vitest';
import { OrderedCommitLane } from '../ordered-commit-lane.ts';
import { SessionScope } from '../session-scope.ts';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('OrderedCommitLane', () => {
  it('starts preparation concurrently but commits in enqueue order', async () => {
    const scope = new SessionScope();
    const lane = new OrderedCommitLane(scope);
    const first = deferred<string>();
    const second = deferred<string>();
    const prepareOrder: string[] = [];
    const commitOrder: string[] = [];

    const firstTask = lane.enqueue({
      prepare: () => {
        prepareOrder.push('first');
        return first.promise;
      },
      commit: (value) => {
        commitOrder.push(value);
      },
    });
    const secondTask = lane.enqueue({
      prepare: () => {
        prepareOrder.push('second');
        return second.promise;
      },
      commit: (value) => {
        commitOrder.push(value);
      },
    });

    expect(prepareOrder).toEqual(['first', 'second']);
    second.resolve('second');
    await Promise.resolve();
    expect(commitOrder).toEqual([]);

    first.resolve('first');
    await Promise.all([firstTask, secondTask]);

    expect(commitOrder).toEqual(['first', 'second']);
  });

  it('continues after preparation and commit failures', async () => {
    const scope = new SessionScope();
    const lane = new OrderedCommitLane(scope);
    const preparationError = new Error('prepare failed');
    const commitError = new Error('commit failed');
    const commits: string[] = [];

    const failedPreparation = lane.enqueue({
      prepare: () => {
        throw preparationError;
      },
      commit: () => {
        commits.push('unreachable');
      },
    });
    const failedCommit = lane.enqueue({
      prepare: () => 'second',
      commit: (value) => {
        commits.push(value);
        throw commitError;
      },
    });
    const successor = lane.enqueue({
      prepare: () => 'third',
      commit: (value) => {
        commits.push(value);
      },
    });

    await expect(failedPreparation).rejects.toBe(preparationError);
    await expect(failedCommit).rejects.toBe(commitError);
    await expect(successor).resolves.toBeUndefined();
    expect(commits).toEqual(['second', 'third']);
  });

  it('settles queued work without committing when disposed', async () => {
    const parent = new SessionScope();
    const lane = new OrderedCommitLane(parent);
    const pending = deferred<string>();
    const commit = vi.fn();
    const observedSignals: AbortSignal[] = [];

    const first = lane.enqueue({
      prepare: (signal) => {
        observedSignals.push(signal);
        return pending.promise;
      },
      commit,
    });
    const second = lane.enqueue({
      prepare: () => 'second',
      commit,
    });

    lane.dispose();
    await Promise.all([first, second]);

    expect(lane.disposed).toBe(true);
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(commit).not.toHaveBeenCalled();

    pending.resolve('late');
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();

    const latePrepare = vi.fn(() => 'late');
    await lane.enqueue({ prepare: latePrepare, commit });
    expect(latePrepare).not.toHaveBeenCalled();
  });

  it('releases callers after disposal even when an active commit does not cooperate', async () => {
    const scope = new SessionScope();
    const lane = new OrderedCommitLane(scope);
    const stuckCommit = deferred<void>();
    const commitStarted = deferred<void>();
    const commitOrder: string[] = [];

    const active = lane.enqueue({
      prepare: () => 'active',
      commit: async (value) => {
        commitOrder.push(value);
        commitStarted.resolve();
        await stuckCommit.promise;
      },
    });
    const queued = lane.enqueue({
      prepare: () => 'queued',
      commit: (value) => {
        commitOrder.push(value);
      },
    });
    await commitStarted.promise;
    expect(commitOrder).toEqual(['active']);

    scope.dispose();
    await expect(Promise.all([active, queued])).resolves.toEqual([undefined, undefined]);
    expect(commitOrder).toEqual(['active']);

    // The ignored commit may still finish, but it no longer owns the lane or
    // prevents disposal. Its body is responsible for checking the signal
    // before any side effect after the awaited operation.
    stuckCommit.resolve();
    await Promise.resolve();
    expect(commitOrder).toEqual(['active']);
  });

  it('does not let one lane block a sibling lane', async () => {
    const scope = new SessionScope();
    const slowLane = new OrderedCommitLane(scope);
    const fastLane = new OrderedCommitLane(scope);
    const slowPreparation = deferred<string>();
    const commits: string[] = [];

    const slow = slowLane.enqueue({
      prepare: () => slowPreparation.promise,
      commit: (value) => {
        commits.push(value);
      },
    });
    await fastLane.enqueue({
      prepare: () => 'fast',
      commit: (value) => {
        commits.push(value);
      },
    });

    expect(commits).toEqual(['fast']);
    slowPreparation.resolve('slow');
    await slow;
    expect(commits).toEqual(['fast', 'slow']);
  });

  it('is disposed when its parent session ends', async () => {
    const scope = new SessionScope();
    const lane = new OrderedCommitLane(scope);
    const commit = vi.fn();

    scope.dispose();
    await lane.enqueue({ prepare: () => 'late', commit });

    expect(lane.disposed).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });
});
