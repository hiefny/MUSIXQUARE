/**
 * MUSIXQUARE FAQ - i18n dictionary + apply.
 */

(function () {
  var STORE_KEY = 'mxqr-landing-lang';

  var i18n = {
    en: {
      'meta.title': 'FAQ · MUSIXQUARE',
      'meta.description':
        'Frequently asked questions about MUSIXQUARE rooms, speaker roles, local files, YouTube mode, system audio sharing, and sync behavior.',
      'meta.og_title': 'FAQ · MUSIXQUARE',
      'meta.og_description':
        'Answers about MUSIXQUARE rooms, connection, local files, YouTube mode, and system audio sharing.',
      'meta.tw_title': 'FAQ · MUSIXQUARE',
      'meta.tw_description': 'Frequently asked questions about MUSIXQUARE.',

      'header.logo_aria': 'MUSIXQUARE home',
      'header.app': 'App',
      'hero.title': 'Frequently Asked Questions',
      'hero.date': 'Last updated: May 8, 2026',

      'section.start.title': '1. Getting Started',
      'section.start.what.q': 'What is MUSIXQUARE?',
      'section.start.what.a':
        'MUSIXQUARE is a web app that connects multiple devices like wireless speakers so you can play music, YouTube, and system audio together.',
      'section.start.install.q': 'Do I need to install an app?',
      'section.start.install.a':
        'No. You can use MUSIXQUARE directly in a browser. If you use it often, installing it as a PWA on iOS, Android, Windows, or macOS can make it easier to open.',
      'section.start.room.q': 'How do I create or join a room?',
      'section.start.room.a':
        'The host creates a room and shares the 6-digit code. Guests choose a role, then enter the code to join. Invite links and QR codes are also supported.',

      'section.channel.title': '2. Channel Routing',
      'section.channel.role.q': 'Which speaker role should I choose?',
      'section.channel.role.a':
        'Each device can play a different channel by choosing Stereo, Left, Right, or Subwoofer.',
      'section.channel.sub.q': 'What is Subwoofer mode for?',
      'section.channel.sub.a':
        'Subwoofer mode emphasizes low frequencies only. You can adjust the cutoff frequency in Settings.',
      'section.channel.surround.q': 'Does MUSIXQUARE support 7.1 surround?',
      'section.channel.surround.a':
        'It is not exposed in the current user interface. An internal 7.1 channel-routing engine exists, but most user audio is stereo, so it is hidden from the product UI after usability review.',

      'section.connection.title': '3. Connection',
      'section.connection.limit.q': 'How many people can join?',
      'section.connection.limit.a':
        'The default room capacity is 3 guests, and the host can adjust it up to 32 guests in the Connection tab. Supported limits may change later depending on operating policy.',
      'section.connection.password.q': 'How can I keep outsiders from joining?',
      'section.connection.password.a':
        'The host can enable an 8-digit numeric password in the Connection tab. When the password is enabled, new guests must enter both the 6-digit room code and the 8-digit password.',
      'section.connection.wifi.q': 'Do all devices have to be on the same Wi-Fi?',
      'section.connection.wifi.a':
        'The same network is the most stable option. Remote participation is possible, but quality can vary greatly depending on the network, VPN, firewall, and browser policies.',

      'section.local.title': '4. Local File Mode',
      'section.local.add.q': 'Who can add local files?',
      'section.local.add.a':
        'Only the host can add local files. For security reasons, admin guests and regular guests cannot add files.',
      'section.local.preload.q': 'Does MUSIXQUARE preload the next track?',
      'section.local.preload.a':
        'Yes. In local file playback, MUSIXQUARE can preload the next track to reduce waiting time during track changes. Remote preload is not supported.',
      'section.local.video.q': 'Can I upload video files directly?',
      'section.local.video.a':
        'Local File Mode is designed for music files. For video, we recommend using YouTube watch-together mode.',

      'section.youtube.title': '5. YouTube Mode',
      'section.youtube.effects.q': 'Do channel routing or audio effects apply in YouTube mode?',
      'section.youtube.effects.a':
        "No. YouTube mode uses the YouTube IFrame Player, so MUSIXQUARE's advanced audio effects and channel routing do not apply.",
      'section.youtube.sync.q': 'YouTube sync is not aligned. What should I do?',
      'section.youtube.sync.a':
        'Try syncing again or check the network condition. YouTube IFrame performance can differ by device, so we are continuing to improve correction behavior.',
      'section.youtube.services.q': 'YouTube works. Are Spotify, Apple Music, or Netflix supported?',
      'section.youtube.services.a':
        'Those services are not supported because of their service policies. If the host is on a PC, consider using System Audio Sharing for audio sources that can be shared by the browser.',

      'section.system.title': '6. System Audio Sharing',
      'section.system.where.q': 'Where can I use system audio sharing?',
      'section.system.where.a':
        'System Audio Sharing is available on desktop Chromium-based browsers on Windows and macOS. Mobile and Safari support is planned for a future app release.',
      'section.system.delay.q': 'Why does System Audio Sharing feel delayed compared with the host?',
      'section.system.delay.a':
        "The host's audio needs time to be processed and transmitted. This mode is meant for muting the host's own speaker, syncing sound through the remaining participant devices, and applying audio effects there.",

      'section.trouble.title': '7. Other Issues',
      'section.trouble.sync.q': 'Sync is not perfectly aligned.',
      'section.trouble.sync.a':
        'MUSIXQUARE supports precise sync, but device performance, browser behavior, network conditions, and Bluetooth latency can still create differences. Use manual sync adjustment when needed.',
      'section.trouble.sound.q': 'I cannot connect, or there is no sound.',
      'section.trouble.sound.a':
        'Check the room code, make sure the host is still keeping the session open, and check browser mute or iOS silent mode. If the issue continues, restart the browser.',
      'section.trouble.contact.q': 'How can I contact MUSIXQUARE?',
      'section.trouble.contact.a':
        'For questions or requests, feel free to contact <a href="mailto:support@musixquare.com" data-copy-email="support@musixquare.com">support@musixquare.com</a>. Thank you.',
    },
    ko: {
      'meta.title': '자주 묻는 질문 · MUSIXQUARE',
      'meta.description':
        'MUSIXQUARE의 방 만들기, 스피커 역할, 로컬 파일, YouTube 모드, 시스템 오디오 공유, 동기화 동작에 대한 자주 묻는 질문입니다.',
      'meta.og_title': '자주 묻는 질문 · MUSIXQUARE',
      'meta.og_description':
        'MUSIXQUARE의 연결, 로컬 파일, YouTube 모드, 시스템 오디오 공유에 대한 답변입니다.',
      'meta.tw_title': '자주 묻는 질문 · MUSIXQUARE',
      'meta.tw_description': 'MUSIXQUARE에 대한 자주 묻는 질문입니다.',

      'header.logo_aria': 'MUSIXQUARE 홈',
      'header.app': 'App',
      'hero.title': '자주 묻는 질문',
      'hero.date': '업데이트: 2026년 5월 8일',

      'section.start.title': '1. 시작하기',
      'section.start.what.q': 'MUSIXQUARE는 어떤 서비스인가요?',
      'section.start.what.a':
        '여러 기기를 무선 스피커처럼 연결해 음악, YouTube, 시스템 오디오를 함께 재생하는 웹 앱이에요.',
      'section.start.install.q': '앱 설치가 필요한가요?',
      'section.start.install.a':
        '설치 없이 브라우저에서 바로 사용할 수 있어요. 다만 자주 사용한다면 iOS, Android, Windows, macOS에서 PWA로 설치해 더 편하게 열 수 있어요.',
      'section.start.room.q': '방은 어떻게 만들고 참여하나요?',
      'section.start.room.a':
        '방장은 방을 만들고 6자리 코드를 공유하면 돼요. 참여자는 역할을 고른 뒤 6자리 코드를 입력해 참여해요. 초대 링크와 QR 코드도 지원해요.',

      'section.channel.title': '2. 채널 분리',
      'section.channel.role.q': '스피커 역할은 무엇을 골라야 하나요?',
      'section.channel.role.a':
        '각 기기는 스테레오, 왼쪽, 오른쪽, 서브우퍼 역할을 선택해 다른 채널을 재생할 수 있어요.',
      'section.channel.sub.q': '서브우퍼 모드는 어떤 용도인가요?',
      'section.channel.sub.a':
        '서브우퍼 모드는 저역대만 강조해서 출력하는 모드예요. 설정에서 컷오프 주파수를 조절할 수 있어요.',
      'section.channel.surround.q': '7.1 서라운드도 지원하나요?',
      'section.channel.surround.a':
        '현재 사용자 UI에는 노출되어 있지 않아요. 내부적으로 7.1 채널 라우팅 엔진이 있지만, 일반 사용자가 가진 음원 대부분이 스테레오라 사용성 검토 후 제품 UI에서는 숨겨 두었어요.',

      'section.connection.title': '3. 연결',
      'section.connection.limit.q': '최대 몇 명까지 연결할 수 있나요?',
      'section.connection.limit.a':
        '기본 참여 가능 인원은 3명이며, 연결 탭에서 최대 32명까지 조절할 수 있어요. 추후 운영 정책에 따라 지원 인원은 변경될 수 있어요.',
      'section.connection.password.q': '세션에 외부인이 접근하지 못하게 하고 싶어요.',
      'section.connection.password.a':
        '방장은 연결 탭에서 8자리 숫자 암호를 켤 수 있어요. 암호가 켜져 있으면 새 참여자는 6자리 입장 코드와 8자리 암호를 모두 입력해야 해요.',
      'section.connection.wifi.q': '무조건 같은 Wi-Fi에 있어야 하나요?',
      'section.connection.wifi.a':
        '같은 네트워크가 가장 안정적이에요. 원격 참여도 가능하지만 네트워크, VPN, 방화벽, 브라우저 정책에 따라 품질이 크게 달라질 수 있어요.',

      'section.local.title': '4. 로컬 파일 모드',
      'section.local.add.q': '로컬 파일은 누가 추가할 수 있나요?',
      'section.local.add.a':
        '방장만 로컬 파일을 추가할 수 있어요. 보안 정책에 따라 관리자 게스트와 일반 게스트는 파일을 추가할 수 없어요.',
      'section.local.preload.q': '다음 곡을 미리 받아 두나요?',
      'section.local.preload.a':
        '네. 로컬 파일 재생에서는 곡 전환 시 대기 시간을 줄이기 위해 다음 곡을 미리 받아 두는 프리로드 기능이 있어요. 원격에서는 프리로드가 지원되지 않아요.',
      'section.local.video.q': '영상 파일도 직접 올릴 수 있나요?',
      'section.local.video.a':
        '현재 로컬 파일 모드는 음악 파일만 업로드하도록 설계했어요. 영상은 YouTube 같이 보기를 사용하는 것을 추천해요.',

      'section.youtube.title': '5. YouTube 모드',
      'section.youtube.effects.q': 'YouTube 모드에서도 채널 분리나 음향 효과가 적용되나요?',
      'section.youtube.effects.a':
        '아니요. YouTube IFrame Player로 재생되기 때문에 MUSIXQUARE의 고급 오디오 효과와 채널 분리는 적용되지 않아요.',
      'section.youtube.sync.q': 'YouTube 모드에서 동기화가 잘 맞지 않아요.',
      'section.youtube.sync.a':
        '동기화를 다시 시도하거나 네트워크 상태를 확인해 주세요. 단, 기기마다 YouTube IFrame Player 성능이 달라질 수 있어 보정 기능을 계속 개선하고 있어요.',
      'section.youtube.services.q':
        'YouTube는 되는데, Spotify나 Apple Music, Netflix 같은 서비스도 지원되나요?',
      'section.youtube.services.a':
        '해당 서비스 정책에 의해 지원되지 않아요. 다만 방장이 PC 환경이고 브라우저가 오디오 캡처를 허용한다면 시스템 오디오 공유 모드 사용을 고려해 보세요.',

      'section.system.title': '6. 시스템 오디오 공유 모드',
      'section.system.where.q': '시스템 오디오 공유는 어디서 사용할 수 있나요?',
      'section.system.where.a':
        'Windows/macOS의 데스크톱 Chromium 계열 브라우저에서 사용할 수 있어요. 모바일과 Safari는 추후 앱 출시 후 지원할 계획이에요.',
      'section.system.delay.q': '시스템 오디오 공유 모드를 켜면 방장과 동기화가 안 맞아요.',
      'section.system.delay.a':
        '방장의 소리를 처리하고 전송하는 데 시간이 필요해요. 이 기능은 방장의 자체 스피커를 끄고, 남아 있는 참여자 기기에서 소리를 동기화하며 음향 효과를 적용하는 용도에 가까워요.',

      'section.trouble.title': '7. 기타 문제',
      'section.trouble.sync.q': '동기화가 완벽하게 맞지 않아요.',
      'section.trouble.sync.a':
        '정밀 동기화를 지원하지만 기기 성능, 브라우저, 네트워크, 블루투스 지연에 따라 차이가 날 수 있어요. 필요하면 수동 싱크 조절을 사용할 수 있어요.',
      'section.trouble.sound.q': '연결이 안 되거나 소리가 안 나요.',
      'section.trouble.sound.a':
        '코드를 다시 확인하고 방장이 세션을 유지 중인지 확인해 주세요. 브라우저 음소거와 iOS 무음 모드도 확인해 주세요. 문제가 계속되면 브라우저를 다시 시작해 주세요.',
      'section.trouble.contact.q': '기타 문의사항',
      'section.trouble.contact.a':
        '질문과 요청사항은 언제든지 <a href="mailto:support@musixquare.com" data-copy-email="support@musixquare.com">support@musixquare.com</a>으로 편하게 연락해 주세요. 감사합니다.',
    },
  };

  function t(lang, key) {
    var dict = i18n[lang] || i18n.en;
    var val = dict[key];
    if (val == null) val = i18n.en[key];
    return val == null ? key : val;
  }

  function applyLang(lang) {
    document.documentElement.lang = lang;
    window.__faqLang = lang;

    document.title = t(lang, 'meta.title');
    setMeta('description', t(lang, 'meta.description'));
    setMetaProperty('og:title', t(lang, 'meta.og_title'));
    setMetaProperty('og:description', t(lang, 'meta.og_description'));
    setMetaProperty('og:locale', lang === 'ko' ? 'ko_KR' : 'en_US');
    setMeta('twitter:title', t(lang, 'meta.tw_title'));
    setMeta('twitter:description', t(lang, 'meta.tw_description'));

    var textEls = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < textEls.length; i++) {
      var el = textEls[i];
      el.textContent = t(lang, el.getAttribute('data-i18n'));
    }

    var htmlEls = document.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < htmlEls.length; j++) {
      var htmlEl = htmlEls[j];
      htmlEl.innerHTML = t(lang, htmlEl.getAttribute('data-i18n-html'));
    }

    var attrEls = document.querySelectorAll('[data-i18n-attr]');
    for (var k = 0; k < attrEls.length; k++) {
      var ae = attrEls[k];
      var spec = ae.getAttribute('data-i18n-attr');
      if (!spec) continue;
      var parts = spec.split(':');
      if (parts.length !== 2) continue;
      ae.setAttribute(parts[0], t(lang, parts[1]));
    }

    var btns = document.querySelectorAll('[data-lang-set]');
    for (var b = 0; b < btns.length; b++) {
      btns[b].classList.toggle('is-active', btns[b].getAttribute('data-lang-set') === lang);
    }
  }

  function setMeta(name, content) {
    var el = document.querySelector('meta[name="' + name + '"]');
    if (el) el.setAttribute('content', content);
  }

  function setMetaProperty(prop, content) {
    var el = document.querySelector('meta[property="' + prop + '"]');
    if (el) el.setAttribute('content', content);
  }

  function setLang(lang) {
    try {
      localStorage.setItem(STORE_KEY, lang);
    } catch (e) {
      /* ignore */
    }
    applyLang(lang);
    try {
      var url = new URL(location.href);
      if (lang === 'ko') url.searchParams.set('lang', 'ko');
      else url.searchParams.delete('lang');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {
      /* ignore */
    }
  }

  var btns = document.querySelectorAll('[data-lang-set]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function (e) {
      setLang(e.currentTarget.getAttribute('data-lang-set'));
    });
  }

  applyLang(window.__faqLang || 'en');
})();
