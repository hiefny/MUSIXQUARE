import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    'globalThis.__mxqrOpenSmokeAuthority = openRoomUploadAssertionAuthorityAttempt;',
  );
const compiled = ts.transpileModule(instrumented, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);
const openAuthority = fixtureGlobal.__mxqrOpenSmokeAuthority as OpenAuthority;
delete fixtureGlobal.__mxqrSmokeSocket;
delete fixtureGlobal.__mxqrOpenSmokeAuthority;

function open() {
  return openAuthority('123456', { roomUploadAssertionVersion: 1 }, 'version', 'secret', true);
}

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
