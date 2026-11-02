/**
 * The app's Han order on the pages outside the app (/han-order.js).
 *
 * The app draws Han in the family of the first Korean, Japanese, Simplified
 * or Traditional Chinese language the browser lists, Korean when it lists
 * none, in every UI that is not Japanese or Chinese; it marks the root with
 * data-mxqr-han-order once at startup (src/i18n/startup-han-order.ts,
 * applied by src/i18n/locale-fonts.ts). The public pages read the same
 * stacks (/web-fonts/stacks.css), so this script marks their root the same
 * way. A page loads it as a blocking script in its head, so the mark is in
 * place before the first paint; a Japanese or Chinese page draws its own
 * family first whatever the mark, through its html lang.
 *
 * A classic script cannot import the app module, so this is a copy:
 * src/i18n/__tests__/public-han-order.test.ts holds it to resolveHanOrder.
 */

(function markHanOrder() {
  /** Browser language tags, matched by BCP 47 prefix, and the order each picks. */
  const HAN_ORDER_TAGS: readonly (readonly [string, string])[] = [
    ['ko', 'ko'],
    ['ja', 'ja'],
    ['zh-hans', 'zh-hans'],
    ['zh-cn', 'zh-hans'],
    ['zh-hant', 'zh-hant'],
    ['zh-tw', 'zh-hant'],
    ['zh-hk', 'zh-hant'],
  ];

  const languages =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language || ''];
  for (const language of languages) {
    const normalized = String(language).trim().replace(/_/gu, '-').toLowerCase();
    for (const [prefix, order] of HAN_ORDER_TAGS) {
      if (normalized !== prefix && !normalized.startsWith(`${prefix}-`)) continue;
      if (order !== 'ko') document.documentElement.setAttribute('data-mxqr-han-order', order);
      return;
    }
  }
})();
