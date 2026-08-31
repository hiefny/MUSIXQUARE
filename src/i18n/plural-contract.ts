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
