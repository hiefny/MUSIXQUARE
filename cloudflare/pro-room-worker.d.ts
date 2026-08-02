export interface ProRoomActivationClaimOptions {
  nowMs?: number;
  expiresAtMs?: number;
  generation?: number;
  roomGeneration?: number;
  nonce?: string;
}

export interface ProRoomOwnerRecoveryClaimOptions {
  nowMs?: number;
  expiresAtMs?: number;
  roomGeneration?: number;
  nonce?: string;
  ownerAuthorityEpoch?: number;
}

export interface ProRoomOwnerTransferClaimOptions {
  nowMs?: number;
  expiresAtMs?: number;
  roomGeneration?: number;
  nonce?: string;
  targetAccountId: string;
  claimGeneration: number;
  ownerAuthorityEpoch: number;
}

export function issueProRoomActivationClaim(
  roomCode: string,
  secret: string,
  options?: ProRoomActivationClaimOptions,
): Promise<string>;

export function issueProRoomOwnerRecoveryClaim(
  roomCode: string,
  secret: string,
  options?: ProRoomOwnerRecoveryClaimOptions,
): Promise<string>;

export function issueProRoomOwnerTransferClaim(
  roomCode: string,
  secret: string,
  options: ProRoomOwnerTransferClaimOptions,
): Promise<string>;

export class MusixquareProRoom {
  constructor(state: unknown, env: unknown);

  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

export class MusixquareServiceControl {
  constructor(state: unknown);

  fetch(request: Request): Promise<Response>;
}

declare const proRoomWorker: {
  fetch(request: Request, env: unknown): Promise<Response>;
};

export default proRoomWorker;
