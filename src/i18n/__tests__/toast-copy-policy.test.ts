import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_DICTIONARIES } from '../catalogs.ts';
import { pluralMessagesForTests } from '../plural.ts';

/**
 * Toast copy policy (owner decision 2026-10-15). A toast does not close its
 * sentences with a period. When it says more than one sentence, each sentence
 * starts a new line instead of following a period and a space. Question and
 * exclamation marks stay, an ellipsis still marks progress, and abbreviations
 * keep their periods.
 *
 * Every `toast.*` key follows the policy. These keys from other namespaces also
 * reach a toast, directly or through a message helper (capability, sync, seek,
 * upload, queue-mutation, setup-error and PRO playlist errors). Some of them
 * also appear in dialogs, chat or inline errors, which take the same copy.
 */
const SHARED_TOAST_KEYS = [
  'account.action_failed',
  'account.delete_pending',
  'account.login_cancelled',
  'account.login_failed',
  'account.nickname_saved',
  'account.nickname_taken',
  'account.welcome_back',
  'chat.copied',
  'chat.debug_copied',
  'chat.msg_truncated',
  'chat.muted_placeholder',
  'chat.remote_upload_failed_system_message',
  'chat.remote_upload_limited_system_message',
  'chat.update_available_app_system_message',
  'chat.update_available_tab_system_message',
  'common.granted',
  'common.muted',
  'common.pause',
  'common.revoked',
  'common.stop',
  'common.unknown',
  'common.volume_percent',
  'connect.link_copied',
  'connect.room_password_apply_pending',
  'connect.room_password_disabled',
  'demo.external_playback_stopped',
  'demo.host_only_exit',
  'demo.try_later_toast',
  'error.all_tracks_failed',
  'error.audio_decode_fail',
  'error.audio_engine_prepare',
  'error.browser_unsupported',
  'error.connect_failed',
  'error.host_conn_error',
  'error.host_disconnected',
  'error.host_left',
  'error.host_unreachable',
  'error.https_required',
  'error.load_failed',
  'error.network_generic',
  'error.network_init_failed',
  'error.network_issue',
  'error.no_host_id',
  'error.peer_not_ready',
  'error.peer_unavailable',
  'error.room_password_auth_timeout',
  'error.server_disconnected',
  'error.session_id_unavailable',
  'error.signal_server_fail',
  'error.ssl_required',
  'error.webrtc_failed',
  'network.op_granted',
  'network.op_revoked',
  'network.session_full',
  'player.no_media',
  'player.seek_unavailable_system_audio',
  'playlist.empty_hint',
  'playlist.host_update_required',
  'playlist.mutation_retry',
  'playlist.queue_full',
  'playlist.reorder_failed',
  'playlist.repeat_all',
  'playlist.repeat_off',
  'playlist.repeat_one',
  'playlist.shuffle_off',
  'playlist.shuffle_on',
  'pro.connect_failed',
  'pro.file_too_large',
  'pro.owner_only',
  'pro.pin_changed',
  'pro.pin_enabled',
  'pro.quota_exceeded',
  'pro.resume_tap',
  'role.center_placement',
  'role.left_placement',
  'role.right_placement',
  'role.subwoofer_placement',
  'setup.camera_not_found',
  'setup.camera_permission_denied',
  'setup.camera_stream_stalled',
  'setup.camera_unavailable',
  'setup.select_role_alt',
  'share.remote.auth_failed',
  'share.remote.download_failed',
  'share.remote.expired',
  'share.remote.network_error',
  'share.remote.quota_reached',
  'share.remote.rate_limited',
  'share.remote.timeout',
  'share.remote.too_large',
  'share.remote.unavailable',
  'share.remote.upload_failed',
  'share.remote.upload_ready',
  'share.remote.uploading',
  'system_audio.capture_denied',
  'system_audio.connection_unstable',
  'system_audio.coordinator_update_required',
  'system_audio.desktop_only',
  'system_audio.device_limit',
  'system_audio.device_limit_stopped',
  'system_audio.duration_limit_stopped',
  'system_audio.effects_guest_only',
  'system_audio.host_channel_locked',
  'system_audio.no_audio_track',
  'system_audio.owner_active',
  'system_audio.owner_preparing',
  'system_audio.pro_preparing',
  'system_audio.pro_publish_failed',
  'system_audio.receive_failed',
  'system_audio.remote_receive_limit',
  'system_audio.started',
  'system_audio.stopped',
  'transfer.demo_load_fail',
  'transfer.demo_loaded',
  'transfer.file_sending',
  'transfer.file_wait',
  'transfer.host_busy',
  'transfer.preload_done',
  'transfer.preload_fail',
  'transfer.preload_waiting',
  'transfer.preparation_delayed',
  'transfer.recovery_failed',
  'youtube.added_to_playlist',
  'youtube.effects_disabled',
  'youtube.enter_source_toast',
  'youtube.fetch_failed',
  'youtube.invalid_link',
  'youtube.live_sync_warning',
  'youtube.load_fail',
  'youtube.load_timeout',
  'youtube.loading_large_playlist',
  'youtube.ready',
  'youtube.video_unavailable',
] as const;

// A period closing a line, even inside a closing quote. Two or more periods
// form an ellipsis, which is allowed.
const LINE_FINAL_PERIOD_RE = /(?<!\.)[.。．।۔]["'”’»」』]*$/u;
// A Latin period, then a space, then the next sentence. A lowercase word or a
// number after the space marks an abbreviation such as "maks. 200 MB".
const LATIN_SENTENCE_BREAK_RE = /(?<!\.)\.(?!\.)\s+(?=[\p{Lu}\p{Lo}{])/u;
// Full-width marks, the danda and the Urdu full stop never abbreviate.
const OTHER_SENTENCE_BREAK_RE = /[。．।۔？！]\s*(?=[^\s"'”’»」』）)])/u;
const QUESTION_OR_EXCLAMATION_BREAK_RE = /[?!؟]\s+(?=[\p{Lu}\p{Lo}{])/u;

function policyViolations(text: string): string[] {
  const violations: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.trim() !== line)
      violations.push(`untrimmed line: ${JSON.stringify(line)}`);
    if (LINE_FINAL_PERIOD_RE.test(line)) violations.push(`period at line end: ${line}`);
    if (LATIN_SENTENCE_BREAK_RE.test(line)) violations.push(`two sentences on one line: ${line}`);
    if (OTHER_SENTENCE_BREAK_RE.test(line)) violations.push(`two sentences on one line: ${line}`);
    if (QUESTION_OR_EXCLAMATION_BREAK_RE.test(line)) {
      violations.push(`two sentences on one line: ${line}`);
    }
  }
  return violations;
}

function toastKeys(): string[] {
  const toastNamespace = Object.keys(APP_DICTIONARIES.en).filter((key) => key.startsWith('toast.'));
  return [...toastNamespace, ...SHARED_TOAST_KEYS];
}

/** Every toast text in every locale, plural forms included. */
function toastTexts(): Array<{ readonly where: string; readonly text: string }> {
  const texts: Array<{ readonly where: string; readonly text: string }> = [];
  for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
    const byKey: Readonly<Record<string, string | undefined>> = dictionary;
    for (const key of toastKeys()) {
      const text = byKey[key];
      if (text !== undefined) texts.push({ where: `${language}.${key}`, text });
    }
  }
  for (const [language, messages] of Object.entries(pluralMessagesForTests)) {
    const byKey = messages as Readonly<Record<string, Readonly<Record<string, string>>>>;
    for (const key of toastKeys()) {
      for (const [category, text] of Object.entries(byKey[key] ?? {})) {
        texts.push({ where: `${language}.${key}.${category}`, text });
      }
    }
  }
  return texts;
}

/** A length limit from src/ui/toast.ts, so this guard follows the renderer. */
function toastLimit(name: string): number {
  const source = readFileSync(resolve('src/ui/toast.ts'), 'utf8');
  const value = source.match(new RegExp(`const ${name} = (\\d+);`, 'u'))?.[1];
  if (value === undefined) throw new Error(`${name} is missing from src/ui/toast.ts`);
  return Number(value);
}

const charCount = (value: string): number => Array.from(value).length;

function collectSourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'i18n') continue;
      files.push(...collectSourceFiles(path));
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      files.push(path);
    }
  }
  return files;
}

/** The argument text of each toast call, up to its closing parenthesis. */
function toastCallArguments(source: string, callRe: RegExp): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(callRe)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') depth -= 1;
      else if (char === "'" || char === '"' || char === '`') {
        index += 1;
        while (index < source.length && source[index] !== char) {
          if (source[index] === '\\') index += 1;
          index += 1;
        }
      }
      index += 1;
    }
    calls.push(source.slice(start, index - 1));
  }
  return calls;
}

function stringLiterals(code: string): string[] {
  return [...code.matchAll(/'((?:[^'\\]|\\.)*)'/gu)].map((match) =>
    (match[1] ?? '').replaceAll('\\n', '\n'),
  );
}

describe('toast copy policy', () => {
  it('keeps every toast in every locale free of sentence-final periods', () => {
    expect(Object.keys(APP_DICTIONARIES)).toHaveLength(42);
    const violations: string[] = [];
    for (const [language, dictionary] of Object.entries(APP_DICTIONARIES)) {
      const byKey: Readonly<Record<string, string | undefined>> = dictionary;
      for (const key of toastKeys()) {
        const text = byKey[key];
        expect(text, `${language}.${key}`).toBeTypeOf('string');
        for (const violation of policyViolations(text ?? '')) {
          violations.push(`${language}.${key}: ${violation}`);
        }
      }
    }
    // Count-sensitive toasts also have plural forms outside the dictionary.
    let pluralForms = 0;
    for (const [language, messages] of Object.entries(pluralMessagesForTests)) {
      const byKey = messages as Readonly<Record<string, Readonly<Record<string, string>>>>;
      for (const key of toastKeys()) {
        for (const [category, text] of Object.entries(byKey[key] ?? {})) {
          pluralForms += 1;
          for (const violation of policyViolations(text)) {
            violations.push(`${language}.${key}.${category}: ${violation}`);
          }
        }
      }
    }
    expect(pluralForms).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('keeps authored copy within the limits the toast applies to dynamic values', () => {
    // The toast shows authored copy in full (owner decision 2026-10-15) and
    // shortens only values that can run long: a line past the line limit, the
    // text after a colon, and quoted text. Authored copy must stay inside all
    // three so the toast never cuts it. Placeholders are dynamic and not counted.
    const lineLimit = toastLimit('TOAST_MAX_LINE_CHARS');
    const colonLimit = toastLimit('TOAST_COLON_VALUE_CHARS');
    const quotedLimit = toastLimit('TOAST_DYNAMIC_VALUE_CHARS');
    expect([lineLimit, colonLimit, quotedLimit]).toEqual([120, 64, 28]);

    const violations: string[] = [];
    let lines = 0;
    for (const { where, text } of toastTexts()) {
      for (const line of text.split('\n')) {
        lines += 1;
        if (charCount(line.replace(/\{\{\w+\}\}/gu, '')) > lineLimit) {
          violations.push(`${where}: line over ${lineLimit}: ${line}`);
        }
        const colon = line.indexOf(': ');
        const afterColon = colon < 0 ? '' : line.slice(colon + 2);
        if (!afterColon.includes('{{') && charCount(afterColon) > colonLimit) {
          violations.push(`${where}: text after ": " over ${colonLimit}: ${line}`);
        }
        for (const match of line.matchAll(/"([^"]+)"/gu)) {
          const quoted = match[1] ?? '';
          if (!quoted.includes('{{') && charCount(quoted) > quotedLimit) {
            violations.push(`${where}: quoted text over ${quotedLimit}: ${line}`);
          }
        }
      }
    }
    expect(lines).toBeGreaterThan(8000);
    expect(violations).toEqual([]);
  });

  it('pins representative copies', () => {
    expect(APP_DICTIONARIES.en['account.action_failed']).toBe(
      'Could not update your account\nPlease try again',
    );
    expect(APP_DICTIONARIES.ko['account.action_failed']).toBe(
      '계정 정보를 변경하지 못했어요\n잠시 후 다시 시도해 주세요',
    );
    expect(APP_DICTIONARIES.ja['account.login_failed']).toBe(
      'ログインできませんでした\nもう一度お試しください',
    );
    expect(APP_DICTIONARIES.th['transfer.host_busy']).toBe(
      'เจ้าของห้องกำลังประมวลผลไฟล์อื่น\nลองอีกครั้งในอีกสักครู่',
    );
    // Abbreviations keep their periods.
    expect(APP_DICTIONARIES.da['share.remote.too_large']).toBe('Filen er for stor (maks. 200 MB)');
    expect(APP_DICTIONARIES.en['system_audio.desktop_only']).toMatch(/\(Chrome, Edge, etc\.\)$/u);
    // Exclamation marks stay; only the line break follows them.
    expect(APP_DICTIONARIES.en['youtube.ready']).toBe('YouTube is ready!\nPress Play');
  });

  it('lists every key a toast call names directly', () => {
    const listed = new Set(toastKeys());
    const missing: string[] = [];
    const callRe = /showToast\(|emit\(\s*'ui:show-toast',/gu;
    for (const file of collectSourceFiles(resolve('src'))) {
      const source = readFileSync(file, 'utf8');
      for (const argument of toastCallArguments(source, callRe)) {
        for (const literal of stringLiterals(argument)) {
          if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/u.test(literal)) continue;
          if (!(literal in APP_DICTIONARIES.en)) continue;
          // The dialog fallback toast reuses dialog copy, which this policy
          // does not cover.
          if (literal === 'common.info') continue;
          if (!listed.has(literal)) {
            missing.push(`${relative(resolve('.'), file).replaceAll('\\', '/')}: ${literal}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('applies the policy to the events page and the update-completion toast', () => {
    const events = readFileSync(resolve('browser/classic-runtime/events/event.ts'), 'utf8');
    const eventToasts = toastCallArguments(events, /showToast\(/gu)
      .map((argument) => stringLiterals(argument).join('X'))
      .filter((text) => text !== '');
    expect(eventToasts.length).toBeGreaterThan(0);
    for (const text of eventToasts) expect(policyViolations(text), text).toEqual([]);

    // The events toast shows a line break instead of collapsing it to a space.
    const eventCss = readFileSync(resolve('public/events/event.css'), 'utf8');
    expect(eventCss).toMatch(/\.toast \{[^}]*white-space: pre-line;/u);

    const completion = readFileSync(resolve('src/core/sw-update-completion.ts'), 'utf8');
    const block = completion.match(/const COMPLETION_MESSAGES = \{([\s\S]*?)\} as const/u)?.[1];
    expect(block).toBeTypeOf('string');
    const messages = stringLiterals(block ?? '').filter((text) => !/^[a-z-]+$/u.test(text));
    expect(messages).toHaveLength(42);
    for (const text of messages) expect(policyViolations(text), text).toEqual([]);
  });
});
