import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RateLimitUnavailableError,
  createRateLimitUnavailableRetry,
} from '../../../scripts/live-smoke-rate-limit-retry.mts';
import { importTranspiledLiveSmoke } from './live-smoke-module-fixture.ts';

class SmokeSocket extends EventEmitter {
  static current: SmokeSocket;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();

  constructor() {
    super();
    SmokeSocket.current = this;
  }
}

type AssertionProvider = (request: Record<string, unknown>) => Promise<string>;
type OpenAuthority = (
  ...args: unknown[]
) => Promise<{ provider: AssertionProvider | null; close(): void }>;
type Convergence = <T>(
  attempt: (hostSecret: string) => Promise<T>,
  options: Record<string, unknown>,
) => Promise<T>;
const source = readFileSync('scripts/live-remote-share-smoke.ts', 'utf8');
const parsed = ts.createSourceFile('smoke.ts', source, ts.ScriptTarget.Latest, true);
const socketDeclaration = parsed.statements.find(
  (statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => declaration.name.getText(parsed) === 'WebSocket',
    ),
);
if (!socketDeclaration || source.split('await main();').length !== 2) {
  throw new Error('Remote smoke lifetime fixture cannot identify its entry points');
}
const fixtureGlobal = globalThis as typeof globalThis & Record<string, unknown>;
fixtureGlobal.__mxqrSmokeSocket = SmokeSocket;
const instrumented = source
  .replace(socketDeclaration.getText(parsed), 'const WebSocket = globalThis.__mxqrSmokeSocket;')
  .replace(
    'await main();',
    'globalThis.__mxqrOpenSmokeAuthority = openRoomUploadAssertionAuthorityAttempt;\n' +
      'globalThis.__mxqrSmokeConvergence = withSignalingVersionConvergence;',
  );
const compiled = ts.transpileModule(instrumented, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
await importTranspiledLiveSmoke(compiled);
const openAuthority = fixtureGlobal.__mxqrOpenSmokeAuthority as OpenAuthority;
const withConvergence = fixtureGlobal.__mxqrSmokeConvergence as Convergence;
delete fixtureGlobal.__mxqrSmokeSocket;
delete fixtureGlobal.__mxqrOpenSmokeAuthority;
delete fixtureGlobal.__mxqrSmokeConvergence;

function open(expectedVersion = 'version', hostAppBuild = 785) {
  return openAuthority(
    '123456',
    { roomUploadAssertionVersion: 1 },
    expectedVersion,
    'secret',
    hostAppBuild,
  );
}

function sentFrames(): Array<Record<string, unknown>> {
  return SmokeSocket.current.send.mock.calls.map(
    ([frame]) => JSON.parse(String(frame)) as Record<string, unknown>,
  );
}

const INVALID_FIRST_FRAME = JSON.stringify({
  type: 'error',
  errorType: 'invalid-id',
  message: 'HOST_AUTH_FIRST_FRAME_INVALID',
});
const INVALID_FIRST_FRAME_LINE =
  'remote-share signaling host: host-auth refused as an invalid first frame (HOST_AUTH_FIRST_FRAME_INVALID)';

afterEach(() => vi.useRealTimers());

describe('live remote-share smoke socket ownership', () => {
  it('terminates a socket when opening times out', async () => {
    vi.useFakeTimers();
    const outcome = open();
    const rejected = expect(outcome).rejects.toThrow('host open timeout');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(SmokeSocket.current.terminate).toHaveBeenCalledOnce();
  });

  it('terminates an opened socket when its admission frame never arrives', async () => {
    vi.useFakeTimers();
    const outcome = open();
    const rejected = expect(outcome).rejects.toThrow('host admission timeout');
    SmokeSocket.current.emit('open');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(SmokeSocket.current.terminate).toHaveBeenCalledOnce();
  });

  it('retires the open deadline immediately when the connection closes', async () => {
    vi.useFakeTimers();
    const outcome = open();
    const rejected = expect(outcome).rejects.toThrow('closed');
    SmokeSocket.current.emit('close', 1006, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(SmokeSocket.current.terminate).toHaveBeenCalledOnce();
  });

  it('keeps a successful authority alive until its caller closes it', async () => {
    vi.useFakeTimers();
    const outcome = open();
    SmokeSocket.current.emit('open');
    await vi.advanceTimersByTimeAsync(0);
    SmokeSocket.current.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'peer-open',
          workerVersionId: 'version',
          remoteShareUploadAssertionVersion: 1,
          remoteShareUploadAssertionKeyringVersion: 1,
        }),
      ),
    );
    const authority = await outcome;
    expect(SmokeSocket.current.terminate).not.toHaveBeenCalled();
    expect(SmokeSocket.current.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    authority.close();
    expect(SmokeSocket.current.close).toHaveBeenCalledOnce();
  });
});

describe('live remote-share smoke rate-limited signaling upgrade', () => {
  function rejectUpgrade(statusCode: number, body: string) {
    const outcome = open().catch((error: unknown) => error);
    SmokeSocket.current.emit(
      'unexpected-response',
      {},
      Object.assign(Readable.from([Buffer.from(body)]), { statusCode }),
    );
    return outcome;
  }

  it('marks the rate-limiter 503 with the ws failure line and terminates the socket', async () => {
    const error = await rejectUpgrade(503, '{"error":"RATE_LIMIT_UNAVAILABLE"}');

    expect(error).toBeInstanceOf(RateLimitUnavailableError);
    expect((error as Error).message).toBe('Unexpected server response: 503');
    expect(SmokeSocket.current.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    [503, '{"error":"SERVICE_MAINTENANCE"}'],
    [503, '<html>503 Service Unavailable</html>'],
    [502, '{"error":"RATE_LIMIT_UNAVAILABLE"}'],
  ])('keeps HTTP %i with %s final', async (statusCode, body) => {
    const error = await rejectUpgrade(statusCode, body);

    expect(error).not.toBeInstanceOf(RateLimitUnavailableError);
    expect((error as Error).message).toBe(`Unexpected server response: ${statusCode}`);
    expect(SmokeSocket.current.terminate).toHaveBeenCalledOnce();
  });

  it('retries the same room and host secret once', async () => {
    const log = vi.fn();
    const secrets: string[] = [];
    const result = await withConvergence(
      async (hostSecret) => {
        secrets.push(hostSecret);
        if (secrets.length === 1) {
          throw new RateLimitUnavailableError('Unexpected server response: 503');
        }
        return 'authority';
      },
      { rateLimitRetry: createRateLimitUnavailableRetry({ log, wait: async () => {} }) },
    );

    expect(result).toBe('authority');
    expect(secrets).toHaveLength(2);
    expect(secrets[1]).toBe(secrets[0]);
    expect(log.mock.calls[0]).toEqual(['Unexpected server response: 503']);
    expect(String(log.mock.calls[1]?.[0])).toContain('retried after RATE_LIMIT_UNAVAILABLE');
  });

  it('throws a second rate-limited upgrade unchanged', async () => {
    const log = vi.fn();
    const second = new RateLimitUnavailableError('Unexpected server response: 503');
    let attempts = 0;

    await expect(
      withConvergence(
        async () => {
          attempts += 1;
          throw attempts === 1 ? new RateLimitUnavailableError('first') : second;
        },
        { rateLimitRetry: createRateLimitUnavailableRetry({ log, wait: async () => {} }) },
      ),
    ).rejects.toBe(second);
    expect(attempts).toBe(2);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('live remote-share smoke App build', () => {
  it('sends the release build and the PIN fields on the host admission frame', async () => {
    vi.useFakeTimers();
    const outcome = open('version', 785);
    SmokeSocket.current.emit('open');
    await vi.advanceTimersByTimeAsync(0);
    // The Signaling Worker requires the desired PIN ('' for none) and its
    // mutation ID on every host-auth (old-version removal W-3).
    expect(sentFrames()).toEqual([
      {
        type: 'host-auth',
        secret: 'secret',
        desiredRoomPassword: '',
        pinMutationId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
        appBuild: 785,
      },
    ]);
    SmokeSocket.current.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'peer-open',
          workerVersionId: 'version',
          remoteShareUploadAssertionVersion: 1,
          remoteShareUploadAssertionKeyringVersion: 1,
        }),
      ),
    );
    (await outcome).close();
  });

  it('fails an invalid first frame at once when the Worker version is unknown', async () => {
    vi.useFakeTimers();
    const outcome = open('', 785).catch((error: unknown) => error);
    SmokeSocket.current.emit('open');
    await vi.advanceTimersByTimeAsync(0);
    SmokeSocket.current.emit('message', Buffer.from(INVALID_FIRST_FRAME));
    expect(((await outcome) as Error).message).toBe(INVALID_FIRST_FRAME_LINE);
    expect(SmokeSocket.current.terminate).toHaveBeenCalledOnce();
  });

  it('never waits out an invalid first frame of the candidate signaling Worker as a stale edge', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const result = withConvergence(
      async () => {
        attempts += 1;
        if (attempts > 1) return 'authority';
        const outcome = open('version', 785);
        SmokeSocket.current.emit('open');
        await vi.advanceTimersByTimeAsync(0);
        SmokeSocket.current.emit('message', Buffer.from(INVALID_FIRST_FRAME));
        return outcome;
      },
      { now: () => 0, sleep: async () => {}, timeoutMs: 10_000, retryIntervalMs: 0 },
    );
    await expect(result).rejects.toThrow(INVALID_FIRST_FRAME_LINE);
    expect(attempts).toBe(1);
  });

  it('never retries a floor refusal of the release build', async () => {
    vi.useFakeTimers();
    const outcome = open('', 785).catch((error: unknown) => error);
    SmokeSocket.current.emit('open');
    await vi.advanceTimersByTimeAsync(0);
    SmokeSocket.current.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'error',
          errorType: 'app-update-required',
          message: 'APP_UPDATE_REQUIRED',
          minAppBuild: 786,
        }),
      ),
    );
    const error = await outcome;
    expect((error as Error).message).toContain('below the App build floor 786');
  });
});

const ASSERTION_MARKERS = {
  remoteShareUploadAssertionVersion: 1,
  remoteShareUploadAssertionKeyringVersion: 1,
};
const ASSERTION_REQUEST = {
  actorId: 'rsa_smoke-actor',
  requestId: 'rs3_smoke-request',
  sessionId: 1_800_000_000_000,
  queueItemId: 'smoke-queue-item',
  size: 32,
  bodySha256: 'smoke-body-digest',
};

/** A compact `payload.signature` token of the given length (at least 45). */
function compactAssertion(length: number): string {
  return `${'p'.repeat(length - 44)}.${'s'.repeat(43)}`;
}

// The shortest assertion the App accepts.
const VALID_ASSERTION = compactAssertion(64);

async function admitHost(markers: Record<string, unknown>) {
  const outcome = open();
  SmokeSocket.current.emit('open');
  await vi.advanceTimersByTimeAsync(0);
  SmokeSocket.current.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'peer-open', workerVersionId: 'version', ...markers })),
  );
  const authority = await outcome;
  expect(authority.provider).not.toBeNull();
  return authority;
}

/** Answers the latest assertion request on the smoke socket and returns that request. */
function answerAssertionRequest(answer: Record<string, unknown>): Record<string, unknown> {
  const request = sentFrames().at(-1)!;
  SmokeSocket.current.emit(
    'message',
    Buffer.from(JSON.stringify({ correlationId: request.correlationId, ...answer })),
  );
  return request;
}

describe('live remote-share smoke room proof', () => {
  // An older Signaling Worker advertises the assertion markers in the host
  // peer-open and a newer one does not. The smoke must pass on both (a rerun
  // after automated recovery may meet the older one), so a real assertion
  // request and its answer prove the room instead of a marker, and Remote
  // Share then accepts that assertion for a real allocation.
  it.each([
    ['with', ASSERTION_MARKERS],
    ['without', {}],
  ])(
    'proves the room with a real assertion on a Signaling Worker %s the peer-open markers',
    async (_label, markers) => {
      vi.useFakeTimers();
      const authority = await admitHost(markers);
      const assertion = authority.provider!(ASSERTION_REQUEST);
      const request = answerAssertionRequest({
        type: 'remote-share-upload-assertion',
        assertion: VALID_ASSERTION,
        expiresAt: 1_800_000_060,
      });
      expect(request).toEqual({
        type: 'remote-share-upload-assertion-request',
        correlationId: expect.stringMatching(/^rsaq_[A-Za-z0-9_-]{32}$/u),
        ...ASSERTION_REQUEST,
      });
      await expect(assertion).resolves.toBe(VALID_ASSERTION);
      expect(SmokeSocket.current.terminate).not.toHaveBeenCalled();
      authority.close();
      expect(SmokeSocket.current.close).toHaveBeenCalledOnce();
    },
  );

  it('fails the room proof with the Signaling refusal when no assertion can be issued', async () => {
    // A Signaling Worker without the assertion secret advertises no marker
    // either; its own refusal of the real request now fails the smoke.
    vi.useFakeTimers();
    const authority = await admitHost({});
    const assertion = authority.provider!(ASSERTION_REQUEST);
    answerAssertionRequest({
      type: 'remote-share-upload-assertion-error',
      errorType: 'REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE',
    });
    await expect(assertion).rejects.toThrow(
      'remote-share assertion rejected: REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE',
    );
    authority.close();
  });

  // The App's own answer check (normalizeRemoteShareUploadAssertionResponse):
  // exactly four keys and a compact token of 64 to 4096 characters.
  it.each([
    { assertion: 'not-a-compact-token', expiresAt: 1_800_000_060 },
    { assertion: VALID_ASSERTION, expiresAt: 0 },
    { assertion: VALID_ASSERTION },
    { assertion: VALID_ASSERTION, expiresAt: 1_800_000_060, unexpected: true },
    { assertion: compactAssertion(63), expiresAt: 1_800_000_060 },
  ])('fails the room proof on an assertion answer of the wrong shape %o', async (answer) => {
    vi.useFakeTimers();
    const authority = await admitHost({});
    const assertion = authority.provider!(ASSERTION_REQUEST);
    answerAssertionRequest({ type: 'remote-share-upload-assertion', ...answer });
    await expect(assertion).rejects.toThrow(
      'remote-share signaling returned an invalid upload assertion',
    );
    authority.close();
  });
});

describe('live remote-share smoke assertion answer contract', () => {
  // The App does not export its assertion bounds or answer keys, and exporting
  // them would change an App runtime path, so this test pins the smoke's copy
  // to the values of the App's two checks.
  function captured(text: string, pattern: RegExp, label: string): string {
    const match = pattern.exec(text);
    if (!match?.[1]) throw new Error(`${label} not found`);
    return match[1];
  }
  const numberAt = (text: string, pattern: RegExp, label: string) =>
    Number(captured(text, pattern, label).replaceAll('_', ''));
  const keysAt = (text: string, pattern: RegExp, label: string) =>
    [...captured(text, pattern, label).matchAll(/'([^']+)'/gu)].map(([, key]) => key).sort();

  it('checks the same answer keys and assertion length bounds as the App', () => {
    const uploadClient = readFileSync('src/share/r2-client.ts', 'utf8');
    const signaling = readFileSync('src/network/transport/cloudflare-signaling.ts', 'utf8');
    const smokeMin = numberAt(
      source,
      /\bconst UPLOAD_ASSERTION_MIN_LENGTH = ([\d_]+);/u,
      'smoke minimum length',
    );
    const smokeMax = numberAt(
      source,
      /\bconst UPLOAD_ASSERTION_MAX_LENGTH = ([\d_]+);/u,
      'smoke maximum length',
    );
    const smokeKeys = keysAt(
      source,
      /\bconst UPLOAD_ASSERTION_ANSWER_KEYS = Object\.freeze\((\[[^\]]*\])\);/u,
      'smoke answer keys',
    );

    expect([smokeMin, smokeMax]).toEqual([64, 4096]);
    expect(smokeMin).toBe(
      numberAt(uploadClient, /\bassertion\.length < ([\d_]+) \|\|/u, 'upload minimum length'),
    );
    expect(smokeMax).toBe(
      numberAt(
        uploadClient,
        /\bconst REMOTE_SHARE_UPLOAD_ASSERTION_MAX_LENGTH = ([\d_]+);/u,
        'REMOTE_SHARE_UPLOAD_ASSERTION_MAX_LENGTH',
      ),
    );
    expect(smokeMin).toBe(
      numberAt(
        signaling,
        /\bcandidate\.assertion\.length < ([\d_]+) \|\|/u,
        'signaling minimum length',
      ),
    );
    expect(smokeMax).toBe(
      numberAt(
        signaling,
        /\bconst REMOTE_SHARE_UPLOAD_ASSERTION_TOKEN_MAX_LENGTH = ([\d_]+);/u,
        'REMOTE_SHARE_UPLOAD_ASSERTION_TOKEN_MAX_LENGTH',
      ),
    );
    expect(smokeKeys).toEqual(['assertion', 'correlationId', 'expiresAt', 'type']);
    expect(smokeKeys).toEqual(
      keysAt(
        signaling,
        /hasExactObjectKeys\(candidate, (\[[^\]]*\])\) \|\|\s*candidate\.type !== 'remote-share-upload-assertion' \|\|/u,
        'signaling answer keys',
      ),
    );
  });
});
