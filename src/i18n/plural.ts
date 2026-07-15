import type { LanguageCode } from './index.ts';
import type { I18nKey } from './ko.ts';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export const PLURAL_PARAM_BY_KEY = {
  'playlist.delete_selected': 'count',
  'connect.device_list': 'count',
  'connect.cannot_reduce': 'count',
  'demo.session_body_connected': 'count',
  'chat.cmd_slowmode_on': 'sec',
  'chat.cmd_slowmode_wait': 'sec',
  'toast.added_tracks': 'count',
  'dialog.file_drop.message': 'count',
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
    'playlist.delete_selected': { one: 'Delete {{count}} selected track' },
    'connect.device_list': { one: '{{count}} Connected Device' },
    'connect.cannot_reduce': {
      one: 'Cannot reduce capacity: {{count}} device is already connected',
    },
    'demo.session_body_connected': {
      one: '{{count}} device is connected right now.\nSet a role for this device.',
    },
    'chat.cmd_slowmode_on': { one: 'Slow mode: {{sec}} second between messages' },
    'chat.cmd_slowmode_wait': { one: 'Wait {{sec}} second before sending' },
    'toast.added_tracks': { one: '{{count}} track added' },
    'dialog.file_drop.message': { one: 'Add {{count}} track?' },
  },
  de: {
    'playlist.delete_selected': { one: '{{count}} ausgewählten Titel löschen' },
    'connect.device_list': { one: '{{count}} verbundenes Gerät' },
    'connect.cannot_reduce': {
      one: 'Kapazität kann nicht reduziert werden: {{count}} Gerät ist bereits verbunden',
    },
    'demo.session_body_connected': {
      one: '{{count}} Gerät ist gerade verbunden.\nLege für dieses Gerät eine Rolle fest.',
    },
    'chat.cmd_slowmode_on': { one: 'Langsammodus: {{sec}} Sekunde zwischen Nachrichten' },
    'chat.cmd_slowmode_wait': { one: 'Warte {{sec}} Sekunde vor dem Senden' },
    'toast.added_tracks': { one: '{{count}} Titel hinzugefügt' },
    'dialog.file_drop.message': { one: '{{count}} Titel hinzufügen?' },
  },
  es: {
    'playlist.delete_selected': { one: 'Eliminar {{count}} pista seleccionada' },
    'connect.device_list': { one: '{{count}} dispositivo conectado' },
    'connect.cannot_reduce': {
      one: 'No se puede reducir la capacidad: ya hay {{count}} dispositivo conectado',
    },
    'demo.session_body_connected': {
      one: '{{count}} dispositivo está conectado ahora.\nConfigura un rol para este dispositivo.',
    },
    'chat.cmd_slowmode_on': { one: 'Modo lento: {{sec}} segundo entre mensajes' },
    'chat.cmd_slowmode_wait': { one: 'Espera {{sec}} segundo antes de enviar' },
    'toast.added_tracks': { one: '{{count}} pista añadida' },
    'dialog.file_drop.message': { one: '¿Agregar {{count}} pista?' },
  },
  fr: {
    'playlist.delete_selected': { one: 'Supprimer {{count}} titre sélectionné' },
    'connect.device_list': { one: '{{count}} appareil connecté' },
    'connect.cannot_reduce': {
      one: 'Impossible de réduire la capacité : {{count}} appareil est déjà connecté',
    },
    'demo.session_body_connected': {
      one: '{{count}} appareil est connecté actuellement.\nDéfinissez un rôle pour cet appareil.',
    },
    'chat.cmd_slowmode_on': { one: 'Mode lent : {{sec}} seconde entre les messages' },
    'chat.cmd_slowmode_wait': { one: 'Attendez {{sec}} seconde avant d’envoyer' },
    'toast.added_tracks': { one: '{{count}} piste ajoutée' },
    'dialog.file_drop.message': { one: 'Ajouter {{count}} morceau ?' },
  },
  it: {
    'playlist.delete_selected': { one: 'Elimina {{count}} brano selezionato' },
    'connect.device_list': { one: '{{count}} dispositivo connesso' },
    'connect.cannot_reduce': {
      one: 'Impossibile ridurre la capacità: c’è già {{count}} dispositivo connesso',
    },
    'demo.session_body_connected': {
      one: 'Attualmente c’è {{count}} dispositivo connesso.\nAssegna un ruolo a questo dispositivo.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Slow mode attiva: puoi inviare un messaggio ogni {{sec}} secondo',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Attendi {{sec}} secondo prima di inviare un nuovo messaggio',
    },
    'toast.added_tracks': { one: '{{count}} brano aggiunto' },
    'dialog.file_drop.message': { one: 'Aggiungere {{count}} brano?' },
  },
  nl: {
    'playlist.delete_selected': { one: '{{count}} geselecteerd nummer verwijderen' },
    'connect.device_list': { one: '{{count}} verbonden apparaat' },
    'connect.cannot_reduce': {
      one: 'Limiet kan niet omlaag: er is al {{count}} apparaat verbonden',
    },
    'demo.session_body_connected': {
      one: 'Er is nu {{count}} apparaat verbonden.\nStel voor dit apparaat een rol in.',
    },
    'chat.cmd_slowmode_on': { one: 'Langzame modus: {{sec}} seconde tussen berichten' },
    'chat.cmd_slowmode_wait': { one: 'Wacht {{sec}} seconde voordat je verstuurt' },
    'toast.added_tracks': { one: '{{count}} nummer toegevoegd' },
    'dialog.file_drop.message': { one: '{{count}} nummer toevoegen?' },
  },
  'pt-br': {
    'playlist.delete_selected': { one: 'Excluir {{count}} faixa selecionada' },
    'connect.device_list': { one: '{{count}} dispositivo conectado' },
    'connect.cannot_reduce': {
      one: 'Não é possível reduzir a capacidade: {{count}} dispositivo já está conectado',
    },
    'demo.session_body_connected': {
      one: '{{count}} dispositivo está conectado agora.\nDefina um papel para este dispositivo.',
    },
    'chat.cmd_slowmode_on': { one: 'Modo lento: {{sec}} segundo entre mensagens' },
    'chat.cmd_slowmode_wait': { one: 'Aguarde {{sec}} segundo antes de enviar' },
    'toast.added_tracks': { one: '{{count}} faixa adicionada' },
    'dialog.file_drop.message': { one: 'Adicionar {{count}} faixa?' },
  },
  pl: {
    'playlist.delete_selected': {
      one: 'Usuń {{count}} zaznaczony utwór',
      few: 'Usuń {{count}} zaznaczone utwory',
      many: 'Usuń {{count}} zaznaczonych utworów',
    },
    'connect.device_list': {
      one: '{{count}} połączone urządzenie',
      few: '{{count}} połączone urządzenia',
      many: '{{count}} połączonych urządzeń',
    },
    'connect.cannot_reduce': {
      one: 'Nie można zmniejszyć pojemności: połączone jest już {{count}} urządzenie',
      few: 'Nie można zmniejszyć pojemności: połączone są już {{count}} urządzenia',
      many: 'Nie można zmniejszyć pojemności: połączonych jest już {{count}} urządzeń',
    },
    'demo.session_body_connected': {
      one: 'Połączone jest teraz {{count}} urządzenie.\nPrzypisz rolę do tego urządzenia.',
      few: 'Połączone są teraz {{count}} urządzenia.\nPrzypisz rolę do każdego urządzenia.',
      many: 'Połączonych jest teraz {{count}} urządzeń.\nPrzypisz rolę do każdego urządzenia.',
    },
    'chat.cmd_slowmode_on': {
      one: 'Slow mode: wiadomości można wysyłać co {{sec}} sekundę',
      few: 'Slow mode: wiadomości można wysyłać co {{sec}} sekundy',
      many: 'Slow mode: wiadomości można wysyłać co {{sec}} sekund',
    },
    'chat.cmd_slowmode_wait': {
      one: 'Poczekaj {{sec}} sekundę przed wysłaniem kolejnej wiadomości',
      few: 'Poczekaj {{sec}} sekundy przed wysłaniem kolejnej wiadomości',
      many: 'Poczekaj {{sec}} sekund przed wysłaniem kolejnej wiadomości',
    },
    'toast.added_tracks': {
      one: 'Dodano {{count}} utwór',
      few: 'Dodano {{count}} utwory',
      many: 'Dodano {{count}} utworów',
    },
    'dialog.file_drop.message': {
      one: 'Dodać {{count}} utwór?',
      few: 'Dodać {{count}} utwory?',
      many: 'Dodać {{count}} utworów?',
    },
  },
  ru: {
    'playlist.delete_selected': {
      one: 'Удалить {{count}} выбранный трек',
      few: 'Удалить {{count}} выбранных трека',
      many: 'Удалить {{count}} выбранных треков',
    },
    'connect.device_list': {
      one: 'Подключено {{count}} устройство',
      few: 'Подключено {{count}} устройства',
      many: 'Подключено {{count}} устройств',
    },
    'connect.cannot_reduce': {
      one: 'Невозможно уменьшить лимит: уже подключено {{count}} устройство',
      few: 'Невозможно уменьшить лимит: уже подключено {{count}} устройства',
      many: 'Невозможно уменьшить лимит: уже подключено {{count}} устройств',
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
    'toast.added_tracks': {
      one: 'Добавлен {{count}} трек',
      few: 'Добавлено {{count}} трека',
      many: 'Добавлено {{count}} треков',
    },
    'dialog.file_drop.message': {
      one: 'Добавить {{count}} трек?',
      few: 'Добавить {{count}} трека?',
      many: 'Добавить {{count}} треков?',
    },
  },
} satisfies Partial<Record<LanguageCode, LocalePluralMessages>>;
