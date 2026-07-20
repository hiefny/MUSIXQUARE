import { describe, expect, it } from 'vitest';

import {
  normalizeAccountNickname,
  normalizeNewAccountNickname,
} from '../../../cloudflare/account-nickname.js';

describe('account nickname length policy', () => {
  it('accepts at most 12 Unicode code points for every new profile write', () => {
    expect(normalizeNewAccountNickname('🎵'.repeat(12))).toBe('🎵'.repeat(12));
    expect(normalizeNewAccountNickname('🎵'.repeat(13))).toBeNull();
  });

  it('keeps pre-existing 13-to-20-code-point nicknames readable', () => {
    expect(normalizeAccountNickname('x'.repeat(13))).toBe('x'.repeat(13));
    expect(normalizeAccountNickname('x'.repeat(20))).toBe('x'.repeat(20));
    expect(normalizeAccountNickname('x'.repeat(21))).toBeNull();
  });
});
