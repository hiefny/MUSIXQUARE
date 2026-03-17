/**
 * Playwright Global Setup — Start local PeerJS signaling server
 *
 * Uses the `peer` package's PeerServer which auto-starts on the given port.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const PEER_PORT = 9000;

async function globalSetup() {
  const { PeerServer } = require('peer');

  // PeerServer with port option auto-starts listening
  const peerApp = PeerServer({ port: PEER_PORT, host: '127.0.0.1', path: '/' });

  // Wait for server to bind
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  // Store ref for teardown
  (globalThis as Record<string, unknown>).__PEER_APP__ = peerApp;

  console.log(`[E2E] PeerJS signaling server started on port ${PEER_PORT}`);
}

export default globalSetup;
