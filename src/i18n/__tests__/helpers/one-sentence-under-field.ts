/**
 * Lines under a field put one sentence on each line (owner decision
 * 2026-11-03), so English splits these keys in two. A few translations say
 * the same in one sentence and keep it on one line, where English has two:
 * - Thai marks the end of a sentence with a space, not a stop. Its lines
 *   under a field stay as written until a Thai reader confirms where a
 *   sentence ends.
 * - The Chinese and Arabic room-full details join both facts in one
 *   sentence.
 * The line-break parity rows hold these strings to one line instead of
 * English's count; factual-translation-contracts pins their text.
 */
export const ONE_SENTENCE_UNDER_FIELD: Readonly<Record<string, readonly string[]>> = {
  ar: ['pro.room_full_detail'],
  th: [
    'pro.room_full_detail',
    'pro.join_rate_limited',
    'pro.join_rate_limited_later',
    'dialog.room_password_rate_limited',
    'dialog.room_password_rate_limited_later',
  ],
  'zh-hans': ['pro.room_full_detail'],
  'zh-hant': ['pro.room_full_detail'],
};

export function isOneSentenceUnderField(locale: string, key: string): boolean {
  return ONE_SENTENCE_UNDER_FIELD[locale]?.includes(key) ?? false;
}
