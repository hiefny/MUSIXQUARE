import { createServer as createHttpServer } from 'node:http';

import { createServer as createViteServer, type InlineConfig } from 'vite';

export interface ViteMiddlewareTestServer {
  readonly origin: string;
  close(): Promise<void>;
}

function closeHttpServer(http: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    http.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

export async function startViteMiddlewareTestServer(
  config: InlineConfig,
  label: string,
): Promise<ViteMiddlewareTestServer> {
  const vite = await createViteServer({
    ...config,
    server: {
      ...config.server,
      hmr: false,
      middlewareMode: true,
      preTransformRequests: false,
      ws: false,
    },
  });
  const http = createHttpServer(vite.middlewares);

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error);
      http.once('error', onError);
      http.listen(0, '127.0.0.1', () => {
        http.off('error', onError);
        resolveListen();
      });
    });
    const address = http.address();
    if (!address || typeof address === 'string') {
      throw new Error(`${label} test server did not bind a TCP port.`);
    }

    let closed = false;
    return {
      origin: `http://127.0.0.1:${address.port}`,
      async close() {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        try {
          await closeHttpServer(http);
        } catch (error) {
          failures.push(error);
        }
        try {
          await vite.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, `${label} test server did not close cleanly.`);
        }
      },
    };
  } catch (error) {
    const cleanup = http.listening ? closeHttpServer(http) : Promise.resolve();
    await Promise.allSettled([cleanup, vite.close()]);
    throw error;
  }
}
