/**
 * Shared language resolver and footer picker for MUSIXQUARE static pages.
 */

(function () {
  interface StaticLanguageOption {
    readonly code: string;
    readonly htmlLang: string;
    readonly nativeName: string;
    readonly englishName: string;
    readonly locale: string;
    readonly direction?: 'rtl';
  }

  interface PageScrollLock {
    readonly scrollY: number;
    readonly position: string;
    readonly top: string;
    readonly left: string;
    readonly right: string;
    readonly width: string;
  }

  interface StaticLanguageRuntime {
    readonly options: readonly StaticLanguageOption[];
    normalize(value: unknown): string | null;
    resolve(fallback: unknown): string;
    htmlLang(code: unknown): string;
    locale(code: unknown): string;
    direction(code: unknown): 'ltr' | 'rtl';
    ensureFont(code: unknown): void;
    ensurePickerFonts(): void;
    persist(code: unknown): string;
    setDocumentLang(code: unknown): void;
    update(code: unknown): void;
  }

  const STATIC_STORE_KEY = 'mxqr-landing-lang';
  const APP_STORE_KEY = 'musixquare-lang';
  const MOBILE_PICKER_QUERY = '(max-width: 640px)';
  let pageScrollLock: PageScrollLock | null = null;
  let pickerIdSequence = 0;

  const OPTIONS: readonly [StaticLanguageOption, ...StaticLanguageOption[]] = [
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
    {
      code: 'hi',
      htmlLang: 'hi-IN',
      nativeName: 'हिन्दी',
      englishName: 'Hindi',
      locale: 'hi_IN',
    },
    {
      code: 'bn',
      htmlLang: 'bn-BD',
      nativeName: 'বাংলা',
      englishName: 'Bengali',
      locale: 'bn_BD',
    },
    {
      code: 'ta',
      htmlLang: 'ta-IN',
      nativeName: 'தமிழ்',
      englishName: 'Tamil',
      locale: 'ta_IN',
    },
    {
      code: 'te',
      htmlLang: 'te-IN',
      nativeName: 'తెలుగు',
      englishName: 'Telugu',
      locale: 'te_IN',
    },
    {
      code: 'ms',
      htmlLang: 'ms-MY',
      nativeName: 'Bahasa Melayu',
      englishName: 'Malay',
      locale: 'ms_MY',
    },
    {
      code: 'fil',
      htmlLang: 'fil-PH',
      nativeName: 'Filipino',
      englishName: 'Philippines',
      locale: 'fil_PH',
    },
    {
      code: 'ar',
      htmlLang: 'ar',
      nativeName: 'العربية',
      englishName: 'Arabic',
      locale: 'ar_SA',
      direction: 'rtl',
    },
    {
      code: 'ur',
      htmlLang: 'ur-PK',
      nativeName: 'اردو',
      englishName: 'Urdu',
      locale: 'ur_PK',
      direction: 'rtl',
    },
    {
      code: 'he',
      htmlLang: 'he-IL',
      nativeName: 'עברית',
      englishName: 'Hebrew',
      locale: 'he_IL',
      direction: 'rtl',
    },
    {
      code: 'uk',
      htmlLang: 'uk-UA',
      nativeName: 'Українська',
      englishName: 'Ukrainian',
      locale: 'uk_UA',
    },
    {
      code: 'ro',
      htmlLang: 'ro-RO',
      nativeName: 'Română',
      englishName: 'Romanian',
      locale: 'ro_RO',
    },
    {
      code: 'cs',
      htmlLang: 'cs-CZ',
      nativeName: 'Čeština',
      englishName: 'Czech',
      locale: 'cs_CZ',
    },
    {
      code: 'el',
      htmlLang: 'el-GR',
      nativeName: 'Ελληνικά',
      englishName: 'Greek',
      locale: 'el_GR',
    },
    {
      code: 'fa',
      htmlLang: 'fa-IR',
      nativeName: 'فارسی',
      englishName: 'Persian',
      locale: 'fa_IR',
      direction: 'rtl',
    },
    {
      code: 'mr',
      htmlLang: 'mr-IN',
      nativeName: 'मराठी',
      englishName: 'Marathi',
      locale: 'mr_IN',
    },
    {
      code: 'gu',
      htmlLang: 'gu-IN',
      nativeName: 'ગુજરાતી',
      englishName: 'Gujarati',
      locale: 'gu_IN',
    },
    {
      code: 'kn',
      htmlLang: 'kn-IN',
      nativeName: 'ಕನ್ನಡ',
      englishName: 'Kannada',
      locale: 'kn_IN',
    },
    {
      code: 'ml',
      htmlLang: 'ml-IN',
      nativeName: 'മലയാളം',
      englishName: 'Malayalam',
      locale: 'ml_IN',
    },
    {
      code: 'pa',
      htmlLang: 'pa-IN',
      nativeName: 'ਪੰਜਾਬੀ',
      englishName: 'Punjabi',
      locale: 'pa_IN',
    },
    {
      code: 'sv',
      htmlLang: 'sv-SE',
      nativeName: 'Svenska',
      englishName: 'Swedish',
      locale: 'sv_SE',
    },
    {
      code: 'da',
      htmlLang: 'da-DK',
      nativeName: 'Dansk',
      englishName: 'Danish',
      locale: 'da_DK',
    },
    {
      code: 'nb',
      htmlLang: 'nb-NO',
      nativeName: 'Norsk bokmål',
      englishName: 'Norwegian Bokmål',
      locale: 'nb_NO',
    },
    {
      code: 'fi',
      htmlLang: 'fi-FI',
      nativeName: 'Suomi',
      englishName: 'Finnish',
      locale: 'fi_FI',
    },
    {
      code: 'hu',
      htmlLang: 'hu-HU',
      nativeName: 'Magyar',
      englishName: 'Hungarian',
      locale: 'hu_HU',
    },
    {
      code: 'bg',
      htmlLang: 'bg-BG',
      nativeName: 'Български',
      englishName: 'Bulgarian',
      locale: 'bg_BG',
    },
  ];

  const optionByCode: Record<string, StaticLanguageOption> = {};
  for (let i = 0; i < OPTIONS.length; i++) {
    const configuredOption = OPTIONS[i];
    if (configuredOption) optionByCode[configuredOption.code] = configuredOption;
  }

  const FONT_STYLESHEET_BY_CODE: Readonly<Record<string, string>> = {
    ar: '/css/fonts/noto-arabic.css',
    bn: '/css/fonts/noto-bengali.css',
    bg: '/css/fonts/noto-cyrillic.css',
    el: '/css/fonts/noto-greek.css',
    fa: '/css/fonts/noto-arabic.css',
    gu: '/css/fonts/noto-gujarati.css',
    he: '/css/fonts/noto-hebrew.css',
    hi: '/css/fonts/noto-devanagari.css',
    ja: '/css/fonts/noto-jp.css',
    kn: '/css/fonts/noto-kannada.css',
    ml: '/css/fonts/noto-malayalam.css',
    mr: '/css/fonts/noto-devanagari.css',
    pa: '/css/fonts/noto-gurmukhi.css',
    ru: '/css/fonts/noto-cyrillic.css',
    ta: '/css/fonts/noto-tamil.css',
    te: '/css/fonts/noto-telugu.css',
    th: '/css/fonts/noto-thai.css',
    uk: '/css/fonts/noto-cyrillic.css',
    ur: '/css/fonts/noto-arabic.css',
    'zh-hans': '/css/fonts/noto-sc.css',
    'zh-hant': '/css/fonts/noto-tc.css',
  };
  const requestedFontStylesheets = new Set<string>();

  function normalize(value: unknown): string | null {
    if (!value) return null;
    const raw = String(value).trim().toLowerCase().replace(/_/g, '-');
    if (Object.prototype.hasOwnProperty.call(optionByCode, raw)) return raw;
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
    if (raw === 'in' || raw.indexOf('in-') === 0) return 'id';
    if (raw === 'iw' || raw.indexOf('iw-') === 0) return 'he';
    if (raw === 'no' || raw.indexOf('no-') === 0) return 'nb';
    if (raw === 'tl' || raw.indexOf('tl-') === 0) return 'fil';
    const base = raw.split('-')[0];
    return base && Object.prototype.hasOwnProperty.call(optionByCode, base) ? base : null;
  }

  function readStore(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStore(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Storage may be unavailable in private or restricted contexts. */
    }
  }

  function aboutPathLanguage(): string | null {
    try {
      const pathname =
        String(location.pathname || '/')
          .toLowerCase()
          .replace(/\/+$/gu, '') || '/';
      if (pathname === '/about' || pathname === '/about.html') return 'en';
      const match = /^\/([^/]+)\/about(?:\.html)?$/u.exec(pathname);
      const code = normalize(match?.[1]);
      return code && code !== 'en' ? code : null;
    } catch {
      return null;
    }
  }

  function localizedAboutPath(code: string): string {
    return code === 'en' ? '/about' : '/' + code + '/about';
  }

  function localizedAboutHref(code: string): string {
    const fallback = localizedAboutPath(code);
    try {
      const url = new URL(location.href);
      url.pathname = fallback;
      url.searchParams.delete('lang');
      return url.pathname + url.search + url.hash;
    } catch {
      return fallback;
    }
  }

  function resolve(fallback: unknown): string {
    const fromPath = aboutPathLanguage();
    if (fromPath) return fromPath;

    let qLang = null;
    try {
      qLang = new URLSearchParams(location.search).get('lang');
    } catch {
      qLang = null;
    }

    const fromQuery = normalize(qLang);
    if (fromQuery) return fromQuery;

    const fromStaticStore = normalize(readStore(STATIC_STORE_KEY));
    if (fromStaticStore) return fromStaticStore;

    const fromAppStore = normalize(readStore(APP_STORE_KEY));
    if (fromAppStore) return fromAppStore;

    let navs: readonly string[] = [];
    try {
      navs =
        navigator.languages && navigator.languages.length
          ? navigator.languages
          : [navigator.language];
    } catch {
      navs = [];
    }

    for (let i = 0; i < navs.length; i++) {
      const fromNavigator = normalize(navs[i]);
      if (fromNavigator) return fromNavigator;
    }

    return normalize(fallback) || 'en';
  }

  function option(code: unknown): StaticLanguageOption {
    const normalized = normalize(code);
    return (normalized && optionByCode[normalized]) || OPTIONS[0];
  }

  function htmlLang(code: unknown): string {
    return option(code).htmlLang;
  }

  function locale(code: unknown): string {
    return option(code).locale;
  }

  function direction(code: unknown): 'ltr' | 'rtl' {
    return option(code).direction === 'rtl' ? 'rtl' : 'ltr';
  }

  function ensureFont(code: unknown): void {
    const normalized = normalize(code);
    if (!normalized) return;
    const authored = document.querySelector<HTMLLinkElement>(
      `link[rel="stylesheet"][data-static-lang-font-codes~="${normalized}"]`,
    );
    const href = authored?.href || FONT_STYLESHEET_BY_CODE[normalized];
    if (!href || requestedFontStylesheets.has(href)) return;

    const existing =
      authored ||
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find(
        (link) => link.href === new URL(href, document.baseURI).href,
      );
    if (existing && !existing.hasAttribute('data-static-lang-font-codes')) {
      requestedFontStylesheets.add(href);
      return;
    }

    const link = existing || document.createElement('link');
    if (!existing) {
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-static-lang-font', normalized);
    }
    link.disabled = false;
    link.addEventListener(
      'error',
      function () {
        requestedFontStylesheets.delete(href);
        if (existing) link.disabled = true;
        else link.remove();
      },
      { once: true },
    );
    if (!existing) (document.head || document.documentElement).appendChild(link);
    requestedFontStylesheets.add(href);
  }

  function ensurePickerFonts(): void {
    for (let i = 0; i < OPTIONS.length; i++) ensureFont(OPTIONS[i]?.code);
  }

  function persist(code: unknown): string {
    const normalized = normalize(code) || 'en';
    writeStore(STATIC_STORE_KEY, normalized);
    writeStore(APP_STORE_KEY, normalized);
    return normalized;
  }

  function setDocumentLang(code: unknown): void {
    document.documentElement.lang = htmlLang(code);
    document.documentElement.dir = direction(code);
  }

  function isMobilePicker(): boolean {
    try {
      return window.matchMedia(MOBILE_PICKER_QUERY).matches;
    } catch {
      return window.innerWidth <= 640;
    }
  }

  function lockPageScroll(): void {
    if (!isMobilePicker() || pageScrollLock || !document.body) return;

    const body = document.body;
    const scrollY = window.scrollY || window.pageYOffset || 0;
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

  function unlockPageScroll(): void {
    if (!pageScrollLock || !document.body) return;

    const body = document.body;
    const saved = pageScrollLock;
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
    } catch {
      /* Some embedded browsers do not expose scrollTo. */
    }
  }

  function focusSelectedOption(menu: HTMLElement): void {
    const active = menu.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) return;

    active.focus({ preventScroll: true });
    menu.scrollTop = Math.max(
      0,
      active.offsetTop - Math.max(0, (menu.clientHeight - active.offsetHeight) / 2),
    );
  }

  function setMenuExpanded(menu: HTMLElement, expanded: boolean): void {
    menu.setAttribute('aria-hidden', String(!expanded));
    menu.querySelectorAll<HTMLElement>('[data-lang-set]').forEach((item) => {
      item.tabIndex = expanded ? 0 : -1;
    });
  }

  function openPicker(picker: HTMLElement): void {
    ensurePickerFonts();
    const openPickers = document.querySelectorAll<HTMLElement>('[data-static-lang-picker].is-open');
    for (let i = 0; i < openPickers.length; i++) {
      const openPickerElement = openPickers[i];
      if (openPickerElement && openPickerElement !== picker) closePicker(openPickerElement);
    }

    const trigger = picker.querySelector('[data-static-lang-trigger]');
    const menu = picker.querySelector<HTMLElement>('[data-static-lang-menu]');
    picker.classList.add('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    lockPageScroll();

    if (menu) {
      setMenuExpanded(menu, true);
      const pickerMenu = menu;
      window.requestAnimationFrame(function () {
        if (picker.classList.contains('is-open')) focusSelectedOption(pickerMenu);
      });
    }
  }

  function renderPicker(picker: HTMLElement): void {
    if (!picker || picker.getAttribute('data-static-lang-ready') === 'true') return;
    picker.setAttribute('data-static-lang-ready', 'true');
    const pickerId = ++pickerIdSequence;

    const trigger = document.createElement('button');
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

    const menu = document.createElement('div');
    menu.className = 'static-lang-menu';
    menu.tabIndex = -1;
    menu.id = 'static-lang-menu-' + pickerId;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-labelledby', 'static-lang-current-' + pickerId);
    menu.setAttribute('data-static-lang-menu', '');

    const backdrop = document.createElement('div');
    backdrop.className = 'static-lang-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.setAttribute('data-static-lang-backdrop', '');

    for (let i = 0; i < OPTIONS.length; i++) {
      const lang = OPTIONS[i];
      if (!lang) continue;
      const item = document.createElement('a');
      item.className = 'static-lang-option';
      item.href = localizedAboutHref(lang.code);
      item.setAttribute('role', 'option');
      item.setAttribute('data-lang-set', lang.code);
      item.innerHTML =
        '<span class="static-lang-option__native" lang="' +
        lang.htmlLang +
        '" dir="' +
        (lang.direction || 'ltr') +
        '">' +
        lang.nativeName +
        '</span><span class="static-lang-option__english" lang="en" dir="ltr">' +
        lang.englishName +
        '</span>';
      menu.appendChild(item);
    }

    setMenuExpanded(menu, false);
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
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-lang-set]')
          : null;
      if (!target) return;
      persist(target.getAttribute('data-lang-set'));
      closePicker(picker);
      trigger.focus({ preventScroll: true });
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
      const options = menu.querySelectorAll<HTMLAnchorElement>('[data-lang-set]');
      if (!options.length) return;
      event.preventDefault();

      let activeIndex = -1;
      for (let i = 0; i < options.length; i++) {
        if (options[i] === document.activeElement) {
          activeIndex = i;
          break;
        }
      }
      let nextIndex = 0;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = options.length - 1;
      else if (event.key === 'ArrowUp') {
        nextIndex = activeIndex <= 0 ? options.length - 1 : activeIndex - 1;
      } else {
        nextIndex = activeIndex < 0 || activeIndex === options.length - 1 ? 0 : activeIndex + 1;
      }
      const nextOption = options[nextIndex];
      if (nextOption) nextOption.focus({ preventScroll: true });
    });

    picker.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closePicker(picker);
        trigger.focus();
      }
    });
  }

  function closePicker(picker: HTMLElement): void {
    const trigger = picker.querySelector('[data-static-lang-trigger]');
    const menu = picker.querySelector<HTMLElement>('[data-static-lang-menu]');
    picker.classList.remove('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) setMenuExpanded(menu, false);
    if (!document.querySelector('[data-static-lang-picker].is-open')) unlockPageScroll();
  }

  function update(code: unknown): void {
    const normalized = normalize(code) || resolve('en');
    const selected = option(normalized);
    ensureFont(selected.code);
    const pickers = document.querySelectorAll<HTMLElement>('[data-static-lang-picker]');
    for (let i = 0; i < pickers.length; i++) {
      const picker = pickers[i];
      if (!picker) continue;
      const current = picker.querySelector('[data-static-lang-current]');
      if (current) {
        current.textContent = selected.nativeName;
        current.setAttribute('lang', selected.htmlLang);
        current.setAttribute('dir', selected.direction || 'ltr');
      }
      const options = picker.querySelectorAll('[data-lang-set]');
      for (let j = 0; j < options.length; j++) {
        const item = options[j];
        if (!item) continue;
        const active = item.getAttribute('data-lang-set') === normalized;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }
  }

  function initPickers(): void {
    const current = resolve('en');
    const pickers = document.querySelectorAll<HTMLElement>('[data-static-lang-picker]');
    for (let i = 0; i < pickers.length; i++) {
      const picker = pickers[i];
      if (picker) renderPicker(picker);
    }
    update(current);

    document.addEventListener('click', function (event) {
      const openPickers = document.querySelectorAll('[data-static-lang-picker].is-open');
      for (let j = 0; j < openPickers.length; j++) {
        const openPickerElement = openPickers[j];
        if (
          openPickerElement instanceof HTMLElement &&
          !openPickerElement.contains(event.target instanceof Node ? event.target : null)
        ) {
          closePicker(openPickerElement);
        }
      }
    });

    try {
      const mobileQuery = window.matchMedia(MOBILE_PICKER_QUERY);
      const handlePickerModeChange = function () {
        const openPicker = document.querySelector('[data-static-lang-picker].is-open');
        if (openPicker && mobileQuery.matches) lockPageScroll();
        else unlockPageScroll();
      };
      if (mobileQuery.addEventListener)
        mobileQuery.addEventListener('change', handlePickerModeChange);
      else if (mobileQuery.addListener) mobileQuery.addListener(handlePickerModeChange);
    } catch {
      /* matchMedia may be unavailable in restricted embedded browsers. */
    }
  }

  const staticLanguageWindow: Window & { MXQRStaticLang?: StaticLanguageRuntime } = window;
  staticLanguageWindow.MXQRStaticLang = {
    options: OPTIONS,
    normalize: normalize,
    resolve: resolve,
    htmlLang: htmlLang,
    locale: locale,
    direction: direction,
    ensureFont: ensureFont,
    ensurePickerFonts: ensurePickerFonts,
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
