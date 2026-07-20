import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const COMPLETION_HTML = 'public/account-complete.html';
const COMPLETION_CSS = 'public/account-complete.css';
const COMPLETION_SCRIPT = 'public/account-complete.js';

type CompletionDom = JSDOM & { scheduledTimeouts: Array<() => void> };

const localizedCompletionCopy = [
  ['en', 'en', 'Sign-in complete. You may close this window.', 'Close'],
  ['ko', 'ko', '로그인이 완료됐어요. 이 창을 닫아도 돼요.', '닫기'],
  ['ja', 'ja', 'ログインが完了しました。このウィンドウを閉じても構いません。', '閉じる'],
  ['zh-hans', 'zh-Hans', '登录已完成。现在可以关闭此窗口。', '关闭'],
  ['zh-hant', 'zh-Hant', '登入已完成。現在可以關閉此視窗。', '關閉'],
  ['es', 'es', 'Inicio de sesión completado. Puedes cerrar esta ventana.', 'Cerrar'],
  ['pt-br', 'pt-BR', 'Login concluído. Você pode fechar esta janela.', 'Fechar'],
  ['fr', 'fr', 'Connexion terminée. Vous pouvez fermer cette fenêtre.', 'Fermer'],
  ['de', 'de', 'Anmeldung abgeschlossen. Du kannst dieses Fenster schließen.', 'Schließen'],
  ['nl', 'nl', 'Inloggen voltooid. Je kunt dit venster sluiten.', 'Sluiten'],
  ['it', 'it', 'Accesso completato. Puoi chiudere questa finestra.', 'Chiudi'],
  ['pl', 'pl', 'Logowanie zakończone. Możesz zamknąć to okno.', 'Zamknij'],
  ['ru', 'ru', 'Вход выполнен. Это окно можно закрыть.', 'Закрыть'],
  ['tr', 'tr', 'Oturum açma tamamlandı. Bu pencereyi kapatabilirsin.', 'Kapat'],
  ['id', 'id', 'Proses masuk selesai. Anda dapat menutup jendela ini.', 'Tutup'],
  ['vi', 'vi', 'Đăng nhập hoàn tất. Bạn có thể đóng cửa sổ này.', 'Đóng'],
  ['th', 'th', 'เข้าสู่ระบบเรียบร้อยแล้ว คุณปิดหน้าต่างนี้ได้', 'ปิด'],
] as const;

async function renderCompletion(language: string, marker = ''): Promise<CompletionDom> {
  const [html, script] = await Promise.all([
    readFile(COMPLETION_HTML, 'utf8'),
    readFile(COMPLETION_SCRIPT, 'utf8'),
  ]);
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `https://musixquare.com/account-complete.html${marker}`,
  });
  const scheduledTimeouts: Array<() => void> = [];
  Object.defineProperty(dom.window, 'setTimeout', {
    configurable: true,
    value: (handler: unknown) => {
      if (typeof handler === 'function') scheduledTimeouts.push(() => handler());
      return scheduledTimeouts.length;
    },
  });
  dom.window.localStorage.setItem('musixquare-lang', language);
  dom.window.eval(script);
  return Object.assign(dom, { scheduledTimeouts });
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

  it('keeps successful popup completion as the existing refresh-only signal', async () => {
    const success = await renderCompletion('en', '?accountClient=tab-12345678');
    expect(JSON.parse(success.window.localStorage.getItem('mxqr-account-refresh') || '{}')).toEqual(
      {
        type: 'refresh',
      },
    );
    expect(success.scheduledTimeouts).toHaveLength(1);
    success.window.close();
  });

  it.each(localizedCompletionCopy)(
    'uses the saved %s app locale',
    async (locale, htmlLang, message, closeLabel) => {
      const dom = await renderCompletion(locale);
      expect(dom.window.document.documentElement.lang).toBe(htmlLang);
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
