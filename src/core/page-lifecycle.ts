/**
 * MUSIXQUARE — Page Lifecycle Flags
 *
 * Tiny stand-alone module (no side-effect imports) so callers can signal
 * "the app is about to navigate intentionally" without pulling in the
 * heavy app.ts bootstrap graph (which breaks jsdom tests that import
 * any UI module touching this flag).
 *
 * The flag is read by the `beforeunload` handler in app.ts to suppress
 * the browser's native "Changes you made may not be saved" confirmation
 * on reload/href changes that the user has already confirmed via a
 * custom dialog (leave-session, SW update, reconnect, kick, etc.).
 */

let _intentionalNav = false;

/**
 * Call right before triggering a `window.location.reload()` /
 * `window.location.href = …` / similar programmatic navigation that the
 * user has already confirmed through our own UI. Suppresses the native
 * browser confirm prompt for that navigation only.
 */
export function markIntentionalNav(): void {
  _intentionalNav = true;
}

/** @internal — read by app.ts's beforeunload handler. */
export function isIntentionalNav(): boolean {
  return _intentionalNav;
}
