// One home for the release live smokes' single retry after a transient
// `HTTP 503 {"error":"RATE_LIMIT_UNAVAILABLE"}`. The App and signaling Workers
// return that exact response only when their rate-limit Durable Object did not
// answer within its 2 s read timeout. On 2026-10-24 it failed three Production
// Release runs right after a deploy (40048773311, 40049406993, 40101887540);
// each SHA then passed unchanged on a new dispatch. Every other status, code or
// body stays final, and so does any failure once the run's one retry is spent.

export const RATE_LIMIT_UNAVAILABLE = 'RATE_LIMIT_UNAVAILABLE';
// Longer than the 2 s limiter read timeout behind the code, and than the ~4 s
// over which two consecutive bridge requests got it in Release 40101887540.
export const RATE_LIMIT_UNAVAILABLE_RETRY_DELAY_MS = 5_000;
export const UPGRADE_REJECTION_BODY_MAX_BYTES = 4 * 1024;
export const UPGRADE_REJECTION_BODY_TIMEOUT_MS = 2_000;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A WebSocket upgrade rejected with the exact rate-limiter response. Its
 * message is the smoke's existing failure line, and its name stays `Error`, so
 * a final failure prints exactly what it printed before this retry existed.
 */
export class RateLimitUnavailableError extends Error {}

/** True only for HTTP 503 whose JSON body's `error` is exactly `RATE_LIMIT_UNAVAILABLE`. */
export function isRateLimitUnavailableResponse(status: unknown, payload: unknown): boolean {
  return status === 503 && isJsonObject(payload) && payload.error === RATE_LIMIT_UNAVAILABLE;
}

/** The parts of the `ws` client's rejected-upgrade `IncomingMessage` this reads. */
export interface UpgradeRejectionResponse {
  readonly statusCode?: number | undefined;
  resume(): void;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  destroy(): void;
}

/**
 * Classifies a rejected WebSocket upgrade. `ws` hands over the HTTP response,
 * and the signaling Worker's 503 carries the same JSON code as an HTTP one, so
 * a code-less 503 (an edge error page, a cut body) is never retried. Any other
 * status is only drained, as before. A 503 body is read up to 4 KiB for at most
 * 2 s and then released; reading it never throws.
 */
export function readRateLimitUnavailableUpgrade(
  response: UpgradeRejectionResponse,
): Promise<boolean> {
  if (response.statusCode !== 503) {
    response.resume();
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolveRead) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const finish = (rateLimited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.destroy();
      resolveRead(rateLimited);
    };
    const timer = setTimeout(() => finish(false), UPGRADE_REJECTION_BODY_TIMEOUT_MS);
    response.on('data', (chunk) => {
      size += chunk.byteLength;
      if (size > UPGRADE_REJECTION_BODY_MAX_BYTES) {
        finish(false);
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        );
      } catch {
        finish(false);
        return;
      }
      finish(isRateLimitUnavailableResponse(503, payload));
    });
    response.on('error', () => finish(false));
  });
}

export interface RateLimitUnavailableRetry {
  /**
   * Claims the smoke run's single retry for a failure already classified as
   * RATE_LIMIT_UNAVAILABLE: prints its failure line unchanged, then the retry
   * line, then waits. Once spent it prints nothing and returns false, and the
   * caller fails exactly as it did before this retry existed.
   */
  claim(failureLine: string): Promise<boolean>;
}

export function createRateLimitUnavailableRetry({
  delayMs = RATE_LIMIT_UNAVAILABLE_RETRY_DELAY_MS,
  wait = (milliseconds: number) =>
    new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)),
  log = (line: string) => console.warn(line),
}: {
  delayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
} = {}): RateLimitUnavailableRetry {
  let spent = false;
  return {
    async claim(failureLine) {
      if (spent) return false;
      spent = true;
      log(failureLine);
      log(
        `[live smoke] retried after ${RATE_LIMIT_UNAVAILABLE} (HTTP 503): repeating the request ` +
          `once in ${delayMs}ms; this was the run's only rate-limit retry, so another failure is final`,
      );
      await wait(delayMs);
      return true;
    },
  };
}
