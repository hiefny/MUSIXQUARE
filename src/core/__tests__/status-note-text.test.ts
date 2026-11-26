import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  STATUS_NOTE_MESSAGE_MAX_LENGTH,
  canonicalStatusNoteMessage,
} from '../../../cloudflare/status-note-text.ts';

// The one collapse every side applies before a note is compared or stored.
const WHITESPACE_COLLAPSE = ".replace(/\\s+/gu, ' ').trim()";

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

// Joins a call chain that the formatter split over several lines.
function joinedChains(text: string): string {
  return text.replace(/\n\s*(?=\.)/gu, '');
}

describe('status note text rules', () => {
  it('allows one line of up to 280 characters', () => {
    expect(STATUS_NOTE_MESSAGE_MAX_LENGTH).toBe(280);
  });

  it.each([
    ['  Checks   are delayed  ', 'Checks are delayed'],
    ['Checks\tare\ndelayed\r\n', 'Checks are delayed'],
    ['Checks\u{a0}\u{3000}are\u{2028}\u{2029}delayed\u{feff}', 'Checks are delayed'],
    ['\v\fChecks are delayed', 'Checks are delayed'],
  ])('collapses whitespace runs to one space and trims: %j', (value, message) => {
    expect(canonicalStatusNoteMessage(value)).toEqual({ ok: true, message });
  });

  it.each(['', '   ', '\n\t\u{a0} '])('turns an empty message into a removal: %j', (value) => {
    expect(canonicalStatusNoteMessage(value)).toEqual({ ok: true, message: '' });
  });

  it('keeps visible text exactly, markup included', () => {
    for (const message of [
      '<b>Rooms</b> are slow & <script>alert(1)</script>',
      '방 만들기가 지연되고 있어요',
      'Checks are delayed \u{1F6A7} (UTC)',
    ]) {
      expect(canonicalStatusNoteMessage(message)).toEqual({ ok: true, message });
    }
  });

  it('refuses a message over 280 characters instead of truncating it', () => {
    const limit = 'a'.repeat(STATUS_NOTE_MESSAGE_MAX_LENGTH);
    expect(canonicalStatusNoteMessage(limit)).toEqual({ ok: true, message: limit });
    expect(canonicalStatusNoteMessage(`${limit}b`)).toEqual({
      ok: false,
      error: 'STATUS_NOTE_TOO_LONG',
    });
    // The limit applies after the collapse: 287 characters typed, 280 kept.
    expect(canonicalStatusNoteMessage(`  ${'a'.repeat(278)}    b  `)).toEqual({
      ok: true,
      message: `${'a'.repeat(278)} b`,
    });
    // UTF-16 code units, like the textarea maxlength and the stored record.
    const emoji = '\u{1F6A7}';
    expect(canonicalStatusNoteMessage(emoji.repeat(140))).toEqual({
      ok: true,
      message: emoji.repeat(140),
    });
    expect(canonicalStatusNoteMessage(emoji.repeat(141))).toEqual({
      ok: false,
      error: 'STATUS_NOTE_TOO_LONG',
    });
  });

  it.each([
    ['NUL', '\x00'],
    ['SOH', '\x01'],
    ['BEL', '\x07'],
    ['backspace', '\x08'],
    ['escape', '\x1b'],
    ['file separator', '\x1c'],
    ['unit separator', '\x1f'],
    ['DEL', '\x7f'],
    ['LRE', '\u{202a}'],
    ['RLE', '\u{202b}'],
    ['PDF', '\u{202c}'],
    ['LRO', '\u{202d}'],
    ['RLO', '\u{202e}'],
    ['LRI', '\u{2066}'],
    ['RLI', '\u{2067}'],
    ['FSI', '\u{2068}'],
    ['PDI', '\u{2069}'],
    ['lone high surrogate', '\u{d83d}'],
    ['lone low surrogate', '\u{de80}'],
    ['reversed surrogate pair', '\u{de80}\u{d83d}'],
  ])('refuses %s', (_name, character) => {
    expect(canonicalStatusNoteMessage(`Checks ${character}are delayed`)).toEqual({
      ok: false,
      error: 'STATUS_NOTE_INVALID',
    });
  });

  it('refuses invalid characters before it counts the length', () => {
    expect(canonicalStatusNoteMessage(`${'a'.repeat(300)}\u{202e}`)).toEqual({
      ok: false,
      error: 'STATUS_NOTE_INVALID',
    });
  });

  it.each([null, undefined, 42, true, ['note'], { message: 'note' }])(
    'refuses a value that is not a string: %j',
    (value) => {
      expect(canonicalStatusNoteMessage(value)).toEqual({
        ok: false,
        error: 'STATUS_NOTE_INVALID',
      });
    },
  );
});

describe('status note text parity', () => {
  it('collapses whitespace the same way in the admin client before it sends', () => {
    expect(joinedChains(source('cloudflare/status-note-text.ts'))).toContain(WHITESPACE_COLLAPSE);
    const admin = source('browser/classic-runtime/admin.ts');
    const draft = /function canonicalStatusNoteDraft\([^)]*\): string \{([\s\S]*?)\n\}/u.exec(
      admin,
    );
    expect(joinedChains(draft?.[1] ?? '')).toContain(WHITESPACE_COLLAPSE);
    expect(admin).toContain(`Keep the note to ${STATUS_NOTE_MESSAGE_MAX_LENGTH} characters`);
  });

  it('stays within the stored announcement record limit', () => {
    for (const path of [
      'cloudflare/service-control-object.ts',
      'cloudflare/service-maintenance.ts',
    ]) {
      const limits = [...source(path).matchAll(/message\.length > (\d+)/gu)].map((match) =>
        Number(match[1]),
      );
      expect(limits.length).toBeGreaterThan(0);
      for (const limit of limits) expect(STATUS_NOTE_MESSAGE_MAX_LENGTH).toBeLessThanOrEqual(limit);
    }
  });

  it('writes the refused characters as escapes, never as invisible source text', () => {
    const invisible = [...source('cloudflare/status-note-text.ts')]
      .map((character) => character.codePointAt(0) ?? 0)
      .filter(
        (code) =>
          (code < 0x20 && code !== 0x0a && code !== 0x0d) ||
          code === 0x7f ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069),
      );
    expect(invisible).toEqual([]);
  });
});
