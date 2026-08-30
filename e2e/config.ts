const DEFAULT_APP_PORT = 4183;
const DEFAULT_PEER_PORT = 9010;

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export const E2E_APP_HOST = '127.0.0.1';
export const E2E_APP_PORT = readPort('MXQR_E2E_APP_PORT', DEFAULT_APP_PORT);
export const E2E_APP_ORIGIN = `http://${E2E_APP_HOST}:${E2E_APP_PORT}`;
export const E2E_PEER_PORT = readPort('MXQR_E2E_PEER_PORT', DEFAULT_PEER_PORT);

export const E2E_PREVIEW_COMMAND =
  `npm run preview -- --mode e2e --host ${E2E_APP_HOST} ` + `--port ${E2E_APP_PORT} --strictPort`;

// Serves the already-built production candidate without rebuilding it or
// injecting the E2E-only browser hooks into the artifact under test.
export const E2E_PRODUCTION_PREVIEW_COMMAND =
  `npm run preview -- --mode production --host ${E2E_APP_HOST} ` +
  `--port ${E2E_APP_PORT} --strictPort`;

// WebKit's offline emulation rejects navigations before Service Worker
// dispatch. This preview can stall only a uniquely tagged HTML navigation so
// the real worker timeout/fallback remains testable without mutating the app.
export const E2E_CONTROLLED_PRODUCTION_PREVIEW_COMMAND =
  'node e2e/controlled-production-preview.ts';
