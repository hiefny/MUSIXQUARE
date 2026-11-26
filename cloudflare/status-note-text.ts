// Plain-text rules for the public status note shown on /status. A leaf with no
// imports: the App Worker checks every admin write with it, and the admin
// client (browser/classic-runtime/admin.ts) applies the same whitespace
// collapse before it sends, so a retried publish replays. The parity is pinned
// by src/core/__tests__/status-note-text.test.ts.

export const STATUS_NOTE_MESSAGE_MAX_LENGTH = 280;

export type StatusNoteTextError = 'STATUS_NOTE_INVALID' | 'STATUS_NOTE_TOO_LONG';

export type StatusNoteMessageResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: StatusNoteTextError };

// C0 controls, DEL, the bidi embeddings and overrides (U+202A-U+202E), the bidi
// isolates (U+2066-U+2069) and lone surrogates. Whitespace controls such as
// tab and newline never reach this check: the collapse turns them into spaces.
// Escapes only, so no invisible character sits in the source.
const STATUS_NOTE_REJECTED_TEXT_RE = /[\x00-\x1f\x7f\u{202a}-\u{202e}\u{2066}-\u{2069}]|\p{Cs}/u;

/**
 * Canonical one-line note text. Whitespace runs collapse to one space and the
 * ends are trimmed; an empty result means "remove the note". The length is
 * counted in UTF-16 code units, like the textarea's maxlength and the stored
 * announcement record, and a long message is refused, never truncated.
 */
export function canonicalStatusNoteMessage(value: unknown): StatusNoteMessageResult {
  if (typeof value !== 'string') return { ok: false, error: 'STATUS_NOTE_INVALID' };
  const message = value.replace(/\s+/gu, ' ').trim();
  if (STATUS_NOTE_REJECTED_TEXT_RE.test(message)) {
    return { ok: false, error: 'STATUS_NOTE_INVALID' };
  }
  if (message.length > STATUS_NOTE_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: 'STATUS_NOTE_TOO_LONG' };
  }
  return { ok: true, message };
}
