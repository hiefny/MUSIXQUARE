import { describe, it, expect } from 'vitest';
import ko from '../ko.ts';
import en from '../en.ts';
import de from '../de.ts';
import es from '../es.ts';
import fr from '../fr.ts';
import id from '../id.ts';
import italian from '../it.ts';
import ja from '../ja.ts';
import nl from '../nl.ts';
import pl from '../pl.ts';
import ptBr from '../pt-br.ts';
import ru from '../ru.ts';
import th from '../th.ts';
import tr from '../tr.ts';
import vi from '../vi.ts';
import zhHans from '../zh-hans.ts';
import zhHant from '../zh-hant.ts';

const koKeys = Object.keys(ko);
const locales = {
  ko,
  en,
  de,
  es,
  fr,
  id,
  italian,
  ja,
  nl,
  pl,
  ptBr,
  ru,
  th,
  tr,
  vi,
  zhHans,
  zhHant,
};

describe('Translation key integrity', () => {
  it('all locales have the same number of keys as ko', () => {
    for (const [locale, dict] of Object.entries(locales)) {
      expect(Object.keys(dict), locale).toHaveLength(koKeys.length);
    }
  });

  it('every ko key exists in each locale', () => {
    for (const [locale, dict] of Object.entries(locales)) {
      const missing = koKeys.filter((k) => !(k in dict));
      expect(missing, locale).toEqual([]);
    }
  });

  it('every locale key exists in ko', () => {
    for (const [locale, dict] of Object.entries(locales)) {
      const extra = Object.keys(dict).filter((k) => !(k in ko));
      expect(extra, locale).toEqual([]);
    }
  });

  it('no empty values in any locale', () => {
    for (const [locale, dict] of Object.entries(locales)) {
      const empty = Object.entries(dict).filter(([, value]) => !value);
      expect(empty, locale).toEqual([]);
    }
  });

  it('greets Korean users while describing the first room choice', () => {
    expect(ko['setup.hello_select_role']).toBe('안녕하세요! 방을 만들거나 참여해 주세요.');
    expect(ko['setup.host_button']).toBe('방 만들기');
    expect(ko['setup.guest_button']).toBe('방 참여하기');
    expect(en['setup.hello_select_role']).toBe('Create a room or join one.');
    expect(en['setup.host_button']).toBe('Create a Room');
    expect(en['setup.guest_button']).toBe('Join a Room');

    const recoveryKeys = [
      'common.retry',
      'pro.claim_retry_title',
      'pro.claim_retry_message',
      'pro.claim_login_title',
      'pro.claim_login_button',
      'pro.claim_login_message',
      'pro.claim_popup_blocked_message',
      'pro.claim_account_conflict_title',
      'pro.claim_account_conflict_message',
      'pro.claim_account_capacity_title',
      'pro.claim_account_capacity_message',
      'pro.claim_failed_title',
      'pro.claim_failed_message',
      'pro.transfer_title',
      'pro.transfer_message',
      'pro.claim_unavailable_title',
      'pro.new_link_message',
    ] as const;
    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of recoveryKeys) {
        expect(dict[key], `${locale}.${key}`).toBeTruthy();
      }
    }
  });

  it('uses the approved Korean signaling health and recovery copy', () => {
    expect(ko['connect.signaling_healthy']).toBe('연결 서버 정상');
    expect(ko['connect.signaling_recovering']).toBe('연결 복구 중');
    expect(ko['connect.signaling_failed']).toBe('연결 복구 실패');
    expect(ko['connect.signaling_recover_action']).toBe('연결 복구하기');
    expect(ko['connect.signaling_exhausted']).toBe(
      '연결 서버가 응답하지 않아요.\n새 참여자를 초대할 수 없어요.',
    );
    expect(ko['connect.signaling_retry']).toBe('재시도');
  });

  it('uses one consistent Korean honorific form for presence messages', () => {
    expect(ko['toast.device_connected']).toBe('{{name}}님이 연결됐어요');
    expect(ko['chat.peer_connected']).toBe('{{name}}님이 입장했어요');
    expect(ko['chat.peer_disconnected']).toBe('{{name}}님이 퇴장했어요');
  });

  it('{{param}} placeholders match between ko and every locale', () => {
    const paramRe = /\{\{(\w+)\}\}/g;
    const mismatched: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of koKeys) {
        const koVal = ko[key as keyof typeof ko] || '';
        const localeVal = dict[key as keyof typeof dict] || '';

        const koParams = [...koVal.matchAll(paramRe)].map((m) => m[1]).sort();
        const localeParams = [...localeVal.matchAll(paramRe)].map((m) => m[1]).sort();

        if (JSON.stringify(koParams) !== JSON.stringify(localeParams)) {
          mismatched.push(
            `${locale}.${key}: ko=${koParams.join(',')} ${locale}=${localeParams.join(',')}`,
          );
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('names the selected physical device in every kick confirmation message', () => {
    expect(ko['connect.kick_message']).toBe('{{name}}를 내보낼까요?');
    for (const [locale, dict] of Object.entries(locales)) {
      expect(dict['connect.kick_message'], `${locale}.connect.kick_message`).toContain('{{name}}');
    }
  });

  it('HTML tag sequences match Korean in every locale', () => {
    const tagRe = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
    const tagSequence = (value: string): string[] =>
      [...value.matchAll(tagRe)].map((match) => {
        const raw = match[0];
        const name = match[1].toLowerCase();
        return raw.startsWith('</') ? `</${name}>` : `<${name}>`;
      });
    const mismatched: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of koKeys) {
        const koVal = ko[key as keyof typeof ko] || '';
        const localeVal = dict[key as keyof typeof dict] || '';
        const koTags = tagSequence(koVal);
        const localeTags = tagSequence(localeVal);

        if (JSON.stringify(koTags) !== JSON.stringify(localeTags)) {
          mismatched.push(
            `${locale}.${key}: ko=${koTags.join(' ')} ${locale}=${localeTags.join(' ')}`,
          );
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('intentional line breaks match English in every translated locale', () => {
    const newlineSequence = (value: string): string[] => value.match(/\n/g) || [];
    const mismatched: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      // Korean and English are jointly authored sources and occasionally use
      // different line wrapping. All other locale files are translated from
      // the English reference and must preserve its intentional toast/dialog
      // breaks.
      if (locale === 'ko' || locale === 'en') continue;
      for (const key of koKeys) {
        const enNewlines = newlineSequence(en[key as keyof typeof en] || '');
        const localeNewlines = newlineSequence(dict[key as keyof typeof dict] || '');

        if (enNewlines.length !== localeNewlines.length) {
          mismatched.push(
            `${locale}.${key}: en=${enNewlines.length} ${locale}=${localeNewlines.length}`,
          );
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('functional HTML attributes match Korean in every locale', () => {
    const attrRe = /\b(?:href|target|rel|class|style|data-[\w-]+)=(?:"[^"]*"|'[^']*')/g;
    const attributes = (value: string): string[] => (value.match(attrRe) || []).sort();
    const mismatched: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of koKeys) {
        const koAttrs = attributes(ko[key as keyof typeof ko] || '');
        const localeAttrs = attributes(dict[key as keyof typeof dict] || '');

        if (JSON.stringify(koAttrs) !== JSON.stringify(localeAttrs)) {
          mismatched.push(`${locale}.${key}`);
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('keeps slash-command names executable in every locale', () => {
    const commandKeys = koKeys.filter((key) => key.startsWith('chat.cmd_u_'));
    const mismatched: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of commandKeys) {
        const englishCommand = en[key as keyof typeof en].match(/^\/\w+/)?.[0];
        const localized = dict[key as keyof typeof dict] || '';
        if (englishCommand && !localized.startsWith(englishCommand)) {
          mismatched.push(`${locale}.${key}: expected ${englishCommand}`);
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('preserves all-caps status labels in scripts that support letter case', () => {
    const caseBearingLocales = { en, de, es, fr, id, italian, nl, pl, ptBr, ru, tr, vi };
    const keys = ['youtube.tap_to_play', 'chat.system_sender'] as const;
    const mismatched: string[] = [];

    for (const [locale, dict] of Object.entries(caseBearingLocales)) {
      for (const key of keys) {
        if (/\p{Ll}/u.test(dict[key])) mismatched.push(`${locale}.${key}: ${dict[key]}`);
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('describes system-audio support as computer Chromium support, not desktop hardware', () => {
    const desktopHardwareTerms = /desktop|데스크톱|デスクトップ|桌面|เดสก์ท็อป|masaüstü|настольн/i;
    const keys = ['system_audio.desktop_only', 'player.play_media_action_html'] as const;

    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of keys) {
        expect(dict[key], `${locale}.${key}`).toMatch(/Chrom(?:e|ium)/i);
        expect(dict[key], `${locale}.${key}`).not.toMatch(desktopHardwareTerms);
      }
    }
    expect(en['system_audio.desktop_only']).toBe(
      'Only available on computers using a Chromium-based browser (Chrome, Edge, etc.).',
    );
    expect(ko['system_audio.desktop_only']).toBe(
      '컴퓨터의 Chrome 계열 브라우저(Chrome, Edge 등)에서만 사용할 수 있어요.',
    );
  });

  it('describes the subwoofer low-pass control as cutoff, not a full crossover', () => {
    const crossoverTerms = /crossover|croisement|cruce|кроссов|分频|分頻|ครอสโอเวอร์/i;
    const keys = ['settings.subwoofer_adjust', 'settings.subwoofer_cutoff'] as const;

    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of keys) {
        expect(dict[key], `${locale}.${key}`).not.toMatch(crossoverTerms);
      }
    }
    expect(en['settings.subwoofer_cutoff']).toBe('Subwoofer Cutoff Frequency');
    expect(ko['settings.subwoofer_cutoff']).toBe('서브우퍼 컷오프 주파수');
  });

  it('no machine-translation protection tokens remain in locale values', () => {
    const tokenRe = /\b(?:QZX|ZXQ|ZZQ|QQZ)\w*\b/;
    const leftovers: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      for (const [key, value] of Object.entries(dict)) {
        if (tokenRe.test(value)) {
          leftovers.push(`${locale}.${key}: ${value}`);
        }
      }
    }

    expect(leftovers).toEqual([]);
  });

  it('keeps protected contact literals intact in legal copy', () => {
    const badLegalCopy: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      const legal = dict['legal.content_html' as keyof typeof dict] || '';
      const emailTexts = [...legal.matchAll(/>([^<>@]*@[\w.-]+)<\/a>/g)].map((match) => match[1]);

      if (
        !legal.includes('mailto:contact@musixquare.com') ||
        !legal.includes('data-copy-email="contact@musixquare.com"') ||
        emailTexts.some((email) => email !== 'contact@musixquare.com')
      ) {
        badLegalCopy.push(`${locale}: ${emailTexts.join(',') || '(no visible email)'}`);
      }
    }

    expect(badLegalCopy).toEqual([]);
  });

  it('keeps localized room-mode privacy summaries separate and linked to the full policy', () => {
    const badLegalCopy: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      const legal = dict['legal.content_html' as keyof typeof dict] || '';
      const standardMarker = '<span data-legal-standard-storage>';
      const proMarker = '<span data-legal-pro-storage>';
      const standardMarkerCount = legal.match(/data-legal-standard-storage/g)?.length ?? 0;
      const proMarkerCount = legal.match(/data-legal-pro-storage/g)?.length ?? 0;
      const standardStart = legal.indexOf(standardMarker);
      const standardEnd = legal.indexOf('</span>', standardStart);
      const proStart = legal.indexOf(proMarker);
      const proEnd = legal.indexOf('</span>', proStart);
      const privacyLinkIndex = legal.indexOf('<a href="/privacy"');
      const standardCopy = legal.slice(standardStart + standardMarker.length, standardEnd);
      const proCopy = legal.slice(proStart + proMarker.length, proEnd);

      if (
        standardMarkerCount !== 1 ||
        proMarkerCount !== 1 ||
        standardStart < 0 ||
        standardEnd <= standardStart ||
        proStart <= standardEnd ||
        proEnd <= proStart ||
        privacyLinkIndex <= proEnd ||
        standardCopy.trim().length < 30 ||
        proCopy.trim().length < 30 ||
        standardCopy === proCopy ||
        standardCopy.includes('<') ||
        proCopy.includes('<') ||
        !standardCopy.includes('Cloudflare') ||
        !standardCopy.includes('24') ||
        !proCopy.includes('Cloudflare') ||
        proCopy.includes('24') ||
        !proCopy.includes('PRO') ||
        standardCopy.includes('PRO')
      ) {
        badLegalCopy.push(locale);
      }
    }

    expect(badLegalCopy).toEqual([]);
    expect(ko['legal.content_html']).toContain(
      '<span data-legal-standard-storage>같은 네트워크에서는 세션 콘텐츠 대부분이 기기끼리 직접 전송돼요. 시그널링 서버는 방 운영·인증·재연결 정보만 잠시 처리하고, 원격·대규모 세션 일부 데이터는 Cloudflare를 거쳐요. 원격 파일은 Cloudflare 비공개 저장소에 최대 24시간 임시 보관되어 방 참여자에게만 한시적 다운로드가 허용돼요. 뮤직스퀘어는 서비스 제공·운영·보안 외 목적으로 데이터를 열람·분석·보관하지 않아요.</span>',
    );
    expect(ko['legal.content_html']).toContain(
      '<span data-legal-pro-storage>PRO 방 운영에 필요한 세션·멤버·재생목록·재생·업로드 상태는 Cloudflare에 저장돼요. 재생목록 원본 파일은 Cloudflare 비공개 저장소에 보관되며, 방 참여자만 짧게 유효한 주소로 내려받을 수 있어요. 파일은 방 관리자가 재생목록에서 삭제하거나 운영자가 방 데이터를 삭제하면 말소돼요. 뮤직스퀘어는 서비스 제공·운영·보안 외 목적으로 데이터를 열람·분석·보관하지 않아요.</span>',
    );
    expect(en['legal.content_html']).toContain(
      '<span data-legal-standard-storage>On the same network, most session content goes directly between devices. The signaling server only briefly processes room operation, authentication and reconnection data; some remote or large-session data goes via Cloudflare. Remote files are held for up to 24 hours in private Cloudflare storage; only room participants get temporary download access. MUSIXQUARE accesses, analyzes, or retains data only to provide, run, and secure the service.</span>',
    );
    expect(en['legal.content_html']).toContain(
      '<span data-legal-pro-storage>PRO rooms store on Cloudflare the session, member, playlist, playback, and upload state needed for operation. Original playlist files stay in private Cloudflare storage; only room participants can download them via short-lived URLs. Files are erased when a room administrator removes them from the playlist or the operator deletes the room data. MUSIXQUARE accesses, analyzes, or retains data only to provide, run, and secure the service.</span>',
    );
    expect(ko['share.remote.uploading']).toBe('파일을 업로드하고 있어요...');
    expect(en['share.remote.uploading']).toBe('Uploading file...');
  });

  it('keeps optional-account and deletion copy present in every locale', () => {
    const deletionContract: Record<keyof typeof locales, { authority: RegExp; retention: RegExp }> =
      {
        ko: { authority: /권한/, retention: /보관/ },
        en: { authority: /permissions/, retention: /retention/ },
        de: { authority: /Raumrechte/, retention: /Aufbewahrung/ },
        es: { authority: /permisos/, retention: /conservación/ },
        fr: { authority: /droits/, retention: /conservation/ },
        id: { authority: /izin/, retention: /penyimpanan/ },
        italian: { authority: /permessi/, retention: /conservazione/ },
        ja: { authority: /権限/, retention: /保存方針/ },
        nl: { authority: /kamerrechten/, retention: /bewaarbeleid/ },
        pl: { authority: /uprawnienia/, retention: /przechowywania/ },
        ptBr: { authority: /permissões/, retention: /retenção/ },
        ru: { authority: /права/, retention: /хранения/ },
        th: { authority: /สิทธิ์/, retention: /เก็บรักษา/ },
        tr: { authority: /izinlerin/, retention: /saklama/ },
        vi: { authority: /quyền/, retention: /lưu giữ/ },
        zhHans: { authority: /权限/, retention: /保留政策/ },
        zhHant: { authority: /權限/, retention: /保留政策/ },
      };
    const incomplete: string[] = [];

    for (const [locale, dict] of Object.entries(locales)) {
      const login = dict['account.login_message' as keyof typeof dict] || '';
      const deletion = dict['account.delete_confirm_message' as keyof typeof dict] || '';
      const terms = dict['account.terms' as keyof typeof dict] || '';
      const privacy = dict['account.privacy' as keyof typeof dict] || '';
      if (
        login.trim().length < 20 ||
        !login.includes('Google') ||
        deletion.trim().length < 20 ||
        Array.from(deletion).length > 200 ||
        !deletionContract[locale as keyof typeof locales].authority.test(deletion) ||
        !deletionContract[locale as keyof typeof locales].retention.test(deletion) ||
        terms.trim().length === 0 ||
        privacy.trim().length === 0
      ) {
        incomplete.push(locale);
      }
    }

    expect(incomplete).toEqual([]);
    expect(en['account.login_message']).toBe(
      'Sign in with Google to keep your nickname across rooms. You can continue without signing in.',
    );
    expect(ko['account.login_message']).toBe(
      'Google로 로그인하면 다른 방에서도 닉네임을 유지할 수 있어요. 로그인 없이도 계속 이용할 수 있어요.',
    );
    expect(en['account.delete_confirm_message']).toBe(
      "Your nickname, sign-in sessions, and account-linked room permissions will be deleted. Content shared in a room follows that room's retention policy.",
    );
    expect(ko['account.delete_confirm_message']).toBe(
      '닉네임, 로그인 세션, 계정에 연결된 방 권한이 삭제돼요. 방에 공유한 콘텐츠는 해당 방의 보관 정책을 따라요.',
    );
  });

  it('keeps the account locale key and placeholder contract explicit', () => {
    const accountKeys = koKeys.filter((key) => key.startsWith('account.'));
    expect(accountKeys).toEqual([
      'account.login_title',
      'account.login_cancelled',
      'account.login_failed',
      'account.login_message',
      'account.google_continue',
      'account.terms',
      'account.privacy',
      'account.unavailable',
      'account.account_title',
      'account.stats_sessions_label',
      'account.stats_listening_label',
      'account.stats_tracks_label',
      'account.stats_count_value',
      'account.stats_seconds_value',
      'account.stats_minutes_value',
      'account.stats_hours_minutes_value',
      'account.change_nickname',
      'account.logout',
      'account.delete_account',
      'account.nickname_title',
      'account.nickname_message',
      'account.nickname_placeholder',
      'account.nickname_hint',
      'account.nickname_required',
      'account.nickname_whitespace',
      'account.nickname_taken',
      'account.nickname_saved',
      'account.action_failed',
      'account.delete_confirm_title',
      'account.delete_confirm_message',
      'account.delete_pending',
    ]);

    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    for (const [locale, dict] of Object.entries(locales)) {
      expect(
        accountKeys.filter((key) => !(key in dict)),
        `${locale} account keys`,
      ).toEqual([]);
      for (const key of accountKeys) {
        expect(placeholders(dict[key as keyof typeof dict] || ''), `${locale}.${key}`).toEqual(
          placeholders(ko[key as keyof typeof ko] || ''),
        );
      }
    }

    expect(ko['account.stats_sessions_label']).toBe('참여한 세션');
    expect(ko['account.stats_listening_label']).toBe('감상 시간');
    expect(ko['account.stats_tracks_label']).toBe('재생한 미디어');
    expect(ko['account.stats_hours_minutes_value']).toBe('{{hours}}시간 {{minutes}}분');
  });
});
