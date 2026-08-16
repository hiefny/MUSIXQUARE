'use strict';

(() => {
  const accordions = Array.from(
    document.querySelectorAll<HTMLDetailsElement>('details.policy-accordion'),
  );
  if (accordions.length === 0) return;

  const decodedHash = (): string => {
    if (window.location.hash.length <= 1) return '';
    try {
      return decodeURIComponent(window.location.hash.slice(1));
    } catch (_error) {
      return window.location.hash.slice(1);
    }
  };

  const revealHashTarget = (): void => {
    const id = decodedHash();
    if (!id) return;

    const target = document.getElementById(id);
    if (!target) return;
    const accordion = target.matches('details.policy-accordion')
      ? target
      : target.closest('details.policy-accordion');
    if (!(accordion instanceof HTMLDetailsElement)) return;

    accordion.open = true;
    const scroll = (): void => {
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' });
      }
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(scroll);
    else scroll();
  };

  for (const accordion of accordions) {
    accordion.addEventListener('toggle', () => {
      const id = accordion.id;
      if (!id) return;

      if (accordion.open) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}#${id}`,
        );
        return;
      }

      if (decodedHash() === id) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}`,
        );
      }
    });
  }

  window.addEventListener('hashchange', revealHashTarget);
  revealHashTarget();
})();
