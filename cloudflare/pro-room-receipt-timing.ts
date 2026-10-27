// Timing home of the PRO browser receipt ledger (resource ownership RO-53, see
// docs/design/resource-ownership-registry.md). A browser receipt exists so that
// a request sent again with the same idempotency key replays its first answer
// instead of applying twice. It therefore only has to outlive every request
// that can still carry that key, with a 2x margin. The ordering test
// (src/pro-room/__tests__/pro-room-receipt-timing.test.ts) pins these against
// the client deadlines they cover.

// Owner decision 2026-10-27: keep a receipt only while the App can retry the
// same request. Every browser control request is sent once with a 15 s
// deadline; the longest single-request window is the 45 s BOT lease below.
export const PRO_ROOM_REQUEST_RECEIPT_TTL_MS = 2 * 60 * 1000;

// A BOT run's context lease: execute must reach the room before it ends, so it
// bounds how long the bot-context and bot-execute receipts can be needed.
export const PRO_ROOM_BOT_REQUEST_LEASE_MS = 45 * 1000;

// The App's playback command: one idempotency key across at most this many
// attempts, each bounded by its own timeout (src/pro-room/playback-controller.ts).
export const PRO_ROOM_PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS = 6_000;
export const PRO_ROOM_PLAYBACK_COMMAND_ATTEMPTS = 2;

/**
 * A playback command's second attempt is started by a timer, so a frozen page
 * can send it long after the first. The Worker refuses it once the device's
 * presence lapsed, which makes the latest resend one presence window plus one
 * attempt after the receipt was written. In production (45 s presence) this is
 * the request window; a longer configured presence keeps the receipt longer.
 */
export function proRoomPlaybackReceiptTtlMs(presenceTtlMs: number): number {
  return Math.max(
    PRO_ROOM_REQUEST_RECEIPT_TTL_MS,
    2 * (presenceTtlMs + PRO_ROOM_PLAYBACK_COMMAND_REQUEST_TIMEOUT_MS),
  );
}

/**
 * Upload completion is judged separately: the batch failure dialog's Retry
 * reuses the completion key for as long as the asset can still be appended.
 * An unnamed asset is collected one GC grace after completion, so the receipt
 * lives at least that long. The Worker releases it earlier, once a playlist
 * names the asset or the asset is gone, because no retry can follow then.
 */
export function proRoomCompletionReceiptTtlMs(assetGcGraceMs: number): number {
  return Math.max(PRO_ROOM_REQUEST_RECEIPT_TTL_MS, assetGcGraceMs);
}
