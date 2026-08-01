export function emergencyDeploymentMessage(target: string, commitSha: string): string;
export function emergencyDeploymentPlan(target: string, commitSha: string): string[][];
export function emergencyCompatibilityTarget(target: string): string | null;
export function parseEmergencyDeploymentArgs(args: string[]): string;
export function runEmergencyDeployment(options: {
  target: string;
  authorize?: (target: string, options?: object) => { target: string; commitSha: string };
  runner?: (command: string[]) => void;
  compatibilityCheck?: (
    releaseTarget: string,
    headSha: string,
    directory: string,
    options?: object,
  ) => unknown;
}): { target: string; commitSha: string; message: string; commands: string[][] };
export function emergencyNpmInvocation(
  platform?: string,
  options?: {
    nodeExecutable?: string;
    environment?: Record<string, string | undefined>;
    fileExists?: (path: string) => boolean;
  },
): {
  executable: string;
  prefixArgs: string[];
};
