import type { Draft } from './drafts';

/** Derive the same request across reloads, sign-in renewals and concurrent tabs.
 * The saved revision distinguishes a new proposal with identical wording. Older
 * v1 drafts use their original timestamp until the next edit creates a revision.
 * The server scopes receipts by account ID; the session scope belongs only in
 * the mutation fence, since re-signing into the same account changes that scope.
 * No separate read/write ticket election or receipt cleanup can lose this key.
 */
export async function submissionRequestId(draft: Draft): Promise<string> {
  const identity = JSON.stringify([
    'musixquare.translation.request.v1',
    draft.revisionId ?? draft.updatedAt,
    draft.id,
    draft.locale,
    draft.surface,
    draft.key,
    draft.sourceEn,
    draft.sourceKo,
    draft.current,
    draft.proposed,
    draft.reason,
  ]);
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)),
  );
  // UUIDv8: an application-defined, 122-bit digest accepted by the existing API.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
