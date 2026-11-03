import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import {
  PUBLIC_TEXT_FONT_FAMILY,
  publicFontCssProblems,
} from '../../../scripts/lib/public-font-pages.mts';
import { LANGUAGE_OPTIONS } from '../../i18n/locales.ts';
import { restFontSheetInHead } from '../../i18n/public-font-contract.ts';
import { PUBLIC_FONT_SHEET_URLS } from '../../i18n/public-font-urls.ts';

const COMPLETION_HTML = 'public/account-complete.html';
const COMPLETION_CSS = 'public/account-complete.css';

/** The longest the text of the window waits, invisible, for the app's faces. */
const TEXT_WAIT_CAP = '600ms';

/** The root mark account-complete.js sets once the text may show. */
const FONTS_MARK = 'data-mxqr-fonts';

/** The success window closes itself this long after its completion message (ms). */
const SUCCESS_CLOSE_MS = 250;

/** The success window shows its text this long after its message at the latest (ms). */
const SUCCESS_TEXT_BY_MS = 200;

type CompletionDom = JSDOM & {
  /** The page's timeouts with their delays; a test runs them with runTimeouts. */
  scheduledTimeouts: Array<{ readonly delay: number; ran: boolean; run(): void }>;
  openerMessages: unknown[];
  broadcastMessages: unknown[];
  /** The shared font sheets in the document when each completion channel fired. */
  fontSheetsAtSignal: { channel: string; sheets: number }[];
};

/** A FontFaceSet stand-in whose `ready` settles when the test says so, and frames the test runs. */
interface FontSetStub {
  readonly readyReads: number;
  readonly framesAsked: number;
  resolve(): void;
  /** Run the animation frame callbacks asked for so far. */
  frame(): void;
}

let compiledScript: Promise<string> | undefined;

function completionScript(): Promise<string> {
  const asset = CLASSIC_RUNTIME_ASSETS.find(
    (candidate) => candidate.outputPath === 'account-complete.js',
  );
  if (!asset) throw new Error('Classic account-complete runtime is missing from the manifest.');
  compiledScript ??= compileClassicRuntimeAsset(process.cwd(), asset).then(({ code }) => code);
  return compiledScript;
}

/** The shared font sheets the document links, in document order. */
function fontSheetLinks(dom: JSDOM): HTMLLinkElement[] {
  return [...dom.window.document.querySelectorAll<HTMLLinkElement>('link')].filter((link) =>
    (link.getAttribute('href') ?? '').startsWith('/web-fonts/'),
  );
}

function installFontSet(dom: JSDOM): FontSetStub {
  let reads = 0;
  let resolve = (): void => undefined;
  let frames: Array<() => void> = [];
  Object.defineProperty(dom.window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: () => void) => frames.push(callback),
  });
  const ready = new Promise<void>((settle) => {
    resolve = settle;
  });
  Object.defineProperty(dom.window.document, 'fonts', {
    configurable: true,
    value: {
      get ready() {
        reads += 1;
        return ready;
      },
    },
  });
  return {
    get readyReads() {
      return reads;
    },
    get framesAsked() {
      return frames.length;
    },
    resolve: () => resolve(),
    frame: () => {
      const due = frames;
      frames = [];
      for (const callback of due) callback();
    },
  };
}

/** Let every settled promise callback of the page run. */
async function settle(dom: JSDOM): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
  }
}

/** The delays of the page's timeouts, in the order they fall due. */
function timeoutDelays(dom: CompletionDom): number[] {
  return dom.scheduledTimeouts.map(({ delay }) => delay).sort((a, b) => a - b);
}

/** Run the page's timeouts due within `ms` of its script, in the order they fall due. */
function runTimeouts(dom: CompletionDom, ms: number): void {
  const due = dom.scheduledTimeouts
    .filter((timeout) => !timeout.ran && timeout.delay <= ms)
    .sort((a, b) => a.delay - b.delay);
  for (const timeout of due) {
    timeout.ran = true;
    timeout.run();
  }
}

const localizedCompletionCopy = [
  ['en', 'en', 'Sign-in complete. You may close this window.', 'Close'],
  ['ko', 'ko', '로그인이 완료됐어요. 이 창을 닫아도 돼요.', '닫기'],
  ['ja', 'ja', 'ログインが完了しました。このウィンドウを閉じても大丈夫です。', '閉じる'],
  ['zh-hans', 'zh-Hans', '登录已完成。现在可以关闭此窗口。', '关闭'],
  ['zh-hant', 'zh-Hant', '登入已完成。現在可以關閉此視窗。', '關閉'],
  ['es', 'es', 'Inicio de sesión completado. Puedes cerrar esta ventana.', 'Cerrar'],
  ['pt-br', 'pt-BR', 'Login concluído. Você pode fechar esta janela.', 'Fechar'],
  ['fr', 'fr', 'Connexion réussie. Vous pouvez fermer cette fenêtre.', 'Fermer'],
  ['de', 'de', 'Anmeldung abgeschlossen. Du kannst dieses Fenster schließen.', 'Schließen'],
  ['nl', 'nl', 'Inloggen voltooid. Je kunt dit venster sluiten.', 'Sluiten'],
  ['it', 'it', 'Accesso completato. Puoi chiudere questa finestra.', 'Chiudi'],
  ['pl', 'pl', 'Logowanie zakończone. Możesz zamknąć to okno.', 'Zamknij'],
  ['ru', 'ru', 'Вход выполнен. Это окно можно закрыть.', 'Закрыть'],
  ['tr', 'tr', 'Oturum açma tamamlandı. Bu pencereyi kapatabilirsin.', 'Kapat'],
  ['id', 'id', 'Berhasil masuk. Anda dapat menutup jendela ini.', 'Tutup'],
  ['vi', 'vi', 'Đăng nhập hoàn tất. Bạn có thể đóng cửa sổ này.', 'Đóng'],
  ['th', 'th', 'เข้าสู่ระบบเรียบร้อยแล้ว ปิดหน้าต่างนี้ได้เลย', 'ปิด'],
  ['hi', 'hi-IN', 'साइन इन पूरा हुआ। अब आप यह विंडो बंद कर सकते हैं।', 'बंद करें'],
  ['bn', 'bn-BD', 'সাইন-ইন সম্পন্ন হয়েছে। এখন এই উইন্ডোটি বন্ধ করতে পারেন।', 'বন্ধ করুন'],
  ['ta', 'ta-IN', 'உள்நுழைவு முடிந்தது. இப்போது இந்தச் சாளரத்தை மூடலாம்.', 'மூடு'],
  ['te', 'te-IN', 'సైన్ ఇన్ పూర్తయింది. ఇప్పుడు ఈ విండోను మూసివేయవచ్చు.', 'మూసివేయి'],
  ['ms', 'ms-MY', 'Log masuk selesai. Anda boleh menutup tetingkap ini.', 'Tutup'],
  ['fil', 'fil-PH', 'Tapos na ang pag-sign in. Maaari mo nang isara ang window na ito.', 'Isara'],
  ['ar', 'ar', 'اكتمل تسجيل الدخول. يمكنك إغلاق هذه النافذة الآن.', 'إغلاق'],
  ['ur', 'ur-PK', 'سائن اِن مکمل ہو گیا۔ اب آپ یہ ونڈو بند کر سکتے ہیں۔', 'بند کریں'],
  ['he', 'he-IL', 'ההתחברות הושלמה. אפשר לסגור את החלון הזה.', 'סגירה'],
  ['uk', 'uk-UA', 'Вхід завершено. Тепер це вікно можна закрити.', 'Закрити'],
  ['ro', 'ro-RO', 'Autentificarea s-a încheiat. Poți închide această fereastră.', 'Închide'],
  ['cs', 'cs-CZ', 'Přihlášení je dokončeno. Toto okno můžete zavřít.', 'Zavřít'],
  ['el', 'el-GR', 'Η σύνδεση ολοκληρώθηκε. Μπορείτε να κλείσετε αυτό το παράθυρο.', 'Κλείσιμο'],
  ['fa', 'fa-IR', 'ورود انجام شد. اکنون می‌توانید این پنجره را ببندید.', 'بستن'],
  ['mr', 'mr-IN', 'साइन इन पूर्ण झाले. आता तुम्ही ही विंडो बंद करू शकता.', 'बंद करा'],
  ['gu', 'gu-IN', 'સાઇન ઇન પૂર્ણ થયું. હવે તમે આ વિન્ડો બંધ કરી શકો છો.', 'બંધ કરો'],
  ['kn', 'kn-IN', 'ಸೈನ್ ಇನ್ ಪೂರ್ಣಗೊಂಡಿದೆ. ಈಗ ನೀವು ಈ ವಿಂಡೋವನ್ನು ಮುಚ್ಚಬಹುದು.', 'ಮುಚ್ಚಿ'],
  ['ml', 'ml-IN', 'സൈൻ ഇൻ പൂർത്തിയായി. ഇനി ഈ വിൻഡോ അടയ്ക്കാം.', 'അടയ്ക്കുക'],
  ['pa', 'pa-IN', 'ਸਾਈਨ ਇਨ ਪੂਰਾ ਹੋ ਗਿਆ ਹੈ। ਹੁਣ ਤੁਸੀਂ ਇਹ ਵਿੰਡੋ ਬੰਦ ਕਰ ਸਕਦੇ ਹੋ।', 'ਬੰਦ ਕਰੋ'],
  ['sv', 'sv-SE', 'Inloggningen är klar. Du kan stänga det här fönstret.', 'Stäng'],
  ['da', 'da-DK', 'Login er gennemført. Du kan lukke dette vindue.', 'Luk'],
  ['nb', 'nb-NO', 'Innloggingen er fullført. Du kan lukke dette vinduet.', 'Lukk'],
  ['fi', 'fi-FI', 'Kirjautuminen onnistui. Voit sulkea tämän ikkunan.', 'Sulje'],
  ['hu', 'hu-HU', 'A bejelentkezés befejeződött. Bezárhatod ezt az ablakot.', 'Bezárás'],
  ['bg', 'bg-BG', 'Входът е завършен. Можеш да затвориш този прозорец.', 'Затваряне'],
] as const;

async function renderCompletion(
  language: string,
  marker = '',
  prepare: (dom: JSDOM) => void = () => undefined,
): Promise<CompletionDom> {
  const [html, script] = await Promise.all([readFile(COMPLETION_HTML, 'utf8'), completionScript()]);
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `https://musixquare.com/account-complete.html${marker}`,
  });
  const scheduledTimeouts: CompletionDom['scheduledTimeouts'] = [];
  const openerMessages: unknown[] = [];
  const broadcastMessages: unknown[] = [];
  const fontSheetsAtSignal: { channel: string; sheets: number }[] = [];
  const recordSignal = (channel: string) =>
    fontSheetsAtSignal.push({ channel, sheets: fontSheetLinks(dom).length });
  Object.defineProperty(dom.window, 'setTimeout', {
    configurable: true,
    value: (handler: unknown, delay?: unknown) => {
      if (typeof handler === 'function') {
        scheduledTimeouts.push({ delay: Number(delay ?? 0), ran: false, run: () => handler() });
      }
      return scheduledTimeouts.length;
    },
  });
  Object.defineProperty(dom.window, 'opener', {
    configurable: true,
    value: {
      postMessage: (message: unknown) => {
        recordSignal('opener');
        openerMessages.push(message);
      },
    },
  });
  class CompletionBroadcastChannel {
    constructor(_name: string) {}

    postMessage(message: unknown): void {
      recordSignal('broadcast');
      broadcastMessages.push(message);
    }

    close(): void {}
  }
  Object.defineProperty(dom.window, 'BroadcastChannel', {
    configurable: true,
    value: CompletionBroadcastChannel,
  });
  dom.window.localStorage.setItem('musixquare-lang', language);
  // A Storage object stores any property set on it, so wrap its prototype.
  const storagePrototype = dom.window.Storage.prototype;
  const setItem = storagePrototype.setItem;
  Object.defineProperty(storagePrototype, 'setItem', {
    configurable: true,
    writable: true,
    value(this: Storage, key: string, value: string) {
      if (key === 'mxqr-account-refresh') recordSignal('storage');
      setItem.call(this, key, value);
    },
  });
  prepare(dom);
  dom.window.eval(script);
  return Object.assign(dom, {
    scheduledTimeouts,
    openerMessages,
    broadcastMessages,
    fontSheetsAtSignal,
  });
}

/** Every copy the window can show in one language: the three outcomes and the button. */
async function completionCopies(code: string): Promise<string[]> {
  const copies: string[] = [];
  for (const marker of ['', '?accountAuth=cancelled', '?accountAuth=error']) {
    const dom = await renderCompletion(code, marker);
    const { document } = dom.window;
    copies.push(
      document.getElementById('account-complete-message')?.textContent ?? '',
      document.getElementById('account-complete-close')?.textContent ?? '',
    );
    dom.window.close();
  }
  return copies;
}

/** The single top-level rule whose selector list is exactly `selectors`. */
function ruleWithSelectors(css: string, selectors: readonly string[]): Rule {
  const found: Rule[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent?.type !== 'root') return;
    const normalized = rule.selectors.map((selector) => selector.replace(/\s+/gu, ' ').trim());
    if (JSON.stringify(normalized) === JSON.stringify(selectors)) found.push(rule);
  });
  expect(found, selectors.join(', ')).toHaveLength(1);
  const [rule] = found;
  if (!rule) throw new Error(`no rule for ${selectors.join(', ')}`);
  return rule;
}

function declarations(rule: Rule): Record<string, string> {
  const values: Record<string, string> = {};
  rule.each((node) => {
    if (node.type === 'decl') values[node.prop] = node.value.replace(/\s+/gu, ' ').trim();
  });
  return values;
}

describe('account completion localization', () => {
  it('uses the current wordmark card and primary pill treatment', async () => {
    const [html, stylesheet] = await Promise.all([
      readFile(COMPLETION_HTML, 'utf8'),
      readFile(COMPLETION_CSS, 'utf8'),
    ]);

    expect(html).toMatch(/id="account-complete-message"\s+aria-live="polite"/);
    expect(stylesheet).toMatch(/--primary:\s*#3b82f6;/);
    expect(stylesheet).toMatch(/main\s*{[^}]*border-radius:\s*var\(--radius-l\);/s);
    expect(stylesheet).toContain("url('/designsystem/assets/logo-wordmark.svg')");
    expect(stylesheet).toMatch(/button\s*{[^}]*min-height:\s*56px;[^}]*border-radius:\s*999px;/s);
    expect(stylesheet).toMatch(/button:focus-visible\s*{/);
  });

  it('uses one refresh nonce across every successful popup completion channel', async () => {
    const success = await renderCompletion('en', '?accountClient=tab-12345678');
    const storedPulse = JSON.parse(
      success.window.localStorage.getItem('mxqr-account-refresh') || '{}',
    ) as Record<string, unknown>;
    expect(storedPulse).toEqual({
      type: 'refresh',
      accountAuth: 'success',
      id: expect.stringMatching(/^result:/),
      accountClient: 'tab-12345678',
    });
    expect(success.openerMessages).toEqual([storedPulse]);
    expect(success.broadcastMessages).toEqual([storedPulse]);
    // The close, and the end of the text's wait before it (below), with three
    // frames or more between them.
    expect(timeoutDelays(success)).toEqual([SUCCESS_TEXT_BY_MS, SUCCESS_CLOSE_MS]);
    expect(SUCCESS_TEXT_BY_MS + 50).toBeLessThanOrEqual(SUCCESS_CLOSE_MS);
    success.window.close();
  });

  it.each(localizedCompletionCopy)(
    'uses the saved %s app locale',
    async (locale, htmlLang, message, closeLabel) => {
      const dom = await renderCompletion(locale);
      expect(dom.window.document.documentElement.lang).toBe(htmlLang);
      expect(dom.window.document.documentElement.dir).toBe(
        ['ar', 'fa', 'ur', 'he'].includes(locale) ? 'rtl' : 'ltr',
      );
      expect(dom.window.document.getElementById('account-complete-message')?.textContent).toBe(
        message,
      );
      expect(dom.window.document.getElementById('account-complete-close')?.textContent).toBe(
        closeLabel,
      );
      dom.window.close();
    },
  );

  it('maps regional Portuguese and Traditional Chinese modes to supported locales', async () => {
    const portuguese = await renderCompletion('pt-PT');
    expect(portuguese.window.document.documentElement.lang).toBe('pt-BR');
    expect(portuguese.window.document.getElementById('account-complete-close')?.textContent).toBe(
      'Fechar',
    );
    portuguese.window.close();

    const chinese = await renderCompletion('zh-HK');
    expect(chinese.window.document.documentElement.lang).toBe('zh-Hant');
    expect(chinese.window.document.getElementById('account-complete-close')?.textContent).toBe(
      '關閉',
    );
    chinese.window.close();

    const explicitSimplified = await renderCompletion('zh-Hans-TW');
    expect(explicitSimplified.window.document.documentElement.lang).toBe('zh-Hans');
    explicitSimplified.window.close();

    const explicitTraditional = await renderCompletion('zh-Hant-CN');
    expect(explicitTraditional.window.document.documentElement.lang).toBe('zh-Hant');
    explicitTraditional.window.close();
  });

  it.each([
    ['in-ID', 'id', 'ltr'],
    ['iw-IL', 'he-IL', 'rtl'],
    ['no-NO', 'nb-NO', 'ltr'],
    ['tl-PH', 'fil-PH', 'ltr'],
  ] as const)('maps the legacy %s language alias', async (locale, htmlLang, direction) => {
    const dom = await renderCompletion(locale);
    expect(dom.window.document.documentElement.lang).toBe(htmlLang);
    expect(dom.window.document.documentElement.dir).toBe(direction);
    dom.window.close();
  });

  it('localizes cancellation and provider-error completion states', async () => {
    const cancelled = await renderCompletion(
      'ko',
      '?accountAuth=cancelled&accountClient=tab-12345678',
    );
    expect(cancelled.window.document.getElementById('account-complete-message')?.textContent).toBe(
      '로그인이 취소됐어요.',
    );
    const cancelledPulse = JSON.parse(
      cancelled.window.localStorage.getItem('mxqr-account-refresh') || '{}',
    ) as Record<string, unknown>;
    expect(cancelledPulse).toMatchObject({
      type: 'refresh',
      accountAuth: 'cancelled',
      accountClient: 'tab-12345678',
    });
    expect(cancelledPulse.id).toEqual(expect.stringMatching(/^result:/));
    expect(cancelled.scheduledTimeouts).toHaveLength(0);
    cancelled.window.close();

    const failed = await renderCompletion('en', '?accountAuth=error&accountClient=tab-12345678');
    expect(failed.window.document.getElementById('account-complete-message')?.textContent).toBe(
      'Could not sign in. Please try again.',
    );
    const failedPulse = JSON.parse(
      failed.window.localStorage.getItem('mxqr-account-refresh') || '{}',
    ) as Record<string, unknown>;
    expect(failedPulse).toMatchObject({ type: 'refresh', accountAuth: 'error' });
    expect(failed.scheduledTimeouts).toHaveLength(0);
    failed.window.close();
  });
});

describe('account completion fonts', () => {
  it('links nothing the parser would make its completion script wait for', async () => {
    // The deferred script tells the app the sign-in finished. A stylesheet
    // the parser meets anywhere in the page holds a deferred script back
    // until it loads, so the page links only its own small sheet, preloads
    // nothing, and leaves the shared font sheets to the script.
    const html = await readFile(COMPLETION_HTML, 'utf8');
    const { document } = new JSDOM(html).window;
    expect(
      [...document.querySelectorAll('link[rel~="stylesheet"]')].map((link) =>
        link.getAttribute('href'),
      ),
    ).toEqual(['/account-complete.css']);
    expect(
      [...document.querySelectorAll('script')].map((script) => ({
        src: script.getAttribute('src'),
        defer: script.hasAttribute('defer'),
      })),
    ).toEqual([{ src: '/account-complete.js', defer: true }]);
    expect(document.querySelector('link[rel~="preload"], link[rel~="modulepreload"]')).toBeNull();
    expect(html).not.toMatch(/\/web-fonts\/|\/han-order\.js|<style\b|\son[a-z]+=/iu);
  });

  it('keeps the two files its completion message waits for compact', async () => {
    // The message goes out once this sheet and the script have arrived, so on
    // a first load with no service worker and no cache every byte of the two
    // delays it on a slow link. The sheet ships as written (public/), so it
    // carries no comment; the script ships minified, on one line.
    const [stylesheet, script] = await Promise.all([
      readFile(COMPLETION_CSS, 'utf8'),
      completionScript(),
    ]);
    const comments: string[] = [];
    postcss.parse(stylesheet).walkComments((comment) => {
      comments.push(comment.text);
    });
    expect(comments).toEqual([]);
    expect(script.trimEnd().split('\n')).toHaveLength(1);
  });

  it("reads the app's stacks over the device's fonts and declares no face", async () => {
    const stylesheet = await readFile(COMPLETION_CSS, 'utf8');
    // The public pages' sheet rules: no face, no stack, no family of its own.
    expect(publicFontCssProblems(stylesheet)).toEqual([]);
    expect(declarations(ruleWithSelectors(stylesheet, [':root']))['font-family']).toBe(
      PUBLIC_TEXT_FONT_FAMILY,
    );
    expect(stylesheet).not.toMatch(/@font-face|pretendard|url\([^)]*\.woff2?/iu);
  });

  it(`keeps its text invisible until the faces are ready, ${TEXT_WAIT_CAP} at most`, async () => {
    const stylesheet = await readFile(COMPLETION_CSS, 'utf8');
    // One wait: every frame of it draws the text in no colour.
    const keyframes: AtRule[] = [];
    postcss.parse(stylesheet).walkAtRules('keyframes', (atRule) => {
      keyframes.push(atRule);
    });
    expect(keyframes.map(({ params }) => params)).toEqual(['account-complete-text-wait']);
    const frames: Record<string, string>[] = [];
    keyframes[0]?.walkRules((frame) => {
      frames.push(declarations(frame));
    });
    expect(frames).toEqual([{ color: 'transparent' }]);
    // The wordmark's fallback text, the message and the button label wait,
    // once and for the cap at most: no delay, no fill, no repeat, so the
    // text shows when it ends even if the script never marks the root.
    expect(declarations(ruleWithSelectors(stylesheet, ['.brand', 'p', 'button']))).toEqual({
      animation: `account-complete-text-wait ${TEXT_WAIT_CAP}`,
    });
    // The script's mark ends the wait at once.
    expect(
      declarations(
        ruleWithSelectors(stylesheet, [
          `:root[${FONTS_MARK}] .brand`,
          `:root[${FONTS_MARK}] p`,
          `:root[${FONTS_MARK}] button`,
        ]),
      ),
    ).toEqual({ animation: 'none' });
  });

  it('adds the shared font sheets only once the completion message is out', async () => {
    const dom = await renderCompletion('ko', '?accountClient=tab-12345678');
    // Each of the three channels fired before any font sheet was in the page.
    expect(dom.fontSheetsAtSignal).toEqual([
      { channel: 'opener', sheets: 0 },
      { channel: 'broadcast', sheets: 0 },
      { channel: 'storage', sheets: 0 },
    ]);
    const links = fontSheetLinks(dom);
    // For print until each has loaded: while a sheet for the screen loads,
    // WebKit holds the page's rendering, and so the text's capped wait.
    expect(links.map((link) => [link.rel, link.getAttribute('href'), link.media])).toEqual([
      ['stylesheet', PUBLIC_FONT_SHEET_URLS.first, 'print'],
      ['stylesheet', PUBLIC_FONT_SHEET_URLS.stacks, 'print'],
    ]);
    const { head } = dom.window.document;
    expect([...head.children].slice(-links.length)).toEqual(links);
    // No Han order script: no copy of the window draws a character whose
    // face follows the Han order (see below).
    expect(
      [...dom.window.document.querySelectorAll('script')].map((script) =>
        script.getAttribute('src'),
      ),
    ).toEqual(['/account-complete.js']);
    expect(dom.window.document.documentElement.hasAttribute(FONTS_MARK)).toBe(false);
    expect(timeoutDelays(dom)).toEqual([SUCCESS_TEXT_BY_MS, SUCCESS_CLOSE_MS]);
    dom.window.close();
  });

  it.each(LANGUAGE_OPTIONS.map(({ code }) => code))(
    "adds rest.css in %s only where the app's first faces lack its script",
    async (code) => {
      const dom = await renderCompletion(code);
      expect(fontSheetLinks(dom).map((link) => link.getAttribute('href'))).toEqual(
        restFontSheetInHead(code)
          ? [
              PUBLIC_FONT_SHEET_URLS.first,
              PUBLIC_FONT_SHEET_URLS.stacks,
              PUBLIC_FONT_SHEET_URLS.rest,
            ]
          : [PUBLIC_FONT_SHEET_URLS.first, PUBLIC_FONT_SHEET_URLS.stacks],
      );
      dom.window.close();
    },
  );

  it('draws no character whose face follows the Han order', async () => {
    // stacks.css draws Han and kana in the order of --font-cjk-default,
    // which /han-order.js sets from the browser's languages, except on the
    // Japanese and Chinese copies, whose html lang puts their own family
    // first. Only those copies hold Han or kana, so the window needs no Han
    // order script.
    const ownOrder = new Set(['ja', 'zh-hans', 'zh-hant']);
    const followsHanOrder: string[] = [];
    for (const { code } of LANGUAGE_OPTIONS) {
      if (ownOrder.has(code)) continue;
      for (const copy of await completionCopies(code)) {
        if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(copy)) {
          followsHanOrder.push(`${code}: ${copy}`);
        }
      }
    }
    expect(followsHanOrder).toEqual([]);
  });

  it('shows its text once the sheets have loaded and the faces of its text are ready', async () => {
    let fonts: FontSetStub | undefined;
    const dom = await renderCompletion('ko', '', (page) => {
      fonts = installFontSet(page);
    });
    const root = dom.window.document.documentElement;
    const [first, stacks] = fontSheetLinks(dom);
    first?.dispatchEvent(new dom.window.Event('load'));
    await settle(dom);
    // A loaded sheet turns to every medium.
    expect([first?.media, stacks?.media]).toEqual(['all', 'print']);
    // One sheet is not enough: the stack and the faces need both.
    expect(fonts?.readyReads).toBe(0);
    stacks?.dispatchEvent(new dom.window.Event('load'));
    await settle(dom);
    // The next frame's layout asks for the faces (WebKit starts those loads
    // after that frame), so ready is read a frame later.
    expect(fonts?.readyReads).toBe(0);
    expect(fonts?.framesAsked).toBe(1);
    fonts?.frame();
    expect(fonts?.readyReads).toBe(0);
    fonts?.frame();
    expect(fonts?.readyReads).toBe(1);
    await settle(dom);
    expect(root.hasAttribute(FONTS_MARK)).toBe(false);
    fonts?.resolve();
    await settle(dom);
    expect(root.getAttribute(FONTS_MARK)).toBe('app');
    dom.window.close();
  });

  it("shows its text at once in the device's fonts when a sheet cannot load", async () => {
    let fonts: FontSetStub | undefined;
    const dom = await renderCompletion('ja', '?accountAuth=error', (page) => {
      fonts = installFontSet(page);
    });
    const root = dom.window.document.documentElement;
    const [first, stacks, rest] = fontSheetLinks(dom);
    expect(rest?.getAttribute('href')).toBe(PUBLIC_FONT_SHEET_URLS.rest);
    first?.dispatchEvent(new dom.window.Event('load'));
    stacks?.dispatchEvent(new dom.window.Event('error'));
    await settle(dom);
    expect(root.getAttribute(FONTS_MARK)).toBe('device');
    // A late sheet changes nothing.
    rest?.dispatchEvent(new dom.window.Event('load'));
    fonts?.resolve();
    await settle(dom);
    expect(root.getAttribute(FONTS_MARK)).toBe('device');
    dom.window.close();
  });

  it('shows its text once the sheets have loaded in a browser without FontFaceSet', async () => {
    const dom = await renderCompletion('en');
    expect('fonts' in dom.window.document).toBe(false);
    const root = dom.window.document.documentElement;
    for (const link of fontSheetLinks(dom)) link.dispatchEvent(new dom.window.Event('load'));
    await settle(dom);
    expect(root.getAttribute(FONTS_MARK)).toBe('app');
    dom.window.close();
  });

  it('shows the success copy before it closes itself when its sheets are late', async () => {
    let fonts: FontSetStub | undefined;
    const dom = await renderCompletion('ko', '', (page) => {
      fonts = installFontSet(page);
    });
    const root = dom.window.document.documentElement;
    // The success window closes itself 250 ms after its message, and its text
    // shows first. A late sheet does not end the wait sooner: the app tab has
    // often cached the faces, which then come with the sheet, still in time.
    const [first, stacks] = fontSheetLinks(dom);
    first?.dispatchEvent(new dom.window.Event('load'));
    await settle(dom);
    runTimeouts(dom, SUCCESS_TEXT_BY_MS - 1);
    expect(root.hasAttribute(FONTS_MARK)).toBe(false);
    // 200 ms after the message the text shows with what has loaded: here the
    // device's fonts, as a sheet is still loading.
    runTimeouts(dom, SUCCESS_TEXT_BY_MS);
    expect(root.getAttribute(FONTS_MARK)).toBe('device');
    // The sheet and the faces that arrive later change nothing.
    stacks?.dispatchEvent(new dom.window.Event('load'));
    await settle(dom);
    fonts?.frame();
    fonts?.frame();
    fonts?.resolve();
    await settle(dom);
    expect(root.getAttribute(FONTS_MARK)).toBe('device');
    dom.window.close();
  });

  it('waits for the faces until 200 ms after the success message once its sheets are in', async () => {
    let fonts: FontSetStub | undefined;
    const dom = await renderCompletion('ko', '', (page) => {
      fonts = installFontSet(page);
    });
    const root = dom.window.document.documentElement;
    for (const link of fontSheetLinks(dom)) link.dispatchEvent(new dom.window.Event('load'));
    await settle(dom);
    fonts?.frame();
    fonts?.frame();
    await settle(dom);
    // The sheets are in, so the faces may still come before the close.
    runTimeouts(dom, SUCCESS_TEXT_BY_MS - 1);
    expect(root.hasAttribute(FONTS_MARK)).toBe(false);
    // Then the text shows with whatever has loaded, frames before the close.
    runTimeouts(dom, SUCCESS_TEXT_BY_MS);
    expect(root.getAttribute(FONTS_MARK)).toBe('device');
    expect(dom.scheduledTimeouts.filter(({ ran }) => !ran).map(({ delay }) => delay)).toEqual([
      SUCCESS_CLOSE_MS,
    ]);
    fonts?.resolve();
    await settle(dom);
    expect(root.getAttribute(FONTS_MARK)).toBe('device');
    dom.window.close();
  });

  it('draws the success copy with the app faces when they are ready in time', async () => {
    let fonts: FontSetStub | undefined;
    const dom = await renderCompletion('ko', '', (page) => {
      fonts = installFontSet(page);
    });
    const root = dom.window.document.documentElement;
    for (const link of fontSheetLinks(dom)) link.dispatchEvent(new dom.window.Event('load'));
    await settle(dom);
    fonts?.frame();
    fonts?.frame();
    fonts?.resolve();
    await settle(dom);
    expect(root.getAttribute(FONTS_MARK)).toBe('app');
    runTimeouts(dom, SUCCESS_TEXT_BY_MS);
    expect(root.getAttribute(FONTS_MARK)).toBe('app');
    dom.window.close();
  });
});
