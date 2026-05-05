/**
 * MUSIXQUARE editorial pages - reveal and header progress.
 */

(function () {
  function isInViewport(el) {
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top < vh - 80 && r.bottom > 0;
  }

  function initReveal() {
    var targets = document.querySelectorAll('[data-animate]');
    if (!targets.length) return;

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
    var doc = document.documentElement;
    var raf = 0;

    function update() {
      raf = 0;
      var max = doc.scrollHeight - doc.clientHeight;
      var pct = max > 0 ? (doc.scrollTop / max) * 100 : 0;
      bar.style.width = pct + '%';
    }

    function schedule() {
      if (raf) return;
      raf = window.requestAnimationFrame(update);
    }

    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
  }

  function initSmoothAnchor() {
    document.querySelectorAll('a[href^="#"]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        var id = (link.getAttribute('href') || '').slice(1);
        if (!id) return;
        var target = document.getElementById(id);
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function boot() {
    initReveal();
    initScrollProgress();
    initSmoothAnchor();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
