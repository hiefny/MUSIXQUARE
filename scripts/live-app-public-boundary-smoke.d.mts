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

export function main(): Promise<void>;
