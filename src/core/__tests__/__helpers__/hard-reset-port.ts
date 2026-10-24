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
