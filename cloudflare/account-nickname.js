import profanityPatterns from '../src/chat/profanity-patterns.generated.json' with { type: 'json' };
import {
  displayNameSecuritySkeleton,
  hasDisplayNameWhitespaceOrFiller,
  hasVisibleDisplayNameContent,
  sanitizeDisplayNameForValidation,
} from './display-name-policy.js';

// New profile writes use the shorter product limit. Keep the stored/read
// boundary at 20 so accounts created before the limit changed remain valid in
// sessions and signed room assertions until their owner chooses a new name.
const NICKNAME_WRITE_MAX_CODE_POINTS = 12;
const NICKNAME_STORED_MAX_CODE_POINTS = 20;
const GENERATED_PEER_NAME_RE = /^peer(?: \d+)?$/i;
const NUMBER_BADGE_NAME_RE = /^#\d+$/u;
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
function normalizeAccountNicknameWithLimit(
  value,
  maxCodePoints,
  { rejectWhitespace = false } = {},
) {
  if (typeof value !== 'string') return null;
  // Stored values retain the historical read boundary: trim surrounding
  // whitespace so old assertions remain valid. New writes pass
  // rejectWhitespace and are checked before any trimming can hide the input.
  const normalized = rejectWhitespace ? value.normalize('NFC') : value.normalize('NFC').trim();
  const comparisonKey = accountNicknameKey(normalized);
  if (
    !normalized ||
    !comparisonKey ||
    Array.from(normalized).length > maxCodePoints ||
    (rejectWhitespace && hasDisplayNameWhitespaceOrFiller(normalized)) ||
    (rejectWhitespace && hasDisplayNameWhitespaceOrFiller(comparisonKey)) ||
    sanitizeDisplayNameForValidation(normalized) !== normalized ||
    !hasVisibleDisplayNameContent(normalized)
  ) {
    return null;
  }
  const policyKey = displayNameSecuritySkeleton(comparisonKey);
  if (
    RESERVED_NICKNAMES.has(policyKey) ||
    GENERATED_PEER_NAME_RE.test(policyKey) ||
    NUMBER_BADGE_NAME_RE.test(policyKey) ||
    containsEnglishNicknameProfanity(policyKey)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Canonical global-uniqueness key. The display spelling remains NFC, while
 * compatibility forms and casing (for example full-width MUSIXQUARE) share a
 * single database claim. Authorization must continue to use account/member
 * IDs; this key is only a product-level name reservation.
 */
export function accountNicknameKey(value) {
  if (typeof value !== 'string' || !value) return null;
  const key = value.normalize('NFKC').toLocaleLowerCase('en-US').normalize('NFC');
  return key && sanitizeDisplayNameForValidation(key) === key && hasVisibleDisplayNameContent(key)
    ? key
    : null;
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
  return normalizeAccountNicknameWithLimit(value, NICKNAME_WRITE_MAX_CODE_POINTS, {
    rejectWhitespace: true,
  });
}
