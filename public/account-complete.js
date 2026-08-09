(() => {
  const completionUrl = new URL(window.location.href);
  const marker = completionUrl.searchParams.get('accountAuth');
  const accountClient = completionUrl.searchParams.get('accountClient');
  const outcome = marker === 'cancelled' || marker === 'error' ? marker : 'success';
  const message =
    outcome === 'success'
      ? { type: 'refresh' }
      : {
          type: 'refresh',
          accountAuth: outcome,
          id: `result:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
          accountClient,
        };
  const storageKey = 'mxqr-account-refresh';
  const translations = {
    en: [
      'Sign-in complete. You may close this window.',
      'Close',
      'en',
      'Sign-in was cancelled.',
      'Could not sign in. Please try again.',
    ],
    ko: [
      '로그인이 완료됐어요. 이 창을 닫아도 돼요.',
      '닫기',
      'ko',
      '로그인이 취소됐어요.',
      '로그인하지 못했어요. 다시 시도해 주세요.',
    ],
    ja: [
      'ログインが完了しました。このウィンドウを閉じても大丈夫です。',
      '閉じる',
      'ja',
      'ログインがキャンセルされました。',
      'ログインできませんでした。もう一度お試しください。',
    ],
    'zh-hans': [
      '登录已完成。现在可以关闭此窗口。',
      '关闭',
      'zh-Hans',
      '已取消登录。',
      '登录失败，请重试。',
    ],
    'zh-hant': [
      '登入已完成。現在可以關閉此視窗。',
      '關閉',
      'zh-Hant',
      '已取消登入。',
      '無法登入，請再試一次。',
    ],
    es: [
      'Inicio de sesión completado. Puedes cerrar esta ventana.',
      'Cerrar',
      'es',
      'Se canceló el inicio de sesión.',
      'No se pudo iniciar sesión. Inténtalo de nuevo.',
    ],
    'pt-br': [
      'Login concluído. Você pode fechar esta janela.',
      'Fechar',
      'pt-BR',
      'O login foi cancelado.',
      'Não foi possível entrar. Tente novamente.',
    ],
    fr: [
      'Connexion réussie. Vous pouvez fermer cette fenêtre.',
      'Fermer',
      'fr',
      'La connexion a été annulée.',
      'Connexion impossible. Réessayez.',
    ],
    de: [
      'Anmeldung abgeschlossen. Du kannst dieses Fenster schließen.',
      'Schließen',
      'de',
      'Die Anmeldung wurde abgebrochen.',
      'Anmeldung fehlgeschlagen. Versuche es erneut.',
    ],
    nl: [
      'Inloggen voltooid. Je kunt dit venster sluiten.',
      'Sluiten',
      'nl',
      'Het inloggen is geannuleerd.',
      'Inloggen mislukt. Probeer het opnieuw.',
    ],
    it: [
      'Accesso completato. Puoi chiudere questa finestra.',
      'Chiudi',
      'it',
      'Accesso annullato.',
      'Accesso non riuscito. Riprova.',
    ],
    pl: [
      'Logowanie zakończone. Możesz zamknąć to okno.',
      'Zamknij',
      'pl',
      'Logowanie anulowano.',
      'Nie udało się zalogować. Spróbuj ponownie.',
    ],
    ru: [
      'Вход выполнен. Это окно можно закрыть.',
      'Закрыть',
      'ru',
      'Вход отменён.',
      'Не удалось войти. Попробуйте ещё раз.',
    ],
    tr: [
      'Oturum açma tamamlandı. Bu pencereyi kapatabilirsin.',
      'Kapat',
      'tr',
      'Oturum açma iptal edildi.',
      'Oturum açılamadı. Lütfen tekrar dene.',
    ],
    id: [
      'Berhasil masuk. Anda dapat menutup jendela ini.',
      'Tutup',
      'id',
      'Proses masuk dibatalkan.',
      'Tidak dapat masuk. Coba lagi.',
    ],
    vi: [
      'Đăng nhập hoàn tất. Bạn có thể đóng cửa sổ này.',
      'Đóng',
      'vi',
      'Đã hủy đăng nhập.',
      'Không thể đăng nhập. Vui lòng thử lại.',
    ],
    th: [
      'เข้าสู่ระบบเรียบร้อยแล้ว ปิดหน้าต่างนี้ได้เลย',
      'ปิด',
      'th',
      'ยกเลิกการเข้าสู่ระบบแล้ว',
      'เข้าสู่ระบบไม่ได้ ลองอีกครั้ง',
    ],
  };

  const matchLanguage = (value) => {
    const normalized = String(value || '')
      .trim()
      .replace(/_/g, '-')
      .toLowerCase();
    if (!normalized || normalized === 'system') return null;
    if (normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) return 'zh-hans';
    if (normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) return 'zh-hant';
    if (normalized.startsWith('zh')) {
      return /(?:tw|hk|mo|hant)/.test(normalized) ? 'zh-hant' : 'zh-hans';
    }
    if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-br';
    const primary = normalized.split('-')[0];
    return Object.prototype.hasOwnProperty.call(translations, primary) ? primary : null;
  };

  let savedLanguage = null;
  try {
    savedLanguage = localStorage.getItem('musixquare-lang');
  } catch {}
  const systemLanguages = navigator.languages?.length
    ? navigator.languages
    : [navigator.language || ''];
  const key =
    matchLanguage(savedLanguage) || systemLanguages.map(matchLanguage).find(Boolean) || 'en';
  const translated = translations[key];
  document.documentElement.lang = translated[2];
  document.getElementById('account-complete-message').textContent =
    outcome === 'cancelled' ? translated[3] : outcome === 'error' ? translated[4] : translated[0];
  document.getElementById('account-complete-close').textContent = translated[1];

  try {
    window.opener?.postMessage(message, window.location.origin);
  } catch {}
  try {
    const channel = new BroadcastChannel('mxqr-account-v1');
    channel.postMessage(message);
    channel.close();
  } catch {}
  try {
    localStorage.setItem(storageKey, JSON.stringify(message));
  } catch {}

  const close = () => window.close();
  document.getElementById('account-complete-close').addEventListener('click', close);
  // Successful popup authentication is already reflected in the source tab,
  // so finish unobtrusively. Keep cancellation and failure explanations open
  // until the user dismisses them instead of flashing the message for 250 ms.
  if (outcome === 'success') window.setTimeout(close, 250);
})();
