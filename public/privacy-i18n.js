/**
 * MUSIXQUARE privacy — i18n dictionary + apply.
 */

(function () {
  var STORE_KEY = 'mxqr-landing-lang';

  var i18n = {
    en: {
      'meta.title': 'Privacy Policy · MUSIXQUARE',
      'meta.description':
        'MUSIXQUARE privacy policy for real-time audio sync, remote sharing, and temporary encrypted file storage.',
      'meta.og_title': 'Privacy Policy · MUSIXQUARE',
      'meta.og_description':
        'How MUSIXQUARE handles connection data, remote sharing, and temporary encrypted file storage.',
      'meta.tw_title': 'Privacy Policy · MUSIXQUARE',
      'meta.tw_description': 'How MUSIXQUARE handles service data.',

      'header.logo_aria': 'MUSIXQUARE home',
      'header.app': 'App',
      'hero.title': 'Privacy Policy',
      'hero.date': 'Effective date: May 5, 2026',

      'section.general.title': '1. General',
      'section.general.p1':
        'MUSIXQUARE is a browser-based real-time audio sync and sharing service that can be used without creating an account.',
      'section.general.p2':
        'MUSIXQUARE does not directly collect account data such as names, addresses, phone numbers, login credentials, or payment information. Some connection and session data may be processed temporarily to provide device connection, remote sharing, and service reliability.',

      'section.data.title': '2. Data We Process',
      'section.data.intro': 'MUSIXQUARE may process the following data to provide the service.',
      'section.data.connection.term': 'Connection setup data',
      'section.data.connection.desc':
        'Room codes, temporary device IDs, IP addresses, connection status, and WebRTC signaling data may be processed to create and maintain rooms.',
      'section.data.local.term': 'Local session data',
      'section.data.local.desc':
        'On the same network, session data is sent directly between devices. Only IP and connection details may pass through the signaling server.',
      'section.data.remote.term': 'Remote sharing data',
      'section.data.remote.desc':
        'Remote file sharing and remote system audio sharing route actual data through Cloudflare. Remote system audio is relayed for real-time delivery and is not stored by MUSIXQUARE.',
      'section.data.files.term': 'Remote file data',
      'section.data.files.desc':
        'Remote file data is encrypted before upload and may be stored temporarily for delivery. The decryption key is not stored.',

      'section.purpose.title': '3. Purpose of Processing',
      'section.purpose.p1':
        'Data is processed only to establish rooms, synchronize playback, deliver remote sharing features, maintain connections, and operate MUSIXQUARE safely.',
      'section.purpose.p2':
        'MUSIXQUARE does not use shared data for advertising, profiling, resale, or unrelated analytics.',

      'section.retention.title': '4. Retention and Deletion',
      'section.retention.p1':
        'Encrypted data uploaded for remote file sharing is stored for up to 24 hours and then automatically deleted.',
      'section.retention.p2':
        'Connection and session data is processed only while needed for room operation or connection maintenance. MUSIXQUARE does not view, analyze, or store data outside providing its features.',

      'section.third.title': '5. Third-Party Services',
      'section.third.p1': 'MUSIXQUARE does not sell user data or provide it to third parties for advertising or marketing.',
      'section.third.p2':
        "Some features rely on external infrastructure. Cloudflare may be used for signaling, remote sharing, TURN, SFU, and temporary encrypted file delivery. YouTube sharing uses YouTube's official playback structure.",

      'section.security.title': '6. Security Measures',
      'section.security.p1':
        'MUSIXQUARE uses HTTPS, browser security features, WebRTC, and Cloudflare infrastructure to provide encrypted transport where applicable.',
      'section.security.p2':
        'For remote file sharing, files are encrypted before upload and the decryption key is not stored in storage. Connection quality and security behavior may still vary by network, browser policy, and device settings.',

      'section.rights.title': '7. User Requests',
      'section.rights.p1':
        'MUSIXQUARE does not provide account-based user profiles, so account lookup or profile editing features are not available.',
      'section.rights.p2':
        'For privacy questions, deletion requests, or related concerns, contact <a href="mailto:contact@musixquare.com" data-copy-email="contact@musixquare.com">contact@musixquare.com</a>. MUSIXQUARE will review requests and take action where reasonably possible.',

      'section.changes.title': '8. Changes',
      'section.changes.p1':
        'This Privacy Policy may be updated when MUSIXQUARE features, infrastructure, or related legal requirements change.',
      'section.changes.p2': 'Important changes may be announced through the MUSIXQUARE website or service screen.',
    },
    ko: {
      'meta.title': '개인정보 처리방침 · MUSIXQUARE',
      'meta.description':
        'MUSIXQUARE의 실시간 오디오 동기화, 원격 공유, 암호화 파일 임시 저장에 대한 개인정보 처리방침입니다.',
      'meta.og_title': '개인정보 처리방침 · MUSIXQUARE',
      'meta.og_description': 'MUSIXQUARE가 연결 정보, 원격 공유, 암호화 파일 임시 저장을 처리하는 방식입니다.',
      'meta.tw_title': '개인정보 처리방침 · MUSIXQUARE',
      'meta.tw_description': 'MUSIXQUARE가 서비스 데이터를 처리하는 방식입니다.',

      'header.logo_aria': 'MUSIXQUARE 홈',
      'header.app': 'App',
      'hero.title': '개인정보 처리방침',
      'hero.date': '시행일: 2026년 5월 5일',

      'section.general.title': '1. 총칙',
      'section.general.p1':
        'MUSIXQUARE는 별도의 회원가입 없이 사용할 수 있는 웹 기반 실시간 오디오 동기화 및 공유 서비스입니다.',
      'section.general.p2':
        'MUSIXQUARE는 이름, 주소, 전화번호, 로그인 정보, 결제 정보 같은 계정 정보를 직접 수집하지 않습니다. 다만 기기 간 연결, 원격 공유, 서비스 안정성을 위해 연결 정보와 세션 데이터가 일시적으로 처리될 수 있습니다.',

      'section.data.title': '2. 처리하는 데이터',
      'section.data.intro': 'MUSIXQUARE는 서비스 제공을 위해 다음 데이터를 처리할 수 있습니다.',
      'section.data.connection.term': '연결 수립 데이터',
      'section.data.connection.desc':
        '방 코드, 기기 식별용 임시 ID, IP 주소, 연결 상태, WebRTC 시그널링 데이터가 방 생성과 연결 유지를 위해 처리될 수 있습니다.',
      'section.data.local.term': '로컬 세션 데이터',
      'section.data.local.desc':
        '같은 네트워크에서는 세션 데이터가 기기 간에 직접 전송됩니다. IP 주소와 연결 정보만 시그널링 서버를 경유할 수 있습니다.',
      'section.data.remote.term': '원격 공유 데이터',
      'section.data.remote.desc':
        '원격 파일 공유와 원격 시스템 오디오 공유는 실제 데이터가 Cloudflare를 경유합니다. 원격 시스템 오디오는 실시간 전달을 위해 경유하며 MUSIXQUARE가 저장하지 않습니다.',
      'section.data.files.term': '원격 파일 데이터',
      'section.data.files.desc':
        '원격 파일 데이터는 업로드 전에 암호화되며 전달을 위해 임시 저장될 수 있습니다. 복호화 키는 저장되지 않습니다.',

      'section.purpose.title': '3. 처리 목적',
      'section.purpose.p1':
        '데이터는 방 생성, 재생 동기화, 원격 공유 기능 제공, 연결 유지, 안전한 서비스 운영을 위해서만 처리됩니다.',
      'section.purpose.p2':
        'MUSIXQUARE는 공유 데이터를 광고, 프로파일링, 판매, 무관한 분석 목적으로 사용하지 않습니다.',

      'section.retention.title': '4. 보유 및 삭제',
      'section.retention.p1':
        '원격 파일 공유를 위해 업로드된 암호화 데이터는 최대 24시간 저장된 뒤 자동 삭제됩니다.',
      'section.retention.p2':
        '연결 및 세션 데이터는 방 운영이나 연결 유지에 필요한 동안만 처리됩니다. MUSIXQUARE는 기능 제공 외의 목적으로 데이터를 열람, 분석, 보관하지 않습니다.',

      'section.third.title': '5. 외부 서비스',
      'section.third.p1': 'MUSIXQUARE는 사용자 데이터를 광고나 마케팅 목적으로 판매하거나 제3자에게 제공하지 않습니다.',
      'section.third.p2':
        '일부 기능은 외부 인프라에 의존합니다. Cloudflare는 시그널링, 원격 공유, TURN, SFU, 암호화 파일 임시 전달에 사용될 수 있습니다. YouTube 공유는 YouTube의 공식 재생 구조를 사용합니다.',

      'section.security.title': '6. 보안 조치',
      'section.security.p1':
        'MUSIXQUARE는 HTTPS, 브라우저 보안 기능, WebRTC, Cloudflare 인프라를 기반으로 가능한 범위에서 암호화된 전송을 제공합니다.',
      'section.security.p2':
        '원격 파일 공유 시 파일은 업로드 전에 암호화되며 복호화 키는 저장소에 보관되지 않습니다. 다만 연결 품질과 보안 동작은 네트워크, 브라우저 정책, 기기 설정에 따라 달라질 수 있습니다.',

      'section.rights.title': '7. 사용자 요청',
      'section.rights.p1':
        'MUSIXQUARE는 계정 기반 사용자 프로필을 제공하지 않으므로 계정 조회나 프로필 수정 기능은 제공하지 않습니다.',
      'section.rights.p2':
        '개인정보 관련 문의, 삭제 요청, 기타 요청은 <a href="mailto:contact@musixquare.com" data-copy-email="contact@musixquare.com">contact@musixquare.com</a>으로 연락할 수 있습니다. MUSIXQUARE는 요청 내용을 확인한 뒤 가능한 범위에서 필요한 조치를 진행합니다.',

      'section.changes.title': '8. 변경',
      'section.changes.p1':
        '본 개인정보 처리방침은 MUSIXQUARE의 기능, 인프라, 관련 법령 변경에 따라 수정될 수 있습니다.',
      'section.changes.p2': '중요한 변경이 있는 경우 MUSIXQUARE 웹사이트 또는 서비스 화면을 통해 안내할 수 있습니다.',
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
    window.__privacyLang = lang;

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

  applyLang(window.__privacyLang || 'en');
})();
