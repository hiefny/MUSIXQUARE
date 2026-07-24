export const ACCOUNT_ASSERTION_HEADER: 'X-MXQR-Account-Assertion';
export const ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM: 'pro-room';

export interface AccountAssertionInput {
  accountId: string;
  nickname: string;
  roomCode: string;
  roomGeneration?: number;
  audience: typeof ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM;
}

export interface VerifiedAccountAssertion extends AccountAssertionInput {
  roomGeneration: number;
  issuedAt: number;
  expiresAt: number;
}

export function createAccountAssertion(
  input: AccountAssertionInput,
  secret: string,
  nowSeconds?: number,
): Promise<string | null>;

export function verifyAccountAssertion(
  token: string | null | undefined,
  secret: string,
  options?: {
    audience?: string;
    roomCode?: string;
    roomGeneration?: number;
    nowSeconds?: number;
  },
): Promise<VerifiedAccountAssertion | null>;
