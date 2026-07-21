import { beforeEach, describe, expect, it } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import {
  accountNicknameKeyForTests,
  normalizeAccountNickname,
  validateAccountNickname,
} from '../nickname.ts';

beforeEach(() => {
  resetState();
});

describe('account nickname validation', () => {
  it('leaves global uniqueness to the race-safe account service', () => {
    setState('network.lastKnownDeviceList', [
      {
        id: 'other-device',
        label: 'Minsu',
        status: 'connected',
        joinOrder: 1,
        isHost: false,
        isOp: false,
      },
    ]);

    expect(validateAccountNickname('Minsu')).toBeNull();
  });

  it('counts Unicode code points consistently with the account service', () => {
    expect(validateAccountNickname('🎵'.repeat(12))).toBeNull();
    expect(validateAccountNickname('🎵'.repeat(13))).not.toBeNull();
  });

  it('keeps display NFC while rejecting hidden controls before submission', () => {
    expect(normalizeAccountNickname('e\u0301')).toBe('\u00e9');
    expect(normalizeAccountNickname('H\u0085OST')).toBe('H\u0085OST');
    expect(validateAccountNickname('H\u0085OST')).not.toBeNull();
  });

  it('rejects every Unicode whitespace form and combining-only names', () => {
    for (const whitespace of [' ', '\t', '\n', '\u00a0', '\u1680', '\u2007', '\u2028', '\u202f']) {
      expect(
        validateAccountNickname(`Min${whitespace}su`),
        JSON.stringify(whitespace),
      ).not.toBeNull();
    }
    expect(validateAccountNickname('\u0301\u0308')).not.toBeNull();
  });

  it('uses the service NFKC/case key for reserved-name validation', () => {
    expect(accountNicknameKeyForTests('Ｍｉｎｓｕ')).toBe('minsu');
    expect(validateAccountNickname('ＨＯＳＴ')).not.toBeNull();
  });

  it('allows Korean text while rejecting only standalone English profanity', () => {
    expect(validateAccountNickname('청년개발자')).toBeNull();
    expect(validateAccountNickname('시발')).toBeNull();
    expect(validateAccountNickname('ssibal')).toBeNull();
    expect(validateAccountNickname('saekki')).toBeNull();
    expect(validateAccountNickname('nyeon')).toBeNull();
    expect(validateAccountNickname('fuck')).not.toBeNull();
    expect(validateAccountNickname('Cassidy')).toBeNull();
    expect(validateAccountNickname('assignment')).toBeNull();
  });
});
