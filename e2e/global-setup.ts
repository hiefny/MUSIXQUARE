/**
 * Playwright Global Setup — Start local PeerJS signaling server
 *
 * Uses the `peer` package's PeerServer which auto-starts on the given port.
 */
import { createRequire } from 'module';
import { createConnection } from 'net';
import { E2E_PEER_PORT } from './config.ts';

const require = createRequire(import.meta.url);

const PEER_READY_TIMEOUT_MS = 5_000;

/** Check if something is already listening on host:port */
function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(listening);
    };
    sock.setTimeout(250);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

async function waitForPort(port: number, host: string): Promise<void> {
  const deadline = Date.now() + PEER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isPortInUse(port, host)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `PeerJS server did not listen on ${host}:${port} within ${PEER_READY_TIMEOUT_MS}ms`,
  );
}

async function globalSetup() {
  if (await isPortInUse(E2E_PEER_PORT, '127.0.0.1')) {
    throw new Error(
      `[E2E] Dedicated PeerJS port ${E2E_PEER_PORT} is already in use; refusing to reuse an unverified listener`,
    );
  }

  const { PeerServer } = require('peer');

  const peerApp = PeerServer({ port: E2E_PEER_PORT, host: '127.0.0.1', path: '/' });

  await waitForPort(E2E_PEER_PORT, '127.0.0.1');

  (globalThis as Record<string, unknown>).__PEER_APP__ = peerApp;

  console.log(`[E2E] PeerJS signaling server started on port ${E2E_PEER_PORT}`);
}

export default globalSetup;
