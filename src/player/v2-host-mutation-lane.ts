/**
 * One latest-wins serialization lane for standard-room V2 host mutations.
 *
 * Supersession has two deliberately separate effects:
 *  - the previous exact AbortSignal is cancelled synchronously, so work that
 *    has not crossed its commit boundary can stop immediately;
 *  - the successor still waits for the predecessor to settle, because a
 *    commit-dominant engine operation may validly finish after cancellation.
 *
 * Keeping this lane neutral lets playlist selection, renderer recovery, and
 * transport controls share one ordering authority without nesting lanes.
 */

const trustedAbortControllerAbort = AbortController.prototype.abort;

export interface V2HostMutationIntent {
  readonly sequence: number;
  readonly label: string;
  readonly controller: AbortController;
}

type V2HostMutationOperation<T> = (intent: V2HostMutationIntent) => Promise<T>;

let sequence = 0;
let currentIntent: V2HostMutationIntent | null = null;
let tail: Promise<void> = Promise.resolve();

function abortIntent(intent: V2HostMutationIntent | null, reason: string): void {
  if (!intent || intent.controller.signal.aborted) return;
  Reflect.apply(trustedAbortControllerAbort, intent.controller, [new Error(reason)]);
}

export function isCurrentV2HostMutationIntent(intent: V2HostMutationIntent): boolean {
  return currentIntent === intent && !intent.controller.signal.aborted;
}

/**
 * Cancels both active and not-yet-admitted work. A commit-dominant active
 * operation may still settle, but it no longer owns follow-up UI side effects.
 */
export function cancelV2HostMutation(reason: string): void {
  const intent = currentIntent;
  currentIntent = null;
  abortIntent(intent, reason);
}

/**
 * Enqueues one mutation and returns `undefined` when it was superseded before
 * admission. Operation failures are intentionally propagated to the caller.
 */
export function enqueueV2HostMutation<T>(
  label: string,
  operation: V2HostMutationOperation<T>,
): Promise<T | undefined> {
  const predecessor = tail;
  const previousIntent = currentIntent;
  const intent: V2HostMutationIntent = {
    sequence: ++sequence,
    label,
    controller: new AbortController(),
  };

  currentIntent = intent;

  const task = (async (): Promise<T | undefined> => {
    await predecessor;
    if (!isCurrentV2HostMutationIntent(intent)) return undefined;
    return operation(intent);
  })();

  const settlement = task.finally(() => {
    if (currentIntent === intent) currentIntent = null;
  });
  tail = settlement.then(
    () => undefined,
    () => undefined,
  );

  // Install the successor in the serialized tail before dispatching abort.
  // Abort listeners are user code and may synchronously enqueue another
  // mutation; publishing the tail first keeps that re-entrant request ordered
  // after this one instead of letting it be overwritten below.
  abortIntent(previousIntent, `V2 host mutation was superseded by ${label}`);
  return settlement;
}
