import { afterAll, afterEach, beforeEach } from 'vitest';

type BlockedRequest = Readonly<{ method: string; url: string }>;

let blockedRequests: BlockedRequest[] = [];
const resetUnitTestHistory =
  typeof window !== 'undefined' && window.history?.replaceState
    ? window.history.replaceState.bind(window.history)
    : null;

function safeRequestTarget(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const url = new URL(raw, 'https://unit-test.invalid');
    return url.origin === 'https://unit-test.invalid'
      ? url.pathname
      : `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Unit tests must never reach production or any other real network service.
 * Tests that exercise fetch behavior are required to install an explicit
 * per-test stub; an omitted stub fails closed with the attempted URL in the
 * stack trace instead of silently mutating or loading live state.
 */
function blockedUnitTestFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = safeRequestTarget(input);
  const method = String(
    init?.method || (input instanceof Request ? input.method : 'GET'),
  ).toUpperCase();
  blockedRequests.push({ method, url });
  return Promise.reject(
    new Error(
      `[unit-test-network-guard] Blocked outbound fetch: ${method} ${url}. ` +
        'Stub globalThis.fetch explicitly in this test.',
    ),
  );
}

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: blockedUnitTestFetch,
});

function assertNoBlockedRequests(phase: string): void {
  if (blockedRequests.length === 0) return;
  const attempts = blockedRequests.map(({ method, url }) => `${method} ${url}`).join('\n');
  blockedRequests = [];
  throw new Error(
    `[unit-test-network-guard] Unmocked outbound fetch detected ${phase}:\n${attempts}`,
  );
}

beforeEach(() => {
  // Catch work that escaped the previous test after its teardown completed.
  assertNoBlockedRequests('before the next test started');
  // Locale selection intentionally projects the app URL in place. Keep that
  // browser state from leaking into the next test in a reused DOM environment.
  try {
    resetUnitTestHistory?.(null, '', '/');
  } catch {
    /* A test-specific non-DOM history stub remains outside global isolation. */
  }
});

afterEach(async () => {
  // Let already-queued promise continuations settle before checking the test.
  await Promise.resolve();
  assertNoBlockedRequests('during test execution or teardown');
});

afterAll(async () => {
  await Promise.resolve();
  assertNoBlockedRequests('after the final test completed');
});

export {};
