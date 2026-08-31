import type { LocalePluralMessages } from './plural-contract.ts';

/** English is eager because it is the immediate, no-network fallback locale. */
export const EN_PLURAL_MESSAGES = {
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
} satisfies LocalePluralMessages;
