/**
 * Playwright Global Teardown — Stop local PeerJS signaling server
 */

async function globalTeardown() {
  // PeerServer process cleanup is handled by Playwright's process exit.
  // Attempt graceful close if the underlying http server is accessible.
  try {
    const peerApp = (globalThis as Record<string, unknown>).__PEER_APP__;
    if (peerApp && typeof peerApp === 'object') {
      const app = peerApp as Record<string, unknown>;
      // PeerServer stores the http server internally
      const httpServer = app._server || app.server;
      if (httpServer && typeof (httpServer as Record<string, unknown>).close === 'function') {
        await new Promise<void>((resolve) => {
          (httpServer as { close: (cb: () => void) => void }).close(() => resolve());
        });
      }
    }
  } catch {
    // Ignore — Playwright will kill the process anyway
  }
  console.log('[E2E] PeerJS server cleanup complete');
}

export default globalTeardown;
