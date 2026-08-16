/** Shared standalone chrome, reveal, and navigation-progress behavior for editorial pages. */

(function installEditorialPageRuntime() {
  const EDITORIAL_LOAD_DELAY_MS = 300;
  let updateHeaderProgress: (() => void) | null = null;
  let pendingEditorialNavigation = false;
  const EDITORIAL_CHROME_COLOR = '#1a1a1a';

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
