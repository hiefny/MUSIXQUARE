/** Shared standalone chrome, reveal, and navigation-progress behavior for editorial pages. */

(function () {
  var EDITORIAL_LOAD_DELAY_MS = 300;
  var updateHeaderProgress = null;
  var pendingEditorialNavigation = false;
  var EDITORIAL_CHROME_COLOR = '#1a1a1a';

  function syncEditorialThemeChrome() {
    document.documentElement.style.colorScheme = 'dark';

    var metas = document.querySelectorAll('meta[name="theme-color"]');
    if (!metas.length) {
      var meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
      metas = document.querySelectorAll('meta[name="theme-color"]');
    }

    metas.forEach(function (meta) {
      meta.setAttribute('content', EDITORIAL_CHROME_COLOR);
    });
  }

  function initStandaloneMode() {
    var root = document.documentElement;

    function apply() {
      var standalone = false;
      try {
        standalone =
          window.matchMedia &&
          window.matchMedia('(display-mode: standalone)').matches;
      } catch (e) {
        standalone = false;
      }

      try {
        if (navigator.standalone) {
          standalone = true;
          root.classList.add('ios-standalone');
        }
      } catch (e) {
        /* Standalone detection is optional on restricted browsers. */
      }

      root.classList.toggle('standalone', !!standalone);
    }

    apply();

    try {
      var media = window.matchMedia('(display-mode: standalone)');
      if (media.addEventListener) media.addEventListener('change', apply);
      else if (media.addListener) media.addListener(apply);
    } catch (e) {
      /* Display-mode change tracking is optional on restricted browsers. */
    }
  }

  function isInViewport(el) {
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top < vh - 80 && r.bottom > 0;
  }

  function initReveal() {
    var targets = document.querySelectorAll('[data-animate]');
    if (!targets.length) return;

    if (document.body && document.body.getAttribute('data-soro-view') === 'article') {
      var articleSection = document.getElementById('articles');
      if (articleSection) articleSection.classList.add('is-visible');
    }

    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (el) {
        el.classList.add('is-visible');
      });
      return;
    }

    var initiallyVisible = [];
    targets.forEach(function (el) {
      if (isInViewport(el)) initiallyVisible.push(el);
    });

    if (initiallyVisible.length) {
      window.setTimeout(function () {
        initiallyVisible.forEach(function (el) {
          el.classList.add('is-visible');
        });
      }, 20);
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -80px 0px' },
    );

    targets.forEach(function (el) {
      if (initiallyVisible.indexOf(el) === -1) observer.observe(el);
    });
  }

  function initScrollProgress() {
    var bar = document.querySelector('.lp-header-progress');
    if (!bar) return;
    var header = document.querySelector('.lp-header');
    var doc = document.documentElement;
    var raf = 0;

    function update() {
      raf = 0;
      if (header && header.classList.contains('is-loading')) return;
      var max = doc.scrollHeight - doc.clientHeight;
      var pct = max > 0 ? (doc.scrollTop / max) * 100 : 0;
      bar.style.width = pct + '%';
    }

    function schedule() {
      if (raf) return;
      raf = window.requestAnimationFrame(update);
    }

    updateHeaderProgress = update;
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
  }

  function setHeaderLoading(loading) {
    var header = document.querySelector('.lp-header');
    var bar = document.querySelector('.lp-header-progress');
    if (!header) return;

    if (loading) {
      header.classList.add('is-loading');
      if (bar) bar.style.width = '100%';
      return;
    }

    header.classList.remove('is-loading');
    window.requestAnimationFrame(function () {
      if (updateHeaderProgress) updateHeaderProgress();
    });
  }

  function initEditorialPageLoader() {
    window.setTimeout(function () {
      setHeaderLoading(false);
    }, EDITORIAL_LOAD_DELAY_MS);

    document.querySelectorAll('.editorial-site-tab[href]').forEach(function (link) {
      link.addEventListener('click', function (event) {
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

        var href = link.getAttribute('href');
        if (!href) return;

        var url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin) return;

        event.preventDefault();
        if (pendingEditorialNavigation) return;

        pendingEditorialNavigation = true;
        setHeaderLoading(true);
        window.setTimeout(function () {
          window.location.assign(url.href);
        }, EDITORIAL_LOAD_DELAY_MS);
      });
    });
  }

  function initHairlineScale() {
    function update() {
      var dpr = Math.max(1, window.devicePixelRatio || 1);
      document.documentElement.style.setProperty('--hairline-scale', String(Math.min(1, 1 / dpr)));
    }

    update();
    window.addEventListener('resize', update, { passive: true });
  }

  function initSmoothAnchor() {
    document.querySelectorAll('a[href^="#"]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        var id = (link.getAttribute('href') || '').slice(1);
        if (!id) return;
        var target = document.getElementById(id);
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

  function initArticleEntryScroll() {
    if (!document.body || document.body.getAttribute('data-soro-view') !== 'article') return;
    if (window.location.hash) return;

    var target = document.getElementById('articles');
    if (!target) return;

    function scrollToArticle() {
      var y = target.getBoundingClientRect().top + window.pageYOffset;
      window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
      if (updateHeaderProgress) updateHeaderProgress();
    }

    window.requestAnimationFrame(function () {
      scrollToArticle();
      window.setTimeout(scrollToArticle, 120);
    });
  }

  function boot() {
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
