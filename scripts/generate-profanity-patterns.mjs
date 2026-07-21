#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { KO } from 'content-shield/languages/ko';
import { EN } from 'content-shield/languages/en';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'src', 'chat', 'profanity-patterns.generated.json');
const checkOnly = process.argv.slice(2).includes('--check');

function buildPatterns() {
  const words = new Set();
  const accountEnglishWords = new Set();

  for (const entry of KO.profanity) {
    if (entry.severity < 2) continue;
    for (const variation of entry.variations) words.add(variation.toLowerCase());
  }
  for (const entry of EN.words) {
    if (entry.severity < 2) continue;
    const word = entry.word.toLowerCase();
    words.add(word);
    accountEnglishWords.add(word);
    for (const variation of entry.variations) {
      const normalized = variation.toLowerCase();
      words.add(normalized);
      accountEnglishWords.add(normalized);
    }
  }

  const korean = [];
  const english = [];
  for (const word of words) {
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/[\uAC00-\uD7AF\u3131-\u3163]/.test(word)) korean.push(escaped);
    else english.push(escaped);
  }

  // Preserve the previous runtime rule exactly. Stable sort keeps source
  // insertion order for equal-length alternatives.
  korean.sort((a, b) => b.length - a.length);
  english.sort((a, b) => b.length - a.length);
  const accountEnglish = [...accountEnglishWords]
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  return {
    korean: korean.join('|'),
    english: `\\b(?:${english.join('|')})\\b`,
    // Account nicknames intentionally use only the EN source. The broader
    // chat `english` bucket also contains romanized KO entries.
    accountEnglish: `\\b(?:${accountEnglish.join('|')})\\b`,
  };
}

const output = `${JSON.stringify(buildPatterns(), null, 2)}\n`;

if (checkOnly) {
  let current = '';
  try {
    current = await readFile(outputPath, 'utf8');
  } catch {
    // Report the same actionable command for a missing or stale artifact.
  }
  if (current !== output) {
    console.error(
      '[profanity-patterns] Generated artifact is stale. Run npm run generate:profanity-patterns.',
    );
    process.exitCode = 1;
  } else {
    console.log('[profanity-patterns] PASS: generated patterns match content-shield.');
  }
} else {
  await writeFile(outputPath, output, 'utf8');
  console.log(`[profanity-patterns] Wrote ${path.relative(repoRoot, outputPath)}.`);
}
