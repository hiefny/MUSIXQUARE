/**
 * The App build the live smokes report (forced update, train 9.0.12).
 *
 * The Signaling Worker refuses a `host-auth` or `guest-auth` whose `appBuild`
 * is below the App build floor, and the PRO front door refuses an entry whose
 * `X-MXQR-App-Build` header is. Every release smoke therefore reports the
 * checked-out release's build (the service-worker cache epoch), which is never
 * below the live App and so never below the floor: a release after the floor
 * is turned on does not refuse its own smoke and roll itself back.
 *
 * The shape rule follows the Signaling Worker under test, never the App:
 * - candidate: `MXQR_EXPECTED_SIGNALING_VERSION` names this release's
 *   Signaling Worker, which accepts `appBuild`. A host-auth carrying the
 *   build must be admitted.
 * - unknown: any other run (the remote-share smoke before signaling deploys,
 *   an App-only release, the emergency App deploy, a manual run). A Worker
 *   older than the floor refuses the unknown key with
 *   `HOST_AUTH_FIRST_FRAME_INVALID`; such a Worker enforces no floor, so the
 *   host-auth is retried once in the legacy shape. A guest-auth always carries
 *   the build: the pre-floor guest validator ignores extra keys.
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

/** Close reason (and error message) of a Signaling Worker that refused the first host frame. */
export const LEGACY_HOST_AUTH_REFUSAL_REASON = 'HOST_AUTH_FIRST_FRAME_INVALID';

export type LiveSmokeSignalingMode = 'candidate' | 'unknown';

export interface LiveSmokeAppBuild {
  /** The checked-out release's build: the service-worker cache epoch. */
  readonly build: number;
  readonly signalingMode: LiveSmokeSignalingMode;
}

export interface ResolveLiveSmokeAppBuildOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readBuild?: () => number;
}

export function resolveLiveSmokeAppBuild({
  env = process.env,
  readBuild = () => readReleaseIdentity().serviceWorkerCacheEpoch,
}: ResolveLiveSmokeAppBuildOptions = {}): LiveSmokeAppBuild {
  const build = parseAppBuild(readBuild());
  if (build === null || build <= 0) {
    throw new Error('Live smokes need the positive App build of the checked-out release.');
  }
  return {
    build,
    signalingMode: env.MXQR_EXPECTED_SIGNALING_VERSION?.trim() ? 'candidate' : 'unknown',
  };
}

/** The PRO request header that reports `build`. */
export function appBuildRequestHeaders(build: number): Record<string, string> {
  return { [APP_BUILD_HEADER]: String(build) };
}

/** The auth frame with `appBuild`, or unchanged when the legacy shape is selected. */
export function withAppBuild<Frame extends JsonObject>(
  frame: Frame,
  appBuild: number | null,
): Frame {
  return appBuild === null ? frame : { ...frame, appBuild };
}

/** A pre-floor Signaling Worker refused a host-auth because it carried `appBuild`. */
export class LegacySignalingHostAuthError extends Error {
  constructor(label: string) {
    super(
      `${label} reached a signaling Worker without appBuild support (${LEGACY_HOST_AUTH_REFUSAL_REASON})`,
    );
    this.name = 'LegacySignalingHostAuthError';
  }
}

export type HostAdmission =
  | { readonly outcome: 'admitted'; readonly frame: JsonObject }
  | { readonly outcome: 'below-floor'; readonly minAppBuild: number }
  | { readonly outcome: 'legacy-refused' }
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
    frame.message === LEGACY_HOST_AUTH_REFUSAL_REASON
  ) {
    return { outcome: 'legacy-refused' };
  }
  const errorType = typeof frame.errorType === 'string' ? frame.errorType : 'unknown';
  const message = typeof frame.message === 'string' ? frame.message : 'unknown';
  return { outcome: 'refused', detail: `${String(frame.type)}/${errorType}/${message}` };
}

/**
 * The legacy-shape host (no `appBuild`, a 9.0.12 or older client) meets
 * either admission (floor off) or the exact floor refusal (floor on).
 */
export function requireLegacyShapeHostOutcome(
  frame: JsonObject,
  label: string,
): { readonly admitted: JsonObject } | { readonly minAppBuild: number } {
  const admission = classifyHostAdmission(frame);
  if (admission.outcome === 'admitted') return { admitted: admission.frame };
  if (admission.outcome === 'below-floor') return { minAppBuild: admission.minAppBuild };
  if (admission.outcome === 'legacy-refused') {
    throw new Error(`${label} was refused as invalid (${LEGACY_HOST_AUTH_REFUSAL_REASON})`);
  }
  throw new Error(`${label} was neither admitted nor refused below the floor: ${admission.detail}`);
}

export interface HostAuthBuildSelector {
  /** The `appBuild` for the next host-auth: the release build, or null once a legacy Worker was met. */
  frameBuild(): number | null;
  /** Runs `attempt`; for a Signaling Worker of unknown version, retries it once in the legacy shape. */
  run<Result>(attempt: (frameBuild: number | null) => Promise<Result>): Promise<Result>;
}

export function createHostAuthBuildSelector(
  appBuild: LiveSmokeAppBuild,
  { label, log = console.warn }: { readonly label: string; readonly log?: (line: string) => void },
): HostAuthBuildSelector {
  let legacyShape = false;
  const frameBuild = (): number | null => (legacyShape ? null : appBuild.build);
  return {
    frameBuild,
    async run(attempt) {
      const sent = frameBuild();
      try {
        return await attempt(sent);
      } catch (error) {
        if (
          !(error instanceof LegacySignalingHostAuthError) ||
          sent === null ||
          appBuild.signalingMode !== 'unknown'
        ) {
          throw error;
        }
        legacyShape = true;
        log(
          `[${label}] legacy signaling Worker (no floor): retrying host-auth once without appBuild`,
        );
        return attempt(null);
      }
    },
  };
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
