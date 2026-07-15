const PRO_ROOM_PIN_RE = /^\d{8}$/;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-](?:[A-Za-z0-9._~-]{30,2046})[A-Za-z0-9_-]$/;

declare const memberTokenBrand: unique symbol;
declare const claimTokenBrand: unique symbol;

/**
 * An authenticated room membership credential. The client treats the value as
 * opaque: parsing, expiry, signatures, and revocation all belong to the server.
 */
export type ProRoomMemberToken = string & { readonly [memberTokenBrand]: true };

/** A one-time owner activation credential. It must never be used as a member token. */
export type ProRoomClaimToken = string & { readonly [claimTokenBrand]: true };

/**
 * PINs remain strings so leading zeroes are never lost. Formatting such as
 * `0000-0001` is presentation-only and must be normalized before this boundary.
 */
export function isProRoomPin(value: unknown): value is string {
  return typeof value === 'string' && PRO_ROOM_PIN_RE.test(value);
}

function isOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_TOKEN_RE.test(value);
}

/** Format validation only; this does not authenticate or inspect the token. */
export function parseProRoomMemberToken(value: unknown): ProRoomMemberToken | null {
  return isOpaqueToken(value) ? (value as ProRoomMemberToken) : null;
}

/** Format validation only; one-time use must be enforced atomically by the server. */
export function parseProRoomClaimToken(value: unknown): ProRoomClaimToken | null {
  return isOpaqueToken(value) ? (value as ProRoomClaimToken) : null;
}
