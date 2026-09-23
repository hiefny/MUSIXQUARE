import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';

let workerCallSequence = 0;

/**
 * The decoder package's worker RPC does not reject outstanding requests when
 * its worker fails. Fence every request so a bad file or blocked WASM worker
 * cannot leave the room's preparation promise hanging indefinitely.
 */
export function decoderWorkerCall<T>(worker: unknown, result: Promise<T>): Promise<T> {
  const target = worker as Partial<
    Pick<Worker, 'addEventListener' | 'removeEventListener' | 'terminate'>
  >;
  const timerName = `large-audio-worker-call-${++workerCallSequence}`;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearManagedTimer(timerName);
      target.removeEventListener?.('error', onError);
      target.removeEventListener?.('messageerror', onError);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      target.terminate?.();
      reject(error);
    };
    const onError = (): void => fail(new Error('Incremental audio decoder worker failed'));
    target.addEventListener?.('error', onError);
    target.addEventListener?.('messageerror', onError);
    setManagedTimer(
      timerName,
      () => fail(new Error('Incremental audio decoder worker timed out')),
      15_000,
    );
    result.then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, fail);
  });
}
