import type { LanguageCode } from './locales.ts';
import type { I18nKey } from './ko.ts';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export const PLURAL_PARAM_BY_KEY = {
  'playlist.delete_selected': 'count',
  'connect.device_list': 'count',
  'connect.administrator_list': 'count',
  'demo.session_body_connected': 'count',
  'chat.cmd_slowmode_on': 'sec',
  'chat.cmd_slowmode_wait': 'sec',
  'chat.tracks_added': 'count',
  'chat.tracks_added_named': 'count',
  'toast.added_tracks': 'count',
  'toast.unsupported_files_excluded': 'count',
  'dialog.file_drop.message': 'count',
  'dialog.file_drop.unsupported_notice': 'count',
} as const satisfies Partial<Record<I18nKey, string>>;

export type PluralI18nKey = keyof typeof PLURAL_PARAM_BY_KEY;
type PluralForms = Partial<Record<PluralCategory, string>>;
export type LocalePluralMessages = Partial<Record<PluralI18nKey, PluralForms>>;

/**
 * Manually authored grammatical variants for locales whose nouns change with
 * cardinal numbers. The ordinary locale dictionary remains the `other`
 * fallback, so languages with invariant counter forms need no duplicate copy.
 */
export const PLURAL_MESSAGES = {
  en: {
    'connect.administrator_list': { one: '{{count}} Administrator' },
    'playlist.delete_selected': { one: 'Delete {{count}} selected track' },
    'connect.device_list': { one: '{{count}} Connected Device' },
    'demo.session_body_connected': {
      one: '{{count}} device is connected right now.\nSet a role for this device.',
    },
    'chat.cmd_slowmode_on': { one: 'Slow mode: {{sec}} second between messages' },
    'chat.cmd_slowmode_wait': { one: 'Wait {{sec}} second before sending' },
    'chat.tracks_added': { one: '{{name}} added {{count}} track' },
    'chat.tracks_added_named': {
      one: '{{name}} added {{count}} track, including {{title}}',
    },
    'toast.added_tracks': { one: '{{count}} track added' },
    'toast.unsupported_files_excluded': { one: 'Unsupported file skipped: {{count}}' },
    'dialog.file_drop.message': { one: 'Add {{count}} file?' },
    'dialog.file_drop.unsupported_notice': {
      one: "{{count}} unsupported file won't be added.",
    },
  },
  de: {
    'connect.administrator_list': { one: '{{count}} Administrator' },
    'playlist.delete_selected': { one: '{{count}} ausgewählten Titel löschen' },
    'connect.device_list': { one: '{{count}} verbundenes Gerät' },
    'demo.session_body_connected': {
      one: '{{count}} Gerät ist gerade verbunden.\nLege für dieses Gerät eine Rolle fest.',
    },
    'chat.cmd_slowmode_on': { one: 'Langsammodus: {{sec}} Sekunde zwischen Nachrichten' },
    'chat.cmd_slowmode_wait': { one: 'Warte {{sec}} Sekunde vor dem Senden' },
    'chat.tracks_added': { one: '{{name}} hat {{count}} Titel hinzugefügt' },
    'chat.tracks_added_named': {
      one: '{{name}} hat {{count}} Titel hinzugefügt, darunter {{title}}',
    },
    'toast.added_tracks': { one: '{{count}} Titel hinzugefügt' },
    'toast.unsupported_files_excluded': {
      one: '{{count}} nicht unterstützte Datei übersprungen',
    },
    'dialog.file_drop.message': { one: '{{count}} Datei hinzufügen?' },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} nicht unterstützte Datei wird nicht hinzugefügt.',
    },
  },
  es: {
    'connect.administrator_list': { one: '{{count}} administrador' },
    'playlist.delete_selected': { one: 'Eliminar {{count}} pista seleccionada' },
    'connect.device_list': { one: '{{count}} dispositivo conectado' },
    'demo.session_body_connected': {
      one: '{{count}} dispositivo está conectado ahora.\nConfigura un rol para este dispositivo.',
    },
    'chat.cmd_slowmode_on': { one: 'Modo lento: {{sec}} segundo entre mensajes' },
    'chat.cmd_slowmode_wait': { one: 'Espera {{sec}} segundo antes de enviar' },
    'chat.tracks_added': { one: '{{name}} añadió {{count}} pista' },
    'chat.tracks_added_named': {
      one: '{{name}} añadió {{count}} pista, incluida {{title}}',
    },
    'toast.added_tracks': { one: '{{count}} pista añadida' },
    'toast.unsupported_files_excluded': {
      one: 'Archivo no compatible omitido: {{count}}',
    },
    'dialog.file_drop.message': { one: '¿Añadir {{count}} archivo?' },
    'dialog.file_drop.unsupported_notice': {
      one: 'No se añadirá {{count}} archivo no compatible.',
    },
  },
  fr: {
    'connect.administrator_list': { one: '{{count}} administrateur' },
    'playlist.delete_selected': { one: 'Supprimer {{count}} piste sélectionnée' },
    'connect.device_list': { one: '{{count}} appareil connecté' },
    'demo.session_body_connected': {
      one: '{{count}} appareil est actuellement connecté.\nDéfinissez un rôle pour cet appareil.',
    },
    'chat.cmd_slowmode_on': { one: 'Mode lent : {{sec}} seconde entre les messages' },
    'chat.cmd_slowmode_wait': { one: 'Attendez {{sec}} seconde avant d’envoyer' },
    'chat.tracks_added': { one: '{{name}} a ajouté {{count}} piste' },
    'chat.tracks_added_named': {
      one: '{{name}} a ajouté {{count}} piste, dont {{title}}',
    },
    'toast.added_tracks': { one: '{{count}} piste ajoutée' },
    'toast.unsupported_files_excluded': {
      one: 'Fichier non pris en charge ignoré : {{count}}',
    },
    'dialog.file_drop.message': { one: 'Ajouter {{count}} fichier ?' },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} fichier non pris en charge ne sera pas ajouté.',
    },
  },
  it: {
    'connect.administrator_list': { one: '{{count}} amministratore' },
    'playlist.delete_selected': { one: 'Elimina {{count}} traccia selezionata' },
    'connect.device_list': { one: '{{count}} dispositivo connesso' },
    'demo.session_body_connected': {
      one: 'Attualmente c’è {{count}} dispositivo connesso.\nAssegna un ruolo a questo dispositivo.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Modalità lenta attiva: puoi inviare un messaggio ogni {{sec}} secondo',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Attendi {{sec}} secondo prima di inviare un nuovo messaggio',
    },
    'chat.tracks_added': { one: '{{name}} ha aggiunto {{count}} traccia' },
    'chat.tracks_added_named': {
      one: '{{name}} ha aggiunto {{count}} traccia, inclusa {{title}}',
    },
    'toast.added_tracks': { one: '{{count}} traccia aggiunta' },
    'toast.unsupported_files_excluded': { one: '{{count}} file non supportato escluso' },
    'dialog.file_drop.message': { one: 'Aggiungere {{count}} file?' },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} file non supportato non verrà aggiunto.',
    },
  },
  nl: {
    'connect.administrator_list': { one: '{{count}} beheerder' },
    'playlist.delete_selected': { one: '{{count}} geselecteerde track verwijderen' },
    'connect.device_list': { one: '{{count}} verbonden apparaat' },
    'demo.session_body_connected': {
      one: 'Er is nu {{count}} apparaat verbonden.\nStel voor dit apparaat een rol in.',
    },
    'chat.cmd_slowmode_on': { one: 'Langzame modus: {{sec}} seconde tussen berichten' },
    'chat.cmd_slowmode_wait': {
      one: 'Wacht {{sec}} seconde voordat je een bericht verstuurt',
    },
    'chat.tracks_added': { one: '{{name}} heeft {{count}} track toegevoegd' },
    'chat.tracks_added_named': {
      one: '{{name}} heeft {{count}} track toegevoegd, waaronder {{title}}',
    },
    'toast.added_tracks': { one: '{{count}} track toegevoegd' },
    'toast.unsupported_files_excluded': {
      one: 'Niet-ondersteund bestand overgeslagen: {{count}}',
    },
    'dialog.file_drop.message': { one: '{{count}} bestand toevoegen?' },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} niet-ondersteund bestand wordt niet toegevoegd.',
    },
  },
  'pt-br': {
    'connect.administrator_list': { one: '{{count}} administrador' },
    'playlist.delete_selected': { one: 'Excluir {{count}} faixa selecionada' },
    'connect.device_list': { one: '{{count}} dispositivo conectado' },
    'demo.session_body_connected': {
      one: '{{count}} dispositivo está conectado agora.\nDefina uma função para este dispositivo.',
    },
    'chat.cmd_slowmode_on': { one: 'Modo lento: {{sec}} segundo entre mensagens' },
    'chat.cmd_slowmode_wait': { one: 'Aguarde {{sec}} segundo antes de enviar' },
    'chat.tracks_added': { one: '{{name}} adicionou {{count}} faixa' },
    'chat.tracks_added_named': {
      one: '{{name}} adicionou {{count}} faixa, incluindo {{title}}',
    },
    'toast.added_tracks': { one: '{{count}} faixa adicionada' },
    'toast.unsupported_files_excluded': {
      one: '{{count}} arquivo não compatível ignorado',
    },
    'dialog.file_drop.message': { one: 'Adicionar {{count}} arquivo?' },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} arquivo não compatível não será adicionado.',
    },
  },
  pl: {
    'connect.administrator_list': {
      one: 'Administrator: {{count}}',
      few: 'Administratorzy: {{count}}',
      many: 'Administratorzy: {{count}}',
    },
    'playlist.delete_selected': {
      one: 'Usuń {{count}} zaznaczony materiał',
      few: 'Usuń {{count}} zaznaczone materiały',
      many: 'Usuń {{count}} zaznaczonych materiałów',
    },
    'connect.device_list': {
      one: '{{count}} połączone urządzenie',
      few: '{{count}} połączone urządzenia',
      many: '{{count}} połączonych urządzeń',
    },
    'demo.session_body_connected': {
      one: 'Obecnie połączone jest {{count}} urządzenie.\nPrzypisz rolę do tego urządzenia.',
      few: 'Obecnie połączone są {{count}} urządzenia.\nPrzypisz rolę do każdego urządzenia.',
      many: 'Obecnie połączonych jest {{count}} urządzeń.\nPrzypisz rolę do każdego urządzenia.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Tryb spowolniony: wiadomości można wysyłać co {{sec}} sekundę',
      few: 'Tryb spowolniony: wiadomości można wysyłać co {{sec}} sekundy',
      many: 'Tryb spowolniony: wiadomości można wysyłać co {{sec}} sekund',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Poczekaj {{sec}} sekundę przed wysłaniem kolejnej wiadomości',
      few: 'Poczekaj {{sec}} sekundy przed wysłaniem kolejnej wiadomości',
      many: 'Poczekaj {{sec}} sekund przed wysłaniem kolejnej wiadomości',
    },
    'chat.tracks_added': {
      one: '{{name}}: dodano {{count}} materiał',
      few: '{{name}}: dodano {{count}} materiały',
      many: '{{name}}: dodano {{count}} materiałów',
    },
    'chat.tracks_added_named': {
      one: '{{name}}: dodano {{count}} materiał, w tym {{title}}',
      few: '{{name}}: dodano {{count}} materiały, w tym {{title}}',
      many: '{{name}}: dodano {{count}} materiałów, w tym {{title}}',
    },
    'toast.added_tracks': {
      one: 'Dodano {{count}} materiał',
      few: 'Dodano {{count}} materiały',
      many: 'Dodano {{count}} materiałów',
    },
    'toast.unsupported_files_excluded': {
      one: 'Pominięto {{count}} nieobsługiwany plik',
      few: 'Pominięto {{count}} nieobsługiwane pliki',
      many: 'Pominięto {{count}} nieobsługiwanych plików',
    },
    'dialog.file_drop.message': {
      one: 'Dodać {{count}} plik?',
      few: 'Dodać {{count}} pliki?',
      many: 'Dodać {{count}} plików?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} nieobsługiwany plik nie zostanie dodany.',
      few: '{{count}} nieobsługiwane pliki nie zostaną dodane.',
      many: '{{count}} nieobsługiwanych plików nie zostanie dodanych.',
    },
  },
  ru: {
    'connect.administrator_list': {
      one: '{{count}} администратор',
      few: '{{count}} администратора',
      many: '{{count}} администраторов',
    },
    'playlist.delete_selected': {
      one: 'Удалить {{count}} выбранный материал',
      few: 'Удалить {{count}} выбранных материала',
      many: 'Удалить {{count}} выбранных материалов',
    },
    'connect.device_list': {
      one: 'Подключено {{count}} устройство',
      few: 'Подключено {{count}} устройства',
      many: 'Подключено {{count}} устройств',
    },
    'demo.session_body_connected': {
      one: 'Сейчас подключено {{count}} устройство.\nНазначьте роль этому устройству.',
      few: 'Сейчас подключено {{count}} устройства.\nНазначьте роль каждому устройству.',
      many: 'Сейчас подключено {{count}} устройств.\nНазначьте роль каждому устройству.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Медленный режим: одно сообщение в {{sec}} секунду',
      few: 'Медленный режим: одно сообщение в {{sec}} секунды',
      many: 'Медленный режим: одно сообщение в {{sec}} секунд',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Подождите {{sec}} секунду перед отправкой следующего сообщения',
      few: 'Подождите {{sec}} секунды перед отправкой следующего сообщения',
      many: 'Подождите {{sec}} секунд перед отправкой следующего сообщения',
    },
    'chat.tracks_added': {
      one: 'Добавлен {{count}} материал ({{name}})',
      few: 'Добавлено {{count}} материала ({{name}})',
      many: 'Добавлено {{count}} материалов ({{name}})',
    },
    'chat.tracks_added_named': {
      one: 'Добавлен {{count}} материал, включая {{title}} ({{name}})',
      few: 'Добавлено {{count}} материала, включая {{title}} ({{name}})',
      many: 'Добавлено {{count}} материалов, включая {{title}} ({{name}})',
    },
    'toast.added_tracks': {
      one: 'Добавлен {{count}} материал',
      few: 'Добавлено {{count}} материала',
      many: 'Добавлено {{count}} материалов',
    },
    'toast.unsupported_files_excluded': {
      one: 'Пропущен {{count}} неподдерживаемый файл',
      few: 'Пропущено {{count}} неподдерживаемых файла',
      many: 'Пропущено {{count}} неподдерживаемых файлов',
    },
    'dialog.file_drop.message': {
      one: 'Добавить {{count}} файл?',
      few: 'Добавить {{count}} файла?',
      many: 'Добавить {{count}} файлов?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} неподдерживаемый файл не будет добавлен.',
      few: '{{count}} неподдерживаемых файла не будут добавлены.',
      many: '{{count}} неподдерживаемых файлов не будут добавлены.',
    },
  },
  ro: {
    'connect.device_list': {
      one: '{{count}} dispozitiv conectat',
      other: '{{count}} de dispozitive conectate',
    },
    'connect.administrator_list': {
      one: '{{count}} administrator',
      other: '{{count}} de administratori',
    },
    'demo.session_body_connected': {
      one: 'În acest moment este conectat {{count}} dispozitiv.\nSetează un rol pentru acest dispozitiv.',
      other:
        'În acest moment sunt conectate {{count}} de dispozitive.\nSetează un rol pentru fiecare.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Mod lent: {{sec}} secundă între mesaje',
      other: 'Mod lent: {{sec}} de secunde între mesaje',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Așteaptă {{sec}} secundă înainte de a trimite',
      other: 'Așteaptă {{sec}} de secunde înainte de a trimite',
    },
    'chat.tracks_added': {
      one: '{{name}} a adăugat {{count}} pistă',
      other: '{{name}} a adăugat {{count}} de piste',
    },
    'chat.tracks_added_named': {
      one: '{{name}} a adăugat {{count}} pistă, inclusiv {{title}}',
      other: '{{name}} a adăugat {{count}} de piste, inclusiv {{title}}',
    },
    'toast.added_tracks': {
      one: '{{count}} pistă adăugată',
      other: '{{count}} de piste adăugate',
    },
    'dialog.file_drop.message': {
      one: 'Adaugi {{count}} fișier?',
      other: 'Adaugi {{count}} de fișiere?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} fișier neacceptat nu va fi adăugat.',
      other: '{{count}} de fișiere neacceptate nu vor fi adăugate.',
    },
  },
  ar: {
    'playlist.delete_selected': {
      one: 'حذف {{count}} مقطع محدد',
      two: 'حذف {{count}} مقطعين محددين',
      few: 'حذف {{count}} مقاطع محددة',
      many: 'حذف {{count}} مقطعًا محددًا',
    },
    'demo.session_body_connected': {
      one: 'هناك {{count}} جهاز متصل الآن.\nعيّن دورًا لهذا الجهاز.',
      two: 'هناك {{count}} جهازان متصلان الآن.\nعيّن دورًا لكلا الجهازين.',
      few: 'هناك {{count}} أجهزة متصلة الآن.\nعيّن دورًا لكل جهاز.',
      many: 'هناك {{count}} جهازًا متصلًا الآن.\nعيّن دورًا لكل جهاز.',
    },
    'chat.cmd_slowmode_on': {
      two: 'الوضع البطيء: {{sec}} ثانيتان بين الرسائل',
      few: 'الوضع البطيء: {{sec}} ثوانٍ بين الرسائل',
    },
    'chat.cmd_slowmode_wait': {
      two: 'انتظر {{sec}} ثانيتين قبل الإرسال',
      few: 'انتظر {{sec}} ثوانٍ قبل الإرسال',
    },
    'chat.tracks_added': {
      one: 'أضاف {{name}} {{count}} مقطعًا',
      two: 'أضاف {{name}} {{count}} مقطعين',
      few: 'أضاف {{name}} {{count}} مقاطع',
      many: 'أضاف {{name}} {{count}} مقطعًا',
    },
    'chat.tracks_added_named': {
      one: 'أضاف {{name}} {{count}} مقطعًا، وهو {{title}}',
      two: 'أضاف {{name}} {{count}} مقطعين، منهما {{title}}',
      few: 'أضاف {{name}} {{count}} مقاطع، منها {{title}}',
      many: 'أضاف {{name}} {{count}} مقطعًا، منها {{title}}',
    },
    'toast.added_tracks': {
      one: 'تمت إضافة {{count}} مقطع',
      two: 'تمت إضافة {{count}} مقطعين',
      few: 'تمت إضافة {{count}} مقاطع',
      many: 'تمت إضافة {{count}} مقطعًا',
    },
    'dialog.file_drop.message': {
      one: 'هل تريد إضافة {{count}} ملف؟',
      two: 'هل تريد إضافة {{count}} ملفين؟',
      few: 'هل تريد إضافة {{count}} ملفات؟',
      many: 'هل تريد إضافة {{count}} ملفًا؟',
    },
    'dialog.file_drop.unsupported_notice': {
      one: 'لن تتم إضافة {{count}} ملف غير مدعوم.',
      two: 'لن تتم إضافة {{count}} ملفين غير مدعومين.',
      few: 'لن تتم إضافة {{count}} ملفات غير مدعومة.',
      many: 'لن تتم إضافة {{count}} ملفًا غير مدعوم.',
    },
  },
  ur: {
    'playlist.delete_selected': {
      one: 'منتخب کیا گیا {{count}} ٹریک حذف کریں',
    },
    'demo.session_body_connected': {
      one: 'اس وقت {{count}} آلہ منسلک ہے۔\nاس آلے کا کردار مقرر کریں۔',
    },
    'chat.tracks_added': {
      one: '{{name}} نے {{count}} ٹریک شامل کیا',
    },
    'chat.tracks_added_named': {
      one: '{{name}} نے {{count}} ٹریک شامل کیا، یعنی {{title}}',
    },
    'toast.added_tracks': {
      one: '{{count}} ٹریک شامل ہوا',
    },
    'dialog.file_drop.message': {
      one: '{{count}} فائل شامل کریں؟',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} غیر معاون فائل شامل نہیں کی جائے گی۔',
    },
  },
  he: {
    'playlist.delete_selected': {
      one: 'מחיקת {{count}} רצועה שנבחרה',
    },
    'demo.session_body_connected': {
      one: '{{count}} מכשיר מחובר עכשיו.\nיש להגדיר תפקיד למכשיר הזה.',
    },
    'chat.cmd_slowmode_on': {
      one: 'מצב איטי: {{sec}} שנייה בין הודעות',
    },
    'chat.cmd_slowmode_wait': {
      one: 'יש להמתין {{sec}} שנייה לפני השליחה',
    },
    'chat.tracks_added': {
      one: 'נוספה {{count}} רצועה על ידי {{name}}',
    },
    'chat.tracks_added_named': {
      one: 'נוספה {{count}} רצועה על ידי {{name}}, כולל {{title}}',
    },
    'toast.added_tracks': {
      one: 'נוספה {{count}} רצועה',
    },
    'dialog.file_drop.message': {
      one: 'להוסיף {{count}} קובץ?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} קובץ שאינו נתמך לא יתווסף.',
    },
  },
  sv: {
    'playlist.delete_selected': {
      one: 'Radera {{count}} markerat spår',
    },
    'demo.session_body_connected': {
      one: '{{count}} enhet är ansluten just nu.\nAnge en roll för den här enheten.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Långsamt läge: {{sec}} sekund mellan meddelanden',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Vänta {{sec}} sekund innan du skickar',
    },
    'dialog.file_drop.message': {
      one: 'Lägg till {{count}} fil?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} fil som inte stöds kommer inte att läggas till.',
    },
  },
  da: {
    'playlist.delete_selected': {
      one: 'Slet {{count}} markeret nummer',
    },
    'demo.session_body_connected': {
      one: '{{count}} enhed er forbundet lige nu.\nAngiv en rolle for denne enhed.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Langsom tilstand: {{sec}} sekund mellem beskeder',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Vent {{sec}} sekund, før du sender',
    },
    'chat.tracks_added': {
      one: '{{name}} tilføjede {{count}} nummer',
    },
    'chat.tracks_added_named': {
      one: '{{name}} tilføjede {{count}} nummer, herunder {{title}}',
    },
    'toast.added_tracks': {
      one: '{{count}} nummer blev tilføjet',
    },
    'dialog.file_drop.message': {
      one: 'Tilføj {{count}} fil?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} fil, der ikke understøttes, bliver ikke tilføjet.',
    },
  },
  nb: {
    'playlist.delete_selected': {
      one: 'Slett {{count}} merket spor',
    },
    'demo.session_body_connected': {
      one: '{{count}} enhet er tilkoblet nå.\nAngi en rolle for denne enheten.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Sakte modus: {{sec}} sekund mellom meldinger',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Vent {{sec}} sekund før du sender',
    },
    'dialog.file_drop.message': {
      one: 'Legg til {{count}} fil?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} fil som ikke støttes, blir ikke lagt til.',
    },
  },
  fi: {
    'playlist.delete_selected': {
      one: 'Poista {{count}} valittu kappale',
    },
    'demo.session_body_connected': {
      one: 'Yhdistettynä on nyt {{count}} laite.\nAseta tälle laitteelle rooli.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Hidas tila: viestien välillä {{sec}} sekunti',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Odota {{sec}} sekunti ennen lähettämistä',
    },
    'chat.tracks_added': {
      one: '{{name}} lisäsi {{count}} kappaleen',
    },
    'chat.tracks_added_named': {
      one: '{{name}} lisäsi {{count}} kappaleen ({{title}})',
    },
    'toast.added_tracks': {
      one: 'Lisättiin {{count}} kappale',
    },
    'dialog.file_drop.message': {
      one: 'Lisätäänkö {{count}} tiedosto?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} tiedosto, jota ei tueta, jätetään lisäämättä.',
    },
  },
  // Hindi `one` covers both 0 and 1. These variants therefore use
  // count-neutral labels instead of forcing singular agreement at zero.
  hi: {
    'playlist.delete_selected': {
      one: 'चयनित ट्रैक मिटाएँ ({{count}})',
    },
    'connect.device_list': {
      one: 'कनेक्टेड डिवाइस की संख्या: {{count}}',
    },
    'demo.session_body_connected': {
      one: 'अभी कनेक्टेड डिवाइस की संख्या: {{count}}।\nहर कनेक्टेड डिवाइस के लिए भूमिका सेट करें।',
    },
    'chat.tracks_added': {
      one: '{{name}} द्वारा जोड़े गए ट्रैक: {{count}}',
    },
    'chat.tracks_added_named': {
      one: '{{name}} द्वारा जोड़े गए ट्रैक: {{count}}, जिनमें {{title}} शामिल है',
    },
    'toast.added_tracks': {
      one: 'जोड़े गए ट्रैक: {{count}}',
    },
    'dialog.file_drop.message': {
      one: 'जोड़ने के लिए फ़ाइलें: {{count}}। आगे बढ़ें?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: 'नहीं जोड़ी जाने वाली असमर्थित फ़ाइलें: {{count}}।',
    },
  },

  // Bengali intentionally needs no overrides: টি/জন classifiers, nouns,
  // duration units, and predicates in all 12 base messages are number-invariant.

  ta: {
    'playlist.delete_selected': {
      one: 'தேர்ந்தெடுத்த {{count}} டிராக்கை நீக்கு',
    },
    'connect.device_list': {
      one: 'இணைக்கப்பட்ட சாதனம்: {{count}}',
    },
    'connect.administrator_list': {
      one: 'நிர்வாகி: {{count}}',
    },
    'demo.session_body_connected': {
      one: 'இப்போது {{count}} சாதனம் இணைந்துள்ளது.\nஇந்தச் சாதனத்துக்கு ஒரு பங்கை அமைக்கவும்.',
    },
    'chat.cmd_slowmode_on': {
      one: 'மெதுவான பயன்முறை: செய்திகளுக்கு இடையில் {{sec}} வினாடி',
    },
    'chat.cmd_slowmode_wait': {
      one: 'அனுப்புவதற்கு முன் {{sec}} வினாடி காத்திருக்கவும்',
    },
    'chat.tracks_added': {
      one: '{{name}} {{count}} டிராக்கைச் சேர்த்தார்',
    },
    'chat.tracks_added_named': {
      one: '{{name}} {{title}} உட்பட {{count}} டிராக்கைச் சேர்த்தார்',
    },
    'toast.added_tracks': {
      one: '{{count}} டிராக் சேர்க்கப்பட்டது',
    },
    'toast.unsupported_files_excluded': {
      one: 'ஆதரிக்கப்படாத கோப்பு தவிர்க்கப்பட்டது: {{count}}',
    },
    'dialog.file_drop.message': {
      one: '{{count}} கோப்பைச் சேர்க்கவா?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: 'ஆதரிக்கப்படாத {{count}} கோப்பு சேர்க்கப்படாது.',
    },
  },

  te: {
    'playlist.delete_selected': {
      one: 'ఎంచుకున్న {{count}} ట్రాక్‌ను తొలగించు',
    },
    'connect.device_list': {
      one: 'కనెక్ట్ అయిన పరికరం: {{count}}',
    },
    'connect.administrator_list': {
      one: 'అడ్మిన్: {{count}}',
    },
    'demo.session_body_connected': {
      one: 'ప్రస్తుతం {{count}} పరికరం కనెక్ట్ అయింది.\nఈ పరికరానికి ఒక పాత్రను సెట్ చేయండి.',
    },
    'chat.cmd_slowmode_on': {
      one: 'స్లో మోడ్: సందేశాల మధ్య {{sec}} సెకను',
    },
    'chat.cmd_slowmode_wait': {
      one: 'పంపడానికి ముందు {{sec}} సెకను వేచి ఉండండి',
    },
    'chat.tracks_added': {
      one: '{{name}} {{count}} ట్రాక్‌ను జోడించారు',
    },
    'chat.tracks_added_named': {
      one: '{{name}} {{title}}తో కలిపి {{count}} ట్రాక్‌ను జోడించారు',
    },
    'toast.added_tracks': {
      one: '{{count}} ట్రాక్ జోడించబడింది',
    },
    'toast.unsupported_files_excluded': {
      one: 'మద్దతు లేని ఫైల్ దాటవేయబడింది: {{count}}',
    },
    'dialog.file_drop.message': {
      one: '{{count}} ఫైల్‌ను జోడించాలా?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: 'మద్దతు లేని {{count}} ఫైల్ జోడించబడదు.',
    },
  },

  mr: {
    'playlist.delete_selected': {
      one: 'निवडलेला {{count}} ट्रॅक हटवा',
    },
    'connect.device_list': {
      one: 'कनेक्ट केलेले {{count}} डिव्हाइस',
    },
    'demo.session_body_connected': {
      one: 'सध्या {{count}} डिव्हाइस कनेक्ट आहे.\nया डिव्हाइसची भूमिका ठरवा.',
    },
    'chat.tracks_added': {
      one: '{{name}} यांनी {{count}} ट्रॅक जोडला',
    },
    'chat.tracks_added_named': {
      one: '{{name}} यांनी {{title}} सह {{count}} ट्रॅक जोडला',
    },
    'toast.added_tracks': {
      one: '{{count}} ट्रॅक जोडला',
    },
    'toast.unsupported_files_excluded': {
      one: 'असमर्थित फाइल वगळली: {{count}}',
    },
    'dialog.file_drop.message': {
      one: '{{count}} फाइल जोडायची?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: '{{count}} असमर्थित फाइल जोडली जाणार नाही.',
    },
  },

  // Gujarati `one` covers both 0 and 1, so the forms below express a count
  // rather than attaching singular agreement directly to the numeral.
  gu: {
    'playlist.delete_selected': {
      one: 'કાઢી નાખવાના પસંદ કરેલા ટ્રૅકની સંખ્યા: {{count}}',
    },
    'connect.device_list': {
      one: 'જોડાયેલા ડિવાઇસની સંખ્યા: {{count}}',
    },
    'connect.administrator_list': {
      one: 'સંચાલકોની સંખ્યા: {{count}}',
    },
    'demo.session_body_connected': {
      one: 'હમણાં જોડાયેલા ડિવાઇસની સંખ્યા: {{count}}.\nદરેક ડિવાઇસની ભૂમિકા નક્કી કરો.',
    },
    'chat.tracks_added': {
      one: '{{name}} એ ઉમેરેલા ટ્રૅકની સંખ્યા: {{count}}',
    },
    'chat.tracks_added_named': {
      one: '{{name}} એ {{title}} સહિત ઉમેરેલા ટ્રૅકની સંખ્યા: {{count}}',
    },
    'toast.added_tracks': {
      one: 'ઉમેરેલા ટ્રૅકની સંખ્યા: {{count}}',
    },
    'toast.unsupported_files_excluded': {
      one: 'છોડી દેવાયેલી અસમર્થિત ફાઇલોની સંખ્યા: {{count}}',
    },
    'dialog.file_drop.message': {
      one: 'ઉમેરવાની ફાઇલોની સંખ્યા {{count}} છે. આગળ વધવું છે?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: 'ઉમેરવામાં નહીં આવે એવી અસમર્થિત ફાઇલોની સંખ્યા: {{count}}.',
    },
  },

  // Kannada `one` also covers 0 and 1. Count-noun phrases are deliberately
  // neutralized so zero never receives a singular predicate.
  kn: {
    'playlist.delete_selected': {
      one: 'ಆರಿಸಿದ ಟ್ರ್ಯಾಕ್‌ಗಳನ್ನು ಅಳಿಸಿ ({{count}})',
    },
    'connect.device_list': {
      one: 'ಸಂಪರ್ಕಗೊಂಡ ಸಾಧನಗಳ ಸಂಖ್ಯೆ: {{count}}',
    },
    'connect.administrator_list': {
      one: 'ನಿರ್ವಾಹಕರ ಸಂಖ್ಯೆ: {{count}}',
    },
    'demo.session_body_connected': {
      one: 'ಈಗ ಸಂಪರ್ಕಗೊಂಡ ಸಾಧನಗಳ ಸಂಖ್ಯೆ: {{count}}.\nಸಂಪರ್ಕಗೊಂಡ ಪ್ರತಿ ಸಾಧನಕ್ಕೂ ಪಾತ್ರ ಹೊಂದಿಸಿ.',
    },
    'chat.tracks_added': {
      one: '{{name}} ಸೇರಿಸಿದ ಟ್ರ್ಯಾಕ್‌ಗಳ ಸಂಖ್ಯೆ: {{count}}',
    },
    'chat.tracks_added_named': {
      one: '{{name}} {{title}} ಸೇರಿದಂತೆ ಸೇರಿಸಿದ ಟ್ರ್ಯಾಕ್‌ಗಳ ಸಂಖ್ಯೆ: {{count}}',
    },
    'toast.added_tracks': {
      one: 'ಸೇರಿಸಿದ ಟ್ರ್ಯಾಕ್‌ಗಳ ಸಂಖ್ಯೆ: {{count}}',
    },
    'toast.unsupported_files_excluded': {
      one: 'ಬಿಟ್ಟುಬಿಡಲಾದ ಬೆಂಬಲಿಸದ ಫೈಲ್‌ಗಳ ಸಂಖ್ಯೆ: {{count}}',
    },
    'dialog.file_drop.message': {
      one: 'ಸೇರಿಸಬೇಕಾದ ಫೈಲ್‌ಗಳ ಸಂಖ್ಯೆ {{count}}. ಮುಂದುವರಿಯಬೇಕೆ?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: 'ಸೇರಿಸದೇ ಬಿಡುವ ಬೆಂಬಲಿಸದ ಫೈಲ್‌ಗಳ ಸಂಖ್ಯೆ: {{count}}.',
    },
  },

  ml: {
    'playlist.delete_selected': {
      one: 'തിരഞ്ഞെടുത്ത {{count}} ട്രാക്ക് ഇല്ലാതാക്കുക',
    },
    'connect.device_list': {
      one: 'ബന്ധിപ്പിച്ച ഡിവൈസ്: {{count}}',
    },
    'connect.administrator_list': {
      one: 'അഡ്മിൻ: {{count}}',
    },
    'demo.session_body_connected': {
      one: 'ഇപ്പോൾ {{count}} ഡിവൈസ് ബന്ധിപ്പിച്ചിട്ടുണ്ട്.\nഈ ഡിവൈസിന് ഒരു റോൾ സജ്ജമാക്കുക.',
    },
    'chat.tracks_added': {
      one: '{{name}} {{count}} ട്രാക്ക് ചേർത്തു',
    },
    'chat.tracks_added_named': {
      one: '{{name}} {{title}} ഉൾപ്പെടെ {{count}} ട്രാക്ക് ചേർത്തു',
    },
    'toast.added_tracks': {
      one: '{{count}} ട്രാക്ക് ചേർത്തു',
    },
    'toast.unsupported_files_excluded': {
      one: 'പിന്തുണയ്ക്കാത്ത ഫയൽ ഒഴിവാക്കി: {{count}}',
    },
    'dialog.file_drop.message': {
      one: '{{count}} ഫയൽ ചേർക്കണോ?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: 'പിന്തുണയ്ക്കാത്ത {{count}} ഫയൽ ചേർക്കില്ല.',
    },
  },

  // Punjabi `one` covers both 0 and 1; count-neutral wording keeps both values
  // grammatical without changing the ordinary 2+ forms.
  pa: {
    'playlist.delete_selected': {
      one: 'ਚੁਣੇ ਟਰੈਕ ਮਿਟਾਓ ({{count}})',
    },
    'connect.device_list': {
      one: 'ਜੁੜੀਆਂ ਡਿਵਾਈਸਾਂ ਦੀ ਗਿਣਤੀ: {{count}}',
    },
    'demo.session_body_connected': {
      one: 'ਇਸ ਵੇਲੇ ਜੁੜੀਆਂ ਡਿਵਾਈਸਾਂ ਦੀ ਗਿਣਤੀ: {{count}}।\nਹਰ ਜੁੜੀ ਡਿਵਾਈਸ ਦੀ ਭੂਮਿਕਾ ਸੈੱਟ ਕਰੋ।',
    },
    'chat.tracks_added': {
      one: '{{name}} ਵੱਲੋਂ ਜੋੜੇ ਟਰੈਕਾਂ ਦੀ ਗਿਣਤੀ: {{count}}',
    },
    'chat.tracks_added_named': {
      one: '{{name}} ਵੱਲੋਂ {{title}} ਸਮੇਤ ਜੋੜੇ ਟਰੈਕਾਂ ਦੀ ਗਿਣਤੀ: {{count}}',
    },
    'toast.added_tracks': {
      one: 'ਜੋੜੇ ਗਏ ਟਰੈਕਾਂ ਦੀ ਗਿਣਤੀ: {{count}}',
    },
    'toast.unsupported_files_excluded': {
      one: 'ਛੱਡੀਆਂ ਗਈਆਂ ਨਾ-ਚੱਲਣ ਵਾਲੀਆਂ ਫ਼ਾਈਲਾਂ ਦੀ ਗਿਣਤੀ: {{count}}',
    },
    'dialog.file_drop.message': {
      one: 'ਜੋੜੀਆਂ ਜਾਣ ਵਾਲੀਆਂ ਫ਼ਾਈਲਾਂ ਦੀ ਗਿਣਤੀ {{count}} ਹੈ। ਅੱਗੇ ਵਧਣਾ ਹੈ?',
    },
    'dialog.file_drop.unsupported_notice': {
      one: 'ਨਾ ਜੋੜੀਆਂ ਜਾਣ ਵਾਲੀਆਂ ਨਾ-ਚੱਲਣ ਵਾਲੀਆਂ ਫ਼ਾਈਲਾਂ ਦੀ ਗਿਣਤੀ: {{count}}।',
    },
  },
} satisfies Partial<Record<LanguageCode, LocalePluralMessages>>;
