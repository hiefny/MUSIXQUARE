/**
 * The one inline script the app documents run: index.html's
 * `<script data-boot-preflight>` applies the stored theme and marks a session
 * reset's continuation before the boot splash first paints (bootstrap.js runs
 * later, from the top of `<body>`). The app document CSP allows exactly this
 * text by its SHA-256 (cloudflare/app-worker.ts), and the shrink-only inline
 * JavaScript guard exempts exactly this block in index.html
 * (scripts/check-authored-inline-js-inventory.mts). Any edit of the script's
 * text needs the new hash here, in the same change: the boot-splash,
 * app-worker and inline-guard tests compare it with index.html.
 */

/** The attribute that names the preflight's `<script>` element. */
export const BOOT_PREFLIGHT_SCRIPT_ATTRIBUTE = 'data-boot-preflight';

/** Base64 SHA-256 of the preflight script's text, exactly as index.html carries it. */
export const BOOT_PREFLIGHT_SCRIPT_SHA256 = '+aAftJOmrteXcseZDaYwEI4GxV+FWcHqsDU3BrGS8gQ=';

/** The CSP source that allows the preflight on app documents. */
export const BOOT_PREFLIGHT_CSP_SOURCE = `'sha256-${BOOT_PREFLIGHT_SCRIPT_SHA256}'`;
