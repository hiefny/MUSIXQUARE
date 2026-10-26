/**
 * The App build the live smokes report (forced update, train 9.0.14).
 *
 * The Signaling Worker refuses a `host-auth` or `guest-auth` whose `appBuild`
 * is below the App build floor, and the PRO front door refuses an entry whose
 * `X-MXQR-App-Build` header is. Every release smoke therefore reports the
 * checked-out release's build (the service-worker cache epoch), which is never
 * below the live App and so never below the floor: a release after the floor
 * is turned on does not refuse its own smoke and roll itself back.
 *
 * Every host-auth also carries the desired PIN ('' for none) and its mutation
 * ID, which the Signaling Worker requires (old-version removal W-3; every App
 * since 8.4.17 sends both). A host-auth the Worker cannot parse is refused
 * with `HOST_AUTH_FIRST_FRAME_INVALID`: the smoke's own frame is wrong, so it
 * fails at once with that reason and is never waited out as a stale edge.
 * Rolling the Signaling Worker back below 9.0.14 while such an App is live is
 * outside the procedure, so no smoke falls back to a frame without the build.
 */

import {
  APP_BUILD_HEADER,
  APP_UPDATE_REQUIRED_CODE,
  APP_UPDATE_REQUIRED_ERROR_TYPE,
  parseAppBuild,
} from '../cloudflare/app-build-floor-contract.ts';
import { parseServiceWorkerCacheEpoch, readReleaseIdentity } from './release-identity.mts';

type JsonObject = Record<string, unknown>;

const LIVE_APP_SERVICE_WORKER_URL = 'https://musixquare.com/service-worker.js';
const LIVE_APP_SERVICE_WORKER_MAX_BYTES = 1024 * 1024;
const LIVE_APP_REQUEST_TIMEOUT_MS = 10_000;

/** The close reason (and error message) for a first host frame the Worker cannot parse. */
const HOST_AUTH_FIRST_FRAME_INVALID = 'HOST_AUTH_FIRST_FRAME_INVALID';

export interface LiveSmokeAppBuild {
  /** The checked-out release's build: the service-worker cache epoch. */
  readonly build: number;
}

export interface ResolveLiveSmokeAppBuildOptions {
  readonly readBuild?: () => number;
}

export function resolveLiveSmokeAppBuild({
  readBuild = () => readReleaseIdentity().serviceWorkerCacheEpoch,
}: ResolveLiveSmokeAppBuildOptions = {}): LiveSmokeAppBuild {
  const build = parseAppBuild(readBuild());
  if (build === null || build <= 0) {
    throw new Error('Live smokes need the positive App build of the checked-out release.');
  }
  return { build };
}

/** The PRO request header that reports `build`. */
export function appBuildRequestHeaders(build: number): Record<string, string> {
  return { [APP_BUILD_HEADER]: String(build) };
}

/** The auth frame with `appBuild`. */
export function withAppBuild<Frame extends JsonObject>(frame: Frame, appBuild: number): Frame {
  return { ...frame, appBuild };
}

/** The failure of a host-auth the Signaling Worker refused as an invalid first frame. */
export function invalidHostAuthFrameError(label: string): Error {
  return new Error(
    `${label}: host-auth refused as an invalid first frame (${HOST_AUTH_FIRST_FRAME_INVALID})`,
  );
}

export type HostAdmission =
  | { readonly outcome: 'admitted'; readonly frame: JsonObject }
  | { readonly outcome: 'below-floor'; readonly minAppBuild: number }
  | { readonly outcome: 'invalid-frame' }
  | { readonly outcome: 'refused'; readonly detail: string };

function isExactFloorRefusal(frame: JsonObject): number | null {
  const keys = Object.keys(frame).sort();
  if (
    keys.length !== 4 ||
    keys.join(',') !== 'errorType,message,minAppBuild,type' ||
    frame.type !== 'error' ||
    frame.errorType !== APP_UPDATE_REQUIRED_ERROR_TYPE ||
    frame.message !== APP_UPDATE_REQUIRED_CODE ||
    typeof frame.minAppBuild !== 'number'
  ) {
    return null;
  }
  const minAppBuild = parseAppBuild(frame.minAppBuild);
  return minAppBuild !== null && minAppBuild > 0 ? minAppBuild : null;
}

/** Reads the first frame a pending host gets back: `peer-open` or an `error`. */
export function classifyHostAdmission(frame: JsonObject): HostAdmission {
  if (frame.type === 'peer-open') return { outcome: 'admitted', frame };
  const minAppBuild = isExactFloorRefusal(frame);
  if (minAppBuild !== null) return { outcome: 'below-floor', minAppBuild };
  if (
    frame.type === 'error' &&
    frame.errorType === 'invalid-id' &&
    frame.message === HOST_AUTH_FIRST_FRAME_INVALID
  ) {
    return { outcome: 'invalid-frame' };
  }
  const errorType = typeof frame.errorType === 'string' ? frame.errorType : 'unknown';
  const message = typeof frame.message === 'string' ? frame.message : 'unknown';
  return { outcome: 'refused', detail: `${String(frame.type)}/${errorType}/${message}` };
}

/**
 * The legacy-shape host (no `appBuild`, a 9.0.13 or older client, with the PIN
 * fields every App since 8.4.17 sends) meets either admission (floor off) or
 * the exact floor refusal (floor on).
 */
export function requireLegacyShapeHostOutcome(
  frame: JsonObject,
  label: string,
): { readonly admitted: JsonObject } | { readonly minAppBuild: number } {
  const admission = classifyHostAdmission(frame);
  if (admission.outcome === 'admitted') return { admitted: admission.frame };
  if (admission.outcome === 'below-floor') return { minAppBuild: admission.minAppBuild };
  if (admission.outcome === 'invalid-frame') throw invalidHostAuthFrameError(label);
  throw new Error(`${label} was neither admitted nor refused below the floor: ${admission.detail}`);
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength > maxBytes ? null : new TextDecoder().decode(bytes);
}

/**
 * The App build the live App serves: the one canonical `CACHE_VERSION` line
 * of its `/service-worker.js`, the same asset the App Worker reports from.
 * Null when it cannot be read or is not exactly one positive build.
 */
export async function readServiceWorkerAppBuild(
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<number | null> {
  try {
    const response = await fetcher(LIVE_APP_SERVICE_WORKER_URL, {
      cache: 'no-store',
      headers: { Accept: 'text/javascript, */*' },
      signal: AbortSignal.timeout(LIVE_APP_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const source = await readBoundedText(response, LIVE_APP_SERVICE_WORKER_MAX_BYTES);
    return source === null ? null : parseServiceWorkerCacheEpoch(source);
  } catch {
    return null;
  }
}
