/**
 * MUSIXQUARE landing — i18n dictionary + apply
 *
 * Runs at end of body so the DOM exists. The <html lang> attr was already
 * set by landing-bootstrap.js in <head>, so :lang(ko) CSS rules have
 * applied since first paint — only text content + meta tags need swapping
 * here, plus the language-toggle click handlers.
 *
 * Extracted from inline <script> in landing.html so the production CSP
 * can drop `script-src 'unsafe-inline'`.
 */

(function () {
  var STORE_KEY = 'mxqr-landing-lang';

  var i18n = {
    en: {
      'meta.title': 'About · MUSIXQUARE',
      'meta.description':
        'MUSIXQUARE turns every phone, tablet, and laptop in the room into a single synchronized sound system. Browser-native. No install.',
      'meta.og_title': 'About · MUSIXQUARE',
      'meta.og_description': 'Every device, one system. Multi-device synchronized audio, no install.',
      'meta.og_image_alt': 'MUSIXQUARE: Every device, one system.',
      'meta.tw_title': 'About · MUSIXQUARE',
      'meta.tw_description': 'Every device, one system.',

      'header.logo_aria': 'MUSIXQUARE home',
      'header.try': 'Try it now',
      'header.try_aria': 'Try MUSIXQUARE now',

      'hero.h1': 'Every device,<br>one system.',
      'hero.lead':
        'MUSIXQUARE turns every phone, tablet, and laptop in the room into a single synchronized sound system. No install, one room code.',
      'hero.btn_ghost': 'How it works',

      'array.h2': 'Surround, without<br>surround speakers.',
      'array.lead':
        'Each device plays one role: left, right, subwoofer, or full stereo. The room itself becomes the system.',
      'array.aria': 'Left phone, center laptop, right phone. Three-device surround setup.',

      'code.h2': 'Six digits.<br>Nothing else.',
      'code.lead': 'Start a session, share six digits. Anyone with a browser joins in seconds.',
      'code.aria_code': 'Example room code',
      'code.aria_qr': 'QR code for musixquare.com',
      'code.copy_btn': 'Copy invite link',
      'code.toast_success': 'Invite link copied',
      'code.toast_fail': 'Copy failed',

      'remote.h2': 'Not in the room?<br>No problem.',
      'remote.lead': 'Chat, listen to music, or watch YouTube together, even from across town.',
      'remote.chat_label': 'Chat',
      'remote.chat_value': 'Realtime text, no limits',
      'remote.whisper_label': 'Whisper',
      'remote.whisper_value': 'Private 1:1 messages',
      'remote.cowatch_label': 'Co-watch',
      'remote.cowatch_value': 'YouTube together, in sync',
      'remote.reach_label': 'Reach',
      'remote.reach_value': 'Any browser, any network',
      'remote.caveat': "Note: channel separation and audio effects aren't available for YouTube.",
      'remote.pin_label': 'NOTICE · HOST',
      'remote.pin_text': "Tonight's playlist, make yourself at home.",
      'remote.host_name': 'HOST',
      'remote.host_msg1': 'you in yet?',
      'remote.peer_name': 'Peer 1',
      'remote.peer_msg1': 'joining from the café',
      'remote.peer_ts_msg': 'i really like this part',
      'remote.host_msg2': "this one's really good",
      'remote.whisper_sender': 'whisper to HOST',
      'remote.whisper_msg': 'try pinning a playlist rec request',

      'sync.h2': 'Frame-perfect.<br>Across networks.',
      'sync.lead':
        'Each device measures its round-trip latency against the host, then aligns playback to a shared master clock.',
      'sync.video_label': 'MEDIA',
      'sync.video_value': 'Frame-accurate Media playback',
      'sync.transport_label': 'Transport',
      'sync.transport_value': 'Peer-to-peer, WebRTC',
      'sync.effects_label': 'Effects',
      'sync.effects_value': '5-band EQ · Reverb · Virtualizer',
      'sync.platforms_label': 'Platforms',
      'sync.platforms_value': 'iOS · Android · macOS · Windows',
      'sync.host_label': 'Host',
      'sync.meta': 'NTP style sync with 60 samples',

      'standin.h2': 'No speakers on<br>your computer?',
      'standin.lead':
        'MUSIXQUARE works as a quick stand-in. A phone and a tablet from your bag are enough to start.',
      'standin.aria': 'Silent computer above two active phones acting as left and right speakers',
      'standin.desktop_label': 'Desktop',
      'standin.desktop_value': 'Phones or tablets on the desk become the speakers',
      'standin.laptop_label': 'Laptop',
      'standin.laptop_value': 'Multiple devices instead of weak built-in speakers',
      'standin.feature_label': 'Feature',
      'standin.feature_value': 'System audio sharing mode',
      'standin.platform_label': 'Platform',
      'standin.platform_value': 'Chromium-based browsers on Windows / Mac',
      'standin.caveat':
        'Note: System audio sharing mode has unavoidable latency, so the host should lower their volume as much as possible.',

      'cta.h2': 'Start a session.',
      'cta.btn': 'Launch MUSIXQUARE',

      'footer.app': 'App',
      'footer.changelog': 'Changelog',
      'footer.roadmap': 'Roadmap',
      'footer.designsystem': 'Design System',
    },

    ko: {
      'meta.title': 'MUSIXQUARE 소개',
      'meta.description':
        'MUSIXQUARE는 같은 방의 폰, 태블릿, 노트북을 하나의 동기화된 사운드 시스템으로 만들어요. 브라우저에서 바로, 설치 없이.',
      'meta.og_title': 'MUSIXQUARE 소개',
      'meta.og_description': '모든 기기, 하나의 시스템. 여러 기기 동기 재생, 설치 없이.',
      'meta.og_image_alt': 'MUSIXQUARE: 모든 기기, 하나의 시스템.',
      'meta.tw_title': 'MUSIXQUARE 소개',
      'meta.tw_description': '모든 기기, 하나의 시스템.',

      'header.logo_aria': 'MUSIXQUARE 홈',
      'header.try': '바로가기',
      'header.try_aria': 'MUSIXQUARE 바로가기',

      'hero.h1': '모든 기기를<br>하나의 시스템으로',
      'hero.lead':
        '뮤직스퀘어는 같은 공간에 있는 모든 폰, 태블릿, 노트북을 하나의 사운드 시스템으로 묶어줘요. 설치 없이 코드 하나만 공유하면 돼요.',
      'hero.btn_ghost': '자세히 보기',

      'array.h2': '서라운드 스피커 없이<br>서라운드 사운드 만들기',
      'array.lead': '각 기기가 좌측 우측 서브우퍼 스테레오 스피커가 돼요. 방 전체에 서라운드 시스템을 구현해봐요.',
      'array.aria': '왼쪽 폰, 가운데 노트북, 오른쪽 폰. 3 기기 서라운드 구성.',

      'code.h2': '여섯자리 숫자만<br>있으면 돼요',
      'code.lead': '방을 열면 여섯 자리 코드가 생겨요. 브라우저가 있는 기기라면 금방 연결할 수 있어요.',
      'code.aria_code': '예시 방 코드',
      'code.aria_qr': 'musixquare.com QR 코드',
      'code.copy_btn': '초대 링크 복사하기',
      'code.toast_success': '초대 링크가 복사되었어요',
      'code.toast_fail': '복사에 실패했어요',

      'remote.h2': '같은 공간이 아니어도<br>괜찮아요',
      'remote.lead': '멀리 떨어져 있어도 채팅하면서 음악을 듣거나 유튜브를 볼 수 있어요.',
      'remote.chat_label': '채팅',
      'remote.chat_value': '제한 없는 실시간 텍스트 채팅',
      'remote.whisper_label': '귓속말',
      'remote.whisper_value': '1:1 비공개 메시지',
      'remote.cowatch_label': '함께 보기',
      'remote.cowatch_value': '유튜브 동기화 재생',
      'remote.reach_label': '가능 환경',
      'remote.reach_value': '모든 브라우저, 모든 네트워크',
      'remote.caveat': '참고: YouTube 모드에서는 채널 분리와 음향 효과를 쓸 수 없어요.',
      'remote.pin_label': '공지 · HOST',
      'remote.pin_text': '플리 추천받습니다',
      'remote.host_name': 'HOST',
      'remote.host_msg1': '들어왔어?',
      'remote.peer_name': 'Peer 1',
      'remote.peer_msg1': '아 카페임ㅋㅋ',
      'remote.peer_ts_msg': '이부분 진짜 좋은듯',
      'remote.host_msg2': '오 이거 마음에 든다',
      'remote.whisper_sender': 'HOST에게 귓속말',
      'remote.whisper_msg': '공지로 플리 추천좀 받아봐',

      'sync.h2': '네트워크를 넘어<br>프레임 단위로 정확하게',
      'sync.lead': '각 기기가 방장과의 지연을 측정하고 칼같이 정렬해요.',
      'sync.video_label': '미디어',
      'sync.video_value': '프레임 단위 미디어 재생',
      'sync.transport_label': '전송',
      'sync.transport_value': 'P2P, WebRTC',
      'sync.effects_label': '효과',
      'sync.effects_value': '5밴드 이퀄라이저, 리버브, 버추얼라이저',
      'sync.platforms_label': '플랫폼',
      'sync.platforms_value': 'iOS · Android · macOS · Windows',
      'sync.host_label': 'HOST',
      'sync.meta': '60개 샘플 수집 후 NTP 방식 동기화',

      'standin.h2': '혹시 컴퓨터에<br>스피커가 없다면',
      'standin.lead': '뮤직스퀘어가 좋은 임시방편이 될 수 있어요. 가방 속 폰과 태블릿이면 충분해요.',
      'standin.aria': '음소거된 컴퓨터 아래에 좌우 스피커 역할을 하는 폰 두 대',
      'standin.desktop_label': '데스크톱',
      'standin.desktop_value': '책상 위 폰이나 태블릿으로 스피커 셋업',
      'standin.laptop_label': '노트북',
      'standin.laptop_value': '빈약한 노트북 스피커 대신 여러 개의 디바이스',
      'standin.feature_label': '기능',
      'standin.feature_value': '시스템 오디오 공유 모드',
      'standin.platform_label': '플랫폼',
      'standin.platform_value': 'Windows / Mac의 Chromium 기반 브라우저',
      'standin.caveat':
        '참고: 시스템 오디오 공유 모드는 지연이 필연적으로 발생해요. 사용 시 방장은 소리를 최대한 낮추어야 해요.',

      'cta.h2': '지금 시작해봐요!',
      'cta.btn': 'MUSIXQUARE 시작하기',

      'footer.app': 'App',
      'footer.changelog': 'Changelog',
      'footer.roadmap': 'Roadmap',
      'footer.designsystem': 'Design System',
    },
  };

  function t(lang, key) {
    var dict = i18n[lang] || i18n.en;
    var val = dict[key];
    if (val == null) val = i18n.en[key];
    return val == null ? key : val;
  }

  // Exposed for main.ts toast calls. Reads current __landingLang at call time
  // so a runtime toggle is reflected without re-binding.
  window.__landingT = function (key, fallback) {
    var lang = window.__landingLang || 'en';
    var v = i18n[lang] && i18n[lang][key];
    return v != null ? v : fallback != null ? fallback : key;
  };

  function applyLang(lang) {
    document.documentElement.lang = lang;
    window.__landingLang = lang;

    // Text content. Values containing <br> use innerHTML so the line break renders;
    // everything else uses textContent to keep XSS surface minimal.
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var v = t(lang, el.getAttribute('data-i18n'));
      if (v.indexOf('<br>') !== -1) el.innerHTML = v;
      else el.textContent = v;
    }

    // Attribute translations. Format: "attrName:key" (single attr per element for now).
    var attrEls = document.querySelectorAll('[data-i18n-attr]');
    for (var j = 0; j < attrEls.length; j++) {
      var ae = attrEls[j];
      var spec = ae.getAttribute('data-i18n-attr');
      if (!spec) continue;
      var pair = spec.split(':');
      if (pair.length === 2) ae.setAttribute(pair[0], t(lang, pair[1]));
    }

    // Meta tags. Crawlers see the HTML defaults (English); JS swaps for users.
    document.title = t(lang, 'meta.title');
    var metaPairs = [
      ['meta[name="description"]', 'meta.description'],
      ['meta[property="og:title"]', 'meta.og_title'],
      ['meta[property="og:description"]', 'meta.og_description'],
      ['meta[property="og:image:alt"]', 'meta.og_image_alt'],
      ['meta[name="twitter:title"]', 'meta.tw_title'],
      ['meta[name="twitter:description"]', 'meta.tw_description'],
    ];
    for (var m = 0; m < metaPairs.length; m++) {
      var mEl = document.querySelector(metaPairs[m][0]);
      if (mEl) mEl.setAttribute('content', t(lang, metaPairs[m][1]));
    }
    // Locale meta swap (primary + alternate).
    var ogLocale = document.querySelector('meta[property="og:locale"]');
    var ogAlt = document.querySelector('meta[property="og:locale:alternate"]');
    if (ogLocale) ogLocale.setAttribute('content', lang === 'ko' ? 'ko_KR' : 'en_US');
    if (ogAlt) ogAlt.setAttribute('content', lang === 'ko' ? 'en_US' : 'ko_KR');

    // Toggle UI active state.
    var btns = document.querySelectorAll('[data-lang-set]');
    for (var b = 0; b < btns.length; b++) {
      btns[b].classList.toggle('is-active', btns[b].getAttribute('data-lang-set') === lang);
    }
  }

  function setLang(lang) {
    try {
      localStorage.setItem(STORE_KEY, lang);
    } catch (e) {
      /* ignore quota / disabled */
    }
    applyLang(lang);
    // Reflect in URL so the choice is shareable. replaceState avoids polluting history.
    try {
      var url = new URL(location.href);
      if (lang === 'ko') url.searchParams.set('lang', 'ko');
      else url.searchParams.delete('lang');
      history.replaceState(null, '', url.toString());
    } catch (e) {
      /* old browser without URL constructor — silent */
    }
  }

  var btns = document.querySelectorAll('[data-lang-set]');
  for (var k = 0; k < btns.length; k++) {
    btns[k].addEventListener('click', function (e) {
      setLang(e.currentTarget.getAttribute('data-lang-set'));
    });
  }

  applyLang(window.__landingLang || 'en');
})();
