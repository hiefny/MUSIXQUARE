import { beginLargeAudioResource } from './diagnostics.ts';

/**
 * The decoder package's worker RPC does not reject outstanding requests when
 * its worker fails. Fence every request so a bad file or blocked WASM worker
 * cannot leave the room's preparation promise hanging indefinitely.
 */
export function decoderWorkerCall<T>(worker: unknown, result: Promise<T>): Promise<T> {
  const target = worker as Partial<
    Pick<Worker, 'addEventListener' | 'removeEventListener' | 'terminate'>
  >;
  const releaseResource = beginLargeAudioResource('workerCalls');
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      globalThis.clearTimeout(timeout);
      target.removeEventListener?.('error', onError);
      target.removeEventListener?.('messageerror', onError);
      releaseResource();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        target.terminate?.();
      } catch {
        // A teardown failure must not leave the waiting decoder promise pending.
      }
      reject(error);
    };
    const onError = (): void => fail(new Error('Incremental audio decoder worker failed'));
    target.addEventListener?.('error', onError);
    target.addEventListener?.('messageerror', onError);
    // This deadline owns a Worker RPC, not a room task. Session teardown clears
    // managed room timers before closing media; removing this deadline there
    // would strand an iterator waiting for a lost decoder response forever.
    const timeout = globalThis.setTimeout(
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
