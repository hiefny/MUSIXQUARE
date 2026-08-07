export class ProGrantCampaignCliError extends Error {}

export type ProGrantCampaignCreateCommand = {
  command: 'create';
  slug: string;
  title: string;
  roomCodes: string[];
  startsAt: number | null;
  endsAt: number | null;
  perAccountLimit: number;
  artifact: string | null;
  origin: string;
  apply: boolean;
};

export type ProGrantCampaignStatusCommand = {
  command: 'status';
  slug: string;
  origin: string;
};

export type ProGrantCampaignRevokeCommand = {
  command: 'revoke';
  slug: string;
  reason: string;
  origin: string;
  apply: boolean;
};

export type ProGrantCampaignApplyCommand = {
  command: 'apply';
  artifact: string;
  origin: string;
};

export function expandProGrantRoomSelection(value: string): string[];
export function parseProGrantCampaignCommand(
  argv: string[],
):
  | ProGrantCampaignCreateCommand
  | ProGrantCampaignStatusCommand
  | ProGrantCampaignRevokeCommand
  | ProGrantCampaignApplyCommand;

export function createProGrantBatchRequestId(
  randomBytes?: (size: number) => { toString(encoding: 'base64url'): string },
): string;

export function generateProGrantVoucherCode(randomBytes?: (size: number) => Uint8Array): string;

export function reserveProGrantArtifact(
  root: string,
  requestedPath: string | null,
  slug: string,
  requestId: string,
): {
  path: string;
  write(payload: unknown): void;
  discard(): void;
};

export function readProGrantArtifact(
  root: string,
  requestedPath: string,
): { path: string; payload: any };

export function classifyProGrantRoomInventory(
  payload: { rooms: unknown[] },
  requestedRoomCodes: string[],
): {
  ready: Array<{ roomCode: string; roomGeneration: number }>;
  needsProvisioning: Array<{
    roomCode: string;
    roomGeneration?: number;
    reason: 'missing' | 'provisioning';
  }>;
  unavailable: Array<{
    roomCode: string;
    roomGeneration: number;
    status: string;
    activationState: string;
  }>;
};

export function createProGrantRoomLabel(slug: string, roomCode: string): string;

export function createProGrantAdminClient(options: {
  origin: string;
  env: Record<string, string | undefined>;
  fetcher?: typeof fetch;
}): {
  request(
    path: string,
    options?: { method?: string; body?: unknown; sensitive?: boolean },
  ): Promise<unknown>;
};

export function runProGrantCampaignCli(options?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  stdout?: { write(value: string): unknown };
  root?: string;
  fetcher?: typeof fetch;
  randomBytes?: (size: number) => { toString(encoding: 'base64url'): string };
  now?: () => number;
  client?: { request(path: string, options?: Record<string, unknown>): Promise<any> };
  reserveArtifact?: typeof reserveProGrantArtifact;
}): Promise<any>;
