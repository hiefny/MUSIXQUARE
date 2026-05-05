/**
 * MUSIXQUARE terms — i18n dictionary + apply.
 */

(function () {
  var STORE_KEY = 'mxqr-landing-lang';

  var i18n = {
    en: {
      'meta.title': 'Terms of Use · MUSIXQUARE',
      'meta.description':
        'MUSIXQUARE terms of use for shared content, remote sharing, external services, and service limitations.',
      'meta.og_title': 'Terms of Use · MUSIXQUARE',
      'meta.og_description': 'Terms for using MUSIXQUARE sharing, sync, and external-service features.',
      'meta.tw_title': 'Terms of Use · MUSIXQUARE',
      'meta.tw_description': 'Terms for using MUSIXQUARE.',

      'header.logo_aria': 'MUSIXQUARE home',
      'header.app': 'App',
      'hero.title': 'Terms of Use',
      'hero.date': 'Effective date: May 5, 2026',

      'section.general.title': '1. General',
      'section.general.p1':
        'MUSIXQUARE is a free browser-based service for real-time audio sync, shared playback, remote sharing, and communication between devices.',
      'section.general.p2': 'By using MUSIXQUARE, users agree to use the service lawfully and responsibly.',

      'section.content.title': '2. Content and Copyright',
      'section.content.p1':
        'Music, videos, files, and other content shared through MUSIXQUARE belong to their respective rights holders.',
      'section.content.p2':
        'System audio sharing and file sharing are intended for personal use. Users are responsible for unauthorized distribution, public transmission, or other infringement of copyrighted content.',
      'section.content.p3':
        "YouTube sharing uses YouTube's official playback structure. Views and rights handling follow YouTube policies and rights-holder settings.",

      'section.remote.title': '3. Remote Sharing',
      'section.remote.p1':
        'Remote file sharing and remote system audio sharing may route actual data through Cloudflare to provide the feature.',
      'section.remote.p2':
        'Users should not share content they do not have the right to share, or content that violates laws, rights, or the safety of others.',

      'section.external.title': '4. External Services',
      'section.external.p1': 'Some MUSIXQUARE features rely on external services such as YouTube and Cloudflare.',
      'section.external.p2':
        'Features may be limited, delayed, or unavailable if those services change, fail, restrict access, or apply their own policies.',

      'section.quality.title': '5. Service Quality',
      'section.quality.p1':
        'Real-time audio sync and remote sharing quality can vary greatly depending on network conditions, browser policy, device performance, and operating system behavior.',
      'section.quality.p2': 'Mobile data charges may apply when MUSIXQUARE is used outside Wi-Fi.',

      'section.prohibited.title': '6. Prohibited Use',
      'section.prohibited.p1':
        'Users must not use MUSIXQUARE for illegal distribution, infringement, abusive traffic, unauthorized access, service disruption, or attempts to bypass technical safeguards.',

      'section.changes.title': '7. Changes',
      'section.changes.p1':
        'MUSIXQUARE may change, limit, suspend, or discontinue features when needed for service operation, security, infrastructure, or external-service changes.',
      'section.changes.p2': 'These Terms of Use may be updated as the service changes.',

      'section.contact.title': '8. Contact',
      'section.contact.p1':
        'For questions about these terms, contact <a href="mailto:contact@musixquare.com" data-copy-email="contact@musixquare.com">contact@musixquare.com</a>.',
    },
    ko: {
      'meta.title': '이용 및 책임 안내 · MUSIXQUARE',
      'meta.description':
        'MUSIXQUARE의 콘텐츠 공유, 원격 공유, 외부 서비스, 서비스 한계에 대한 이용 및 책임 안내입니다.',
      'meta.og_title': '이용 및 책임 안내 · MUSIXQUARE',
      'meta.og_description': 'MUSIXQUARE의 공유, 동기화, 외부 서비스 이용에 대한 안내입니다.',
      'meta.tw_title': '이용 및 책임 안내 · MUSIXQUARE',
      'meta.tw_description': 'MUSIXQUARE 이용 및 책임 안내입니다.',

      'header.logo_aria': 'MUSIXQUARE 홈',
      'header.app': 'App',
      'hero.title': '이용 및 책임 안내',
      'hero.date': '시행일: 2026년 5월 5일',

      'section.general.title': '1. 총칙',
      'section.general.p1':
        'MUSIXQUARE는 실시간 오디오 동기화, 공유 재생, 원격 공유, 기기 간 소통을 제공하는 무료 웹 기반 서비스입니다.',
      'section.general.p2': 'MUSIXQUARE를 사용하는 사용자는 서비스를 적법하고 책임 있게 이용해야 합니다.',

      'section.content.title': '2. 콘텐츠와 저작권',
      'section.content.p1':
        'MUSIXQUARE를 통해 공유되는 음악, 영상, 파일 등 콘텐츠의 권리는 해당 권리자에게 있습니다.',
      'section.content.p2':
        '시스템 오디오 공유 및 파일 공유 기능은 개인적인 이용을 위한 것입니다. 저작권이 있는 콘텐츠의 무단 배포, 공개 송신, 기타 권리 침해에 대한 책임은 사용자에게 있습니다.',
      'section.content.p3':
        'YouTube 공유는 YouTube의 공식 재생 구조를 사용합니다. 조회 및 권리 처리는 YouTube 정책과 권리자 설정을 따릅니다.',

      'section.remote.title': '3. 원격 공유',
      'section.remote.p1':
        '원격 파일 공유와 원격 시스템 오디오 공유는 기능 제공을 위해 실제 데이터가 Cloudflare를 경유할 수 있습니다.',
      'section.remote.p2':
        '사용자는 공유할 권리가 없는 콘텐츠, 법령이나 타인의 권리 또는 안전을 침해하는 콘텐츠를 공유해서는 안 됩니다.',

      'section.external.title': '4. 외부 서비스',
      'section.external.p1': 'MUSIXQUARE의 일부 기능은 YouTube와 Cloudflare 같은 외부 서비스에 의존합니다.',
      'section.external.p2':
        '해당 서비스의 변경, 장애, 접근 제한, 자체 정책 적용에 따라 일부 기능이 제한되거나 지연되거나 사용할 수 없게 될 수 있습니다.',

      'section.quality.title': '5. 서비스 품질',
      'section.quality.p1':
        '실시간 오디오 동기화와 원격 공유 품질은 네트워크 환경, 브라우저 정책, 기기 성능, 운영체제 동작에 따라 크게 달라질 수 있습니다.',
      'section.quality.p2': 'Wi-Fi가 아닌 환경에서 MUSIXQUARE를 사용할 경우 모바일 데이터 요금이 발생할 수 있습니다.',

      'section.prohibited.title': '6. 금지 행위',
      'section.prohibited.p1':
        '사용자는 불법 배포, 권리 침해, 악의적 트래픽, 무단 접근, 서비스 방해, 기술적 보호 조치 우회 시도에 MUSIXQUARE를 사용해서는 안 됩니다.',

      'section.changes.title': '7. 변경',
      'section.changes.p1':
        'MUSIXQUARE는 서비스 운영, 보안, 인프라, 외부 서비스 변경을 위해 필요한 경우 기능을 변경, 제한, 중단 또는 종료할 수 있습니다.',
      'section.changes.p2': '본 이용 및 책임 안내는 서비스 변경에 따라 수정될 수 있습니다.',

      'section.contact.title': '8. 문의',
      'section.contact.p1':
        '이 안내와 관련한 문의는 <a href="mailto:contact@musixquare.com" data-copy-email="contact@musixquare.com">contact@musixquare.com</a>으로 연락할 수 있습니다.',
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
    window.__termsLang = lang;

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

  applyLang(window.__termsLang || 'en');
})();
