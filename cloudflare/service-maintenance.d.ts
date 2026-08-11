export interface ServiceMaintenanceState {
  enabled: boolean;
  revision: number;
  updatedAt: number | null;
  activatedAt: number | null;
  /** Edge traffic-gate propagation deadline; not a direct-storage write drain. */
  settlesAt: number | null;
  controlUnavailable?: boolean;
}

export const SERVICE_CONTROL_OBJECT_NAME: string;
export const SERVICE_CONTROL_STATUS_PATH: string;
export const SERVICE_CONTROL_STATE_PATH: string;
export const ADMIN_ANNOUNCEMENT_STATUS_PATH: string;
export const ADMIN_ANNOUNCEMENT_STATE_PATH: string;
export const ABUSE_RATE_CONSUME_PATH: string;
export const ABUSE_RATE_IDEMPOTENT_CONSUME_PATH: string;
export const ABUSE_RATE_PAIR_CONSUME_PATH: string;
export const SERVICE_CONTROL_READ_TIMEOUT_MS: number;

export interface AdminAnnouncementControlResult {
  status: 'ok' | 'conflict' | 'rejected' | 'unavailable' | 'unbound';
  payload: unknown;
  responseStatus?: number;
}

export function inactiveServiceMaintenanceState(): ServiceMaintenanceState;
export function normalizeServiceMaintenanceState(value: unknown): ServiceMaintenanceState | null;
export function readServiceMaintenance(
  env: Record<string, unknown>,
  options?: { fresh?: boolean },
): Promise<ServiceMaintenanceState>;
export function updateServiceMaintenance(
  env: Record<string, unknown>,
  input: { enabled: boolean; expectedRevision: number; requestId: string },
): Promise<{
  status: 'ok' | 'conflict' | 'unavailable';
  state: ServiceMaintenanceState;
}>;
export function readAdminAnnouncementControl(
  env: Record<string, unknown>,
  options?: { fresh?: boolean },
): Promise<AdminAnnouncementControlResult>;
export function updateAdminAnnouncementControl(
  env: Record<string, unknown>,
  input: {
    message: string;
    enabled: boolean;
    expiresAt: string | null;
    expectedRevision: number;
    requestId: string;
    baseHistory?: Array<Record<string, unknown>>;
  },
): Promise<AdminAnnouncementControlResult>;
export function consumeAbuseRateLimit(
  env: Record<string, unknown>,
  input: {
    scope: string;
    identity: string;
    limit: number;
    windowMs: number;
    cost?: number;
    operationId?: string;
  },
): Promise<
  | {
      status: 'ok';
      allowed: boolean;
      limit: number;
      remaining: number;
      resetAtMs: number;
      retryAfterSeconds: number;
    }
  | { status: 'unavailable' | 'unbound' }
>;
export function consumeAbuseRateLimitPair(
  env: Record<string, unknown>,
  input: {
    scope: string;
    identity: string;
    limit: number;
    windowMs: number;
    cost?: number;
    /**
     * Already-pseudonymous identity, 1-64 URL-safe characters. Its cost must
     * not exceed the primary cost so persisted pair-state accounting remains
     * canonically bounded by the primary counter.
     */
    secondary?: null | { identity: string; limit: number; cost?: number };
  },
): Promise<
  | {
      status: 'ok';
      allowed: boolean;
      deniedBy: 'primary' | 'secondary' | null;
      retryAfterSeconds: number;
      primary: {
        allowed: boolean;
        limit: number;
        remaining: number;
        resetAtMs: number;
        retryAfterSeconds: number;
      };
      secondary: {
        allowed: boolean;
        limit: number;
        remaining: number;
        resetAtMs: number;
        retryAfterSeconds: number;
      } | null;
    }
  | { status: 'unavailable' | 'unbound' }
>;
export function serviceMaintenanceResponse(
  request: Request,
  state?: Partial<ServiceMaintenanceState>,
  options?: { format?: 'auto' | 'html' | 'json' },
): Response;
export function gateServiceMaintenance(
  request: Request,
  env: Record<string, unknown>,
  options?: { fresh?: boolean; format?: 'auto' | 'html' | 'json' },
): Promise<Response | null>;
export function clearServiceMaintenanceCacheForTests(): void;
