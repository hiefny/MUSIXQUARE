export const NAVIGATION_OUTAGE_QUERY_PARAMETER = '__mxqr_e2e_navigation_outage';
export const NAVIGATION_OUTAGE_CONTROL_HEADER = 'x-mxqr-e2e-control';
export const NAVIGATION_OUTAGE_CONTROL_VALUE = 'navigation-outage-status-v1';
export const NAVIGATION_OUTAGE_ARM_PATH = '/__mxqr_e2e__/navigation-outage-arm';
export const NAVIGATION_OUTAGE_RELEASE_PATH = '/__mxqr_e2e__/navigation-outage-release';
export const NAVIGATION_OUTAGE_STATUS_PATH = '/__mxqr_e2e__/navigation-outage-status';

export interface NavigationOutageStatus {
  activeResponseCount: number;
  observedToken: boolean;
  outageAttempts: number;
  stalledForMs: number;
  uniqueTokenCount: number;
}

export interface NavigationOutageRelease {
  released: boolean;
}

export interface NavigationOutageArm {
  armed: boolean;
}

export function isNavigationOutageToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
