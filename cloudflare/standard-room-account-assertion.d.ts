export const STANDARD_ROOM_ACCOUNT_ASSERTION_AUDIENCE: 'standard-room';
export const STANDARD_ROOM_ACCOUNT_DELETION_ASSERTION_AUDIENCE: 'standard-room-delete';

export type StandardRoomAssertionRole = 'host' | 'guest';

export interface StandardRoomAssertionInput {
  accountId: string;
  nickname: string;
  roomCode: string;
  peerId: string;
  role: StandardRoomAssertionRole;
}

export interface StandardRoomDeletionAssertionInput {
  accountId: string;
  roomCode: string;
  peerId: string;
  role: StandardRoomAssertionRole;
}

export interface StandardRoomAssertionOptions {
  roomCode?: string;
  peerId?: string;
  role?: StandardRoomAssertionRole;
  nowSeconds?: number;
}

export interface VerifiedStandardRoomAssertion {
  roomCode: string;
  accountSubject: string;
  nickname: string;
  peerId: string;
  role: StandardRoomAssertionRole;
  issuedAt: number;
  expiresAt: number;
}

export type VerifiedStandardRoomDeletionAssertion = Omit<VerifiedStandardRoomAssertion, 'nickname'>;

export function deriveStandardRoomAccountSubject(
  accountId: string,
  roomCode: string,
  secret: string,
): Promise<string | null>;
export function createStandardRoomAccountAssertion(
  input: StandardRoomAssertionInput,
  secret: string,
  nowSeconds?: number,
): Promise<string | null>;
export function createStandardRoomAccountDeletionAssertion(
  input: StandardRoomDeletionAssertionInput,
  secret: string,
  nowSeconds?: number,
): Promise<string | null>;
export function verifyStandardRoomAccountAssertion(
  token: string | null | undefined,
  secret: string,
  options?: StandardRoomAssertionOptions,
): Promise<VerifiedStandardRoomAssertion | null>;
export function verifyStandardRoomAccountDeletionAssertion(
  token: string | null | undefined,
  secret: string,
  options?: StandardRoomAssertionOptions,
): Promise<VerifiedStandardRoomDeletionAssertion | null>;
export function deriveStandardRoomMemberId(
  roomSecret: string,
  accountSubject: string | null,
): Promise<string | null>;
