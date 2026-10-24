/**
 * Ports and origins of the Cloudflare two-context lab (playwright.lab.config.ts).
 * They differ from the default E2E ports so a lab run can share the machine
 * with the PeerJS suite.
 */
function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export const LAB_HOST = '127.0.0.1';
export const LAB_APP_PORT = readPort('MXQR_LAB_APP_PORT', 4383);
export const LAB_SIGNALING_PORT = readPort('MXQR_LAB_SIGNALING_PORT', 8873);
export const LAB_INSPECTOR_PORT = readPort('MXQR_LAB_INSPECTOR_PORT', 9373);

export const LAB_APP_ORIGIN = `http://${LAB_HOST}:${LAB_APP_PORT}`;
export const LAB_SIGNALING_ORIGIN = `http://${LAB_HOST}:${LAB_SIGNALING_PORT}`;
export const LAB_SIGNALING_URL = `ws://${LAB_HOST}:${LAB_SIGNALING_PORT}/api/rooms`;

// The lab reads the E2E-only state hooks, so it always serves a fresh E2E build
// of the working tree rather than whatever dist/ an earlier command left.
export const LAB_PREVIEW_COMMAND =
  'npm run build:e2e && ' +
  `npm run preview -- --mode e2e --host ${LAB_HOST} --port ${LAB_APP_PORT} --strictPort`;
