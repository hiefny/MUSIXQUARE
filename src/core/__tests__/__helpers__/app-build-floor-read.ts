/**
 * The page's App build floor read (`APP_BUILD_FLOOR_CLIENT_PATH`, the forced
 * update's start and resume check, RO-22) for tests that run the update
 * machine with a build (__MXQR_BUILD_CACHE_VERSION__ stubbed). The unit
 * network guard (network-guard.setup.ts) rejects every unstubbed fetch, so a
 * suite that opens a loaded, visible document with a build installs this
 * stub: by default it answers `{"effectiveMinAppBuild":0}` (no floor), and a
 * row sets another answer or holds the reads. Any other URL goes to the
 * guard, so a stray fetch still fails the test.
 */
import { vi, type Mock } from 'vitest';
import { APP_BUILD_FLOOR_CLIENT_PATH } from '../../../../cloudflare/app-build-floor-contract.ts';

/** The unit network guard's fetch, captured before any test stubs fetch. */
const guardFetch = globalThis.fetch;

/**
 * How the next floor reads answer: a floor (a 200 JSON body), another status
 * or body, a `fetch` rejection with no response, or no answer at all (the
 * read's deadline or the page's own abort ends it).
 */
export type FloorAnswer =
  number | { readonly status: number; readonly body: string } | 'network-error' | 'no-answer';

export interface FloorReadStub {
  /** The stubbed fetch; install it with vi.stubGlobal('fetch', stub.fetch). */
  readonly fetch: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
  /** The floor reads started so far. */
  reads(): number;
  /** The request options of each read. */
  readonly requests: RequestInit[];
  /** Answer the reads from now on this way. */
  answer(next: FloorAnswer): void;
  /** Hold the reads from now on until `release`. */
  hold(): void;
  /** Answer every held read, then answer the next reads this way too. */
  release(next: FloorAnswer): void;
}

function respond(answer: Exclude<FloorAnswer, 'no-answer'>): Promise<Response> {
  if (answer === 'network-error') return Promise.reject(new TypeError('Failed to fetch'));
  const { status, body } =
    typeof answer === 'number'
      ? { status: 200, body: JSON.stringify({ effectiveMinAppBuild: answer }) }
      : answer;
  return Promise.resolve(
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    }),
  );
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** A floor read stub answering 0, which the caller installs as `fetch`. */
export function createFloorReadStub(initial: FloorAnswer = 0): FloorReadStub {
  let current: FloorAnswer = initial;
  let holding = false;
  let count = 0;
  const requests: RequestInit[] = [];
  const held: Array<(answer: FloorAnswer) => void> = [];

  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    if (new URL(raw, 'https://unit-test.invalid').pathname !== APP_BUILD_FLOOR_CLIENT_PATH) {
      return guardFetch(input, init);
    }
    count += 1;
    requests.push(init ?? {});
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled || !signal) return;
        settled = true;
        reject(abortError(signal));
      };
      const finish = (answer: FloorAnswer): void => {
        if (settled || answer === 'no-answer') return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        respond(answer).then(resolve, reject);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (holding) held.push(finish);
      else finish(current);
    });
  });

  return {
    fetch,
    reads: () => count,
    requests,
    answer(next) {
      current = next;
    },
    hold() {
      holding = true;
    },
    release(next) {
      holding = false;
      current = next;
      for (const finish of held.splice(0)) finish(next);
    },
  };
}
