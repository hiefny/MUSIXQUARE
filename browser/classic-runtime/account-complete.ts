(() => {
  type CompletionTranslation = readonly [
    success: string,
    close: string,
    htmlLang: string,
    cancelled: string,
    error: string,
  ];
  type CompletionTranslations = Readonly<Record<string, CompletionTranslation>> & {
    readonly en: CompletionTranslation;
  };

  const completionUrl = new URL(window.location.href);
  const marker = completionUrl.searchParams.get('accountAuth');
  const accountClient = completionUrl.searchParams.get('accountClient');
  const outcome = marker === 'cancelled' || marker === 'error' ? marker : 'success';
  // One completion is announced through three fallback channels. Keep one
  // nonce across all of them so the source tab can distinguish duplicate
  // delivery from a genuinely later account change.
  const refreshId = `result:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  const message = {
    type: 'refresh',
    accountAuth: outcome,
    id: refreshId,
    accountClient,
  };
  const storageKey = 'mxqr-account-refresh';
  const translations: CompletionTranslations = {
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
    hi: [
      'साइन इन पूरा हुआ। अब आप यह विंडो बंद कर सकते हैं।',
      'बंद करें',
      'hi-IN',
      'साइन इन रद्द कर दिया गया।',
      'साइन इन नहीं हो सका। कृपया फिर से कोशिश करें।',
    ],
    bn: [
      'সাইন-ইন সম্পন্ন হয়েছে। এখন এই উইন্ডোটি বন্ধ করতে পারেন।',
      'বন্ধ করুন',
      'bn-BD',
      'সাইন-ইন বাতিল করা হয়েছে।',
      'সাইন-ইন করা যায়নি। আবার চেষ্টা করুন।',
    ],
    ta: [
      'உள்நுழைவு முடிந்தது. இப்போது இந்தச் சாளரத்தை மூடலாம்.',
      'மூடு',
      'ta-IN',
      'உள்நுழைவு ரத்துசெய்யப்பட்டது.',
      'உள்நுழைய முடியவில்லை. மீண்டும் முயலவும்.',
    ],
    te: [
      'సైన్ ఇన్ పూర్తయింది. ఇప్పుడు ఈ విండోను మూసివేయవచ్చు.',
      'మూసివేయి',
      'te-IN',
      'సైన్ ఇన్ రద్దయింది.',
      'సైన్ ఇన్ చేయడం సాధ్యపడలేదు. మళ్లీ ప్రయత్నించండి.',
    ],
    ms: [
      'Log masuk selesai. Anda boleh menutup tetingkap ini.',
      'Tutup',
      'ms-MY',
      'Log masuk dibatalkan.',
      'Tidak dapat log masuk. Sila cuba lagi.',
    ],
    fil: [
      'Tapos na ang pag-sign in. Maaari mo nang isara ang window na ito.',
      'Isara',
      'fil-PH',
      'Kinansela ang pag-sign in.',
      'Hindi makapag-sign in. Pakisubukan ulit.',
    ],
    ar: [
      'اكتمل تسجيل الدخول. يمكنك إغلاق هذه النافذة الآن.',
      'إغلاق',
      'ar',
      'أُلغي تسجيل الدخول.',
      'تعذّر تسجيل الدخول. يُرجى المحاولة مرة أخرى.',
    ],
    ur: [
      'سائن اِن مکمل ہو گیا۔ اب آپ یہ ونڈو بند کر سکتے ہیں۔',
      'بند کریں',
      'ur-PK',
      'سائن اِن منسوخ کر دیا گیا۔',
      'سائن اِن نہیں ہو سکا۔ براہِ کرم دوبارہ کوشش کریں۔',
    ],
    he: [
      'ההתחברות הושלמה. אפשר לסגור את החלון הזה.',
      'סגירה',
      'he-IL',
      'ההתחברות בוטלה.',
      'לא הצלחנו להתחבר. נסו שוב.',
    ],
    uk: [
      'Вхід завершено. Тепер це вікно можна закрити.',
      'Закрити',
      'uk-UA',
      'Вхід скасовано.',
      'Не вдалося ввійти. Спробуйте ще раз.',
    ],
    ro: [
      'Autentificarea s-a încheiat. Poți închide această fereastră.',
      'Închide',
      'ro-RO',
      'Autentificarea a fost anulată.',
      'Autentificarea nu a reușit. Încearcă din nou.',
    ],
    cs: [
      'Přihlášení je dokončeno. Toto okno můžete zavřít.',
      'Zavřít',
      'cs-CZ',
      'Přihlášení bylo zrušeno.',
      'Přihlášení se nezdařilo. Zkuste to znovu.',
    ],
    el: [
      'Η σύνδεση ολοκληρώθηκε. Μπορείτε να κλείσετε αυτό το παράθυρο.',
      'Κλείσιμο',
      'el-GR',
      'Η σύνδεση ακυρώθηκε.',
      'Δεν ήταν δυνατή η σύνδεση. Δοκιμάστε ξανά.',
    ],
    fa: [
      'ورود انجام شد. اکنون می‌توانید این پنجره را ببندید.',
      'بستن',
      'fa-IR',
      'ورود لغو شد.',
      'ورود انجام نشد. لطفاً دوباره تلاش کنید.',
    ],
    mr: [
      'साइन इन पूर्ण झाले. आता तुम्ही ही विंडो बंद करू शकता.',
      'बंद करा',
      'mr-IN',
      'साइन इन रद्द झाले.',
      'साइन इन करता आले नाही. कृपया पुन्हा प्रयत्न करा.',
    ],
    gu: [
      'સાઇન ઇન પૂર્ણ થયું. હવે તમે આ વિન્ડો બંધ કરી શકો છો.',
      'બંધ કરો',
      'gu-IN',
      'સાઇન ઇન રદ થયું.',
      'સાઇન ઇન થઈ શક્યું નહીં. કૃપા કરીને ફરી પ્રયાસ કરો.',
    ],
    kn: [
      'ಸೈನ್ ಇನ್ ಪೂರ್ಣಗೊಂಡಿದೆ. ಈಗ ನೀವು ಈ ವಿಂಡೋವನ್ನು ಮುಚ್ಚಬಹುದು.',
      'ಮುಚ್ಚಿ',
      'kn-IN',
      'ಸೈನ್ ಇನ್ ರದ್ದಾಗಿದೆ.',
      'ಸೈನ್ ಇನ್ ಮಾಡಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
    ],
    ml: [
      'സൈൻ ഇൻ പൂർത്തിയായി. ഇനി ഈ വിൻഡോ അടയ്ക്കാം.',
      'അടയ്ക്കുക',
      'ml-IN',
      'സൈൻ ഇൻ റദ്ദാക്കി.',
      'സൈൻ ഇൻ ചെയ്യാനായില്ല. വീണ്ടും ശ്രമിക്കുക.',
    ],
    pa: [
      'ਸਾਈਨ ਇਨ ਪੂਰਾ ਹੋ ਗਿਆ ਹੈ। ਹੁਣ ਤੁਸੀਂ ਇਹ ਵਿੰਡੋ ਬੰਦ ਕਰ ਸਕਦੇ ਹੋ।',
      'ਬੰਦ ਕਰੋ',
      'pa-IN',
      'ਸਾਈਨ ਇਨ ਰੱਦ ਕਰ ਦਿੱਤਾ ਗਿਆ।',
      'ਸਾਈਨ ਇਨ ਨਹੀਂ ਹੋ ਸਕਿਆ। ਕਿਰਪਾ ਕਰਕੇ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।',
    ],
    sv: [
      'Inloggningen är klar. Du kan stänga det här fönstret.',
      'Stäng',
      'sv-SE',
      'Inloggningen avbröts.',
      'Det gick inte att logga in. Försök igen.',
    ],
    da: [
      'Login er gennemført. Du kan lukke dette vindue.',
      'Luk',
      'da-DK',
      'Login blev annulleret.',
      'Det var ikke muligt at logge ind. Prøv igen.',
    ],
    nb: [
      'Påloggingen er fullført. Du kan lukke dette vinduet.',
      'Lukk',
      'nb-NO',
      'Påloggingen ble avbrutt.',
      'Kunne ikke logge på. Prøv igjen.',
    ],
    fi: [
      'Kirjautuminen onnistui. Voit sulkea tämän ikkunan.',
      'Sulje',
      'fi-FI',
      'Kirjautuminen peruutettiin.',
      'Kirjautuminen epäonnistui. Yritä uudelleen.',
    ],
    hu: [
      'A bejelentkezés befejeződött. Bezárhatod ezt az ablakot.',
      'Bezárás',
      'hu-HU',
      'A bejelentkezést megszakították.',
      'Nem sikerült bejelentkezni. Próbáld újra.',
    ],
    bg: [
      'Влизането е завършено. Можете да затворите този прозорец.',
      'Затваряне',
      'bg-BG',
      'Влизането беше отменено.',
      'Неуспешно влизане. Опитайте отново.',
    ],
  };

  const matchLanguage = (value: unknown): string | null => {
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
    if (normalized === 'in' || normalized.startsWith('in-')) return 'id';
    if (normalized === 'iw' || normalized.startsWith('iw-')) return 'he';
    if (normalized === 'no' || normalized.startsWith('no-')) return 'nb';
    if (normalized === 'tl' || normalized.startsWith('tl-')) return 'fil';
    const [primary] = normalized.split('-');
    return primary && Object.prototype.hasOwnProperty.call(translations, primary) ? primary : null;
  };

  let savedLanguage = null;
  try {
    savedLanguage = localStorage.getItem('musixquare-lang');
  } catch {
    /* Language storage is optional in restricted browsing contexts. */
  }
  const systemLanguages = navigator.languages?.length
    ? navigator.languages
    : [navigator.language || ''];
  const key =
    matchLanguage(savedLanguage) || systemLanguages.map(matchLanguage).find(Boolean) || 'en';
  const translated = translations[key] ?? translations.en;
  const completionMessage = document.getElementById('account-complete-message');
  const closeButton = document.getElementById('account-complete-close');
  if (!completionMessage || !closeButton) {
    throw new Error('Account completion document is missing its required controls.');
  }
  document.documentElement.lang = translated[2];
  document.documentElement.dir =
    key === 'ar' || key === 'fa' || key === 'he' || key === 'ur' ? 'rtl' : 'ltr';
  completionMessage.textContent =
    outcome === 'cancelled' ? translated[3] : outcome === 'error' ? translated[4] : translated[0];
  closeButton.textContent = translated[1];

  try {
    window.opener?.postMessage(message, window.location.origin);
  } catch {
    /* The opener may have closed or use an incompatible origin. */
  }
  try {
    const channel = new BroadcastChannel('mxqr-account-v1');
    channel.postMessage(message);
    channel.close();
  } catch {
    /* BroadcastChannel is optional on older or restricted browsers. */
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(message));
  } catch {
    /* Cross-tab storage signaling is best-effort. */
  }

  const close = () => window.close();
  closeButton.addEventListener('click', close);
  // Successful popup authentication is already reflected in the source tab,
  // so finish unobtrusively. Keep cancellation and failure explanations open
  // until the user dismisses them instead of flashing the message for 250 ms.
  if (outcome === 'success') window.setTimeout(close, 250);
})();
