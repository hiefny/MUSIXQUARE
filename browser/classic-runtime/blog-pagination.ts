(function installBlogPagination() {
  const PAGE_SIZE = 10;
  const container = document.getElementById('soro-blog');
  if (!container) return;
  const blogContainer = container;

  type PageItem = number | 'ellipsis';
  type IconDirection = 'next' | 'previous';
  interface PaginationOptions {
    readonly ariaLabel?: string;
    readonly className?: string;
    readonly icon?: IconDirection;
    readonly scroll?: boolean | undefined;
  }

  let currentPage = 1;
  let activeList: Element | null = null;
  let scheduled = false;

  function getCards(list: Element): HTMLElement[] {
    return Array.prototype.filter.call(
      list.children,
      (child: Element) => child.classList && child.classList.contains('soro-blog-card'),
    ) as HTMLElement[];
  }

  function clampPage(page: number, totalPages: number): number {
    return Math.max(1, Math.min(page, totalPages));
  }

  function getVisiblePages(totalPages: number): PageItem[] {
    const pages = [1, currentPage - 1, currentPage, currentPage + 1, totalPages]
      .filter((page, index, values) => {
        return page >= 1 && page <= totalPages && values.indexOf(page) === index;
      })
      .sort((a, b) => {
        return a - b;
      });

    const result: PageItem[] = [];
    pages.forEach((page) => {
      const previous = result[result.length - 1];
      if (typeof previous === 'number' && page - previous > 1) {
        result.push('ellipsis');
      }
      result.push(page);
    });
    return result;
  }

  function makeButton(
    label: string,
    page: number,
    list: Element,
    options?: PaginationOptions,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'soro-blog-page-button';
    if (options && options.className) {
      button.className += ' ' + options.className;
    }
    if (options && options.ariaLabel) {
      button.setAttribute('aria-label', options.ariaLabel);
    }
    if (options && options.icon) {
      button.appendChild(makeIcon(options.icon));
    } else {
      button.textContent = label;
    }
    button.addEventListener('click', () => {
      currentPage = page;
      updatePagination(list, { scroll: options && options.scroll });
    });
    return button;
  }

  function makeIcon(direction: IconDirection): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.setAttribute('class', 'soro-blog-page-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    path.setAttribute('d', direction === 'next' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6');
    svg.appendChild(path);
    return svg;
  }

  function renderControls(list: Element, totalPages: number, totalCards: number): void {
    let controls = list.parentNode!.querySelector<HTMLElement>('[data-blog-pagination]');
    if (!controls) {
      controls = document.createElement('nav');
      controls.className = 'soro-blog-pagination';
      controls.setAttribute('data-blog-pagination', '');
      controls.setAttribute('aria-label', 'Article pages');
      list.insertAdjacentElement('afterend', controls);
    }

    controls.textContent = '';

    const start = (currentPage - 1) * PAGE_SIZE + 1;
    const end = Math.min(currentPage * PAGE_SIZE, totalCards);
    const status = document.createElement('div');
    status.className = 'soro-blog-page-status';
    status.textContent = 'Articles ' + start + '-' + end + ' of ' + totalCards;

    const buttons = document.createElement('div');
    buttons.className = 'soro-blog-page-buttons';

    const prev = makeButton('', currentPage - 1, list, {
      ariaLabel: 'Previous page',
      className: 'soro-blog-page-button--nav',
      icon: 'previous',
      scroll: true,
    });
    prev.disabled = currentPage === 1;
    buttons.appendChild(prev);

    getVisiblePages(totalPages).forEach((item) => {
      if (item === 'ellipsis') {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'soro-blog-page-ellipsis';
        ellipsis.textContent = '...';
        buttons.appendChild(ellipsis);
        return;
      }

      const pageButton = makeButton(String(item), item, list, { scroll: true });
      if (item === currentPage) {
        pageButton.setAttribute('aria-current', 'page');
      }
      buttons.appendChild(pageButton);
    });

    const next = makeButton('', currentPage + 1, list, {
      ariaLabel: 'Next page',
      className: 'soro-blog-page-button--nav',
      icon: 'next',
      scroll: true,
    });
    next.disabled = currentPage === totalPages;
    buttons.appendChild(next);

    controls.appendChild(status);
    controls.appendChild(buttons);
  }

  function removeControls(list: Element | null): void {
    if (!list || !list.parentNode) return;
    const controls = list.parentNode.querySelector('[data-blog-pagination]');
    if (controls) controls.remove();
  }

  function updatePagination(list: Element, options?: PaginationOptions): void {
    const cards = getCards(list);
    if (activeList !== list) {
      activeList = list;
      currentPage = 1;
    }

    if (cards.length <= PAGE_SIZE) {
      cards.forEach(function (card) {
        card.hidden = false;
        card.style.removeProperty('display');
      });
      removeControls(list);
      return;
    }

    const totalPages = Math.ceil(cards.length / PAGE_SIZE);
    currentPage = clampPage(currentPage, totalPages);

    cards.forEach((card, index) => {
      const page = Math.floor(index / PAGE_SIZE) + 1;
      const visible = page === currentPage;
      card.hidden = !visible;
      if (visible) {
        card.style.removeProperty('display');
      } else {
        card.style.setProperty('display', 'none', 'important');
      }
    });

    renderControls(list, totalPages, cards.length);

    if (options && options.scroll) {
      const section = document.getElementById('articles');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function scanForList(): void {
    scheduled = false;
    const list = blogContainer.querySelector('.soro-blog-list');
    if (!list) {
      activeList = null;
      return;
    }
    updatePagination(list);
  }

  function scheduleScan(): void {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(scanForList);
  }

  function isPaginationMutation(mutation: MutationRecord): boolean {
    const target = mutation.target;
    return target instanceof Element && Boolean(target.closest('[data-blog-pagination]'));
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.length && mutations.every(isPaginationMutation)) return;
    scheduleScan();
  });
  observer.observe(blogContainer, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleScan);
  } else {
    scheduleScan();
  }
})();
