(function () {
  var PAGE_SIZE = 10;
  var container = document.getElementById('soro-blog');
  if (!container) return;

  var currentPage = 1;
  var activeList = null;
  var scheduled = false;

  function getCards(list) {
    return Array.prototype.filter.call(list.children, function (child) {
      return child.classList && child.classList.contains('soro-blog-card');
    });
  }

  function clampPage(page, totalPages) {
    return Math.max(1, Math.min(page, totalPages));
  }

  function getVisiblePages(totalPages) {
    var pages = [1, currentPage - 1, currentPage, currentPage + 1, totalPages]
      .filter(function (page, index, arr) {
        return page >= 1 && page <= totalPages && arr.indexOf(page) === index;
      })
      .sort(function (a, b) {
        return a - b;
      });

    var result = [];
    pages.forEach(function (page) {
      var previous = result[result.length - 1];
      if (typeof previous === 'number' && page - previous > 1) {
        result.push('ellipsis');
      }
      result.push(page);
    });
    return result;
  }

  function makeButton(label, page, list, options) {
    var button = document.createElement('button');
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
    button.addEventListener('click', function () {
      currentPage = page;
      updatePagination(list, { scroll: options && options.scroll });
    });
    return button;
  }

  function makeIcon(direction) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.setAttribute('class', 'soro-blog-page-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    path.setAttribute('d', direction === 'next' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6');
    svg.appendChild(path);
    return svg;
  }

  function renderControls(list, totalPages, totalCards) {
    var controls = list.parentNode.querySelector('[data-blog-pagination]');
    if (!controls) {
      controls = document.createElement('nav');
      controls.className = 'soro-blog-pagination';
      controls.setAttribute('data-blog-pagination', '');
      controls.setAttribute('aria-label', 'Article pages');
      list.insertAdjacentElement('afterend', controls);
    }

    controls.textContent = '';

    var start = (currentPage - 1) * PAGE_SIZE + 1;
    var end = Math.min(currentPage * PAGE_SIZE, totalCards);
    var status = document.createElement('div');
    status.className = 'soro-blog-page-status';
    status.textContent = 'Articles ' + start + '-' + end + ' of ' + totalCards;

    var buttons = document.createElement('div');
    buttons.className = 'soro-blog-page-buttons';

    var prev = makeButton('', currentPage - 1, list, {
      ariaLabel: 'Previous page',
      className: 'soro-blog-page-button--nav',
      icon: 'previous',
      scroll: true,
    });
    prev.disabled = currentPage === 1;
    buttons.appendChild(prev);

    getVisiblePages(totalPages).forEach(function (item) {
      if (item === 'ellipsis') {
        var ellipsis = document.createElement('span');
        ellipsis.className = 'soro-blog-page-ellipsis';
        ellipsis.textContent = '...';
        buttons.appendChild(ellipsis);
        return;
      }

      var pageButton = makeButton(String(item), item, list, { scroll: true });
      if (item === currentPage) {
        pageButton.setAttribute('aria-current', 'page');
      }
      buttons.appendChild(pageButton);
    });

    var next = makeButton('', currentPage + 1, list, {
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

  function removeControls(list) {
    if (!list || !list.parentNode) return;
    var controls = list.parentNode.querySelector('[data-blog-pagination]');
    if (controls) controls.remove();
  }

  function updatePagination(list, options) {
    var cards = getCards(list);
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

    var totalPages = Math.ceil(cards.length / PAGE_SIZE);
    currentPage = clampPage(currentPage, totalPages);

    cards.forEach(function (card, index) {
      var page = Math.floor(index / PAGE_SIZE) + 1;
      var visible = page === currentPage;
      card.hidden = !visible;
      if (visible) {
        card.style.removeProperty('display');
      } else {
        card.style.setProperty('display', 'none', 'important');
      }
    });

    renderControls(list, totalPages, cards.length);

    if (options && options.scroll) {
      var section = document.getElementById('articles');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function scanForList() {
    scheduled = false;
    var list = container.querySelector('.soro-blog-list');
    if (!list) {
      activeList = null;
      return;
    }
    updatePagination(list);
  }

  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(scanForList);
  }

  function isPaginationMutation(mutation) {
    var target = mutation.target;
    return (
      target && target.nodeType === 1 && target.closest && target.closest('[data-blog-pagination]')
    );
  }

  var observer = new MutationObserver(function (mutations) {
    if (mutations.length && mutations.every(isPaginationMutation)) return;
    scheduleScan();
  });
  observer.observe(container, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleScan);
  } else {
    scheduleScan();
  }
})();
