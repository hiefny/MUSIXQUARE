import { describe, expect, it } from 'vitest';
import { parseAnnouncementExpiry } from '../../../cloudflare/announcement-expiry.ts';

describe('announcement expiry instants', () => {
  it.each([
    '2031-02-29T12:00:00Z',
    '2032-02-30T12:00:00.001Z',
    '2031-04-31T12:00:00+09:00',
    '2031-12-31T24:00:00Z',
    '2031-12-31T12:60:00Z',
    '2031-12-31T12:00:60Z',
    '2031-12-31T12:00:00+24:00',
    '2031-12-31T12:00:00+09:60',
    '2100-02-29T12:00:00Z',
    '2031-12-31 12:00',
    '2031-12-31',
    0,
    false,
    {},
  ])('rejects an impossible or ambiguous instant: %s', (value) => {
    expect(parseAnnouncementExpiry(value)).toBeUndefined();
  });

  it.each([
    ['2032-02-29T12:00:01.234Z', '2032-02-29T12:00:01.234Z'],
    ['2000-02-29T12:00Z', '2000-02-29T12:00:00.000Z'],
    ['2031-04-30T12:00:01.2+09:00', '2031-04-30T03:00:01.200Z'],
    ['2031-01-01T00:00:00-02:30', '2031-01-01T02:30:00.000Z'],
    ['9999-12-31T23:59:00-01:00', '+010000-01-01T00:59:00.000Z'],
    ['+010000-01-01T00:59:00.000Z', '+010000-01-01T00:59:00.000Z'],
    [null, null],
    ['', null],
  ])('preserves an explicit instant or empty expiry: %s', (value, expected) => {
    expect(parseAnnouncementExpiry(value)).toBe(expected);
  });
});
