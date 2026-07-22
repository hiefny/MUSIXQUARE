export interface DeveloperApiReadiness {
  service?: string;
  expectedVersion: string | null;
  actualVersion: string | null;
}

export function assertDeveloperApiOff(): Promise<void>;
export function assertDeveloperApiCanary(apiKey: string, roomCode?: string): Promise<void>;
export function waitForDeveloperApiReady(
  expectedVersion: string,
  dependencies?: {
    read?: () => Promise<{ service?: string; workerVersionId?: string }>;
    retryDelaysMs?: readonly number[];
    wait?: (milliseconds: number) => Promise<unknown>;
  },
): Promise<DeveloperApiReadiness>;
export function runDeveloperApiSmoke(options?: {
  env?: Record<string, string | undefined>;
  stdout?: { write(value: string): unknown };
}): Promise<void>;
