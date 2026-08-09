import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../timers.ts';
import {
  cancelResponseBody,
  createIdleWatchdog,
  createLinkedAbortScope,
  raceWithAbortSignal,
  readBoundedJsonResponse,
  readBoundedResponseText,
  withRequestDeadline,
} from '../request-lifetime.ts';

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('request lifetime primitives', () => {
  it('keeps the deadline armed until the complete operation settles', async () => {
    vi.useFakeTimers();
    const operation = withRequestDeadline(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      { timeoutMs: 1000, timeoutReason: 'BODY_STALLED' },
    );

    const rejection = expect(operation).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'BODY_STALLED',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
  });

  it('settles at the deadline even when an operation ignores its abort signal', async () => {
    vi.useFakeTimers();
    const operation = withRequestDeadline(() => new Promise<void>(() => undefined), {
      timeoutMs: 1000,
      timeoutReason: 'NON_COOPERATIVE_OPERATION',
    });

    const rejection = expect(operation).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'NON_COOPERATIVE_OPERATION',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
  });

  it('observes and disposes a value that resolves after the abort race', async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    let resolveOperation!: (response: Response) => void;
    const operation = new Promise<Response>((resolve) => {
      resolveOperation = resolve;
    });
    const result = raceWithAbortSignal(operation, controller.signal, cancelResponseBody);
    const rejection = expect(result).rejects.toMatchObject({ message: 'caller stopped' });

    controller.abort(new Error('caller stopped'));
    await rejection;
    resolveOperation({ body: { cancel } } as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('survives page session timer cleanup and still releases the operation', async () => {
    vi.useFakeTimers();
    const operation = withRequestDeadline(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      { timeoutMs: 1000, timeoutReason: 'BODY_STALLED' },
    );
    const rejection = expect(operation).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'BODY_STALLED',
    });

    // This is what leaveSession() does for ordinary page-lifecycle timers.
    clearAllManagedTimers();
    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
  });

  it('links a caller abort and removes the managed deadline on cleanup', () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const scope = createLinkedAbortScope(caller.signal, 1000);
    caller.abort(new Error('caller stopped'));

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toMatchObject({ message: 'caller stopped' });
    scope.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires only after a full idle interval and touch resets that interval', async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const watchdog = createIdleWatchdog(onIdle, 1000);

    await vi.advanceTimersByTimeAsync(900);
    watchdog.touch();
    await vi.advanceTimersByTimeAsync(900);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watchdog.cleanup();
  });

  it('rejects a declared oversized control response before reading it', async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      headers: new Headers({ 'content-length': '65537' }),
      body: { cancel },
    } as unknown as Response;

    await expect(readBoundedResponseText(response, 65_536)).rejects.toMatchObject({
      name: 'ControlResponseTooLargeError',
      message: 'CONTROL_RESPONSE_TOO_LARGE',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not let non-cooperative cancellation delay an oversized response error', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = {
      headers: new Headers({ 'content-length': '65537' }),
      body: { cancel },
    } as unknown as Response;

    await expect(readBoundedResponseText(response, 65_536)).rejects.toMatchObject({
      name: 'ControlResponseTooLargeError',
      message: 'CONTROL_RESPONSE_TOO_LARGE',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an undeclared oversized control response while streaming', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
          controller.enqueue(new Uint8Array(6));
          controller.close();
        },
      }),
    );

    await expect(readBoundedResponseText(response, 10)).rejects.toMatchObject({
      name: 'ControlResponseTooLargeError',
      message: 'CONTROL_RESPONSE_TOO_LARGE',
    });
  });

  it('parses bounded JSON and cancels intentionally unread responses', async () => {
    await expect(readBoundedJsonResponse(Response.json({ ok: true }), 1024)).resolves.toEqual({
      ok: true,
    });

    const cancel = vi.fn(async () => undefined);
    await cancelResponseBody({ body: { cancel } } as unknown as Response);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed UTF-8 instead of normalizing credentials or protocol fields', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
          );
        },
        cancel,
      }),
    );

    await expect(readBoundedJsonResponse(response, 1024)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('settles an aborted read even when reader cancellation throws synchronously', async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => {
      throw new Error('cancel failed');
    });
    const response = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
          cancel,
          releaseLock: vi.fn(),
        }),
      },
    } as unknown as Response;

    const pending = readBoundedResponseText(response, 1024, controller.signal);
    controller.abort(new Error('caller stopped'));

    await expect(pending).rejects.toMatchObject({ message: 'caller stopped' });
    expect(cancel).toHaveBeenCalled();
  });

  it('returns immediately from cleanup when body cancellation never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));

    await expect(
      cancelResponseBody({ body: { cancel } } as unknown as Response),
    ).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
