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
