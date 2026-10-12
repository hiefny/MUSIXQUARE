import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';

/**
 * Some Windows hosts allocate ephemeral ports from 1024–15000, which includes
 * ports rejected by Node fetch (for example 6000/6667/10080). Miniflare's
 * synchronous binding bridge uses fetch, so probe a free high port explicitly.
 * This only retries listener allocation; application requests are never retried.
 */
export async function localWorkerdPort(): Promise<number> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const port = randomInt(49_152, 65_536);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return port;
  }
  throw new Error('Could not allocate a free local workerd port after 16 attempts');
}
