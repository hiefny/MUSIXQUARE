import profanityPatterns from '../src/chat/profanity-patterns.generated.json' with { type: 'json' };

// New profile writes use the shorter product limit. Keep the stored/read
// boundary at 20 so accounts created before the limit changed remain valid in
// sessions and signed room assertions until their owner chooses a new name.
const NICKNAME_WRITE_MAX_CODE_POINTS = 12;
const NICKNAME_STORED_MAX_CODE_POINTS = 20;
// Reject rather than silently strip at the HTTP boundary. The browser UI
// strips these characters before submit, while scripted callers receive a
// clear NICKNAME_INVALID response instead of storing a visually ambiguous ID.
const NICKNAME_FORBIDDEN_RE =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
const GENERATED_PEER_NAME_RE = /^peer(?: \d+)?$/i;
const NUMBER_BADGE_NAME_RE = /^#\d+$/u;
const MARKS_ONLY_RE = /^\p{M}+$/u;
const RESERVED_NICKNAMES = new Set([
  'host',
  'guest',
  'admin',
  'operator',
  'op',
  'mod',
  'moderator',
  'system',
  'server',
  'bot',
  '방장',
  '호스트',
  '관리자',
  '운영자',
]);

// Account nicknames only reject standalone English profanity. Chat moderation
// intentionally keeps its broader Korean-substring and English-word policy.
const ENGLISH_NICKNAME_PROFANITY_RE = profanityPatterns.accountEnglish
  ? new RegExp(profanityPatterns.accountEnglish, 'iu')
  : null;

function containsEnglishNicknameProfanity(value) {
  return Boolean(ENGLISH_NICKNAME_PROFANITY_RE?.test(value));
}

/** Common character, reserved-name, and profanity policy for both limits. */
function normalizeAccountNicknameWithLimit(value, maxCodePoints) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  if (
    !normalized ||
    Array.from(normalized).length > maxCodePoints ||
    NICKNAME_FORBIDDEN_RE.test(normalized) ||
    MARKS_ONLY_RE.test(normalized)
  ) {
    return null;
  }
  const folded = normalized.toLocaleLowerCase('en-US');
  if (
    RESERVED_NICKNAMES.has(folded) ||
    GENERATED_PEER_NAME_RE.test(normalized) ||
    NUMBER_BADGE_NAME_RE.test(normalized) ||
    containsEnglishNicknameProfanity(normalized)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Normalize an already-persisted nickname for sessions and room assertions.
 * The 20-code-point compatibility ceiling deliberately matches the tracked D1
 * schema and must not be used to admit a new profile write.
 */
export function normalizeAccountNickname(value) {
  return normalizeAccountNicknameWithLimit(value, NICKNAME_STORED_MAX_CODE_POINTS);
}

/** Authoritative boundary for every new or changed account nickname. */
export function normalizeNewAccountNickname(value) {
  return normalizeAccountNicknameWithLimit(value, NICKNAME_WRITE_MAX_CODE_POINTS);
}
