/**
 * The one inline script the app documents run: index.html's
 * `<script data-boot-preflight>` applies the stored theme, marks a session
 * reset's continuation and, in the installed iOS app, keeps the boot splash's
 * height and holds it over a first screen iOS gives short by the home indicator
 * strip (data-boot-installed, --boot-splash-height, data-boot-hold, which
 * src/core/platform.ts ends), all before the boot splash first paints
 * (bootstrap.js runs later, from the top of `<body>`). The app document CSP allows exactly this
 * text by its SHA-256 (cloudflare/app-worker.ts), and the shrink-only inline
 * JavaScript guard exempts exactly this block in index.html
 * (scripts/check-authored-inline-js-inventory.mts). Any edit of the script's
 * text needs the new hash here, in the same change: the boot-splash,
 * app-worker, inline-guard and localized-HTML tests compare it with index.html
 * and with every locale's built copy, and the localized build refuses to write
 * an app shell whose copy hashes otherwise (scripts/materialize-localized-html.mts).
 */

/** The attribute that names the preflight's `<script>` element. */
export const BOOT_PREFLIGHT_SCRIPT_ATTRIBUTE = 'data-boot-preflight';

/**
 * Base64 SHA-256 of the preflight script's text, exactly as index.html and
 * every built app shell carry it (one line, so the build's indentation
 * stripping leaves it alone).
 */
export const BOOT_PREFLIGHT_SCRIPT_SHA256 = 'fEshNMQNC1a95YKeTuMuzt4BfgJPbxjq1AdERjrQxHY=';
