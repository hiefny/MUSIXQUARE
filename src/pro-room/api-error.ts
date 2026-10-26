// The PRO room API error and its session-end reason. They are kept apart from
// the API client (api.ts) because the PRO entry flow in setup-flow.ts raises
// and classifies these errors from the startup graph, while the client, its
// wire parsers and the snapshot validators stay in the lazy PRO runtime.

/**
 * Why the room owner, an administrator, or a sibling device ended this
 * browser's session. The server adds it only to its ordinary terminal
 * `SESSION_REQUIRED` 401, so older Apps keep treating the response as terminal.
 */
export type ProRoomSessionEndReason = 'PIN_ENABLED' | 'PIN_CHANGED' | 'REMOVED' | 'DEVICE_REMOVED';

export class ProRoomApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly sessionEndReason: ProRoomSessionEndReason | null;
  /**
   * The App build floor of an entry refused below it (426
   * `APP_UPDATE_REQUIRED`, forced update train 9.0.14); null otherwise.
   */
  readonly minAppBuild: number | null;

  constructor(
    code: string,
    status = 0,
    retryAfterSeconds: number | null = null,
    sessionEndReason: ProRoomSessionEndReason | null = null,
    minAppBuild: number | null = null,
  ) {
    super(`PRO_ROOM_API_${code}`);
    this.name = 'ProRoomApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.sessionEndReason = sessionEndReason;
    this.minAppBuild = minAppBuild;
  }
}
