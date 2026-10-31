/**
 * The LAN-direct pair-proof poll, a test copy of the private
 * DIRECT_PAIR_POLL_MS in src/network/pro-system-audio-direct.ts (its RO-20
 * timing home). Either end's pair check reads its selected pair once per poll
 * and sees a closed route only at its next poll. The copy cannot be imported
 * from the runtime module, so direct-pair-poll-parity.test.ts pins it to the
 * source value; change both in the same change.
 */
export const DIRECT_PAIR_POLL_MS_COPY = 25;
