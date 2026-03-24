/**
 * Playwright Global Setup — Start local PeerJS signaling server
 *
 * Uses the `peer` package's PeerServer which auto-starts on the given port.
 */
import { createRequire } from 'module';
import { createConnection } from 'net';

const require = createRequire(import.meta.url);

const PEER_PORT = 9000;

/** Check if something is already listening on host:port */
function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

async function globalSetup() {
  // If port 9000 is already in use, assume an external PeerJS server is running
  if (await isPortInUse(PEER_PORT, '127.0.0.1')) {
    console.log(`[E2E] Port ${PEER_PORT} already in use — reusing existing PeerJS server`);
    (globalThis as Record<string, unknown>).__PEER_APP__ = null;
    return;
  }

  const { PeerServer } = require('peer');

  const peerApp = PeerServer({ port: PEER_PORT, host: '127.0.0.1', path: '/' });

  // Wait for server to bind
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  // Store ref for teardown
  (globalThis as Record<string, unknown>).__PEER_APP__ = peerApp;

  console.log(`[E2E] PeerJS signaling server started on port ${PEER_PORT}`);
}

export default globalSetup;
