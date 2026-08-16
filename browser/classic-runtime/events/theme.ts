(function applyInitialEventTheme() {
  try {
    const mode = localStorage.getItem('musixquare-theme') || 'system';
    const dark =
      mode === 'dark' ||
      (mode !== 'light' &&
        Boolean(window.matchMedia) &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    const theme = dark ? 'dark' : 'light';
    const themeColor = dark ? '#121212' : '#f8f9fa';

    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  } catch (_error) {
    // The dark HTML default remains usable when storage or matchMedia is unavailable.
  }
})();
