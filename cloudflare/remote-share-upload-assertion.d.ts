export const REMOTE_SHARE_UPLOAD_ASSERTION_VERSION: 1;
export const REMOTE_SHARE_UPLOAD_ASSERTION_AUDIENCE: 'musixquare-remote-share-upload';
export const REMOTE_SHARE_UPLOAD_ASSERTION_SCOPE: 'remote-share.upload';
export const REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS: 60;

export interface RemoteShareUploadAssertionInput {
  roomId: string;
  hostPeerId: string;
  sessionId: number;
  queueItemId: string;
  size: number;
  actorId: string;
  requestId: string;
  bodySha256: string;
}

export interface RemoteShareUploadAssertionResult {
  assertion: string;
  expiresAt: number;
}

export interface RemoteShareUploadAssertionOptions {
  roomId?: string;
  sessionId?: number;
  queueItemId?: string;
  size?: number;
  actorId?: string;
  requestId?: string;
  bodySha256?: string;
  nowSeconds?: number;
}

export interface VerifiedRemoteShareUploadAssertion extends RemoteShareUploadAssertionInput {
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

export function createRemoteShareUploadAssertion(
  input: RemoteShareUploadAssertionInput,
  secret: string,
  nowSeconds?: number,
): Promise<RemoteShareUploadAssertionResult | null>;

export function verifyRemoteShareUploadAssertion(
  token: string | null | undefined,
  secret: string,
  options?: RemoteShareUploadAssertionOptions,
): Promise<VerifiedRemoteShareUploadAssertion | null>;
