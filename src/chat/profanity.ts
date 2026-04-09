/**
 * MUSIXQUARE 3.0 — Profanity Filter
 *
 * Lightweight filter using word lists from content-shield.
 * Replaces matched words with asterisks.
 * Only runs on host side in handleChatMessage().
 */

// Word lists extracted from content-shield at build time.
// KO uses .profanity[], EN uses .words[] — different structures.
// We collect all variations for severity >= 2 (moderate+).
import { KO } from 'content-shield/languages/ko';
import { EN } from 'content-shield/languages/en';

// ─── Build word set ─────────────────────────────────────────────

const _profanitySet = new Set<string>();

// Korean: severity >= 2
for (const entry of (KO as unknown as { profanity: { severity: number; variations: string[] }[] }).profanity) {
  if (entry.severity >= 2) {
    for (const v of entry.variations) {
      _profanitySet.add(v.toLowerCase());
    }
  }
}

// English: severity >= 2
for (const entry of (EN as unknown as { words: { severity: number; word: string; variations: string[] }[] }).words) {
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

  // Sort longest-first so longer matches take priority
  koreanParts.sort((a, b) => b.length - a.length);
  englishParts.sort((a, b) => b.length - a.length);

  return {
    korean: koreanParts.length > 0 ? new RegExp(koreanParts.join('|'), 'gi') : null,
    english: englishParts.length > 0 ? new RegExp(`\\b(?:${englishParts.join('|')})\\b`, 'gi') : null,
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
 */
export function containsProfanity(text: string): boolean {
  const lower = text.toLowerCase();
  for (const word of _profanitySet) {
    if (!word) continue;
    if (lower.includes(word)) return true;
  }
  return false;
}
