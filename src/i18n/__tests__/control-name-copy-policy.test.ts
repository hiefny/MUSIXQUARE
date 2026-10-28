import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { APP_DICTIONARIES } from '../catalogs.ts';

/**
 * Hint and accessible-name copy policy (owner direction 2026-10-27, UI audit
 * item 6+). An accessible name (aria-label, alt) or hover hint (title, a
 * value's aria-valuetext) ends in a noun form: a Sino-Korean action noun
 * (삭제, 이동), a native verb with -기 (닫기, 열기) or a state noun (필요, 중,
 * 없음). Sentences belong to toasts, dialogs, body text and descriptions.
 *
 * - Korean never ends a name or hint with -하기 or -시키기, a 해요체 or 합니다체
 *   sentence ending, or a period, and never says 클릭하여 or 탭하여, a slash pair,
 *   a leading number, the (으)로 particle trick, {{name}}님 without a space, or
 *   곡 (the app says 트랙).
 * - A toggle keeps one name and aria-pressed or aria-checked tells its state,
 *   so its name never says 전환, 변경, 켜졌어요 or 펼치기/접기. A button whose icon
 *   draws what a press does next (play and pause, the password eye) names that
 *   action, and a control with three or more modes names the current mode.
 * - English uses an imperative for actions and a noun phrase otherwise, in
 *   sentence case, without a final period, a line break, "Click to" or "Tap
 *   to", "Toggle", a slash pair or "Change" on a toggle.
 * - The other 40 locales follow the English structure: one line, no
 *   sentence-final period and the same placeholders.
 *
 * Every key a name or hint reaches is registered below with what it names, so
 * a new key cannot skip these checks. Visible labels (the text is the name),
 * descriptions (aria-describedby takes body sentences) and the excluded rows
 * keep their own copy rules.
 *
 * A lock reason read ahead of a section's own description is a description
 * key of its own, a sentence (rule 10), never the hint's phrase or a toast: a
 * screen reader joins descriptions with a single space.
 */
type Kind =
  | 'action'
  | 'thing'
  | 'value'
  | 'toggle'
  | 'switch'
  | 'next-action'
  | 'cycle'
  | 'disclosure'
  | 'status'
  | 'tip'
  | 'visible'
  | 'description'
  | 'excluded';

interface Entry {
  readonly kinds: readonly Kind[];
  /** A check this key may skip, with the reason. */
  readonly exempt?: {
    readonly enSentenceCase?: string;
    /** Locales whose lock reason description keeps its hint's words. */
    readonly repeatsHint?: Readonly<Record<string, string>>;
  };
  /** Allows one ", value" suffix carrying a current value. */
  readonly allowsValueSuffix?: true;
}

/**
 * Thai writes no sentence-final mark and a space already separates its
 * sentences (settings.eq_desc is two), so the hint phrase reads as a sentence
 * ahead of the section description. A native review may pick another form;
 * then the exception goes.
 */
const THAI_HINT_IS_A_SENTENCE = {
  th: 'a space, not a mark, ends a Thai sentence, so the hint already reads as one',
};

const REGISTRY: Readonly<Record<string, Entry>> = {
  // Common actions and places.
  'common.cancel': { kinds: ['action'] },
  'common.clear_input': { kinds: ['action'] },
  'common.close': { kinds: ['action'] },
  'common.delete': { kinds: ['action'] },
  'common.help': { kinds: ['thing'] },
  'common.next': { kinds: ['action'] },
  'common.next_desc': { kinds: ['action'] },
  'common.pause': { kinds: ['next-action'] },
  'common.previous': { kinds: ['action'] },
  'common.sync': { kinds: ['action'] },
  'common.youtube_video': {
    kinds: ['thing', 'visible'],
    exempt: {
      enSentenceCase:
        'also the visible subtitle and search fallback title, which keep the 9.0.18 English',
    },
  },
  'dialog.go_back': { kinds: ['action'] },
  'nav.connect': { kinds: ['thing'] },
  'nav.go_home': { kinds: ['action'] },
  'nav.playlist': { kinds: ['thing'] },
  'nav.settings': { kinds: ['thing', 'disclosure'] },

  // Account.
  'account.account_title': { kinds: ['thing', 'visible'] },
  'account.change_nickname': { kinds: ['action', 'visible'] },
  'account.login_title': { kinds: ['action', 'visible'] },
  'account.nickname_title': { kinds: ['action', 'visible'] },

  // Player.
  'player.add_media': { kinds: ['action'] },
  'player.admin_permission_checking_tip': { kinds: ['tip'] },
  'player.fullscreen': { kinds: ['toggle'] },
  'player.manual_sync_label': { kinds: ['value'] },
  'player.media_management_checking_tip': { kinds: ['tip'] },
  'player.media_management_required_tip': { kinds: ['tip'] },
  'player.next_track': { kinds: ['action'] },
  'player.no_media': {
    kinds: ['visible', 'tip', 'value'],
    exempt: { enSentenceCase: 'also the visible player title' },
  },
  'player.not_ready_tip': { kinds: ['tip'] },
  'player.play_aria': { kinds: ['next-action'] },
  'player.play_media': { kinds: ['action'] },
  'player.playback_control_checking_tip': { kinds: ['tip'] },
  'player.playback_control_required_tip': { kinds: ['tip'] },
  'player.prev_track': { kinds: ['action'] },
  'player.repeat_all_aria': { kinds: ['cycle'] },
  'player.repeat_off_aria': { kinds: ['cycle'] },
  'player.repeat_one_aria': { kinds: ['cycle'] },
  'player.seek': { kinds: ['value'] },
  'player.shuffle_mode': { kinds: ['toggle'] },
  'player.syncing_aria': { kinds: ['status'] },
  'player.toggle_mute': { kinds: ['toggle'] },
  'player.visualizer': { kinds: ['thing', 'cycle'] },
  'player.visualizer_circular': { kinds: ['cycle'] },
  'player.visualizer_mode_hint': { kinds: ['description'] },
  'player.visualizer_spectrum': { kinds: ['cycle'] },
  'player.volume': { kinds: ['value'] },
  'player.volume_locked_tip': { kinds: ['tip'] },
  'system_audio.sharing': {
    kinds: ['visible', 'tip'],
    exempt: { enSentenceCase: 'the visible System Audio title family' },
  },
  'system_audio.stop': {
    kinds: ['visible', 'action'],
    exempt: { enSentenceCase: 'the visible System Audio button family' },
  },

  // Playlist.
  'playlist.item_tracks_aria': { kinds: ['disclosure'] },
  'playlist.jump_to_current': { kinds: ['action'] },
  'playlist.move_action': { kinds: ['action'] },
  'playlist.reorder_handle': { kinds: ['action'], allowsValueSuffix: true },
  'playlist.select_mode_hint': { kinds: ['tip'] },
  'playlist.select_track': { kinds: ['toggle'] },
  'playlist.selected_count': { kinds: ['visible'] },
  'pro.upload.cancel_file': { kinds: ['action'] },
  'pro.upload.confirming_file': { kinds: ['tip'] },

  // Chat.
  'chat.bot_processing': { kinds: ['excluded'] },
  'chat.close': { kinds: ['action'] },
  'chat.input_label': { kinds: ['value'] },
  'chat.open': { kinds: ['action'] },
  'chat.pinned_close': { kinds: ['action'] },
  'chat.scroll_to_bottom': { kinds: ['action'] },
  'chat.seek_to': { kinds: ['action'] },
  'chat.send': { kinds: ['action'] },
  'chat.title': { kinds: ['thing'] },
  'chat.copy_hint': { kinds: ['description'] },

  // Connect.
  'connect.administrator_grant_aria': { kinds: ['action'] },
  'connect.administrator_revoke_aria': { kinds: ['action'] },
  'connect.administrator_role': { kinds: ['thing'] },
  'connect.administrator_settings_aria': { kinds: ['action'] },
  'connect.device_toggle': { kinds: ['disclosure'] },
  'connect.invite_qr_aria': { kinds: ['thing'] },
  'connect.kick_device_aria': { kinds: ['action'] },
  'connect.kick_member_aria': { kinds: ['action'] },
  'connect.room_owner_role': { kinds: ['thing'] },
  'connect.room_password_hide': { kinds: ['next-action'] },
  'connect.room_password_show': { kinds: ['next-action'] },
  'connect.room_password_title': { kinds: ['visible', 'switch'] },
  'pro.pin_change_title': { kinds: ['action'] },

  // Settings.
  'settings.eq_band_aria': { kinds: ['value'] },
  'settings.language_manual_aria': { kinds: ['action'] },
  'settings.language_select_aria': { kinds: ['action'] },
  'settings.language_system_aria': { kinds: ['action'] },
  'settings.reverb_decay': { kinds: ['value', 'visible'] },
  'settings.reverb_highcut': { kinds: ['value', 'visible'] },
  'settings.reverb_lowcut': { kinds: ['value', 'visible'] },
  'settings.reverb_mix': { kinds: ['value', 'visible'] },
  'settings.reverb_predelay': { kinds: ['value', 'visible'] },
  'settings.subwoofer_cutoff': { kinds: ['value'] },
  'settings.sync_settings': { kinds: ['status', 'visible'] },

  // Setup, demo and help.
  'demo.step_finish': { kinds: ['visible'] },
  'demo.step_nav_label': { kinds: ['thing'] },
  'demo.track_list_label': { kinds: ['thing'] },
  'help.local_file': { kinds: ['thing'] },
  'screensaver.name': { kinds: ['thing'] },
  'setup.carousel_dot_aria': { kinds: ['thing'] },
  'setup.carousel_pause': { kinds: ['description'] },
  'setup.enter_code': { kinds: ['value'] },
  'setup.enter_code_connect': { kinds: ['visible'] },
  'setup.scan_qr': { kinds: ['action'] },
  'setup.what_sound': { kinds: ['visible'] },

  // YouTube.
  'youtube.enter_source': { kinds: ['value'] },
  'youtube.open_link': { kinds: ['action'] },
  'youtube.search_button': { kinds: ['action'] },
  'youtube.search_results': { kinds: ['thing'] },
  'youtube.tap_to_play': {
    kinds: ['visible'],
    exempt: { enSentenceCase: 'the visible all-caps TAP TO PLAY chip' },
  },
  'youtube.thumbnail': { kinds: ['thing'] },

  // Visible titles that name a control or region through aria-labelledby.
  'player.select_media': { kinds: ['visible'] },
  'playlist.slots_title': { kinds: ['visible'] },
  'settings.eq_title': { kinds: ['visible'] },
  'settings.language': { kinds: ['visible'] },
  'settings.language_dialog_title': { kinds: ['visible'] },
  'settings.reverb_title': { kinds: ['visible'] },
  'settings.theme': { kinds: ['visible'] },
  'settings.ui_sounds': { kinds: ['visible'] },
  'settings.virtual_effects_title': { kinds: ['visible'] },
  'setup.set_role': { kinds: ['visible'] },
  'youtube.watch_together': { kinds: ['visible'] },

  // Descriptions reached through aria-describedby: body sentences.
  'playlist.slots_subtitle': { kinds: ['description'] },
  'settings.eq_desc': { kinds: ['description'] },
  'settings.language_desc': { kinds: ['description'] },
  'settings.reverb_desc': { kinds: ['description'] },
  'settings.role_center_desc': { kinds: ['description'] },
  'settings.sync_settings_desc': { kinds: ['description'] },
  'settings.theme_desc': { kinds: ['description'] },
  'settings.ui_sounds_desc': { kinds: ['description'] },
  'settings.virtual_effects_desc': { kinds: ['description'] },
  'youtube.enter_link_prompt': { kinds: ['description'] },

  // Lock reasons read ahead of a section description (rule 10): sentences of
  // their own, while the *_tip phrase stays the hover hint.
  'settings.audio_lock_checking_desc': {
    kinds: ['description'],
    exempt: { repeatsHint: THAI_HINT_IS_A_SENTENCE },
  },
  'settings.audio_locked_desc': {
    kinds: ['description'],
    exempt: { repeatsHint: THAI_HINT_IS_A_SENTENCE },
  },

  // Fallback values put into a name or title, not names themselves.
  'common.info': { kinds: ['excluded'] },
  'common.peer': { kinds: ['excluded'] },
  'common.unknown': { kinds: ['excluded'] },
  'player.select_file_hint': { kinds: ['excluded'] },
  'playlist.video_fallback': { kinds: ['excluded'] },
};

/** Kinds that take the name and hint form checks. */
const NAME_KINDS: ReadonlySet<Kind> = new Set([
  'action',
  'thing',
  'value',
  'toggle',
  'switch',
  'next-action',
  'cycle',
  'disclosure',
  'status',
  'tip',
]);

const PROPER_NOUNS = new Set(['MUSIXQUARE', 'YouTube', 'QR', 'Google', 'PRO', 'Hz', 'kHz', 'BOT']);

const en = APP_DICTIONARIES.en as Readonly<Record<string, string>>;
const ko = APP_DICTIONARIES.ko as Readonly<Record<string, string>>;

function nameKeys(): string[] {
  return Object.entries(REGISTRY)
    .filter(([, entry]) => entry.kinds.some((kind) => NAME_KINDS.has(kind)))
    .map(([key]) => key);
}

// ─── Source scan ────────────────────────────────────────────────

function appSources(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => /\.(?:ts|tsx|mts)$/u.test(file))
    .filter((file) => !/(?:^|\/)__tests__\//u.test(file) && !file.startsWith('src/i18n/'))
    .filter((file) => existsSync(file) && statSync(file).isFile());
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gmu, '$1');
}

/** The text of a call's arguments up to its closing parenthesis. */
function callArguments(source: string, open: number): string {
  let depth = 1;
  let index = open;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === "'" || char === '"') {
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
    }
    index += 1;
  }
  return source.slice(open, index - 1);
}

/** Dictionary keys written as string literals in a piece of code. */
function keyLiterals(code: string): string[] {
  return [...code.matchAll(/['"`]([a-z_]+(?:\.[a-z0-9_]+)+)['"`]/gu)]
    .map((match) => match[1] ?? '')
    .filter((key) => key in en);
}

/**
 * Keys a piece of code reaches: its literals and the tables behind the
 * imported helpers it calls.
 */
function reachedKeys(code: string): string[] {
  const keys = keyLiterals(code);
  for (const identifier of code.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) {
    keys.push(...importedTableKeys(identifier[1] ?? ''));
  }
  return keys;
}

/** Keys a local constant or function can hand to a label sink. */
function localKeySources(code: string, name: string): string[] {
  const keys: string[] = [];
  const declaration = new RegExp(`(?:const|let)\\s+${name}\\b[^=;]*=([\\s\\S]*?);`, 'gu');
  for (const match of code.matchAll(declaration)) keys.push(...reachedKeys(match[1] ?? ''));
  const fn = new RegExp(`function\\s+${name}\\s*\\(`, 'gu');
  for (const match of code.matchAll(fn)) {
    const bodyStart = code.indexOf('{', (match.index ?? 0) + match[0].length);
    if (bodyStart >= 0) keys.push(...reachedKeys(callArguments(code, bodyStart + 1)));
  }
  return keys;
}

/** Helpers that live in another module, read from that module's tables. */
const IMPORTED_KEY_TABLES: Readonly<
  Record<string, { readonly file: string; readonly tables: readonly string[] }>
> = {
  roomCapabilityFeedbackTip: {
    file: 'src/rooms/permission-feedback.ts',
    tables: ['const ROOM_CAPABILITY_TIP_KEYS', 'const ROOM_CAPABILITY_CHECKING_TIP_KEYS'],
  },
  roomCapabilityFeedbackDescription: {
    file: 'src/rooms/permission-feedback.ts',
    tables: ['const ROOM_CAPABILITY_DESCRIPTION_KEYS'],
  },
  // The toast mapper. Its keys in a label sink are toast copy in a hint, which
  // the toast check below rejects.
  roomCapabilityFeedbackMessage: {
    file: 'src/rooms/permission-feedback.ts',
    tables: ['const CAPABILITY_REQUIRED_TOAST', 'const CAPABILITY_CHECKING_TOAST'],
  },
};

function importedTableKeys(name: string): string[] {
  // Own keys only: a body can mention constructor or toString.
  if (!Object.hasOwn(IMPORTED_KEY_TABLES, name)) return [];
  const source = IMPORTED_KEY_TABLES[name]!;
  const code = readFileSync(source.file, 'utf8');
  return source.tables.flatMap((table) => {
    const start = code.indexOf(table);
    expect(start, `${source.file} defines ${table}`).toBeGreaterThanOrEqual(0);
    const open = code.indexOf('{', start);
    return keyLiterals(callArguments(code, open + 1));
  });
}

/** The top-level arguments of a call, split at its commas. */
function splitArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < args.length && args[index] !== quote) {
        if (args[index] === '\\') index += 1;
        index += 1;
      }
    } else if (char === ',' && depth === 0) {
      parts.push(args.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(args.slice(from));
  return parts;
}

interface Sink {
  readonly pattern: RegExp;
  /** The argument that carries the text; without one, the rest of the line. */
  readonly argument?: number;
  /** Writes a description read ahead of the control's own, not a name or hint. */
  readonly describes?: true;
}

/**
 * Label sinks: every place a name, a hint or a value text is written, with
 * the argument that carries the text, and setControlUnavailable's describe
 * option, which writes a lock reason as a description.
 */
const SINKS: readonly Sink[] = [
  {
    pattern: /\bsetAttribute\(\s*(?=['"](?:aria-label|aria-valuetext|data-i18n-aria-label)['"])/gu,
    argument: 1,
  },
  { pattern: /\bsetControl(?:Unavailable|Hint)\(/gu, argument: 1 },
  { pattern: /\b_administratorActionButton\(/gu, argument: 1 },
  { pattern: /\bariaLabel\s*[:=]/gu },
  { pattern: /aria-label="\$\{/gu },
  { pattern: /\.title\s*=(?!=)/gu },
  { pattern: /\bdescribe:/gu, describes: true },
];

const DESCRIPTION_SINKS = SINKS.filter((sink) => sink.describes);

/** Every key one source file hands to a label sink (or only to the given sinks). */
function sinkKeys(code: string, sinks: readonly Sink[] = SINKS): string[] {
  const keys: string[] = [];
  for (const { pattern, argument } of sinks) {
    for (const match of code.matchAll(pattern)) {
      const start = (match.index ?? 0) + match[0].length;
      const statement =
        argument === undefined
          ? code.slice(start, code.indexOf('\n', start) + 1 || undefined)
          : (splitArguments(callArguments(code, start))[argument] ?? '');
      keys.push(...reachedKeys(statement));
      for (const identifier of statement.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) {
        keys.push(...localKeySources(code, identifier[1] ?? ''));
      }
    }
  }
  return keys;
}

function scannedSourceKeys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of appSources()) {
    for (const key of sinkKeys(stripComments(readFileSync(file, 'utf8')))) {
      if (!found.has(key)) found.set(key, file);
    }
  }
  return found;
}

function scannedMarkupKeys(): Map<string, string> {
  const markup = readFileSync('index.html', 'utf8').replace(/<!--[\s\S]*?-->/gu, '');
  const found = new Map<string, string>();
  for (const match of markup.matchAll(/data-i18n-(?:aria-label|alt|title)="([^"]+)"/gu)) {
    found.set(match[1] ?? '', 'index.html');
  }
  // A visible label or description reached by id is part of the name too.
  const ids = new Map<string, string>();
  for (const match of markup.matchAll(/<[a-z][^>]*>/gu)) {
    const tag = match[0];
    const id = /\sid="([^"]+)"/u.exec(tag)?.[1];
    const key = /\sdata-i18n="([^"]+)"/u.exec(tag)?.[1];
    if (id && key) ids.set(id, key);
  }
  for (const match of markup.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/gu)) {
    for (const id of (match[1] ?? '').split(/\s+/u)) {
      const key = ids.get(id);
      if (key) found.set(key, `index.html#${id}`);
    }
  }
  return found;
}

// ─── Form checks ────────────────────────────────────────────────

function koViolations(key: string, entry: Entry, value: string): string[] {
  const kinds = new Set(entry.kinds);
  const problems: string[] = [];
  const check = (failed: boolean, why: string) => {
    if (failed) problems.push(`${key}: ${why}: ${JSON.stringify(value)}`);
  };
  check(/(?:하기|시키기)$/u.test(value), 'ends with -하기 or -시키기');
  check(/(?<!필)요$/u.test(value), 'ends as a 해요체 sentence');
  check(/니다$/u.test(value), 'ends as a 합니다체 sentence');
  check(/[었았였졌됐했]다$/u.test(value), 'ends as a past-tense sentence');
  check(/[.!?。…]$/u.test(value), 'ends with sentence punctuation');
  check(value.includes('\n'), 'breaks the line');
  check(/[가-힣a-z]\s?\/\s?[가-힣a-z]/u.test(value), 'uses a slash pair');
  check(/^\d+\.\s/u.test(value), 'starts with a number');
  check(/클릭|탭하여|탭해서/u.test(value), 'names a pointer gesture');
  check(/\(으\)로/u.test(value), 'uses the (으)로 particle trick');
  check(/\}\}님/u.test(value), 'writes 님 without a space after the name');
  check(/(?:^|\s)곡(?:\s|$|을|이|은|의)/u.test(value), 'says 곡 instead of 트랙');
  check(!entry.allowsValueSuffix && /, /u.test(value), 'adds a second clause after a comma');
  if (kinds.has('toggle') || kinds.has('switch')) {
    check(/(?:전환|변경)$/u.test(value), 'names a toggle by its switching');
    check(/켜졌|꺼졌/u.test(value), 'puts the state in a toggle name');
  }
  if (kinds.has('disclosure')) check(/펼치기|접기/u.test(value), 'names the expanding');
  return problems;
}

function enViolations(key: string, entry: Entry, value: string): string[] {
  const kinds = new Set(entry.kinds);
  const problems: string[] = [];
  const check = (failed: boolean, why: string) => {
    if (failed) problems.push(`${key}: ${why}: ${JSON.stringify(value)}`);
  };
  check(/\.$/u.test(value), 'ends with a period');
  check(value.includes('\n'), 'breaks the line');
  check(/^(?:Click|Tap) to/iu.test(value), 'names a pointer gesture');
  check(/^Toggle /u.test(value), 'starts with Toggle');
  check(/\w\/\w/u.test(value), 'uses a slash pair');
  check(
    /[A-Z]/u.test(value) && !/[a-z]/u.test(value.replace(/\{\{\w+\}\}/gu, '')),
    'is all capitals',
  );
  if (kinds.has('toggle') || kinds.has('switch') || kinds.has('cycle')) {
    check(/^Change /u.test(value), 'names a toggle or mode by changing it');
  }
  if (!entry.exempt?.enSentenceCase) {
    const words = value
      .replace(/\{\{\w+\}\}/gu, '')
      .split(/\s+/u)
      .slice(1)
      .map((word) => word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
      .filter(Boolean);
    const capitalized = words.filter(
      (word) => /^\p{Lu}/u.test(word) && !PROPER_NOUNS.has(word) && !/^\p{Lu}+$/u.test(word),
    );
    check(capitalized.length > 0, `capitalizes ${capitalized.join(', ')} mid-sentence`);
  }
  return problems;
}

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1] ?? '').sort();

describe('hint and accessible-name copy policy', () => {
  it('registers every key that reaches a name, hint or value text', () => {
    const found = new Map([...scannedMarkupKeys(), ...scannedSourceKeys()]);
    // The scan reaches the tables behind the tip helpers.
    expect(found.has('player.volume_locked_tip')).toBe(true);
    expect(found.has('player.admin_permission_checking_tip')).toBe(true);
    expect(found.has('player.not_ready_tip')).toBe(true);
    expect(found.has('player.repeat_one_aria')).toBe(true);

    const unregistered = [...found]
      .filter(([key]) => !(key in REGISTRY))
      .map(([key, where]) => `${key} (${where}): register it with its kinds`);
    expect(unregistered).toEqual([]);
  });

  it('registers only keys that exist and are still used', () => {
    const sources = [
      readFileSync('index.html', 'utf8'),
      ...appSources().map((file) => readFileSync(file, 'utf8')),
    ].join('\n');
    for (const key of Object.keys(REGISTRY)) {
      expect(en[key], `en.${key}`).toBeTypeOf('string');
      expect(sources.includes(`'${key}'`) || sources.includes(`"${key}"`), `${key} in use`).toBe(
        true,
      );
    }
  });

  it('keeps toast copy out of names and hints', () => {
    // A toast sentence used as a name or hint reads two sentences on hover.
    // Make a *_tip or *_aria key instead (shared keys that pass both rules,
    // like player.no_media, are registered under their own namespace).
    expect(nameKeys().filter((key) => key.startsWith('toast.'))).toEqual([]);
  });

  it('follows a hint through local helpers to the toast mapper', () => {
    // The pending "checking" toast once reached play, media and seek hints
    // through roomCapabilityFeedbackMessage, which the scan did not follow.
    const keys = sinkKeys(`
      function lockedTip() { return roomCapabilityFeedbackMessage('media.add'); }
      button.title = lockedTip();
      const reason = roomCapabilityFeedbackMessage('playback.control');
      setControlUnavailable(other, reason);
      setControlUnavailable(group, roomCapabilityFeedbackTip('effects.control'));
    `);
    expect(keys).toEqual(
      expect.arrayContaining([
        'toast.media_management_checking',
        'toast.playback_control_required',
        'player.admin_permission_checking_tip',
        'player.volume_locked_tip',
      ]),
    );
    expect(keys.filter((key) => key.startsWith('toast.'))).not.toEqual([]);
  });

  it('ends every Korean name and hint in a noun form', () => {
    const problems = nameKeys().flatMap((key) =>
      koViolations(key, REGISTRY[key] as Entry, ko[key] ?? ''),
    );
    expect(problems).toEqual([]);
  });

  it('writes every English name and hint as an imperative or a noun phrase in sentence case', () => {
    const problems = nameKeys().flatMap((key) =>
      enViolations(key, REGISTRY[key] as Entry, en[key] ?? ''),
    );
    expect(problems).toEqual([]);
  });

  it('finds the forms it forbids', () => {
    const action: Entry = { kinds: ['action'] };
    const toggle: Entry = { kinds: ['toggle'] };
    const disclosure: Entry = { kinds: ['disclosure'] };
    for (const value of [
      '삭제하기',
      '강제퇴장시키기',
      '반복 재생이 켜졌어요',
      '설정 동기화가 켜져 있어요',
      '로그인할 수 없습니다',
      '연결됐다',
      '닫기.',
      '재생/일시정지',
      '4. 체험 종료',
      '클릭하여 초대 코드 복사',
      '탭하여 스캔',
      '{{time}}(으)로 이동',
      '{{name}}님의 연결 기기',
      '새 곡 추가',
      '1 / 4, 슬라이드 자동 전환 일시정지',
    ]) {
      expect(koViolations('k', action, value), value).not.toEqual([]);
    }
    expect(koViolations('k', toggle, '음소거 전환')).not.toEqual([]);
    expect(koViolations('k', toggle, '반복 모드 변경')).not.toEqual([]);
    expect(koViolations('k', disclosure, '재생목록 펼치기/접기')).not.toEqual([]);
    for (const value of ['재생 제어 권한 필요', '{{name}} 님 내보내기', '닫기', '동기화 중']) {
      expect(koViolations('k', action, value), value).toEqual([]);
    }

    for (const value of [
      'Delete.',
      'Click to copy invite code',
      'Tap to scan',
      'Toggle mute',
      'Play/Pause',
      'Go to Home',
      'BETA',
    ]) {
      expect(enViolations('k', action, value), value).not.toEqual([]);
    }
    expect(enViolations('k', toggle, 'Change shuffle mode')).not.toEqual([]);
    for (const value of [
      'Change room password',
      'Scan QR code',
      'Kick {{name}}',
      'Go to home screen',
    ]) {
      expect(enViolations('k', action, value), value).toEqual([]);
    }
  });

  it('keeps every other locale on one line with the English placeholders', () => {
    expect(Object.keys(APP_DICTIONARIES)).toHaveLength(42);
    const problems: string[] = [];
    for (const [locale, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const byKey = dictionary as Readonly<Record<string, string>>;
      // Every locale spreads English first, so a key the locale never wrote
      // still has a value: look for the key in the locale's own source.
      const source = readFileSync(`src/i18n/${locale}.ts`, 'utf8');
      for (const key of nameKeys()) {
        const value = byKey[key] ?? '';
        if (!value) problems.push(`${locale}.${key}: missing`);
        if (!source.includes(`'${key}':`)) problems.push(`${locale}.${key}: falls back to English`);
        if (value.includes('\n')) problems.push(`${locale}.${key}: breaks the line`);
        if (/(?:\.{2,}|[.。．।۔…!?！？؟])$/u.test(value)) {
          problems.push(`${locale}.${key}: ends a sentence`);
        }
        if (placeholders(value).join() !== placeholders(en[key] ?? '').join()) {
          problems.push(`${locale}.${key}: placeholders differ from English`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('puts an action name and its target in one phrase in every locale', () => {
    // Rule 3.5: '{kick_title}: {name}' reads as two labels glued together.
    // An action name carries the row it acts on inside one phrase, like
    // Kick {{name}}. A value after a colon (a seek time) is not a target.
    const assembled: string[] = [];
    for (const [locale, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const byKey = dictionary as Readonly<Record<string, string>>;
      for (const key of nameKeys()) {
        if (!(REGISTRY[key] as Entry).kinds.includes('action')) continue;
        const value = byKey[key] ?? '';
        if (/[:：]\s*\{\{(?:name|title)\}\}/u.test(value)) {
          assembled.push(`${locale}.${key}: ${value}`);
        }
      }
    }
    expect(assembled).toEqual([]);
  });

  it('keeps the language chip visible word inside its name in every locale', () => {
    // WCAG 2.5.3 Label in Name: the chip shows settings.language_select and
    // is named settings.language_manual_aria, so a voice user who says the
    // visible word reaches it (rule #28a).
    const misses: string[] = [];
    for (const [locale, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const byKey = dictionary as Readonly<Record<string, string>>;
      const visible = (byKey['settings.language_select'] ?? '').toLowerCase();
      const name = (byKey['settings.language_manual_aria'] ?? '').toLowerCase();
      if (!visible || !name.includes(visible)) misses.push(`${locale}: ${visible} / ${name}`);
    }
    expect(misses).toEqual([]);
  });

  it('keeps the visible English of a name that is also screen text', () => {
    // Owner decision (2026-10-27, late evening): this train changes no English
    // screen text. common.youtube_video names the YouTube frame and is also
    // the subtitle of a YouTube track without an artist and the title of a
    // search result without one, so it keeps 9.0.18's 'YouTube Video'.
    expect(en['common.youtube_video']).toBe('YouTube Video');
    expect(REGISTRY['common.youtube_video']?.exempt?.enSentenceCase).toBeTruthy();
  });

  it('keeps the 9.0.18 Korean of the visible labels the owner kept', () => {
    // Owner decision (2026-10-28): these visible labels stay as 9.0.18 in
    // every locale. They are screen text, not hint or name copy, so the noun
    // form above does not reach them: the invite pill and the administrator
    // permissions title are written by src/ui/connect.ts, and the demo step
    // chips show their own text (the final step's also names its button).
    const kept: Readonly<Record<string, string>> = {
      'connect.copy_invite_link': '초대 링크 복사하기',
      'connect.permissions_title': '{{name}}님의 권한',
      'demo.step_connect': '1. 기기 연결하기',
      'demo.step_role': '2. 역할 설정하기',
      'demo.step_effects': '3. 고급 음향 효과',
      'demo.step_finish': '4. 체험 종료하기',
    };
    for (const [key, value] of Object.entries(kept)) {
      expect(ko[key], key).toBe(value);
      expect(nameKeys(), key).not.toContain(key);
    }
    // The other kick wording of this train stays.
    expect(ko['connect.kick_title']).toBe('기기 내보내기');
    expect(ko['connect.kicked_title']).toBe('방에서 내보내졌어요');
    expect(ko['connect.permission_members_kick']).toBe('멤버 내보내기');
  });

  it('titles the Korean kicked dialog without repeating its message', () => {
    // Like the PRO removal dialog: the title says what happened, the message
    // says who did it.
    expect(ko['connect.kicked_title']).toBe(ko['pro.removed_title']);
    expect(ko['connect.kicked_message']).toBe('방장이 이 방에서 내보냈어요.');
    expect(ko['connect.kicked_message']).not.toContain(ko['connect.kicked_title']!);
  });

  it('gives an icon that shows a hint and a name one key', () => {
    const markup = readFileSync('index.html', 'utf8').replace(/<!--[\s\S]*?-->/gu, '');
    for (const match of markup.matchAll(/<[a-z][^>]*>/gu)) {
      const title = /data-i18n-title="([^"]+)"/u.exec(match[0])?.[1];
      const label = /data-i18n-aria-label="([^"]+)"/u.exec(match[0])?.[1];
      if (title && label) expect(title, match[0]).toBe(label);
    }
  });

  it('pins representative names in Korean and English', () => {
    expect([ko['common.delete'], en['common.delete']]).toEqual(['삭제', 'Delete']);
    expect([ko['connect.kick_member_aria'], en['connect.kick_member_aria']]).toEqual([
      '{{name}} 님 내보내기',
      'Kick {{name}}',
    ]);
    expect([ko['player.repeat_one_aria'], en['player.repeat_one_aria']]).toEqual([
      '현재 트랙 반복',
      'Repeat current track',
    ]);
    expect([ko['player.repeat_off_aria'], en['player.repeat_off_aria']]).toEqual([
      '반복 안 함',
      'Repeat off',
    ]);
    expect([ko['player.toggle_mute'], en['player.toggle_mute']]).toEqual(['음소거', 'Mute']);
    expect([ko['player.play_aria'], en['player.play_aria']]).toEqual(['재생', 'Play']);
    expect([ko['player.volume_locked_tip'], en['player.volume_locked_tip']]).toEqual([
      '음향 설정은 방 관리자만 변경 가능',
      'Only room admins can change audio settings',
    ]);
    expect([
      ko['player.playback_control_checking_tip'],
      en['player.playback_control_checking_tip'],
    ]).toEqual(['재생 제어 권한 확인 중', 'Checking playback control permission']);
    expect([
      ko['player.media_management_checking_tip'],
      en['player.media_management_checking_tip'],
    ]).toEqual(['미디어 관리 권한 확인 중', 'Checking media management permission']);
    expect([
      ko['player.admin_permission_checking_tip'],
      en['player.admin_permission_checking_tip'],
    ]).toEqual(['관리자 권한 확인 중', 'Checking administrator permissions']);
    expect([ko['setup.carousel_dot_aria'], en['setup.carousel_dot_aria']]).toEqual([
      '{{total}}개 중 {{current}}번째 설명',
      'Slide {{current}} of {{total}}',
    ]);
  });
});

// ─── Lock reason descriptions ───────────────────────────────────

/** Lock reasons read ahead of a section description (rule 10). */
const LOCK_REASON_DESCRIPTIONS = [
  'settings.audio_locked_desc',
  'settings.audio_lock_checking_desc',
] as const;

/** The hint phrases and toasts that give the same lock reasons. */
const LOCK_REASON_COPY = [
  'player.volume_locked_tip',
  'player.admin_permission_checking_tip',
  'toast.settings_sync_admin_required',
  'toast.admin_permission_checking',
] as const;

/** A value's sentence-final mark, or '' when it ends without one. */
const finalMark = (value: string): string => /[.。．।۔…!?！？؟]$/u.exec(value)?.[0] ?? '';

/** The keys that are registered as anything but a description. */
const notDescriptions = (keys: Iterable<string>): string[] =>
  [...keys].filter((key) => REGISTRY[key]?.kinds.join() !== 'description');

describe('lock reason description copy', () => {
  it('describes a lock with description keys only', () => {
    // setControlUnavailable's describe option puts the reason ahead of the
    // section's own description, and a screen reader joins the two with a
    // single space: a hint's phrase or a toast there runs into the section's
    // first sentence (rule 10).
    const found = new Map<string, string>();
    for (const file of appSources()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const key of sinkKeys(code, DESCRIPTION_SINKS)) {
        if (!found.has(key)) found.set(key, file);
      }
    }
    expect([...found.keys()].sort()).toEqual([...LOCK_REASON_DESCRIPTIONS].sort());
    expect(notDescriptions(found.keys())).toEqual([]);

    // The scan follows the description helper to its table, and finds a hint
    // phrase that reaches the option.
    const keys = sinkKeys(
      `
      const description = roomCapabilityFeedbackDescription('effects.control');
      setControlUnavailable(group, reason, { describe: description });
      setControlUnavailable(volume, reason, { describe: true });
      setControlUnavailable(other, reason, { describe: roomCapabilityFeedbackTip('effects.control') });
    `,
      DESCRIPTION_SINKS,
    );
    expect(keys).toEqual(
      expect.arrayContaining([...LOCK_REASON_DESCRIPTIONS, 'player.volume_locked_tip']),
    );
    expect(notDescriptions(keys)).toContain('player.volume_locked_tip');
  });

  it('writes each lock reason description as one sentence in every locale', () => {
    // Rule 10: one line in the locale's own source (no English fallback),
    // ending the way that locale ends settings.reverb_desc, the section
    // description it is read ahead of. Only Thai ends a sentence without a
    // mark.
    const problems: string[] = [];
    const unmarked: string[] = [];
    for (const [locale, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const byKey = dictionary as Readonly<Record<string, string>>;
      const source = readFileSync(`src/i18n/${locale}.ts`, 'utf8');
      const mark = finalMark(byKey['settings.reverb_desc'] ?? '');
      if (!mark) unmarked.push(locale);
      for (const key of LOCK_REASON_DESCRIPTIONS) {
        const value = byKey[key] ?? '';
        if (!value) problems.push(`${locale}.${key}: missing`);
        if (!source.includes(`'${key}':`)) problems.push(`${locale}.${key}: falls back to English`);
        if (value.includes('\n')) problems.push(`${locale}.${key}: breaks the line`);
        const ending = finalMark(value);
        if (ending !== mark) {
          problems.push(`${locale}.${key}: ends with '${ending}', not '${mark}'`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(unmarked).toEqual(['th']);
  });

  it('keeps each lock reason description apart from its hint and toast copy', () => {
    // The hint keeps its phrase and the toast its lines, so the description
    // is a sentence of its own in every locale. An exception says why, and
    // goes once the locale's description no longer repeats that copy.
    const problems: string[] = [];
    for (const [locale, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const byKey = dictionary as Readonly<Record<string, string>>;
      const copy = new Set<string>();
      for (const key of LOCK_REASON_COPY) {
        const value = byKey[key] ?? '';
        copy.add(value);
        for (const line of value.split('\n')) copy.add(line);
      }
      for (const key of LOCK_REASON_DESCRIPTIONS) {
        const repeats = copy.has(byKey[key] ?? '');
        const exempt = REGISTRY[key]?.exempt?.repeatsHint?.[locale];
        if (repeats && !exempt) problems.push(`${locale}.${key}: repeats its hint or toast`);
        if (exempt && !repeats) problems.push(`${locale}.${key}: exempt, but repeats nothing`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('pins the lock reason descriptions in Korean and English', () => {
    // Owner decision (2026-10-28): the toast's own words, as sentences.
    expect([ko['settings.audio_locked_desc'], en['settings.audio_locked_desc']]).toEqual([
      '방 관리자만 음향 설정을 변경할 수 있어요.',
      'Only room admins can change audio settings.',
    ]);
    expect([
      ko['settings.audio_lock_checking_desc'],
      en['settings.audio_lock_checking_desc'],
    ]).toEqual(['관리자 권한을 확인 중이에요.', 'Checking administrator permissions.']);
  });
});
