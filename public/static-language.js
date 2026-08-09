/**
 * Shared language resolver and footer picker for MUSIXQUARE static pages.
 */

(function () {
  var STATIC_STORE_KEY = 'mxqr-landing-lang';
  var APP_STORE_KEY = 'musixquare-lang';
  var MOBILE_PICKER_QUERY = '(max-width: 640px)';
  var pageScrollLock = null;
  var pickerIdSequence = 0;

  var OPTIONS = [
    { code: 'en', htmlLang: 'en', nativeName: 'English', englishName: 'Default', locale: 'en_US' },
    { code: 'ko', htmlLang: 'ko', nativeName: '한국어', englishName: 'Korean', locale: 'ko_KR' },
    { code: 'ja', htmlLang: 'ja', nativeName: '日本語', englishName: 'Japanese', locale: 'ja_JP' },
    {
      code: 'zh-hans',
      htmlLang: 'zh-Hans',
      nativeName: '简体中文',
      englishName: 'Chinese (Simplified)',
      locale: 'zh_CN',
    },
    {
      code: 'zh-hant',
      htmlLang: 'zh-Hant',
      nativeName: '繁體中文',
      englishName: 'Chinese (Traditional)',
      locale: 'zh_TW',
    },
    { code: 'es', htmlLang: 'es', nativeName: 'Español', englishName: 'Spanish', locale: 'es_ES' },
    {
      code: 'pt-br',
      htmlLang: 'pt-BR',
      nativeName: 'Português (Brasil)',
      englishName: 'Portuguese (Brazil)',
      locale: 'pt_BR',
    },
    { code: 'fr', htmlLang: 'fr', nativeName: 'Français', englishName: 'French', locale: 'fr_FR' },
    { code: 'de', htmlLang: 'de', nativeName: 'Deutsch', englishName: 'German', locale: 'de_DE' },
    { code: 'nl', htmlLang: 'nl', nativeName: 'Nederlands', englishName: 'Dutch', locale: 'nl_NL' },
    { code: 'it', htmlLang: 'it', nativeName: 'Italiano', englishName: 'Italian', locale: 'it_IT' },
    { code: 'pl', htmlLang: 'pl', nativeName: 'Polski', englishName: 'Polish', locale: 'pl_PL' },
    { code: 'ru', htmlLang: 'ru', nativeName: 'Русский', englishName: 'Russian', locale: 'ru_RU' },
    { code: 'tr', htmlLang: 'tr', nativeName: 'Türkçe', englishName: 'Turkish', locale: 'tr_TR' },
    {
      code: 'id',
      htmlLang: 'id',
      nativeName: 'Bahasa Indonesia',
      englishName: 'Indonesian',
      locale: 'id_ID',
    },
    {
      code: 'vi',
      htmlLang: 'vi',
      nativeName: 'Tiếng Việt',
      englishName: 'Vietnamese',
      locale: 'vi_VN',
    },
    { code: 'th', htmlLang: 'th', nativeName: 'ไทย', englishName: 'Thai', locale: 'th_TH' },
  ];

  var optionByCode = {};
  for (var i = 0; i < OPTIONS.length; i++) {
    optionByCode[OPTIONS[i].code] = OPTIONS[i];
  }

  function normalize(value) {
    if (!value) return null;
    var raw = String(value).trim().toLowerCase().replace(/_/g, '-');
    if (optionByCode[raw]) return raw;
    if (raw === 'system') return null;
    if (raw === 'zh-hans' || raw.indexOf('zh-hans-') === 0) return 'zh-hans';
    if (raw === 'zh-hant' || raw.indexOf('zh-hant-') === 0) return 'zh-hant';
    if (raw.indexOf('zh') === 0) {
      if (
        raw.indexOf('tw') !== -1 ||
        raw.indexOf('hk') !== -1 ||
        raw.indexOf('mo') !== -1 ||
        raw.indexOf('hant') !== -1
      ) {
        return 'zh-hant';
      }
      return 'zh-hans';
    }
    if (raw.indexOf('pt') === 0) return 'pt-br';
    var base = raw.split('-')[0];
    return optionByCode[base] ? base : null;
  }

  function readStore(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* Storage may be unavailable in private or restricted contexts. */
    }
  }

  function resolve(fallback) {
    var qLang = null;
    try {
      qLang = new URLSearchParams(location.search).get('lang');
    } catch (e) {
      qLang = null;
    }

    var fromQuery = normalize(qLang);
    if (fromQuery) return fromQuery;

    var fromStaticStore = normalize(readStore(STATIC_STORE_KEY));
    if (fromStaticStore) return fromStaticStore;

    var fromAppStore = normalize(readStore(APP_STORE_KEY));
    if (fromAppStore) return fromAppStore;

    var navs = [];
    try {
      navs =
        navigator.languages && navigator.languages.length
          ? navigator.languages
          : [navigator.language];
    } catch (e) {
      navs = [];
    }

    for (var i = 0; i < navs.length; i++) {
      var fromNavigator = normalize(navs[i]);
      if (fromNavigator) return fromNavigator;
    }

    return normalize(fallback) || 'en';
  }

  function option(code) {
    return optionByCode[normalize(code)] || optionByCode.en;
  }

  function htmlLang(code) {
    return option(code).htmlLang;
  }

  function locale(code) {
    return option(code).locale;
  }

  function setUrlLanguage(code) {
    try {
      var url = new URL(location.href);
      if (code === 'en') url.searchParams.delete('lang');
      else url.searchParams.set('lang', code);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {
      /* URL/history APIs may be unavailable in embedded browsers. */
    }
  }

  function persist(code) {
    var normalized = normalize(code) || 'en';
    writeStore(STATIC_STORE_KEY, normalized);
    writeStore(APP_STORE_KEY, normalized);
    setUrlLanguage(normalized);
    return normalized;
  }

  function setDocumentLang(code) {
    document.documentElement.lang = htmlLang(code);
  }

  function isMobilePicker() {
    try {
      return window.matchMedia(MOBILE_PICKER_QUERY).matches;
    } catch (e) {
      return window.innerWidth <= 640;
    }
  }

  function lockPageScroll() {
    if (!isMobilePicker() || pageScrollLock || !document.body) return;

    var body = document.body;
    var scrollY = window.scrollY || window.pageYOffset || 0;
    pageScrollLock = {
      scrollY: scrollY,
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
    };

    document.documentElement.classList.add('static-lang-page-locked');
    body.classList.add('static-lang-page-locked');
    body.style.position = 'fixed';
    body.style.top = '-' + scrollY + 'px';
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
  }

  function unlockPageScroll() {
    if (!pageScrollLock || !document.body) return;

    var body = document.body;
    var saved = pageScrollLock;
    pageScrollLock = null;

    document.documentElement.classList.remove('static-lang-page-locked');
    body.classList.remove('static-lang-page-locked');
    body.style.position = saved.position;
    body.style.top = saved.top;
    body.style.left = saved.left;
    body.style.right = saved.right;
    body.style.width = saved.width;

    try {
      window.scrollTo(0, saved.scrollY);
    } catch (e) {
      /* Some embedded browsers do not expose scrollTo. */
    }
  }

  function focusSelectedOption(menu) {
    var active = menu.querySelector('[aria-selected="true"]');
    if (!active) return;

    if (active.focus) active.focus({ preventScroll: true });
    menu.scrollTop = Math.max(
      0,
      active.offsetTop - Math.max(0, (menu.clientHeight - active.offsetHeight) / 2),
    );
  }

  function openPicker(picker) {
    var openPickers = document.querySelectorAll('[data-static-lang-picker].is-open');
    for (var i = 0; i < openPickers.length; i++) {
      if (openPickers[i] !== picker) closePicker(openPickers[i]);
    }

    var trigger = picker.querySelector('[data-static-lang-trigger]');
    var menu = picker.querySelector('[data-static-lang-menu]');
    picker.classList.add('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    lockPageScroll();

    if (menu) {
      window.requestAnimationFrame(function () {
        if (picker.classList.contains('is-open')) focusSelectedOption(menu);
      });
    }
  }

  function renderPicker(picker) {
    if (!picker || picker.getAttribute('data-static-lang-ready') === 'true') return;
    picker.setAttribute('data-static-lang-ready', 'true');
    var pickerId = ++pickerIdSequence;

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'static-lang-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'static-lang-menu-' + pickerId);
    trigger.setAttribute('data-static-lang-trigger', '');
    trigger.innerHTML =
      '<span class="static-lang-trigger__icon" aria-hidden="true">Aa</span>' +
      '<span class="static-lang-trigger__label" id="static-lang-current-' +
      pickerId +
      '" data-static-lang-current></span>' +
      '<span class="static-lang-trigger__chevron" aria-hidden="true"></span>';

    var menu = document.createElement('div');
    menu.className = 'static-lang-menu';
    menu.id = 'static-lang-menu-' + pickerId;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-labelledby', 'static-lang-current-' + pickerId);
    menu.setAttribute('data-static-lang-menu', '');

    var backdrop = document.createElement('div');
    backdrop.className = 'static-lang-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.setAttribute('data-static-lang-backdrop', '');

    for (var i = 0; i < OPTIONS.length; i++) {
      var lang = OPTIONS[i];
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'static-lang-option';
      item.setAttribute('role', 'option');
      item.setAttribute('data-lang-set', lang.code);
      item.innerHTML =
        '<span class="static-lang-option__native" lang="' +
        lang.htmlLang +
        '">' +
        lang.nativeName +
        '</span><span class="static-lang-option__english" lang="en">' +
        lang.englishName +
        '</span>';
      menu.appendChild(item);
    }

    picker.appendChild(trigger);
    picker.appendChild(backdrop);
    picker.appendChild(menu);

    trigger.addEventListener('click', function () {
      if (picker.classList.contains('is-open')) closePicker(picker);
      else openPicker(picker);
    });

    backdrop.addEventListener('click', function () {
      closePicker(picker);
      trigger.focus({ preventScroll: true });
    });

    menu.addEventListener('click', function (event) {
      var target = event.target.closest('[data-lang-set]');
      if (!target) return;
      var next = persist(target.getAttribute('data-lang-set'));
      update(next);
      closePicker(picker);
      trigger.focus({ preventScroll: true });
      window.dispatchEvent(
        new CustomEvent('mxqr:static-language-change', { detail: { lang: next } }),
      );
    });

    menu.addEventListener('keydown', function (event) {
      if (
        event.key !== 'ArrowDown' &&
        event.key !== 'ArrowUp' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      ) {
        return;
      }
      var options = menu.querySelectorAll('[data-lang-set]');
      if (!options.length) return;
      event.preventDefault();

      var activeIndex = -1;
      for (var i = 0; i < options.length; i++) {
        if (options[i] === document.activeElement) {
          activeIndex = i;
          break;
        }
      }
      var nextIndex = 0;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = options.length - 1;
      else if (event.key === 'ArrowUp') {
        nextIndex = activeIndex <= 0 ? options.length - 1 : activeIndex - 1;
      } else {
        nextIndex = activeIndex < 0 || activeIndex === options.length - 1 ? 0 : activeIndex + 1;
      }
      options[nextIndex].focus({ preventScroll: true });
    });

    picker.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closePicker(picker);
        trigger.focus();
      }
    });
  }

  function closePicker(picker) {
    var trigger = picker.querySelector('[data-static-lang-trigger]');
    picker.classList.remove('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (!document.querySelector('[data-static-lang-picker].is-open')) unlockPageScroll();
  }

  function update(code) {
    var normalized = normalize(code) || resolve('en');
    var selected = option(normalized);
    var pickers = document.querySelectorAll('[data-static-lang-picker]');
    for (var i = 0; i < pickers.length; i++) {
      var picker = pickers[i];
      var current = picker.querySelector('[data-static-lang-current]');
      if (current) {
        current.textContent = selected.nativeName;
        current.setAttribute('lang', selected.htmlLang);
      }

      var options = picker.querySelectorAll('[data-lang-set]');
      for (var j = 0; j < options.length; j++) {
        var item = options[j];
        var active = item.getAttribute('data-lang-set') === normalized;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }
  }

  function initPickers() {
    var current = resolve('en');
    var pickers = document.querySelectorAll('[data-static-lang-picker]');
    for (var i = 0; i < pickers.length; i++) renderPicker(pickers[i]);
    update(current);

    document.addEventListener('click', function (event) {
      var openPickers = document.querySelectorAll('[data-static-lang-picker].is-open');
      for (var j = 0; j < openPickers.length; j++) {
        if (!openPickers[j].contains(event.target)) closePicker(openPickers[j]);
      }
    });

    try {
      var mobileQuery = window.matchMedia(MOBILE_PICKER_QUERY);
      var handlePickerModeChange = function () {
        var openPicker = document.querySelector('[data-static-lang-picker].is-open');
        if (openPicker && mobileQuery.matches) lockPageScroll();
        else unlockPageScroll();
      };
      if (mobileQuery.addEventListener)
        mobileQuery.addEventListener('change', handlePickerModeChange);
      else if (mobileQuery.addListener) mobileQuery.addListener(handlePickerModeChange);
    } catch (e) {
      /* matchMedia may be unavailable in restricted embedded browsers. */
    }
  }

  window.MXQRStaticLang = {
    options: OPTIONS,
    normalize: normalize,
    resolve: resolve,
    htmlLang: htmlLang,
    locale: locale,
    persist: persist,
    setDocumentLang: setDocumentLang,
    update: update,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPickers);
  } else {
    initPickers();
  }
})();
