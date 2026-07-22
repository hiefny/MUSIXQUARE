export const ACCOUNT_ASSERTION_HEADER: 'X-MXQR-Account-Assertion';
export const ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM: 'pro-room';

export interface AccountAssertionInput {
  accountId: string;
  nickname: string;
  roomCode: string;
  audience: typeof ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM;
}

export interface VerifiedAccountAssertion extends AccountAssertionInput {
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
  options?: { audience?: string; roomCode?: string; nowSeconds?: number },
): Promise<VerifiedAccountAssertion | null>;
