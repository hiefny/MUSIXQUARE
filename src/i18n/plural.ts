import type { LanguageCode } from './index.ts';
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
} satisfies Partial<Record<LanguageCode, LocalePluralMessages>>;
