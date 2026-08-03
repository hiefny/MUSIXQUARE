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
export const SERVICE_CONTROL_READ_TIMEOUT_MS: number;

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
