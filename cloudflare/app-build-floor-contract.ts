/**
 * App build floor wire contract (forced update, train 9.0.12).
 *
 * The build number is the integer of the service-worker cache epoch (`v785`
 * is build 785). A client reports it when it enters a room; the Signaling and
 * PRO Workers refuse a new entry whose build is below the effective floor that
 * the global service-control object holds. Established sessions are never
 * re-checked.
 *
 * This leaf has no imports, so the Workers, the browser client, the release
 * scripts and the live smokes share one copy of every name and value here.
 */

/** Request header that carries the client's build on PRO API requests. */
export const APP_BUILD_HEADER = 'X-MXQR-App-Build';

/**
 * Error code of a refusal below the floor: the PRO JSON `error`, and the
 * Signaling error frame's `message` and close reason.
 */
export const APP_UPDATE_REQUIRED_CODE = 'APP_UPDATE_REQUIRED';

/** `errorType` of the Signaling error frame sent only to a refused socket. */
export const APP_UPDATE_REQUIRED_ERROR_TYPE = 'app-update-required';

/** Largest build any client, setter or live report may carry. */
export const APP_BUILD_MAX = 2_147_483_647;

/**
 * Freshness window of the live-App report (timing home of the floor record).
 * The App Worker reports the build its own assets serve every minute; an older
 * report turns the effective floor off, so the floor can never stay above an
 * App that a rollback, an emergency deploy or a dashboard action made live.
 */
export const APP_BUILD_FLOOR_REPORT_STALE_MS = 300_000;

const APP_BUILD_TEXT_RE = /^(?:0|[1-9]\d{0,9})$/u;

/**
 * Parses a build from a JSON number or from canonical decimal header text.
 * Anything else, including a build outside 0..APP_BUILD_MAX, is `null`.
 */
export function parseAppBuild(value: unknown): number | null {
  const candidate =
    typeof value === 'string' && APP_BUILD_TEXT_RE.test(value) ? Number(value) : value;
  if (
    typeof candidate !== 'number' ||
    !Number.isSafeInteger(candidate) ||
    candidate < 0 ||
    candidate > APP_BUILD_MAX
  ) {
    return null;
  }
  return candidate + 0;
}

/**
 * The `appBuild` key of a Signaling `host-auth` or `guest-auth` frame: absent
 * (an older client, counted as build 0) or a JSON number build. Header text is
 * the PRO form only, so a string here is malformed like any other bad field.
 */
export function isOptionalAppBuild(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && parseAppBuild(value) !== null);
}

export interface AppBuildFloorInputs {
  readonly minAppBuild: number;
  readonly liveAppBuild: number | null;
  readonly liveReportedAt: number | null;
}

/**
 * The floor the gates enforce: the lower of the stored floor and the live App
 * build while the live report is fresh, otherwise 0 (off). A report from the
 * future is not fresh either, so a clock step back fails open.
 */
export function effectiveAppBuildFloor(state: AppBuildFloorInputs, nowMs: number): number {
  const { minAppBuild, liveAppBuild, liveReportedAt } = state;
  if (minAppBuild <= 0 || liveAppBuild === null || liveReportedAt === null) return 0;
  const reportAgeMs = nowMs - liveReportedAt;
  if (reportAgeMs < 0 || reportAgeMs > APP_BUILD_FLOOR_REPORT_STALE_MS) return 0;
  return Math.min(minAppBuild, liveAppBuild);
}
