export type {
  ProRoomActivationClaimOptions,
  ProRoomOwnerRecoveryClaimOptions,
  ProRoomOwnerTransferClaimOptions,
} from './pro-room-claims.js';

export declare const issueProRoomActivationClaim: typeof import('./pro-room-claims.js').issueProRoomActivationClaim;
export declare const issueProRoomOwnerRecoveryClaim: typeof import('./pro-room-claims.js').issueProRoomOwnerRecoveryClaim;
export declare const issueProRoomOwnerTransferClaim: typeof import('./pro-room-claims.js').issueProRoomOwnerTransferClaim;

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
