import { LANGUAGE_OPTIONS, type LanguageCode } from '../i18n/locales.ts';

const COMPLETION_MARKER = 'mxqr-swu';
const COMPLETION_MESSAGES = {
  ar: 'اكتمل التحديث',
  bg: 'Актуализацията е завършена',
  bn: 'আপডেট সম্পন্ন হয়েছে',
  cs: 'Aktualizace dokončena',
  da: 'Opdateringen er fuldført',
  de: 'Update abgeschlossen',
  el: 'Η ενημέρωση ολοκληρώθηκε',
  en: 'Update applied',
  es: 'Actualización completada',
  fa: 'به‌روزرسانی کامل شد',
  fi: 'Päivitys on valmis',
  fil: 'Tapos na ang pag-update',
  fr: 'Mise à jour terminée',
  gu: 'અપડેટ પૂર્ણ થયું',
  he: 'העדכון הושלם',
  hi: 'अपडेट पूरा हो गया',
  hu: 'A frissítés befejeződött',
  id: 'Pembaruan selesai',
  it: 'Aggiornamento completato',
  ja: 'アップデートが適用されました',
  kn: 'ನವೀಕರಣ ಪೂರ್ಣಗೊಂಡಿದೆ',
  ko: '업데이트가 적용되었어요',
  ml: 'അപ്‌ഡേറ്റ് പൂർത്തിയായി',
  mr: 'अपडेट पूर्ण झाले',
  ms: 'Kemas kini selesai',
  nb: 'Oppdateringen er fullført',
  nl: 'Update voltooid',
  pa: 'ਅੱਪਡੇਟ ਪੂਰਾ ਹੋ ਗਿਆ ਹੈ',
  pl: 'Aktualizacja zakończona',
  'pt-br': 'Atualização concluída',
  ro: 'Actualizare finalizată',
  ru: 'Обновление завершено',
  sv: 'Uppdateringen är klar',
  ta: 'புதுப்பிப்பு முடிந்தது',
  te: 'అప్‌డేట్ పూర్తయింది',
  th: 'อัปเดตเรียบร้อยแล้ว',
  tr: 'Güncelleme tamamlandı',
  uk: 'Оновлення завершено',
  ur: 'اپ ڈیٹ مکمل ہو گئی ہے',
  vi: 'Cập nhật hoàn tất',
  'zh-hans': '更新已完成',
  'zh-hant': '更新已完成',
} as const satisfies Readonly<Record<LanguageCode, string>>;

/** Remember a localized completion message across the imminent same-tab navigation. */
export function recordServiceWorkerUpdateCompletion(): void {
  const htmlLanguage = document.documentElement.lang.toLowerCase();
  const language = LANGUAGE_OPTIONS.find(
    ({ code, htmlLang }) => code === htmlLanguage || htmlLang.toLowerCase() === htmlLanguage,
  )?.code;
  try {
    sessionStorage.setItem(COMPLETION_MARKER, COMPLETION_MESSAGES[language ?? 'en']);
  } catch {
    // Storage may be unavailable; the update itself must still complete.
  }
}
