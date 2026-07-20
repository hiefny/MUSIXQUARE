import profanityPatterns from '../src/chat/profanity-patterns.generated.json' with { type: 'json' };

const NICKNAME_MAX_CODE_POINTS = 20;
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

const PROFANITY_RE = {
  korean: profanityPatterns.korean ? new RegExp(profanityPatterns.korean, 'iu') : null,
  english: profanityPatterns.english ? new RegExp(profanityPatterns.english, 'iu') : null,
};

function containsProfanity(value) {
  return Boolean(PROFANITY_RE.korean?.test(value) || PROFANITY_RE.english?.test(value));
}

/**
 * Authoritative nickname normalization shared by account persistence and both
 * room-assertion codecs. Anything saved by the account service must remain
 * representable in Standard and PRO rooms.
 */
export function normalizeAccountNickname(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  if (
    !normalized ||
    Array.from(normalized).length > NICKNAME_MAX_CODE_POINTS ||
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
    containsProfanity(normalized)
  ) {
    return null;
  }
  return normalized;
}
