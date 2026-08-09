export const APP_PUBLIC_BOUNDARY_TIMEOUT_MS: number;

export interface AnonymousAccountSessionBoundaryRead {
  status: number;
  cacheControl: string;
  setCookie: string | null;
  payload: {
    configured?: unknown;
    authenticated?: unknown;
    account?: unknown;
  };
}

export interface AnonymousAccountSessionBoundaryResult {
  configured: true;
  anonymousSessionRejected: true;
}

export function verifyAnonymousAccountSessionBoundary(options?: {
  read?: () => Promise<AnonymousAccountSessionBoundaryRead>;
}): Promise<AnonymousAccountSessionBoundaryResult>;

export interface ProductionCapabilityBoundaryRead {
  configStatus: number;
  config: { capabilityRequired?: unknown };
  paidStatus: number;
  paid: { error?: unknown };
}

export function verifyProductionCapabilityBoundary(options?: {
  read?: () => Promise<ProductionCapabilityBoundaryRead>;
}): Promise<{ capabilityRequired: true; anonymousPaidApiRejected: true }>;

export function main(): Promise<void>;
