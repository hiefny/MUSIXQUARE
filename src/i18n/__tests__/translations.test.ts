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

  it('keeps the returning-account welcome concise, personal, and two-line', () => {
    expect(ko['account.welcome_back']).toBe('다시 만나 반가워요\n{{name}} 님');
    expect(en['account.welcome_back']).toBe('Welcome back\n{{name}}');

    for (const [locale, dict] of Object.entries(locales)) {
      const welcome = dict['account.welcome_back'];
      expect(welcome.split('\n'), locale).toHaveLength(2);
      expect(welcome.match(/{{name}}/g), locale).toHaveLength(1);
    }
  });

  it('keeps the greeting separate from the first room choice', () => {
    const greetings: Record<keyof typeof locales, string> = {
      ko: '안녕하세요!',
      en: 'Hello!',
      de: 'Hallo!',
      es: '¡Hola!',
      fr: 'Bonjour !',
      id: 'Halo!',
      italian: 'Ciao!',
      ja: 'こんにちは！',
      nl: 'Hallo!',
      pl: 'Cześć!',
      ptBr: 'Olá!',
      ru: 'Здравствуйте!',
      th: 'สวัสดี!',
      tr: 'Merhaba!',
      vi: 'Xin chào!',
      zhHans: '你好！',
      zhHant: '你好！',
    };

    for (const [locale, dict] of Object.entries(locales)) {
      expect(dict['setup.greeting'], `${locale}.setup.greeting`).toBe(
        greetings[locale as keyof typeof locales],
      );
    }

    expect(ko['setup.hello_select_role']).toBe('방을 만들거나 참여해 주세요.');
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
      'pro.claim_existing_account_title',
      'pro.claim_existing_account_message',
      'pro.claim_choose_account_button',
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

  it('distinguishes invitation-code copy from six-digit number instructions', () => {
    const invitationTerms: Record<keyof typeof locales, RegExp> = {
      ko: /초대/,
      en: /invitation/i,
      de: /Einladung/i,
      es: /invitación/i,
      fr: /invitation/i,
      id: /undangan/i,
      italian: /invito/i,
      ja: /招待/,
      nl: /uitnodiging/i,
      pl: /zaproszenia/i,
      ptBr: /convite/i,
      ru: /приглашения/i,
      th: /เชิญ/,
      tr: /davet/i,
      vi: /mời/i,
      zhHans: /邀请/,
      zhHant: /邀請/,
    };
    const invitationKeys = [
      'setup.enter_code',
      'setup.enter_host_code',
      'setup.enter_code_connect',
      'setup.invite_share_desc_html',
    ] as const;
    const compactCodeKeys = ['setup.enter_host_code_alt'] as const;
    const numericKeys = ['setup.six_digit_enter'] as const;

    for (const [locale, dict] of Object.entries(locales)) {
      const invitationTerm = invitationTerms[locale as keyof typeof locales];
      for (const key of invitationKeys) {
        expect(dict[key], `${locale}.${key}`).toMatch(invitationTerm);
      }
      for (const key of compactCodeKeys) {
        expect(dict[key], `${locale}.${key}`).not.toMatch(invitationTerm);
        expect(dict[key], `${locale}.${key}`).not.toContain('6');
      }
      for (const key of numericKeys) {
        expect(dict[key], `${locale}.${key}`).toContain('6');
        expect(dict[key], `${locale}.${key}`).not.toMatch(invitationTerm);
      }
    }

    expect(ko['setup.enter_code_connect']).toBe('초대 코드');
    expect(en['setup.enter_code_connect']).toBe('Invitation code');

    expect(ko['setup.enter_host_code']).toBe('초대 코드 입력');
    expect(en['setup.enter_host_code']).toBe('Enter invitation code');
  });

  it('uses the approved Korean signaling health and recovery copy', () => {
    expect(ko['connect.signaling_healthy']).toBe('연결 서버 정상');
    expect(ko['connect.signaling_recovering']).toBe('다시 연결 중…');
    expect(ko['connect.signaling_failed']).toBe('연결 복구 실패');
    expect(ko['connect.signaling_recover_action']).toBe('다시 연결');
    expect(ko['connect.signaling_exhausted']).toBe(
      '연결 서버가 응답하지 않아요.\n새 참여자를 초대할 수 없어요.',
    );
    expect(ko['connect.signaling_retry']).toBe('재시도');
  });

  it('keeps compact player actions paired with full accessible labels', () => {
    const compactActionPairs = [
      ['player.sync_compact', 'common.sync'],
      ['player.syncing_compact', 'toast.yt_sync_start'],
      ['player.play_media_compact', 'player.play_media'],
      ['system_audio.stop_compact', 'system_audio.stop'],
    ] as const;

    for (const [locale, dict] of Object.entries(locales)) {
      for (const [compactKey, fullKey] of compactActionPairs) {
        const compactLabel = dict[compactKey];
        expect(compactLabel, `${locale}.${compactKey} empty copy`).toBeTruthy();
        expect(compactLabel, `${locale}.${compactKey} surrounding whitespace`).toBe(
          compactLabel.trim(),
        );
        expect(compactLabel, `${locale}.${compactKey} multiline copy`).not.toMatch(/[\r\n]/);
        expect(compactLabel, `${locale}.${compactKey} markup`).not.toMatch(/[<>]/);
        expect(dict[fullKey], `${locale}.${fullKey}`).toBeTruthy();
      }
    }
  });

  it('keeps system-audio seek feedback explicit and distinct from sync feedback', () => {
    const expected: Record<keyof typeof locales, string> = {
      ko: '시스템 오디오 공유 중에는 재생 위치를 이동할 수 없어요',
      en: "You can't seek while system audio is being shared",
      de: 'Während der Systemaudio-Freigabe ist Spulen nicht möglich',
      es: 'No puedes cambiar la posición de reproducción mientras se comparte el audio del sistema',
      fr: 'Impossible de modifier la position de lecture pendant le partage de l’audio système',
      id: 'Posisi pemutaran tidak dapat diubah saat audio sistem dibagikan',
      italian:
        'Non puoi cambiare la posizione di riproduzione durante la condivisione dell’audio di sistema',
      ja: 'システムオーディオの共有中は再生位置を移動できません',
      nl: 'Je kunt niet spoelen terwijl systeemaudio wordt gedeeld',
      pl: 'Podczas udostępniania dźwięku systemowego nie można przewijać',
      ptBr: 'Não é possível mudar a posição de reprodução durante o compartilhamento do áudio do sistema',
      ru: 'Нельзя перематывать во время трансляции системного звука',
      th: 'เลื่อนตำแหน่งการเล่นไม่ได้ขณะแชร์เสียงระบบ',
      tr: 'Sistem sesi paylaşılırken oynatma konumu değiştirilemez',
      vi: 'Không thể tua khi đang chia sẻ âm thanh hệ thống',
      zhHans: '共享系统音频时无法调整播放位置',
      zhHant: '分享系統音訊時無法調整播放位置',
    };

    for (const [locale, dict] of Object.entries(locales)) {
      const key = 'player.seek_unavailable_system_audio';
      const value = dict[key];
      expect(value, `${locale}.${key}`).toBe(expected[locale as keyof typeof locales]);
      expect(value, `${locale}.${key} should not reuse sync feedback`).not.toBe(
        dict['toast.sync_not_in_system_audio'],
      );
      expect(value, `${locale}.${key} should stay single-line plain text`).not.toMatch(/[\r\n<>]/);
      expect(value.length, `${locale}.${key} should stay concise`).toBeLessThanOrEqual(100);
    }
  });

  it('keeps repeated modal actions concise except for approved Korean legacy labels', () => {
    const roleActionKeys = ['common.grant', 'common.revoke'] as const;

    for (const [locale, dict] of Object.entries(locales)) {
      const administratorRole = dict['connect.administrator_role'].toLocaleLowerCase();
      if (locale !== 'ko') {
        for (const key of roleActionKeys) {
          const label = dict[key].toLocaleLowerCase();
          expect(label, `${locale}.${key}`).not.toContain(administratorRole);
        }
      }

      expect(dict['connect.signaling_recover_action'], `${locale}.recovery action`).toBeTruthy();
      expect(dict['pro.use_this_tab'], `${locale}.PRO tab action`).toBeTruthy();
    }

    expect(en['common.grant']).toBe('Grant');
    expect(en['common.revoke']).toBe('Revoke');
    expect(en['connect.signaling_recover_action']).toBe('Reconnect');
    expect(en['pro.use_this_tab']).toBe('Use this tab');
    expect(ko['common.grant']).toBe('관리자 부여');
    expect(ko['common.revoke']).toBe('관리자 해제');
    expect(ko['pro.use_this_tab']).toBe('강제로 계속');
    expect(ko['common.next']).toBe('다음으로');
    expect(ko['common.start']).toBe('시작하기');
    expect(ko['dialog.continue']).toBe('계속하기');
    expect(ko['dialog.continue_using']).toBe('계속 사용');
    expect(ko['dialog.leave_session']).toBe('세션 나가기');
  });

  it('keeps every code-used modal action contextual and safety-distinct', () => {
    // Inventory from the actual dialog/account/connect/PRO button call sites.
    // These labels may wrap responsively, but the translation itself must stay
    // a clean action rather than carrying title/body copy or interpolation.
    const actionKeys = [
      'common.ok',
      'common.cancel',
      'common.close',
      'common.retry',
      'common.later',
      'common.refresh',
      'common.reset',
      'common.leave',
      'common.stay',
      'common.next',
      'common.start',
      'common.done',
      'common.grant',
      'common.revoke',
      'connect.signaling_recover_action',
      'connect.signaling_retry',
      'connect.kick_yes',
      'dialog.got_it',
      'dialog.continue',
      'dialog.reconnect',
      'dialog.go_back',
      'dialog.session_lost_btn',
      'account.google_continue',
      'account.change_nickname',
      'account.logout',
      'account.delete_account',
      'pro.claim_login_button',
      'pro.claim_choose_account_button',
      'pro.use_this_tab',
    ] as const;
    const safetyDistinctPairs = [
      ['common.grant', 'common.revoke'],
      ['connect.signaling_recover_action', 'connect.signaling_retry'],
      ['connect.kick_yes', 'common.cancel'],
      ['account.logout', 'account.delete_account'],
      ['account.delete_account', 'common.ok'],
      ['account.delete_account', 'common.cancel'],
      ['account.delete_account', 'common.close'],
      ['pro.claim_login_button', 'common.cancel'],
      ['pro.claim_choose_account_button', 'common.cancel'],
      ['pro.use_this_tab', 'common.cancel'],
    ] as const;

    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of actionKeys) {
        const label = dict[key];
        expect(label, `${locale}.${key} surrounding whitespace`).toBe(label.trim());
        expect(label, `${locale}.${key} multiline copy`).not.toMatch(/[\r\n]/);
        expect(label, `${locale}.${key} interpolation`).not.toContain('{{');
      }

      expect(dict['account.google_continue'], `${locale}.account.google_continue`).toContain(
        'Google',
      );
      for (const [leftKey, rightKey] of safetyDistinctPairs) {
        expect(
          dict[leftKey].toLocaleLowerCase(),
          `${locale}.${leftKey} must differ from ${rightKey}`,
        ).not.toBe(dict[rightKey].toLocaleLowerCase());
      }
    }

    // Destructive and authentication actions deliberately retain their
    // explicit object/intent even though contextual role actions got shorter.
    expect(en['account.delete_account']).toBe('Delete account');
    expect(en['pro.claim_login_button']).toBe('Sign in');
    expect(en['connect.kick_yes']).toBe('Kick');
    expect(ko['account.delete_account']).toBe('계정 삭제');
    expect(ko['pro.claim_login_button']).toBe('로그인');
    expect(ko['connect.kick_yes']).toBe('내보내기');
  });

  it('describes every configurable general and audio setting in every locale', () => {
    const generalDescriptionKeys = [
      'settings.language_desc',
      'settings.theme_desc',
      'settings.ui_sounds_desc',
      'settings.sync_settings_desc',
      'settings.virtual_effects_desc',
      'settings.reverb_desc',
      'settings.eq_desc',
      'settings.surround_desc',
      'settings.bass_desc',
      'settings.exciter_desc',
    ] as const;
    const roleDescriptionKeys = [
      'settings.role_center_desc',
      'settings.role_left_desc',
      'settings.role_right_desc',
      'settings.role_subwoofer_desc',
    ] as const;

    for (const [locale, dict] of Object.entries(locales)) {
      expect(dict['settings.sync_settings'], `${locale}.settings.sync_settings`).toBeTruthy();
      for (const key of generalDescriptionKeys) {
        expect(dict[key], `${locale}.${key}`).toBeTruthy();
        expect(dict[key], `${locale}.${key} surrounding whitespace`).toBe(dict[key].trim());
        expect(dict[key], `${locale}.${key} should not contain HTML`).not.toMatch(/<[^>]*>/);
        expect(dict[key], `${locale}.${key} should stay on one line`).not.toMatch(/[\r\n]/);
      }
      for (const key of roleDescriptionKeys) {
        const value = dict[key];
        expect(value, `${locale}.${key}`).toBeTruthy();
        expect(value, `${locale}.${key} surrounding whitespace`).toBe(value.trim());
        expect(value, `${locale}.${key} should not contain HTML`).not.toMatch(/<[^>]*>/);
        expect(value, `${locale}.${key} should not contain carriage returns`).not.toContain('\r');
        const lines = value.split('\n');
        expect(lines, `${locale}.${key} should contain exactly one newline`).toHaveLength(2);
        for (const line of lines) {
          expect(line.trim(), `${locale}.${key} should have text on both lines`).not.toBe('');
        }
      }
    }

    expect(en['settings.sync_settings']).toBe('Settings sync');
    expect(en['settings.sync_settings_desc']).toContain('Devices with this setting on');
    expect(ko['settings.sync_settings']).toBe('설정 동기화');
    expect(ko['settings.sync_settings_desc']).toBe(
      '이 설정이 켜진 기기들끼리 볼륨과 음향 효과가 동기화돼요.',
    );
    expect(en['settings.virtual_effects_desc']).toBe(
      'Apply synthesized effects to the audio. This may cause heavy distortion.',
    );
    expect(ko['settings.virtual_effects_desc']).toBe(
      '음향에 합성 기술을 적용해요. 왜곡이 심해질 수 있어요.',
    );
    expect(ko['settings.role_center_desc']).toBe(
      '이 기기가 중앙 스피커 역할을 하고 있어요.\n기기를 중앙에 놓아주세요.',
    );
    expect(ko['settings.role_left_desc']).toBe(
      '이 기기가 왼쪽 스피커 역할을 하고 있어요.\n기기를 왼쪽에 놓아주세요.',
    );
    expect(ko['settings.role_right_desc']).toBe(
      '이 기기가 오른쪽 스피커 역할을 하고 있어요.\n기기를 오른쪽에 놓아주세요.',
    );
    expect(ko['settings.role_subwoofer_desc']).toBe(
      '이 기기가 서브우퍼 역할을 하고 있어요.\n저음이 잘 퍼지는 곳에 놓아주세요.',
    );
  });

  it('provides virtual-effect controls and feedback in every locale', () => {
    const settingKeys = [
      'settings.virtual_effects_title',
      'settings.virtual_effects_desc',
      'settings.virtual_effect_bass',
      'settings.virtual_effect_treble',
      'settings.virtual_effect_surround',
    ] as const;
    const toastKeys = [
      'toast.settings_sync_enabled',
      'toast.virtual_bass_on',
      'toast.virtual_bass_off',
      'toast.virtual_treble_on',
      'toast.virtual_treble_off',
      'toast.virtual_surround_on',
      'toast.virtual_surround_off',
      'toast.virtual_effects_off',
    ] as const;

    for (const [locale, dict] of Object.entries(locales)) {
      for (const key of [...settingKeys, ...toastKeys]) {
        const value = dict[key];
        expect(value, `${locale}.${key}`).toBeTruthy();
        expect(value, `${locale}.${key} surrounding whitespace`).toBe(value.trim());
        expect(value, `${locale}.${key} should stay on one line`).not.toMatch(/[\r\n]/);
        expect(value, `${locale}.${key} should not contain HTML`).not.toMatch(/<[^>]*>/);
        expect(value, `${locale}.${key} interpolation`).not.toContain('{{');
      }
    }

    expect(en['settings.virtual_effects_title']).toBe('Virtual effects');
    expect(en['settings.virtual_effect_bass']).toBe('Bass');
    expect(en['settings.virtual_effect_treble']).toBe('Treble');
    expect(en['settings.virtual_effect_surround']).toBe('Surround');
    expect(en['toast.settings_sync_enabled']).toBe('Settings sync is on');
    expect(en['toast.virtual_bass_on']).toBe('Virtual bass is on');
    expect(en['toast.virtual_bass_off']).toBe('Virtual bass is off');
    expect(en['toast.virtual_treble_on']).toBe('Virtual treble is on');
    expect(en['toast.virtual_treble_off']).toBe('Virtual treble is off');
    expect(en['toast.virtual_surround_on']).toBe('Virtual surround is on');
    expect(en['toast.virtual_surround_off']).toBe('Virtual surround is off');
    expect(en['toast.virtual_effects_off']).toBe('All virtual effects are off');

    expect(ko['settings.virtual_effects_title']).toBe('가상 효과');
    expect(ko['settings.virtual_effect_bass']).toBe('베이스');
    expect(ko['settings.virtual_effect_treble']).toBe('트레블');
    expect(ko['settings.virtual_effect_surround']).toBe('서라운드');
    expect(ko['toast.settings_sync_enabled']).toBe('설정 동기화가 켜져 있어요');
    expect(ko['toast.virtual_bass_on']).toBe('가상 베이스가 켜졌어요');
    expect(ko['toast.virtual_bass_off']).toBe('가상 베이스가 꺼졌어요');
    expect(ko['toast.virtual_treble_on']).toBe('가상 트레블이 켜졌어요');
    expect(ko['toast.virtual_treble_off']).toBe('가상 트레블이 꺼졌어요');
    expect(ko['toast.virtual_surround_on']).toBe('가상 서라운드가 켜졌어요');
    expect(ko['toast.virtual_surround_off']).toBe('가상 서라운드가 꺼졌어요');
    expect(ko['toast.virtual_effects_off']).toBe('모든 가상 효과가 꺼졌어요');
  });

  it('explains synchronized audio authority explicitly in every locale without toast truncation', () => {
    const key = 'toast.settings_sync_admin_required' as const;
    const expected: Record<keyof typeof locales, string> = {
      ko: '설정 동기화가 켜져 있어요.\n방 관리자만 음향 설정을 변경할 수 있어요.',
      en: 'Settings sync is on.\nOnly room admins can change audio settings.',
      de: 'Die Einstellungssynchronisierung ist aktiviert.\nNur Raumadmins können Audioeinstellungen ändern.',
      es: 'La sincronización de ajustes está activada.\nSolo admins de la sala pueden cambiarlos.',
      fr: 'La synchronisation des réglages est activée.\nSeuls les admins du salon peuvent les modifier.',
      id: 'Sinkronisasi pengaturan aktif.\nHanya admin ruang yang dapat mengubahnya.',
      italian:
        'La sincronizzazione delle impostazioni è attiva.\nSolo gli admin della stanza possono cambiarle.',
      ja: '設定の同期がオンです。\n音響設定を変更できるのはルーム管理者だけです。',
      nl: 'Instellingensynchronisatie staat aan.\nAlleen kamerbeheerders kunnen dit wijzigen.',
      pl: 'Synchronizacja ustawień jest włączona.\nTylko administratorzy pokoju mogą je zmieniać.',
      ptBr: 'A sincronização de configurações está ativada.\nSó administradores da sala podem alterar o áudio.',
      ru: 'Синхронизация настроек включена.\nТолько администраторы комнаты могут менять звук.',
      th: 'เปิดการซิงก์การตั้งค่าอยู่\nเฉพาะผู้ดูแลห้องเท่านั้นที่เปลี่ยนได้',
      tr: 'Ayar senkronizasyonu açık.\nYalnızca oda yöneticileri değiştirebilir.',
      vi: 'Đồng bộ cài đặt đang bật.\nChỉ quản trị viên phòng mới có thể thay đổi.',
      zhHans: '设置同步已开启。\n只有房间管理员可以更改音频设置。',
      zhHant: '設定同步已開啟。\n只有房間管理員可以變更音訊設定。',
    };

    for (const locale of Object.keys(locales) as Array<keyof typeof locales>) {
      const value = locales[locale][key];
      expect(value, `${locale}.${key}`).toBe(expected[locale]);
      expect(value, `${locale}.${key} surrounding whitespace`).toBe(value.trim());
      expect(value, `${locale}.${key} should not contain HTML`).not.toMatch(/<[^>]*>/);
      expect(value, `${locale}.${key} interpolation`).not.toContain('{{');

      const lines = value.split('\n');
      expect(lines, `${locale}.${key} line count`).toHaveLength(2);
      expect(
        lines.every((line) => Array.from(line).length <= 50),
        `${locale}.${key} must fit the toast formatter`,
      ).toBe(true);

      if (locale !== 'en') {
        expect(value, `${locale}.${key} must not fall back to English`).not.toBe(en[key]);
      }
    }
  });

  it('provides plain-text subwoofer placement guidance in every locale', () => {
    const key = 'role.subwoofer_placement' as const;
    for (const [locale, dict] of Object.entries(locales)) {
      const value = dict[key];
      expect(value, `${locale}.${key}`).toBeTruthy();
      expect(value, `${locale}.${key} surrounding whitespace`).toBe(value.trim());
      expect(value, `${locale}.${key} should stay on one line`).not.toMatch(/[\r\n]/);
      expect(value, `${locale}.${key} should not contain HTML`).not.toMatch(/<[^>]*>/);
    }

    expect(en[key]).toBe('Place the device where the bass carries well');
    expect(ko[key]).toBe('저음이 잘 퍼지는 곳에 놓아주세요');
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
      'account.welcome_back',
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
