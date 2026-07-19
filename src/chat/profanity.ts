/**
 * Profanity matching backed by a generated, behavior-equivalent projection of
 * the content-shield dictionaries. Korean variations use substring matching;
 * English variations require whole words to avoid censoring ordinary names
 * that merely contain a listed term.
 */
import patterns from './profanity-patterns.generated.json';

// The generator applies the exact previous severity, deduplication,
// classification, escaping and longest-first ordering rules. Keeping only the
// final patterns avoids shipping content-shield's moderation metadata to every
// client. `npm run guard:profanity-patterns` prevents source-data drift.
const _compiledRegex = {
  korean: patterns.korean ? new RegExp(patterns.korean, 'gi') : null,
  english: patterns.english ? new RegExp(patterns.english, 'gi') : null,
};

/** Replace matched text with same-length asterisks. */
export function filterProfanity(text: string): string {
  let result = text;

  if (_compiledRegex.korean) {
    _compiledRegex.korean.lastIndex = 0;
    result = result.replace(_compiledRegex.korean, (match) => '*'.repeat(match.length));
  }
  if (_compiledRegex.english) {
    _compiledRegex.english.lastIndex = 0;
    result = result.replace(_compiledRegex.english, (match) => '*'.repeat(match.length));
  }

  return result;
}

/**
 * Apply the same whole-word and substring rules as filterProfanity without
 * rewriting the input.
 */
export function containsProfanity(text: string): boolean {
  const lower = text.toLowerCase();

  if (_compiledRegex.english) {
    _compiledRegex.english.lastIndex = 0;
    if (_compiledRegex.english.test(lower)) return true;
  }
  if (_compiledRegex.korean) {
    _compiledRegex.korean.lastIndex = 0;
    if (_compiledRegex.korean.test(lower)) return true;
  }

  return false;
}
