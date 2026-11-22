import { beforeEach, describe, expect, it, vi } from 'vitest';

// The helper probes random high ports with node:net. These rows replace the
// random pick and the listener with a queue of ports and the listen error each
// one gets, so a port the system holds can be reproduced on any host.
const mocks = vi.hoisted(() => {
  const state = {
    ports: [] as number[],
    failures: new Map<number, string>(),
    listened: [] as number[],
    closed: 0,
  };
  function createServer() {
    let onError: ((error: Error) => void) | null = null;
    const server = {
      once(event: string, handler: (error: Error) => void) {
        if (event === 'error') onError = handler;
        return server;
      },
      removeListener(event: string, handler: unknown) {
        if (event === 'error' && onError === handler) onError = null;
        return server;
      },
      listen(options: { port: number }, callback: () => void) {
        state.listened.push(options.port);
        const code = state.failures.get(options.port);
        queueMicrotask(() => {
          if (code)
            onError?.(
              Object.assign(new Error(`listen ${code}: 127.0.0.1:${options.port}`), { code }),
            );
          else callback();
        });
        return server;
      },
      close(callback: (error?: Error) => void) {
        state.closed += 1;
        queueMicrotask(() => callback());
        return server;
      },
    };
    return server;
  }
  function randomInt() {
    const next = state.ports.shift();
    if (next === undefined) throw new Error('no port queued');
    return next;
  }
  return { state, createServer, randomInt };
});

vi.mock('node:net', () => ({ createServer: mocks.createServer }));
vi.mock('node:crypto', () => ({ randomInt: mocks.randomInt }));

import { localWorkerdPort } from './helpers/local-workerd-port.ts';

function queue(ports: number[], failures: Record<number, string> = {}): void {
  mocks.state.ports = [...ports];
  mocks.state.failures = new Map(
    Object.entries(failures).map(([port, code]) => [Number(port), code]),
  );
}

describe('localWorkerdPort', () => {
  beforeEach(() => {
    mocks.state.listened = [];
    mocks.state.closed = 0;
  });

  it('skips a port the system holds for itself (EACCES) and returns the next free one', async () => {
    queue([49_665, 52_000], { 49_665: 'EACCES' });
    await expect(localWorkerdPort()).resolves.toBe(52_000);
    expect(mocks.state.listened).toEqual([49_665, 52_000]);
    expect(mocks.state.closed).toBe(1);
  });

  it('still skips a port that is already bound (EADDRINUSE)', async () => {
    queue([50_001, 50_002], { 50_001: 'EADDRINUSE' });
    await expect(localWorkerdPort()).resolves.toBe(50_002);
    expect(mocks.state.listened).toEqual([50_001, 50_002]);
  });

  it('throws any other listen error at once', async () => {
    queue([50_010, 50_011], { 50_010: 'EPERM' });
    await expect(localWorkerdPort()).rejects.toMatchObject({ code: 'EPERM' });
    expect(mocks.state.listened).toEqual([50_010]);
  });

  it('gives up after 16 ports that cannot be bound', async () => {
    const ports = Array.from({ length: 16 }, (_, index) => 49_664 + index);
    queue(
      ports,
      Object.fromEntries(ports.map((port, index) => [port, index % 2 ? 'EACCES' : 'EADDRINUSE'])),
    );
    await expect(localWorkerdPort()).rejects.toThrow(
      'Could not allocate a free local workerd port after 16 attempts',
    );
    expect(mocks.state.listened).toHaveLength(16);
    expect(mocks.state.closed).toBe(0);
  });
});
