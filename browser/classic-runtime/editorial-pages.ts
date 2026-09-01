/** Shared standalone chrome, reveal, and navigation-progress behavior for editorial pages. */

(function installEditorialPageRuntime() {
  const EDITORIAL_LOAD_DELAY_MS = 300;
  let updateHeaderProgress: (() => void) | null = null;
  let pendingEditorialNavigation = false;
  const EDITORIAL_CHROME_COLOR = '#1a1a1a';
  const APP_LANGUAGE_STORE_KEY = 'musixquare-lang';
  const STATIC_LANGUAGE_STORE_KEY = 'mxqr-landing-lang';
  const EDITORIAL_LANGUAGE_CODES = new Set([
    'en',
    'ko',
    'ja',
    'zh-hans',
    'zh-hant',
    'es',
    'pt-br',
    'fr',
    'de',
    'nl',
    'it',
    'pl',
    'ru',
    'tr',
    'id',
    'vi',
    'th',
    'hi',
    'bn',
    'ta',
    'te',
    'ms',
    'fil',
    'ar',
    'ur',
    'he',
    'uk',
    'ro',
    'cs',
    'el',
    'fa',
    'mr',
    'gu',
    'kn',
    'ml',
    'pa',
    'sv',
    'da',
    'nb',
    'fi',
    'hu',
    'bg',
  ]);

  interface EditorialLanguageIntent {
    readonly code: string;
    readonly explicitQuery: boolean;
  }

  function normalizeEditorialLanguage(value: unknown): string | null {
    const normalized = String(value ?? '')
      .trim()
      .replace(/_/gu, '-')
      .toLowerCase();
    if (!normalized || normalized === 'system') return null;
    if (EDITORIAL_LANGUAGE_CODES.has(normalized)) return normalized;
    if (normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) return 'zh-hans';
    if (normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) return 'zh-hant';
    if (normalized.startsWith('zh')) {
      return /(?:tw|hk|mo|hant)/u.test(normalized) ? 'zh-hant' : 'zh-hans';
    }
    if (normalized.startsWith('pt')) return 'pt-br';
    if (normalized === 'in' || normalized.startsWith('in-')) return 'id';
    if (normalized === 'iw' || normalized.startsWith('iw-')) return 'he';
    if (normalized === 'no' || normalized.startsWith('no-')) return 'nb';
    if (normalized === 'tl' || normalized.startsWith('tl-')) return 'fil';
    const primary = normalized.split('-')[0];
    return primary && EDITORIAL_LANGUAGE_CODES.has(primary) ? primary : null;
  }

  function readLanguageStore(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function resolveEditorialLanguage(): EditorialLanguageIntent {
    let queryLanguage: string | null = null;
    try {
      queryLanguage = normalizeEditorialLanguage(new URL(location.href).searchParams.get('lang'));
    } catch {
      queryLanguage = null;
    }
    if (queryLanguage) return { code: queryLanguage, explicitQuery: true };

    const appPreference = readLanguageStore(APP_LANGUAGE_STORE_KEY);
    const appLanguage = normalizeEditorialLanguage(appPreference);
    if (appLanguage) return { code: appLanguage, explicitQuery: false };

    // `system` is an explicit app preference. Do not revive a stale static-page
    // choice when the user has asked all surfaces to follow the browser.
    if (String(appPreference || '').toLowerCase() !== 'system') {
      const staticLanguage = normalizeEditorialLanguage(
        readLanguageStore(STATIC_LANGUAGE_STORE_KEY),
      );
      if (staticLanguage) return { code: staticLanguage, explicitQuery: false };
    }

    try {
      const candidates = navigator.languages?.length
        ? navigator.languages
        : [navigator.language || ''];
      for (const candidate of candidates) {
        const language = normalizeEditorialLanguage(candidate);
        if (language) return { code: language, explicitQuery: false };
      }
    } catch {
      /* Restricted browser surfaces fall through to English. */
    }

    return { code: 'en', explicitQuery: false };
  }

  function initLocaleAwareLinks(): void {
    const intent = resolveEditorialLanguage();
    const carryQuery = intent.code !== 'en' || intent.explicitQuery;
    const aboutPath = intent.code === 'en' ? '/about' : `/${intent.code}/about`;
    const appPath = `/${intent.code}/`;

    document.querySelectorAll<HTMLAnchorElement>('.editorial-site-tab[href]').forEach((link) => {
      const authoredHref = link.getAttribute('href');
      if (!authoredHref) return;
      const target = new URL(authoredHref, window.location.origin);
      if (target.origin !== window.location.origin) return;

      if (/^\/about\/?$/u.test(target.pathname)) {
        target.pathname = aboutPath;
        target.searchParams.delete('lang');
      } else if (/^\/(?:blog|history|designsystem)\/?$/u.test(target.pathname)) {
        if (carryQuery) target.searchParams.set('lang', intent.code);
        else target.searchParams.delete('lang');
      } else {
        return;
      }
      link.setAttribute('href', target.pathname + target.search + target.hash);
    });

    document
      .querySelectorAll<HTMLAnchorElement>(
        '.lp-try[href], footer a[href="https://musixquare.com"], body[data-soro-view="article"] .lp-logo[href="https://musixquare.com"]',
      )
      .forEach((link) => link.setAttribute('href', appPath));
  }

  function syncEditorialThemeChrome(): void {
    document.documentElement.style.colorScheme = 'dark';

    let metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    if (!metas.length) {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
      metas = document.querySelectorAll('meta[name="theme-color"]');
    }

    metas.forEach(function (meta) {
      meta.setAttribute('content', EDITORIAL_CHROME_COLOR);
    });
  }

  function initStandaloneMode(): void {
    const root = document.documentElement;

    function apply(): void {
      let standalone = false;
      try {
        standalone =
          Boolean(window.matchMedia) && window.matchMedia('(display-mode: standalone)').matches;
      } catch {
        standalone = false;
      }

      try {
        if ((navigator as Navigator & { readonly standalone?: boolean }).standalone) {
          standalone = true;
          root.classList.add('ios-standalone');
        }
      } catch {
        /* Standalone detection is optional on restricted browsers. */
      }

      root.classList.toggle('standalone', !!standalone);
    }

    apply();

    try {
      const media = window.matchMedia('(display-mode: standalone)');
      if (media.addEventListener) media.addEventListener('change', apply);
      else if (media.addListener) media.addListener(apply);
    } catch {
      /* Display-mode change tracking is optional on restricted browsers. */
    }
  }

  function isInViewport(element: Element): boolean {
    const rectangle = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    return rectangle.top < viewportHeight - 80 && rectangle.bottom > 0;
  }

  function initReveal(): void {
    const targets = document.querySelectorAll<HTMLElement>('[data-animate]');
    if (!targets.length) return;

    if (document.body && document.body.getAttribute('data-soro-view') === 'article') {
      const articleSection = document.getElementById('articles');
      if (articleSection) articleSection.classList.add('is-visible');
    }

    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (el) {
        el.classList.add('is-visible');
      });
      return;
    }

    const initiallyVisible: HTMLElement[] = [];
    targets.forEach((element) => {
      if (isInViewport(element)) initiallyVisible.push(element);
    });

    if (initiallyVisible.length) {
      window.setTimeout(() => {
        initiallyVisible.forEach((element) => {
          element.classList.add('is-visible');
        });
      }, 20);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -80px 0px' },
    );

    targets.forEach((element) => {
      if (initiallyVisible.indexOf(element) === -1) observer.observe(element);
    });
  }

  function initScrollProgress(): void {
    const bar = document.querySelector<HTMLElement>('.lp-header-progress');
    if (!bar) return;
    const progressBar = bar;
    const header = document.querySelector('.lp-header');
    const doc = document.documentElement;
    let raf = 0;

    function update(): void {
      raf = 0;
      if (header && header.classList.contains('is-loading')) return;
      const max = doc.scrollHeight - doc.clientHeight;
      const pct = max > 0 ? (doc.scrollTop / max) * 100 : 0;
      progressBar.style.width = pct + '%';
    }

    function schedule(): void {
      if (raf) return;
      raf = window.requestAnimationFrame(update);
    }

    updateHeaderProgress = update;
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
  }

  function setHeaderLoading(loading: boolean): void {
    const header = document.querySelector('.lp-header');
    const bar = document.querySelector<HTMLElement>('.lp-header-progress');
    if (!header) return;

    if (loading) {
      header.classList.add('is-loading');
      if (bar) bar.style.width = '100%';
      return;
    }

    header.classList.remove('is-loading');
    window.requestAnimationFrame(function () {
      updateHeaderProgress?.();
    });
  }

  function initEditorialPageLoader(): void {
    window.setTimeout(function () {
      setHeaderLoading(false);
    }, EDITORIAL_LOAD_DELAY_MS);

    document.querySelectorAll<HTMLAnchorElement>('.editorial-site-tab[href]').forEach((link) => {
      link.addEventListener('click', (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }

        const href = link.getAttribute('href');
        if (!href) return;

        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin) return;

        event.preventDefault();
        if (pendingEditorialNavigation) return;

        pendingEditorialNavigation = true;
        setHeaderLoading(true);
        window.setTimeout(() => {
          window.location.assign(url.href);
        }, EDITORIAL_LOAD_DELAY_MS);
      });
    });
  }

  function initHairlineScale(): void {
    function update(): void {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      document.documentElement.style.setProperty('--hairline-scale', String(Math.min(1, 1 / dpr)));
    }

    update();
    window.addEventListener('resize', update, { passive: true });
  }

  function initSmoothAnchor(): void {
    document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((link) => {
      link.addEventListener('click', (event) => {
        const id = (link.getAttribute('href') || '').slice(1);
        if (!id) return;
        const target = document.getElementById(id);
        if (!target) return;
        event.preventDefault();
        if (id === 'top') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function initArticleEntryScroll(): void {
    if (!document.body || document.body.getAttribute('data-soro-view') !== 'article') return;
    if (window.location.hash) return;

    const target = document.getElementById('articles');
    if (!target) return;
    const articleTarget = target;

    function scrollToArticle(): void {
      const y = articleTarget.getBoundingClientRect().top + window.pageYOffset;
      window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
      updateHeaderProgress?.();
    }

    window.requestAnimationFrame(function () {
      scrollToArticle();
      window.setTimeout(scrollToArticle, 120);
    });
  }

  function boot(): void {
    syncEditorialThemeChrome();
    initStandaloneMode();
    initHairlineScale();
    initReveal();
    initScrollProgress();
    initLocaleAwareLinks();
    initEditorialPageLoader();
    initSmoothAnchor();
    initArticleEntryScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
