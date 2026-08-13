import { describe, expect, it } from 'vitest';

import {
  findBrandCapitalizationViolations,
  isBrandCopySource,
} from '../../../scripts/check-brand-capitalization.mjs';

function violations(source: string): string[] {
  return findBrandCapitalizationViolations('public/example.js', source).map(
    (violation: { spelling: string }) => violation.spelling,
  );
}

describe('MUSIXQUARE brand-capitalization guard', () => {
  it.each([
    'Musixquare.',
    'musixquare!',
    '<title>Musixquare</title>',
    'A Musixquare-branded screen',
    'A musixquare-branded screen',
    'A musixquare-app-branded screen',
    'A musixquare-theme-inspired screen',
  ])('rejects user-facing copy with noncanonical casing: %s', (source) => {
    expect(violations(source)).toEqual([expect.stringMatching(/musixquare/iu)]);
  });

  it.each([
    'MUSIXQUARE is available.',
    'https://musixquare.com',
    'contact@musixquare.com',
    'const cache = "musixquare-static-v428"; // brand-capitalization: allow-technical',
    'X-Musixquare-Navigation-Source',
    'MusixquareServiceControl',
    '/\\bmusixquare\\b/iu; // brand-capitalization: allow-technical',
  ])('preserves canonical copy and fixed technical spellings: %s', (source) => {
    expect(violations(source)).toEqual([]);
  });

  it('covers public metadata and API description formats', () => {
    expect(isBrandCopySource('index.html')).toBe(true);
    expect(isBrandCopySource('README.md')).toBe(true);
    expect(isBrandCopySource('CONTRIBUTING.md')).toBe(true);
    expect(isBrandCopySource('SECURITY.md')).toBe(true);
    expect(isBrandCopySource('THIRD-PARTY-NOTICES.md')).toBe(true);
    expect(isBrandCopySource('css/style.css')).toBe(true);
    expect(isBrandCopySource('public/admin.css')).toBe(true);
    expect(isBrandCopySource('public/manifest.webmanifest')).toBe(true);
    expect(isBrandCopySource('public/developers/openapi.yaml')).toBe(true);
    expect(isBrandCopySource('public/wordmark.svg')).toBe(true);
  });

  it('does not reinterpret tests or the guard implementation as product copy', () => {
    expect(isBrandCopySource('src/core/__tests__/example.test.ts')).toBe(false);
    expect(isBrandCopySource('scripts/check-brand-capitalization.mjs')).toBe(false);
  });
});
