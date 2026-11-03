/**
 * The three font sheets every page outside the app links (stable URLs, not
 * content-hashed: the public HTML is copied as written and the App Worker
 * renders the blog article and admin pages, so neither can learn a hash).
 *
 * - first.css and rest.css: the build concatenates them from the app's
 *   processed font sheets (scripts/public-font-sheets.mts), grouped by
 *   src/i18n/public-font-contract.ts;
 * - stacks.css: public/web-fonts/stacks.css, the app's font stacks.
 *
 * A leaf module with no imports, so the App Worker and the guards can read
 * the URLs without the font contract. The app itself never requests them.
 */
export const PUBLIC_FONT_SHEET_URLS = {
  first: '/web-fonts/first.css',
  stacks: '/web-fonts/stacks.css',
  rest: '/web-fonts/rest.css',
} as const;

/**
 * The script every page outside the app loads in its head to mark the app's
 * Han order on its root (browser/classic-runtime/han-order.ts), which
 * stacks.css reads.
 */
export const PUBLIC_HAN_ORDER_SCRIPT_URL = '/han-order.js';
