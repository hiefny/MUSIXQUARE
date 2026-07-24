// Shared visible-name policy for browser and Worker boundaries.
//
// Unicode White_Space is handled separately by account nicknames because
// device/session display names may legitimately contain ordinary spaces.
// This module rejects characters that can produce an empty-looking or
// directionally misleading identifier without banning valid visible scripts.
const CONTROL_OR_SEPARATOR_RE = /[\p{Cc}\p{Cs}\u2028\u2029]/u;
const FORMAT_CONTROL_RE = /\p{Cf}/u;
const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const VISUALLY_BLANK_FILLER_RE = /[\u115F\u1160\u2800\u3164\uFFA0]/u;
const WHITE_SPACE_RE = /\p{White_Space}/u;
const VARIATION_SELECTOR_RE = /\p{Variation_Selector}/u;
const EMOJI_TAG_CHARACTER_RE = /[\u{E0020}-\u{E007E}]/u;
const EMOJI_CANCEL_TAG = '\u{E007F}';
const EMOJI_TAG_BASE = '\u{1F3F4}';
const VISIBLE_NAME_CONTENT_RE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/**
 * Report characters that create blank visual spacing in a display name.
 *
 * Unicode does not classify every blank-looking character as White_Space.
 * Hangul fillers and braille blank therefore need to share the same product
 * error as ordinary whitespace even though the security sanitizer also
 * rejects them independently.
 */
export function hasDisplayNameWhitespaceOrFiller(value) {
  return (
    typeof value === 'string' &&
    (WHITE_SPACE_RE.test(value) || VISUALLY_BLANK_FILLER_RE.test(value))
  );
}

function isAllowedVariationSelector(character, previousCharacter) {
  return (
    VARIATION_SELECTOR_RE.test(character) &&
    typeof previousCharacter === 'string' &&
    VISIBLE_NAME_CONTENT_RE.test(previousCharacter)
  );
}

function allowedEmojiTagIndexes(characters) {
  const allowed = new Set();
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== EMOJI_TAG_BASE) continue;
    let cursor = index + 1;
    while (cursor < characters.length && EMOJI_TAG_CHARACTER_RE.test(characters[cursor])) {
      cursor += 1;
    }
    if (cursor === index + 1 || characters[cursor] !== EMOJI_CANCEL_TAG) continue;
    for (let tagIndex = index + 1; tagIndex <= cursor; tagIndex += 1) {
      allowed.add(tagIndex);
    }
  }
  return allowed;
}

function isUnsafeDisplayNameCharacter(character, previousCharacter, index, allowedTags) {
  if (
    CONTROL_OR_SEPARATOR_RE.test(character) ||
    VISUALLY_BLANK_FILLER_RE.test(character) ||
    (WHITE_SPACE_RE.test(character) && character !== ' ')
  ) {
    return true;
  }
  return (
    (DEFAULT_IGNORABLE_RE.test(character) || FORMAT_CONTROL_RE.test(character)) &&
    !isAllowedVariationSelector(character, previousCharacter) &&
    !allowedTags.has(index)
  );
}

/**
 * Remove characters that must never participate in a visible identity.
 *
 * Callers compare the result with the input and reject on any difference.
 * We deliberately do not silently repair a submitted identity.
 */
export function sanitizeDisplayNameForValidation(value) {
  if (typeof value !== 'string') return '';
  const characters = Array.from(value);
  const allowedTags = allowedEmojiTagIndexes(characters);
  return characters
    .filter(
      (character, index) =>
        !isUnsafeDisplayNameCharacter(character, characters[index - 1], index, allowedTags),
    )
    .join('');
}

/**
 * Presentation selectors must not bypass reserved-name or profanity checks.
 * Valid selectors/tags remain in the display spelling but collapse in this
 * security-only comparison skeleton.
 */
export function displayNameSecuritySkeleton(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value)
    .filter(
      (character) =>
        !VARIATION_SELECTOR_RE.test(character) &&
        !EMOJI_TAG_CHARACTER_RE.test(character) &&
        character !== EMOJI_CANCEL_TAG,
    )
    .join('');
}

/** A name needs at least one visible letter, number, punctuation, or symbol. */
export function hasVisibleDisplayNameContent(value) {
  return typeof value === 'string' && VISIBLE_NAME_CONTENT_RE.test(value);
}

/**
 * Validate both the display spelling and its compatibility-normalized form.
 * This closes compatibility-filler aliases without changing the visible NFC
 * spelling stored by account and PRO room services.
 */
export function isSafeVisibleDisplayName(value) {
  if (typeof value !== 'string' || !value) return false;
  const normalized = value.normalize('NFC');
  const compatibility = normalized.normalize('NFKC');
  return (
    sanitizeDisplayNameForValidation(normalized) === normalized &&
    sanitizeDisplayNameForValidation(compatibility) === compatibility &&
    hasVisibleDisplayNameContent(normalized) &&
    hasVisibleDisplayNameContent(compatibility)
  );
}
