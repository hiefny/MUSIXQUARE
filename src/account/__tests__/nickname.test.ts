import { beforeEach, describe, expect, it } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { normalizeAccountNickname, validateAccountNickname } from '../nickname.ts';

beforeEach(() => {
  resetState();
});

describe('account nickname validation', () => {
  it('allows two different accounts to use the same display nickname', () => {
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
    expect(validateAccountNickname('🎵'.repeat(20))).toBeNull();
    expect(validateAccountNickname('🎵'.repeat(21))).not.toBeNull();
  });

  it('strips C1 controls before reserved-name validation', () => {
    expect(normalizeAccountNickname('H\u0085OST')).toBe('HOST');
    expect(validateAccountNickname('H\u0085OST')).not.toBeNull();
  });

  it('matches the server boundary for line separators and combining-only names', () => {
    expect(normalizeAccountNickname('Min\u2028su')).toBe('Minsu');
    expect(validateAccountNickname('Min\u2028su')).toBeNull();
    expect(validateAccountNickname('\u0301\u0308')).not.toBeNull();
  });
});
