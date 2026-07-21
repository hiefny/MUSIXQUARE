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

  it('allows Korean text while rejecting only standalone English profanity', () => {
    expect(normalizeNewAccountNickname('청년개발자')).toBe('청년개발자');
    expect(normalizeNewAccountNickname('시발')).toBe('시발');
    expect(normalizeNewAccountNickname('ssibal')).toBe('ssibal');
    expect(normalizeNewAccountNickname('saekki')).toBe('saekki');
    expect(normalizeNewAccountNickname('nyeon')).toBe('nyeon');
    expect(normalizeNewAccountNickname('fuck')).toBeNull();
    expect(normalizeNewAccountNickname('Cassidy')).toBe('Cassidy');
    expect(normalizeNewAccountNickname('assignment')).toBe('assignment');
  });
});
