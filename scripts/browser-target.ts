export const LEGACY_APP_BROWSER_TARGET = 'chrome79';

// CSS minification drops vendor prefixes that no listed target needs. A
// Chromium-only list made lightningcss strip `-webkit-user-select`, which iOS
// Safari still requires, so keep Safari and iOS in the CSS target list.
export const APP_CSS_BROWSER_TARGETS = [LEGACY_APP_BROWSER_TARGET, 'safari15', 'ios15'];
