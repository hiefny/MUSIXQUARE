import { describe, expect, it } from 'vitest';

import { APP_DICTIONARIES, type TranslationDictionary } from '../catalogs.ts';

/**
 * The lost-session dialog [Go back | Restart] (network/peer.ts). Restart
 * returns a guest with a room code to that room's start screen, where it
 * joins again, and reloads anyone else into a new session. Owner decision
 * (2026-10-29, item 8): a guest with a room code reads its own body, which
 * says Restart joins this room again; hosts and guests without a code keep
 * dialog.session_lost_msg. Both bodies open with the same account of what
 * happened and differ only in what Restart does.
 */
const GUEST = 'dialog.session_lost_guest_msg';
const SHARED = 'dialog.session_lost_msg';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const opening = (value: string, length: number): string =>
  [...graphemes.segment(value)]
    .slice(0, length)
    .map(({ segment }) => segment)
    .join('');

const dictionaries = Object.entries(APP_DICTIONARIES) as Array<[string, TranslationDictionary]>;

describe('lost-session dialog body for a guest who rejoins its room', () => {
  it("keeps the owner's wording in the source locales", () => {
    expect(APP_DICTIONARIES.ko[GUEST]).toBe(
      '앱이 잠시 꺼지거나 절전 상태로 들어가서 다른 기기들과 연결이 끊어졌어요. 다시 시작하면 이 방에 다시 들어갈 수 있어요.',
    );
    expect(APP_DICTIONARIES.en[GUEST]).toBe(
      'The app went to sleep or lost connection, so this device was disconnected from the others. Restart to join this room again.',
    );
  });

  it('opens like the shared body in every locale and ends on what Restart does', () => {
    expect(dictionaries).toHaveLength(42);
    for (const [locale, dictionary] of dictionaries) {
      const guest = dictionary[GUEST];
      const shared = dictionary[SHARED];
      expect(guest, `${locale}.${GUEST} empty`).toBeTruthy();
      expect(guest, `${locale}.${GUEST} surrounding whitespace`).toBe(guest.trim());
      expect(guest, `${locale}.${GUEST} single paragraph`).not.toMatch(/[\r\n<>]|\{\{/u);
      expect(guest, `${locale}.${GUEST} same as the shared body`).not.toBe(shared);
      expect(opening(guest, 20), `${locale}.${GUEST} opening`).toBe(opening(shared, 20));
      if (locale !== 'en')
        expect(guest, `${locale}.${GUEST} copies English`).not.toBe(APP_DICTIONARIES.en[GUEST]);
    }
  });
});
