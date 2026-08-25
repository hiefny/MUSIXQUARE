import type { Connect } from 'vite';

type AsyncConnectMiddleware = (...args: Parameters<Connect.NextHandleFunction>) => Promise<void>;

/** Register an async handler behind Connect's synchronous callback boundary. */
export function useAsyncConnectMiddleware(
  middlewares: Connect.Server,
  handler: AsyncConnectMiddleware,
): void {
  middlewares.use((request, response, next) => {
    handler(request, response, next).catch(next);
  });
}
