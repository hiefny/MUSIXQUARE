/**
 * MUSIXQUARE 3.0 — File Transfer: Shared Helpers
 *
 * Utilities shared between transfer-send and transfer-receive.
 * Sub-files import from here (not from transfer.ts) to avoid circular deps.
 */

/** Cross-realm safe ArrayBuffer check (Worker/iframe boundary safe) */
export const isArrayBuffer = (v: unknown): v is ArrayBuffer =>
  v instanceof ArrayBuffer ||
  (v != null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object ArrayBuffer]');
