/**
 * The LAN-direct publisher's pair-proof window, a test copy of the private
 * DIRECT_PAIR_PROOF_TIMEOUT_MS in src/network/pro-system-audio-direct.ts (its
 * RO-20 timing home): from the answer to both ends' LAN pair proofs, so a
 * route whose proofs never arrive fails this long after its answer. The copy
 * cannot be imported from the runtime module, so
 * direct-pair-proof-window-parity.test.ts pins it to the source value; change
 * both in the same change.
 */
export const DIRECT_PAIR_PROOF_TIMEOUT_MS_COPY = 2_000;
