/**
 * The name of the logo reset's port into the update machine (Phase 3 C6-10):
 * the event core/sw-hard-reset.ts dispatches on the page's service-worker
 * container and src/sw-register.ts answers. Each keeps its own copy (the lazy
 * chunk must not import the eager module), so the tests pin both to this one:
 * sw-hard-reset.test.ts checks the event the hard reset sends, and
 * sw-register.test.ts that the machine answers this event;
 * sw-update-transitions.integration.test.ts runs the two together.
 */
export const HARD_RESET_CLAIM_EVENT = 'mxqr:hard-reset-claim';

/**
 * The quiet window of the logo's claim: STARTUP_PROMPT_QUIET_MS in
 * src/sw-register.ts (the update machine's, the home) and its copy of the same
 * name in core/sw-hard-reset.ts, which measures the page's quiet for the claim
 * so the eager bundle does not carry that check (Phase 3 R2).
 * sw-hard-reset.test.ts pins the copy's behaviour to this value and both
 * sources to it.
 */
export const STARTUP_PROMPT_QUIET_MS = 1_000;
