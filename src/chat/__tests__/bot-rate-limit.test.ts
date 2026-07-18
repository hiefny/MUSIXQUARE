import { describe, expect, it } from 'vitest';
import { formatBotRetryDuration } from '../bot-rate-limit.ts';

describe('formatBotRetryDuration', () => {
  it.each([
    [1, '1초'],
    [59, '59초'],
    [60, '1분 0초'],
    [61, '1분 1초'],
    [3599, '59분 59초'],
    [3600, '1시간 0분 0초'],
    [3661, '1시간 1분 1초'],
    [86400, '24시간 0분 0초'],
  ])('formats %i seconds without a raw-seconds wall', (seconds, expected) => {
    expect(formatBotRetryDuration(seconds, 'ko')).toBe(expected);
  });

  it('uses the active locale unit grammar', () => {
    expect(formatBotRetryDuration(3661, 'en')).toBe('1 hour 1 minute 1 second');
  });
});
