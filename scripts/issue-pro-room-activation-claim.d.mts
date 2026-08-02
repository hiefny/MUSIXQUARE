export type ProvisionedProRoomCode = '000000';
export type ProRoomClaimMode = 'activation' | 'recovery';

export class ProRoomClaimCliError extends Error {}

export function parseProRoomClaimRoomCode(argv: string[]): ProvisionedProRoomCode;

export function parseProRoomClaimRequest(argv: string[]): {
  mode: ProRoomClaimMode;
  roomCode: ProvisionedProRoomCode;
};

export function formatProRoomActivationFragment(claimToken: string): string;

export function formatProRoomOwnerRecoveryFragment(claimToken: string): string;

export interface ProRoomActivationClaimCliOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  stdout?: { write(value: string): unknown };
  issueClaim?: (roomCode: ProvisionedProRoomCode, secret: string) => Promise<string>;
  issueRecoveryClaim?: (roomCode: ProvisionedProRoomCode, secret: string) => Promise<string>;
}

export function runProRoomActivationClaimCli(
  options?: ProRoomActivationClaimCliOptions,
): Promise<string>;
