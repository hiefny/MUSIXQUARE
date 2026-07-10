/**
 * MUSIXQUARE — Profanity Filter
 *
 * Lightweight filter using a generated word list derived from content-shield.
 * Replaces matched words with asterisks.
 * Only runs on host side in handleChatMessage().
 */

// The generator keeps only severity >= 2 words and variations, avoiding the
// much larger metadata dictionaries in every browser session.
import { PROFANITY_WORDS } from './profanity-words.generated.ts';

// ─── Build word set ─────────────────────────────────────────────

const _profanitySet = new Set<string>(PROFANITY_WORDS);

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

  // Sort longest-first so longer matches take priority
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

/**
 * Replace profane words with asterisks.
 * Uses word boundary matching for English, substring matching for Korean.
 */
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
 * Check if text contains profanity.
 * Mirrors filterProfanity matching: word-boundary for English, substring for Korean.
 * (Bare String.includes on EN words flagged legitimate names like "Cassidy".)
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
