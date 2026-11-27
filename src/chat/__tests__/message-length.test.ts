import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MSG_LENGTH } from '../../core/constants.ts';
import {
  fitToMessageLength,
  fitToMessageLengthWithoutSegmenterForTests,
  isOverMessageLimit,
} from '../message-length.ts';

const GRIN = '\u{1F600}';
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
const THUMB_MEDIUM = '\u{1F44D}\u{1F3FD}';
const KOREA = '\u{1F1F0}\u{1F1F7}';
const JAPAN = '\u{1F1EF}\u{1F1F5}';
const E_ACUTE = 'e\u0301';
const KEYCAP_ONE = '1\uFE0F\u20E3';

const hasLoneSurrogate = (text: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);

describe('chat message length', () => {
  it('counts UTF-16 code units, the unit the chat wire and the PRO server count', () => {
    expect(isOverMessageLimit('a'.repeat(MAX_MSG_LENGTH))).toBe(false);
    expect(isOverMessageLimit('a'.repeat(MAX_MSG_LENGTH + 1))).toBe(true);
    // One emoji is 2 units: 499 + 1 emoji is over.
    expect(isOverMessageLimit('a'.repeat(MAX_MSG_LENGTH - 1) + GRIN)).toBe(true);
    expect(FAMILY).toHaveLength(11);

    // The PRO signaling Worker cannot import the client constant; pin its copy
    // and that it measures with String#length.
    const signaling = readFileSync(resolve('cloudflare/signaling-protocol.ts'), 'utf8');
    expect(/const PRO_REALTIME_TEXT_MAX_LENGTH = (\d+);/u.exec(signaling)?.[1]).toBe(
      String(MAX_MSG_LENGTH),
    );
    expect(signaling).toContain('value.text.length > PRO_REALTIME_TEXT_MAX_LENGTH');
  });

  const cases: ReadonlyArray<[string, string, number, string]> = [
    ['plain text', 'a'.repeat(MAX_MSG_LENGTH + 20), MAX_MSG_LENGTH, 'a'.repeat(MAX_MSG_LENGTH)],
    ['an emoji that would end at 501', 'a'.repeat(499) + GRIN, 500, 'a'.repeat(499)],
    ['an emoji that ends at 500', 'a'.repeat(498) + GRIN + 'b', 500, 'a'.repeat(498) + GRIN],
    ['a family emoji across the cut', 'a'.repeat(495) + FAMILY, 500, 'a'.repeat(495)],
    ['a skin tone across the cut', 'a'.repeat(497) + THUMB_MEDIUM, 500, 'a'.repeat(497)],
    ['half a flag', 'a'.repeat(498) + KOREA + JAPAN, 500, 'a'.repeat(498)],
    ['one flag of two', 'a'.repeat(496) + KOREA + JAPAN, 500, 'a'.repeat(496) + KOREA],
    ['a flag after a lone indicator', 'a'.repeat(5) + '\u{1F1F0}' + KOREA, 8, 'a'.repeat(5)],
    ['a combining accent', 'a'.repeat(499) + E_ACUTE, 500, 'a'.repeat(499)],
    ['a keycap', 'a'.repeat(498) + KEYCAP_ONE, 500, 'a'.repeat(498)],
    ['nothing fits', GRIN, 1, ''],
    ['no room', 'abc', 0, ''],
    ['text that already fits', 'abc', 3, 'abc'],
  ];

  it.each(cases)('keeps whole graphemes: %s', (_name, text, limit, expected) => {
    for (const fit of [fitToMessageLength, fitToMessageLengthWithoutSegmenterForTests]) {
      const result = fit(text, limit);
      expect(result).toBe(expected);
      expect(result.length).toBeLessThanOrEqual(limit);
      expect(hasLoneSurrogate(result)).toBe(false);
      expect(text.startsWith(result)).toBe(true);
    }
  });

  it('cuts to MAX_MSG_LENGTH by default', () => {
    expect(fitToMessageLength('a'.repeat(MAX_MSG_LENGTH * 2))).toHaveLength(MAX_MSG_LENGTH);
  });
});
