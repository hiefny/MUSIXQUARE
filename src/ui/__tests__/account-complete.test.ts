import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';

const COMPLETION_HTML = 'public/account-complete.html';
const COMPLETION_CSS = 'public/account-complete.css';

type CompletionDom = JSDOM & {
  scheduledTimeouts: Array<() => void>;
  openerMessages: unknown[];
  broadcastMessages: unknown[];
};

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
  ['ms', 'ms-MY', 'Daftar masuk selesai. Anda boleh menutup tetingkap ini.', 'Tutup'],
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
  ['nb', 'nb-NO', 'Påloggingen er fullført. Du kan lukke dette vinduet.', 'Lukk'],
  ['fi', 'fi-FI', 'Kirjautuminen onnistui. Voit sulkea tämän ikkunan.', 'Sulje'],
  ['hu', 'hu-HU', 'A bejelentkezés befejeződött. Bezárhatod ezt az ablakot.', 'Bezárás'],
  ['bg', 'bg-BG', 'Влизането е завършено. Можете да затворите този прозорец.', 'Затваряне'],
] as const;

async function renderCompletion(language: string, marker = ''): Promise<CompletionDom> {
  const asset = CLASSIC_RUNTIME_ASSETS.find(
    (candidate) => candidate.outputPath === 'account-complete.js',
  );
  if (!asset) throw new Error('Classic account-complete runtime is missing from the manifest.');
  const [html, script] = await Promise.all([
    readFile(COMPLETION_HTML, 'utf8'),
    compileClassicRuntimeAsset(process.cwd(), asset).then(({ code }) => code),
  ]);
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `https://musixquare.com/account-complete.html${marker}`,
  });
  const scheduledTimeouts: Array<() => void> = [];
  const openerMessages: unknown[] = [];
  const broadcastMessages: unknown[] = [];
  Object.defineProperty(dom.window, 'setTimeout', {
    configurable: true,
    value: (handler: unknown) => {
      if (typeof handler === 'function') scheduledTimeouts.push(() => handler());
      return scheduledTimeouts.length;
    },
  });
  Object.defineProperty(dom.window, 'opener', {
    configurable: true,
    value: {
      postMessage: (message: unknown) => openerMessages.push(message),
    },
  });
  class CompletionBroadcastChannel {
    constructor(_name: string) {}

    postMessage(message: unknown): void {
      broadcastMessages.push(message);
    }

    close(): void {}
  }
  Object.defineProperty(dom.window, 'BroadcastChannel', {
    configurable: true,
    value: CompletionBroadcastChannel,
  });
  dom.window.localStorage.setItem('musixquare-lang', language);
  dom.window.eval(script);
  return Object.assign(dom, { scheduledTimeouts, openerMessages, broadcastMessages });
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
    expect(stylesheet).toMatch(/button\s*{[^}]*min-height:\s*54px;[^}]*border-radius:\s*999px;/s);
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
    expect(success.scheduledTimeouts).toHaveLength(1);
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
