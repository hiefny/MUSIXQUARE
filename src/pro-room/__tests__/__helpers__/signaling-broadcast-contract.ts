import { expect } from 'vitest';

/**
 * What the signaling Worker accepts on its broadcast endpoint
 * (`handleInternalProRealtimeBroadcast` in cloudflare/signaling-worker.ts),
 * for the in-process fakes that stand in for it (resource RO-07).
 *
 * Signaling answers 400 to a body with any extra or missing key
 * (`hasExactKeys`) and to a room-code or generation header that disagrees
 * with the body. Signaling treats `roomGeneration` as optional; the fakes
 * require it because the PRO room always sends it. The workerd contract suite
 * (src/core/__tests__/pro-room-signaling-contract-workerd.test.ts) runs the
 * real signaling Worker against the same key list.
 */
export const SIGNALING_BROADCAST_PATH = '/internal/realtime/v1/broadcast';
export const SIGNALING_BROADCAST_BODY_KEYS: readonly string[] = [
  'coordinatorEpoch',
  'event',
  'roomCode',
  'roomGeneration',
  'targets',
];

/** The media types signaling reads as JSON (`readBoundedJson`): parameters allowed. */
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

/** Why signaling would refuse this broadcast; empty when it fits the contract. */
export function signalingBroadcastViolations(request: Request, body: unknown): string[] {
  const violations: string[] = [];
  if (request.method !== 'POST') violations.push(`method ${request.method}`);
  const contentType = request.headers.get('content-type');
  if (!JSON_CONTENT_TYPE.test(contentType ?? '')) violations.push(`content-type ${contentType}`);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [...violations, 'body is not a JSON object'];
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(SIGNALING_BROADCAST_BODY_KEYS)) {
    violations.push(`body keys ${keys.join(',')}`);
  }
  if (request.headers.get('x-mxqr-pro-room-code') !== record.roomCode) {
    violations.push('x-mxqr-pro-room-code differs from body roomCode');
  }
  if (request.headers.get('x-mxqr-pro-room-generation') !== String(record.roomGeneration)) {
    violations.push('x-mxqr-pro-room-generation differs from body roomGeneration');
  }
  return violations;
}

/**
 * Checks every broadcast request a fake signaling `fetch` receives. The PRO
 * room catches anything its signaling call throws and treats it as an
 * undelivered broadcast, so an assertion thrown inside a fake would never
 * fail the test. The check therefore reads a clone of the body beside the
 * fake, records violations, and `assertClean()` (in afterEach) fails the test.
 * The wrapped fake still receives the same request at the same moment.
 */
export function signalingBroadcastContract() {
  const pending: Promise<void>[] = [];
  const violations: string[] = [];
  const observe = (request: Request) => {
    if (new URL(request.url).pathname !== SIGNALING_BROADCAST_PATH) return;
    const copy = request.clone();
    pending.push(
      copy.text().then(
        (text) => {
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          violations.push(...signalingBroadcastViolations(copy, body));
        },
        (error: unknown) => {
          violations.push(`unreadable body: ${String(error)}`);
        },
      ),
    );
  };
  return {
    wrap<Result>(fetch: (request: Request) => Result): (request: Request) => Result {
      return (request: Request) => {
        observe(request);
        return fetch(request);
      };
    },
    /** Wait for the pending checks, then fail on any violation and forget them. */
    async assertClean(): Promise<void> {
      await Promise.all(pending.splice(0));
      expect(violations.splice(0)).toEqual([]);
    },
  };
}
