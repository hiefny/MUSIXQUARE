import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RateLimitUnavailableError,
  createRateLimitUnavailableRetry,
} from '../../../scripts/live-smoke-rate-limit-retry.mts';
import { LegacySignalingHostAuthError } from '../../../scripts/live-smoke-app-build.mts';
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

type OpenAuthority = (...args: unknown[]) => Promise<{ close(): void }>;
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

function open(expectedVersion = 'version', hostAppBuild: number | null = 785) {
  return openAuthority(
    '123456',
    { roomUploadAssertionVersion: 1 },
    expectedVersion,
    'secret',
    true,
    hostAppBuild,
  );
}

function sentFrames(): Array<Record<string, unknown>> {
  return SmokeSocket.current.send.mock.calls.map(
    ([frame]) => JSON.parse(String(frame)) as Record<string, unknown>,
  );
}

const PRE_FLOOR_REFUSAL = JSON.stringify({
  type: 'error',
  errorType: 'invalid-id',
  message: 'HOST_AUTH_FIRST_FRAME_INVALID',
});

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
  it('sends the selected build on the host admission frame', async () => {
    vi.useFakeTimers();
    const outcome = open('version', 785);
    SmokeSocket.current.emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentFrames()).toEqual([{ type: 'host-auth', secret: 'secret', appBuild: 785 }]);
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

  it('sends the legacy shape once the selector chose it', async () => {
    vi.useFakeTimers();
    const outcome = open('', null).catch((error: unknown) => error);
    SmokeSocket.current.emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentFrames()).toEqual([{ type: 'host-auth', secret: 'secret' }]);
    SmokeSocket.current.emit('message', Buffer.from(PRE_FLOOR_REFUSAL));
    const error = await outcome;
    // A legacy-shape frame refused as invalid is a real failure, not a retry.
    expect(error).not.toBeInstanceOf(LegacySignalingHostAuthError);
    expect((error as Error).message).toContain('HOST_AUTH_FIRST_FRAME_INVALID');
  });

  it('hands a pre-floor refusal to the one legacy retry when the Worker version is unknown', async () => {
    vi.useFakeTimers();
    const outcome = open('', 785).catch((error: unknown) => error);
    SmokeSocket.current.emit('open');
    await vi.advanceTimersByTimeAsync(0);
    SmokeSocket.current.emit('message', Buffer.from(PRE_FLOOR_REFUSAL));
    expect(await outcome).toBeInstanceOf(LegacySignalingHostAuthError);
    expect(SmokeSocket.current.terminate).toHaveBeenCalledOnce();
  });

  it('treats a pre-floor refusal of the candidate signaling Worker as a stale edge', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const result = withConvergence(
      async () => {
        attempts += 1;
        if (attempts > 1) return 'authority';
        const outcome = open('version', 785);
        SmokeSocket.current.emit('open');
        await vi.advanceTimersByTimeAsync(0);
        SmokeSocket.current.emit('message', Buffer.from(PRE_FLOOR_REFUSAL));
        return outcome;
      },
      { now: () => 0, sleep: async () => {}, timeoutMs: 10_000, retryIntervalMs: 0 },
    );
    await expect(result).resolves.toBe('authority');
    expect(attempts).toBe(2);
  });

  it('never retries a floor refusal of the selected build', async () => {
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
    expect(error).not.toBeInstanceOf(LegacySignalingHostAuthError);
    expect((error as Error).message).toContain('below the App build floor 786');
  });
});
