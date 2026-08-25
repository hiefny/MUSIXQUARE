import type { Connect } from 'vite';
import { describe, expect, it, vi } from 'vitest';

import { useAsyncConnectMiddleware } from '../../../scripts/async-connect-middleware.ts';

describe('async Connect middleware ownership', () => {
  it('registers a synchronous callback and forwards rejection to next', async () => {
    const use = vi.fn();
    const middlewares = { use } as unknown as Connect.Server;
    const failure = new Error('middleware failed');

    useAsyncConnectMiddleware(middlewares, async () => {
      throw failure;
    });

    const handler = use.mock.calls[0]?.[0] as Connect.NextHandleFunction | undefined;
    expect(handler).toBeTypeOf('function');
    const next = vi.fn();
    const result = handler?.({} as never, {} as never, next);

    expect(result).toBeUndefined();
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalledWith(failure);
    });
  });
});
