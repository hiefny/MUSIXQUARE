/**
 * Profanity matching backed by the bundled content-shield dictionaries.
 * Korean variations use substring matching; English variations require whole
 * words to avoid censoring ordinary names that merely contain a listed term.
 */
import { KO } from 'content-shield/languages/ko';
import { EN } from 'content-shield/languages/en';

interface KoreanProfanityEntry {
  severity: number;
  variations: readonly string[];
}

interface EnglishProfanityEntry {
  severity: number;
  word: string;
  variations: readonly string[];
}

interface KoreanProfanityDictionary {
  profanity: readonly KoreanProfanityEntry[];
}

interface EnglishProfanityDictionary {
  words: readonly EnglishProfanityEntry[];
}

// ─── Build word set ─────────────────────────────────────────────

const _profanitySet = new Set<string>();

for (const entry of (KO as KoreanProfanityDictionary).profanity) {
  if (entry.severity >= 2) {
    for (const v of entry.variations) {
      _profanitySet.add(v.toLowerCase());
    }
  }
}

for (const entry of (EN as EnglishProfanityDictionary).words) {
  if (entry.severity >= 2) {
    _profanitySet.add(entry.word.toLowerCase());
    for (const v of entry.variations) {
      _profanitySet.add(v.toLowerCase());
    }
  }
}

// ─── Precompiled Regex ──────────────────────────────────────────

// Build two combined regex patterns at module load time (once) instead of
// creating N regex objects per filterProfanity() call.
function _buildCombinedRegex(): { korean: RegExp | null; english: RegExp | null } {
  const koreanParts: string[] = [];
  const englishParts: string[] = [];

  for (const word of _profanitySet) {
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/[\uAC00-\uD7AF\u3131-\u3163]/.test(word)) {
      koreanParts.push(escaped);
    } else {
      englishParts.push(escaped);
    }
  }

  // Longest-first prevents a shorter alternative from consuming a prefix.
  koreanParts.sort((a, b) => b.length - a.length);
  englishParts.sort((a, b) => b.length - a.length);

  return {
    korean: koreanParts.length > 0 ? new RegExp(koreanParts.join('|'), 'gi') : null,
    english:
      englishParts.length > 0 ? new RegExp(`\\b(?:${englishParts.join('|')})\\b`, 'gi') : null,
  };
}

const _compiledRegex = _buildCombinedRegex();

// ─── Filter function ────────────────────────────────────────────

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
