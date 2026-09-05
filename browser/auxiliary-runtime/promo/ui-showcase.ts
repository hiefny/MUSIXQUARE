type ClipDirection = 'wlr' | 'wrl' | 'wtb' | 'wbt' | 'wdiag';
type TabName = 'play' | 'playlist' | 'connect' | 'settings' | 'guide';

interface WordmarkElementData {
  readonly el: HTMLElement;
  readonly wt: number;
  readonly wd: number;
  readonly dir: ClipDirection;
}

declare global {
  interface Window {
    appReady?: boolean;
  }
}

function requiredIframe(): HTMLIFrameElement {
  const element = document.getElementById('app-frame');
  if (!(element instanceof HTMLIFrameElement)) throw new Error('Missing #app-frame iframe.');
  return element;
}

function requiredPromoElement(id: string): HTMLElement | SVGElement {
  const element: Element | null = document.getElementById(id);
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
    throw new Error(`Missing promo element #${id}.`);
  }
  return element;
}

const iframe = requiredIframe();
let appDoc: Document | null = null;
window.appReady = false;

function tryInit(): boolean {
  try {
    const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
    if (!doc || !doc.body || doc.body.children.length < 5) return false;
    appDoc = doc;
    setupApp();
    window.appReady = true;
    return true;
  } catch {
    return false;
  }
}
if (!tryInit()) {
  iframe.addEventListener('load', () => tryInit());
  const poll = setInterval(() => {
    if (tryInit()) clearInterval(poll);
  }, 200);
}

// ─── Easing ───
function smooth(t: number): number {
  return 1 - Math.pow(1 - t, 4.5);
}
function ease(t: number): number {
  return 1 - Math.pow(1 - t, 2.5);
}

// ─── Logo animation data ───
const wlData: WordmarkElementData[] = [];
document.querySelectorAll<HTMLElement>('.wl').forEach((el) => {
  const style = el.style;
  const wt = parseFloat(style.getPropertyValue('--wt')) || 0;
  const wd = parseFloat(style.getPropertyValue('--wd')) || 150;
  let dir: ClipDirection = 'wlr';
  if (el.classList.contains('wrl')) dir = 'wrl';
  if (el.classList.contains('wtb')) dir = 'wtb';
  if (el.classList.contains('wbt')) dir = 'wbt';
  if (el.classList.contains('wdiag')) dir = 'wdiag';
  wlData.push({ el, wt, wd, dir });
});

function setClipPath(el: HTMLElement, dir: ClipDirection, progress: number): void {
  const p = ease(progress);
  const remain = (1 - p) * 100;
  switch (dir) {
    case 'wlr':
      el.style.clipPath = `inset(0 ${remain}% 0 0)`;
      break;
    case 'wrl':
      el.style.clipPath = `inset(0 0 0 ${remain}%)`;
      break;
    case 'wtb':
      el.style.clipPath = `inset(0 0 ${remain}% 0)`;
      break;
    case 'wbt':
      el.style.clipPath = `inset(${remain}% 0 0 0)`;
      break;
    case 'wdiag':
      el.style.clipPath = `inset(0 ${remain}% ${remain}% 0)`;
      break;
  }
}

// ─── Cached refs ───
const revealEls: Record<string, HTMLElement> = {};
let currentTab: TabName = 'play';
let currentSetupSection = '';

// (taglineEntries moved after timeline constants)

// ─── Setup ───
function setupApp(): void {
  const doc = appDoc;
  if (!doc) return;

  const fouc = doc.getElementById('fouc-guard');
  if (fouc) fouc.remove();
  doc.documentElement.setAttribute('data-theme', 'light');

  const overlay = doc.getElementById('setup-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
    overlay.style.opacity = '1';
    overlay.classList.add('active');
  }

  ['setup-code-area', 'setup-join-area', 'setup-role-area'].forEach((id) => {
    const el = doc.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const setupWelcome = doc.getElementById('setup-welcome-area');
  if (setupWelcome) {
    setupWelcome.style.display = 'flex';
    setupWelcome.style.flexDirection = 'column';
    setupWelcome.style.flex = '1';
  }

  // Activate first slider slide so content is visible (CSS: .ob-slide children have opacity:0, .ob-slide.active makes them opacity:1)
  // Also force inline opacity since CSS transitions are cancelled by Playwright
  const allSlides = doc.querySelectorAll<HTMLElement>('.ob-slide');
  if (allSlides.length > 0) {
    allSlides[0].classList.add('active');
    allSlides[0]
      .querySelectorAll<HTMLElement>('.ob-title, .ob-desc, .ob-icon-circle')
      .forEach((el) => (el.style.opacity = '1'));
  }

  const setupCodeInput = doc.querySelector<HTMLInputElement>('input#setup-code');
  if (setupCodeInput) setupCodeInput.value = '482937';

  // Setup action buttons — VERTICAL layout matching real mobile app (ob-actions.vertical)
  const setupActions = doc.getElementById('setup-actions');
  if (setupActions) {
    setupActions.classList.add('vertical');
    setupActions.innerHTML = `
      <button class="btn-ob-primary" id="btn-setup-host">제가 방장할래요</button>
      <button class="btn-ob-secondary" id="btn-setup-guest">모임에 참여할래요</button>
    `;
  }

  // HOST badge — blue
  const roleBadge = doc.getElementById('role-badge');
  if (roleBadge) {
    const roleText = doc.getElementById('role-text');
    if (roleText) roleText.textContent = 'HOST';
    roleBadge.style.background = '#3b82f6';
    roleBadge.style.color = '#ffffff';
    roleBadge.classList.add('connected');
    if (roleText) roleText.style.color = '#ffffff';
  }

  // Track info
  const tt = doc.getElementById('track-title');
  if (tt) tt.textContent = 'Sunset Boulevard';
  const ta = doc.getElementById('track-artist');
  if (ta) ta.textContent = 'Luna & The Stars';
  const ss = doc.querySelector<HTMLInputElement>('input#seek-slider');
  if (ss) {
    ss.max = '225';
    ss.value = '83';
  }
  const tc = doc.getElementById('time-curr');
  if (tc) tc.textContent = '1:23';
  const td = doc.getElementById('time-dur');
  if (td) td.textContent = '3:45';
  const vs = doc.querySelector<HTMLInputElement>('input#volume-slider');
  if (vs) vs.value = '80';

  // Playlist
  const pul = doc.getElementById('playlist-ui');
  if (pul) {
    pul.innerHTML = '';
    [
      { name: 'Sunset Boulevard', active: true },
      { name: 'Midnight in Seoul', active: false },
      { name: 'Ocean Drive (feat. Luna)', active: false },
      { name: 'Golden Hour', active: false },
    ].forEach((t, i) => {
      const li = doc.createElement('li');
      li.className = 'track-item' + (t.active ? ' active' : '');
      li.innerHTML = `<span class="track-idx">${i + 1}</span><div class="track-name"><span class="track-name-text">${t.name}</span></div>${t.active ? '<div class="playing-indicator" style="display:flex; margin-left:auto; flex-shrink:0;"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>' : ''}`;
      li.style.opacity = '0';
      li.style.transform = 'translateY(16px)';
      pul.appendChild(li);
    });
  }

  // Mobile settings: show general + audio panels stacked
  doc.querySelectorAll<HTMLElement>('.settings-subtab-panel').forEach((p) => {
    const panel = p.dataset.panel;
    if (panel === 'general' || panel === 'audio') {
      p.style.display = 'block';
    } else {
      p.style.display = 'none';
    }
  });

  doc
    .querySelectorAll<HTMLElement>('.invite-code-value')
    .forEach((el) => (el.textContent = '482937'));
  const dt = doc.getElementById('connect-device-title');
  if (dt) dt.textContent = '연결된 기기 2대';

  const cd = doc.getElementById('chat-drawer');
  if (cd) cd.style.display = 'none';

  // i18n
  const i18nMap: Record<string, string> = {
    'nav.home': '메인',
    'nav.playlist': '재생목록',
    'nav.connect': '연결',
    'nav.settings': '설정',
    'nav.help': '도움말',
    'chat.start': '채팅을 시작하세요',
    'common.sync': '동기화',
    'player.play_media': '미디어 재생',
    'settings.invite_code': '초대 코드',
    'connect.qr_title': 'QR 코드로 참가',
    'settings.leave_session': '이 세션 나가기',
    'settings.subtab.general': '일반',
    'settings.subtab.audio': '오디오',
    'settings.subtab.connect': '연결',
    'settings.subtab.help': '도움말',
    'settings.language': '언어',
    'settings.theme': '테마',
    'settings.theme_light': '라이트',
    'settings.battery_saving': '배터리 절약 모드',
    'settings.speaker_role': '스피커 역할',
    'settings.speaker_role_stereo': '스테레오',
    'settings.reverb': '리버브',
    'settings.reverb_none': '없음',
    'settings.eq': '이퀄라이저',
    'player.visualizer': '비주얼라이저',
    'player.visualizer_circular': '원형',
    'player.visualizer_spectrum': '스펙트럼',
    'player.visualizer_mode_hint': '음향 시각화 방식을 선택할 수 있어요.',
    'setup.hello_select_role': '안녕하세요! 본인의 역할을 선택해주세요.',
    'setup.last_step': '마지막 단계!',
    'setup.connect_devices': '이제 다른 기기들과 연결해주세요.',
    'setup.enter_code_connect': '이 코드를 다른 기기에 입력해주세요',
    'setup.enter_host_code': '방장이 알려준 6자리 코드를 입력해주세요',
    'setup.what_sound': '어떤 소리를 맡을까요?',
    'setup.change_later': '나중에 설정에서 변경할 수 있어요',
    'setup.demo_button': '앱 체험하기',
    'role.left': '왼쪽',
    'role.right': '오른쪽',
    'role.subwoofer': '서브우퍼',
    'role.center': '센터',
    'help.local_recommended': '로컬 네트워크 권장',
    'setup.how_to_connect': '어떻게 연결하나요?',
    'player.play_speakers': '스피커로 재생하기',
    'player.play_media_action': '미디어 재생하기',
    'help.need_help': '도움이 필요할 때',
    'settings.invite_share': '초대와 공유',
    'player.play_together': '동시에 재생',
    'settings.spatial_audio': '입체 음향',
    'settings.advanced_audio': '고급 음향',
    'settings.reverb_title': '리버브',
    'setup.set_role': '이 기기 역할 설정하기',
    'settings.self_ctrl': '직접 제어',
  };
  doc.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key && i18nMap[key]) el.textContent = i18nMap[key];
  });

  // data-i18n-html
  const i18nHtmlMap: Record<string, string> = {
    'help.local_recommended_html':
      '동일한 네트워크에 연결하면 모든 기능을 이용할 수 있어요.<ul class="help-list"><li>모든 기기를 <strong>동일한 Wi\u2011Fi</strong>에 연결해주세요.</li><li>VPN/사내 보안망이 켜져 있으면 연결이 안 될 수 있어요.</li><li>연결이 안 되면 호스트의 핫스팟에 연결 후 앱을 새로고침해주세요.</li></ul>',
    'setup.how_to_connect_html':
      '방장이 알려주는 <strong>6자리 코드</strong>를 입력해 연결해요.<ul class="help-list"><li><strong>방장:</strong> \u201C제가 방장할래요\u201D \u2192 코드 확인 \u2192 \u201C시작할래요!\u201D</li><li><strong>참가자:</strong> \u201C모임에 참여할래요\u201D \u2192 코드 입력 \u2192 역할 선택(원본/왼쪽/오른쪽/저음)</li><li>방장 포함, 연결할 수 있는 기기 수는 <strong>최대 100대예요</strong>.</li></ul>',
    'player.play_speakers_html':
      '참가자가 <strong>역할(출력 채널)</strong>을 선택해요.<ul class="help-list"><li><strong>중앙 스피커:</strong> 스테레오(기본) 출력</li><li><strong>왼쪽 스피커:</strong> L 채널 출력</li><li><strong>오른쪽 스피커:</strong> R 채널 출력</li><li><strong>서브우퍼:</strong> 저역 믹스 출력</li></ul>필요하면 <strong>설정</strong>에서 역할을 언제든 바꿀 수 있어요.',
    'player.play_media_action_html':
      '방장에게는 3가지 선택지가 나와요.<ul class="help-list"><li><strong>로컬파일 불러오기:</strong> 기기 파일에서 음악/영상을 선택</li><li><strong>유튜브(채널분리 미지원):</strong> 링크를 붙여넣어 재생 목록에 추가</li><li><strong>앱 체험하기:</strong> 데모 미디어로 프로그램 테스트</li></ul>',
    'help.need_help_html':
      '<ul class="help-list"><li><strong>코드를 입력했는데 연결이 안 돼요:</strong> 서버 오류일 수 있어요. 이런 경우 두 기기를 같은 네트워크에 연결해주세요.</li><li><strong>연결이 불안정해요:</strong> 네트워크 품질이 낮을 수 있어요. 공유기 가까이로 이동해 보세요.</li><li><strong>데모 트랙 정보:</strong> AI Generated Music</li><li><strong>기타 문의:</strong> contact@musixquare.com</li></ul>',
    'setup.brand_tagline_html': '언제 어디서나 함께 듣는<br>완벽한 사운드 경험',
    'setup.invite_share_desc_html':
      '여러 기기를 무선으로 연결해<br>거대한 오디오 시스템을 만들어 보세요.<br>6자리 숫자 코드로 연결할 수 있어요.',
    'setup.play_together_desc_html':
      '호스트가 미디어를 재생하면<br>연결된 모든 기기에서 동시에 재생돼요.<br>동기화 버튼을 눌러서 싱크를 맞춰보세요.',
    'setup.spatial_audio_desc_html':
      '각 기기의 역할을 설정해 보세요.<br>왼쪽, 오른쪽 소리를 따로 재생하고<br>우퍼 모드로 웅장한 저음을 느껴보세요.',
    'setup.advanced_audio_desc_html':
      '호스트의 설정에 맞추어<br>리버브, 이퀄라이저, 가상 효과 등<br>고급 효과를 시스템에 적용할 수 있어요.',
  };
  doc.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    if (key && i18nHtmlMap[key]) el.innerHTML = i18nHtmlMap[key];
  });

  // QR code
  const qrContainer = doc.getElementById('qr-container');
  if (qrContainer) {
    qrContainer.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" class="qr-svg" width="200" height="200" viewBox="0 0 27 27" shape-rendering="crispEdges"><path stroke="#212529" d="M1 1.5h7m4 0h3m2 0h1m1 0h7M1 2.5h1m5 0h1m3 0h1m1 0h1m2 0h1m2 0h1m5 0h1M1 3.5h1m1 0h3m1 0h1m1 0h2m1 0h2m1 0h3m1 0h1m1 0h3m1 0h1M1 4.5h1m1 0h3m1 0h1m1 0h7m3 0h1m1 0h3m1 0h1M1 5.5h1m1 0h3m1 0h1m1 0h1m7 0h1m1 0h1m1 0h3m1 0h1M1 6.5h1m5 0h1m1 0h1m4 0h3m2 0h1m5 0h1M1 7.5h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7M9 8.5h1m1 0h1m4 0h2M1 9.5h1m1 0h5m4 0h6m1 0h5M1 10.5h1m1 0h1m1 0h1m2 0h1m3 0h4m1 0h2m1 0h1m3 0h1M1 11.5h1m3 0h1m1 0h2m1 0h1m5 0h2m2 0h1m1 0h1m1 0h2M1 12.5h1m3 0h1m2 0h1m1 0h3m2 0h3m1 0h3m3 0h1M1 13.5h3m1 0h1m1 0h1m1 0h2m1 0h1m1 0h1m1 0h1m1 0h2m1 0h1m1 0h3M1 14.5h5m4 0h1m2 0h2m2 0h2m1 0h1m1 0h1m1 0h1M1 15.5h1m2 0h2m1 0h1m2 0h2m2 0h3m2 0h4m1 0h2M1 16.5h1m1 0h1m2 0h1m4 0h1m1 0h1m3 0h5m3 0h1M1 17.5h1m5 0h1m1 0h1m1 0h1m1 0h3m1 0h5m1 0h1M9 18.5h1m1 0h1m4 0h2m3 0h2M1 19.5h7m4 0h2m3 0h1m1 0h1m1 0h1m1 0h3M1 20.5h1m5 0h1m1 0h2m1 0h1m2 0h1m1 0h1m3 0h2m2 0h1M1 21.5h1m1 0h3m1 0h1m1 0h1m1 0h11m1 0h1M1 22.5h1m1 0h3m1 0h1m1 0h2m2 0h1m1 0h5m1 0h5M1 23.5h1m1 0h3m1 0h1m1 0h1m3 0h1m3 0h2m3 0h2m1 0h1M1 24.5h1m5 0h1m3 0h1m1 0h1m2 0h2m1 0h4m2 0h1M1 25.5h7m1 0h1m4 0h3m3 0h6"/></svg>
      <button class="btn-copy-invite-link" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true" style="width:20px;height:20px;fill:currentColor;"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
        <span>초대 링크 복사</span>
      </button>`;
  }

  // Device list
  const dl2 = doc.getElementById('connect-device-list');
  if (dl2) {
    dl2.innerHTML = '';
    [
      { name: 'iPhone 15 Pro', shortId: 'a3b7', isOp: true },
      { name: 'Galaxy S24', shortId: 'e4f2', isOp: false },
    ].forEach((d) => {
      const row = doc.createElement('div');
      row.className = 'device-row';
      row.innerHTML = `<span class="d-dot active"></span><span class="d-name">${d.name} <span class="d-short-id">(${d.shortId})</span>${d.isOp ? '<span class="d-op-badge">OP</span>' : ''}</span>`;
      dl2.appendChild(row);
    });
  }

  // Inject nuclear CSS overrides
  const style = doc.createElement('style');
  style.textContent = `
    * { transition: none !important; animation: none !important; }
    .header-loading-text { display: none !important; }
    #setup-overlay.promo-visible {
      display: flex !important; opacity: 1 !important; visibility: visible !important;
      position: fixed !important; inset: 0 !important; z-index: 9999 !important;
      background: var(--bg, #f8f9fa) !important; pointer-events: auto !important;
    }
    #setup-overlay.promo-visible .onboarding-card,
    #setup-overlay.promo-visible .setup-mobile-view {
      display: flex !important; visibility: visible !important; opacity: 1 !important;
    }
    #setup-overlay.promo-hidden { display: none !important; }
    .settings-subtab-nav { display: none !important; }
  `;
  doc.head.appendChild(style);

  // Cache reveal-target elements
  const revealSelectors = [
    '#main-header',
    '.vinyl-wrapper',
    '.track-box',
    '.progress-bar',
    '.play-controls-left',
    '.chat-preview-btn',
    '.play-action-buttons',
    '.bottom-nav',
  ];
  revealSelectors.forEach((sel) => {
    const el = doc.querySelector<HTMLElement>(sel);
    if (el) {
      el.style.opacity = '0';
      el.style.transform = sel === '#main-header' ? 'translateY(-30px)' : 'translateY(18px)';
      revealEls[sel] = el;
    }
  });

  switchTab('play', true);
}

function switchTab(tabName: TabName, force = false): void {
  const doc = appDoc;
  if (!doc) return;
  if (tabName === currentTab && !force) return;
  currentTab = tabName;
  doc.querySelectorAll<HTMLElement>('.tab-content').forEach((t) => {
    t.classList.remove('active');
    t.style.display = 'none';
    t.style.opacity = '0';
    t.style.transform = 'translateX(0)';
  });
  const target = doc.getElementById('tab-' + tabName);
  if (target) {
    target.style.display = '';
    target.classList.add('active');
    if (force) {
      target.style.opacity = '1';
      target.style.transform = 'translateX(0)';
    }
    if (!force && (tabName === 'connect' || tabName === 'settings' || tabName === 'guide')) {
      target
        .querySelectorAll<HTMLElement>('.tab-header, .section-group, .help-block')
        .forEach((el) => {
          el.style.opacity = '0';
          el.style.transform = 'translateY(22px)';
        });
    }
    // Settings: reset scroll to top on tab switch
    if (tabName === 'settings') {
      const tabBody = target.querySelector<HTMLElement>('.tab-body');
      if (tabBody) tabBody.scrollTop = 0;
    }
  }
  const navMap: Record<TabName, string> = {
    play: 'nav-play',
    playlist: 'nav-playlist',
    connect: 'nav-connect',
    settings: 'nav-settings',
    guide: 'nav-guide',
  };
  doc.querySelectorAll<HTMLElement>('.nav-item').forEach((n) => n.classList.remove('active'));
  const nEl = doc.getElementById(navMap[tabName]);
  if (nEl) nEl.classList.add('active');
}

function showSetupSection(sectionName: string): void {
  const doc = appDoc;
  if (!doc) return;
  if (currentSetupSection === sectionName) return;
  currentSetupSection = sectionName;
  ['setup-welcome-area', 'setup-code-area', 'setup-join-area', 'setup-role-area'].forEach((id) => {
    const el = doc.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const target = doc.getElementById(sectionName);
  if (target) {
    target.style.display = 'flex';
    target.style.width = '100%';
    target.style.flexDirection = 'column';
    target.style.flex = '1';
  }
  // Update buttons per section (matching real app flow)
  const setupActions = doc.getElementById('setup-actions');
  if (!setupActions) return;
  const BACK_SVG =
    '<svg viewBox="0 0 24 24" style="width:24px;height:24px;fill:currentColor"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>';
  if (sectionName === 'setup-welcome-area') {
    setupActions.className = 'ob-actions vertical';
    setupActions.innerHTML = `
      <button class="btn-ob-primary">제가 방장할래요</button>
      <button class="btn-ob-secondary">모임에 참여할래요</button>`;
  } else if (sectionName === 'setup-role-area') {
    setupActions.className = 'ob-actions horizontal-with-back';
    setupActions.innerHTML = `
      <button class="btn-ob-icon">${BACK_SVG}</button>
      <button class="btn-ob-primary">다음으로</button>`;
  } else if (sectionName === 'setup-code-area') {
    setupActions.className = 'ob-actions horizontal-with-back';
    setupActions.innerHTML = `
      <button class="btn-ob-icon">${BACK_SVG}</button>
      <button class="btn-ob-primary">시작하기</button>`;
  }
}

function clearAppEntranceClasses(): void {
  const doc = appDoc;
  if (!doc) return;
  doc
    .querySelectorAll<HTMLElement>('.app-entrance, .app-entered, .app-chat-entrance')
    .forEach((el) => {
      el.classList.remove(
        'app-entrance',
        'app-entrance-down',
        'app-entrance-up',
        'app-entrance-left',
        'app-entrance-right',
        'app-entered',
        'app-chat-entrance',
      );
      el.style.removeProperty('--entrance-delay');
    });
}

// ─── Timeline constants ───
// Phase A: Logo animation (note + MUSIXQUARE appear together)
const NOTE_APPEAR = 200;
const NOTE_DRAW_START = 300,
  NOTE_DRAW_END = 2000; // Slower — finishes with typo
const NOTE_FILL_START = 1600,
  NOTE_FILL_END = 2200;
const LOGO_WRITE_START = 400; // Simultaneous with note!
const GHOST_TIME = 1200;
const _TAGLINE_START = 3200;
const TRANSITION_START = 5000,
  TRANSITION_END = 7000;

// Phase C-I timeline — keep captions and UI phases on the same clock.
const REVEAL_DUR = 800;
const TAB_DUR = 600;
const STAGGER = 130;
const EL_DUR = 650;
const FADEOUT_DUR = 400; // fade-out before tab switch
const HOLD = 1900; // time to hold a completed tab before fading out
const SETUP_START = TRANSITION_END;
const SETUP_END = 13000;
const SETUP_FADE_START = SETUP_END - 500;
const CONTENT_LEAD = 0;

// Phase D: Player reveals under the setup fade so the app is not blank at handoff.
const D_START = SETUP_FADE_START + 100;
const D_VISIBLE_START = SETUP_END;
const D_LAST = D_START + STAGGER * 7;
const D_END_ANIM = D_LAST + REVEAL_DUR;
const D_FADEOUT = D_END_ANIM + HOLD;

// Phase E: Playlist
const E_START = D_FADEOUT + FADEOUT_DUR;
const E_LAST = E_START + CONTENT_LEAD + STAGGER * 3;
const E_END_ANIM = E_LAST + EL_DUR;
const E_FADEOUT = E_END_ANIM + HOLD;

// Phase F: Connect
const F_START = E_FADEOUT + FADEOUT_DUR;
const F_LAST = F_START + CONTENT_LEAD + STAGGER * 3;
const F_END_ANIM = F_LAST + EL_DUR;
const F_FADEOUT = F_END_ANIM + HOLD;

// Phase G: Settings
const G_START = F_FADEOUT + FADEOUT_DUR;
const G_LAST = G_START + CONTENT_LEAD + STAGGER * 5;
const G_END_ANIM = G_LAST + EL_DUR;
const G_SCROLL_START = G_END_ANIM + 500; // pause then scroll
const G_SCROLL_END = G_SCROLL_START + 1500;
const G_FADEOUT = G_SCROLL_END + 800;

// Phase H: Guide
const H_START = G_FADEOUT + FADEOUT_DUR;
const H_LAST = H_START + CONTENT_LEAD + STAGGER * 5;
const _H_END_ANIM = H_LAST + EL_DUR;

interface TimedEntry {
  readonly t: number;
  readonly dur: number;
}

type AppEntry =
  | (TimedEntry & { readonly type: 'reveal'; readonly sel: string; readonly fromTop?: boolean })
  | (TimedEntry & { readonly type: 'reveal-track'; readonly idx: number })
  | (TimedEntry & {
      readonly type: 'reveal-el';
      readonly sel: string;
      readonly parent: string;
      readonly nth?: number;
    })
  | (TimedEntry & { readonly type: 'tab'; readonly tab: TabName; _switched?: boolean });

const appEntries: AppEntry[] = [
  // Phase D: Player
  { t: D_START, dur: REVEAL_DUR, type: 'reveal', sel: '#main-header', fromTop: true },
  { t: D_START + STAGGER * 1, dur: REVEAL_DUR, type: 'reveal', sel: '.vinyl-wrapper' },
  { t: D_START + STAGGER * 2, dur: REVEAL_DUR, type: 'reveal', sel: '.track-box' },
  { t: D_START + STAGGER * 3, dur: REVEAL_DUR, type: 'reveal', sel: '.progress-bar' },
  { t: D_START + STAGGER * 4, dur: REVEAL_DUR, type: 'reveal', sel: '.play-controls-left' },
  { t: D_START + STAGGER * 5, dur: REVEAL_DUR, type: 'reveal', sel: '.chat-preview-btn' },
  { t: D_START + STAGGER * 6, dur: REVEAL_DUR, type: 'reveal', sel: '.play-action-buttons' },
  { t: D_START + STAGGER * 7, dur: REVEAL_DUR, type: 'reveal', sel: '.bottom-nav' },

  // Phase E: Playlist
  { t: E_START, dur: TAB_DUR, type: 'tab', tab: 'playlist' },
  { t: E_START + CONTENT_LEAD, dur: EL_DUR, type: 'reveal-track', idx: 0 },
  { t: E_START + CONTENT_LEAD + STAGGER * 1, dur: EL_DUR, type: 'reveal-track', idx: 1 },
  { t: E_START + CONTENT_LEAD + STAGGER * 2, dur: EL_DUR, type: 'reveal-track', idx: 2 },
  { t: E_START + CONTENT_LEAD + STAGGER * 3, dur: EL_DUR, type: 'reveal-track', idx: 3 },

  // Phase F: Connect
  { t: F_START, dur: TAB_DUR, type: 'tab', tab: 'connect' },
  {
    t: F_START + CONTENT_LEAD,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.tab-header',
    parent: 'tab-connect',
  },
  {
    t: F_START + CONTENT_LEAD + STAGGER * 1,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.section-group',
    parent: 'tab-connect',
    nth: 0,
  },
  {
    t: F_START + CONTENT_LEAD + STAGGER * 2,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.section-group',
    parent: 'tab-connect',
    nth: 1,
  },
  {
    t: F_START + CONTENT_LEAD + STAGGER * 3,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.section-group',
    parent: 'tab-connect',
    nth: 2,
  },

  // Phase G: Settings
  { t: G_START, dur: TAB_DUR, type: 'tab', tab: 'settings' },
  {
    t: G_START + CONTENT_LEAD,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.tab-header',
    parent: 'tab-settings',
  },
  {
    t: G_START + CONTENT_LEAD + STAGGER * 1,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.section-group',
    parent: 'tab-settings',
    nth: 0,
  },
  {
    t: G_START + CONTENT_LEAD + STAGGER * 2,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.section-group',
    parent: 'tab-settings',
    nth: 1,
  },
  {
    t: G_START + CONTENT_LEAD + STAGGER * 3,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.section-group',
    parent: 'tab-settings',
    nth: 2,
  },
  {
    t: G_START + CONTENT_LEAD + STAGGER * 4,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.section-group',
    parent: 'tab-settings',
    nth: 3,
  },
  {
    t: G_START + CONTENT_LEAD + STAGGER * 5,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.section-group',
    parent: 'tab-settings',
    nth: 4,
  },

  // Phase H: Guide
  { t: H_START, dur: TAB_DUR, type: 'tab', tab: 'guide' },
  {
    t: H_START + CONTENT_LEAD,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.tab-header',
    parent: 'tab-guide',
  },
  {
    t: H_START + CONTENT_LEAD + STAGGER * 1,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.help-block',
    parent: 'tab-guide',
    nth: 0,
  },
  {
    t: H_START + CONTENT_LEAD + STAGGER * 2,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.help-block',
    parent: 'tab-guide',
    nth: 1,
  },
  {
    t: H_START + CONTENT_LEAD + STAGGER * 3,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.help-block',
    parent: 'tab-guide',
    nth: 2,
  },
  {
    t: H_START + CONTENT_LEAD + STAGGER * 4,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.help-block',
    parent: 'tab-guide',
    nth: 3,
  },
  {
    t: H_START + CONTENT_LEAD + STAGGER * 5,
    dur: EL_DUR,
    type: 'reveal-el',
    sel: '.help-block',
    parent: 'tab-guide',
    nth: 4,
  },
];

// ─── Tagline entries (must be after timeline constants) ───
const taglineEntries = [
  { start: 6000, end: D_VISIBLE_START, text: '3초면 연결 완료!' },
  { start: D_VISIBLE_START, end: E_START, text: '같은 음악으로 함께' },
  { start: E_START, end: F_START, text: '재생목록도 실시간 공유' },
  { start: F_START, end: G_START, text: 'QR 하나로 바로 참가' },
  { start: G_START, end: H_START, text: '내 취향대로 사운드 커스텀' },
  { start: H_START, end: 40000, text: '지금 바로 시작하세요' },
];

// ════════════════════════════════════════════════════════════
//  MAIN TIMELINE
// ════════════════════════════════════════════════════════════
window.__promoSetTime = function (ms: number): void {
  const promoTop = document.getElementById('promo-top');
  const phone = document.getElementById('promo-phone-wrap');
  const noteWrapper = requiredPromoElement('note-wrapper');
  const noteStroke = requiredPromoElement('note-stroke');
  const noteFill = requiredPromoElement('note-fill');
  const ghost = document.querySelector<HTMLElement>('.wg');
  const tagline = requiredPromoElement('promo-tagline');
  const logoSvg = document.getElementById('logo-svg');

  // ═══ PHASE A: Logo (0-5s) — Note + MUSIXQUARE appear simultaneously ═══
  if (ms < TRANSITION_START) {
    if (promoTop) {
      promoTop.style.left = '50%';
      promoTop.style.top = '50%';
      promoTop.style.transform = 'translate(-50%, -50%) scale(1)';
      promoTop.style.opacity = '1';
    }
    if (phone) phone.style.opacity = '0';
    if (logoSvg) logoSvg.style.opacity = '1';

    // Note icon — appear + scale
    if (ms >= NOTE_APPEAR) {
      const p = Math.min((ms - NOTE_APPEAR) / 400, 1);
      const ep = smooth(p);
      noteWrapper.style.opacity = String(ep);
      noteWrapper.style.transform = `scale(${0.5 + 0.5 * ep})`;
    }
    // Note stroke draw (inside stroke via clip-path)
    if (ms >= NOTE_DRAW_START) {
      const p = Math.min((ms - NOTE_DRAW_START) / (NOTE_DRAW_END - NOTE_DRAW_START), 1);
      noteStroke.style.strokeDashoffset = String(60 * (1 - smooth(p)));
      noteStroke.style.opacity = '1';
    }
    // Note fill
    if (ms >= NOTE_FILL_START) {
      const p = Math.min((ms - NOTE_FILL_START) / (NOTE_FILL_END - NOTE_FILL_START), 1);
      noteFill.style.opacity = String(p);
    }
    // Ghost letters
    if (ms >= GHOST_TIME && ghost) {
      ghost.style.opacity = String(0.15 * Math.min((ms - GHOST_TIME) / 300, 1));
    }
    // Logo clip-path writing — starts at 400ms (simultaneous with note draw)
    wlData.forEach(({ el, wt, wd, dir }) => {
      const st = LOGO_WRITE_START + wt;
      if (ms < st) return;
      setClipPath(el, dir, Math.min((ms - st) / wd, 1));
    });
    // Phase A intentionally presents the wordmark without a tagline.
    tagline.style.opacity = '0';
    return;
  }

  // ═══ PHASE B: Transition (5-7s) — logo fades out in place, tagline appears at top ═══
  if (ms < TRANSITION_END) {
    const t = (ms - TRANSITION_START) / (TRANSITION_END - TRANSITION_START);

    if (promoTop) {
      // First half: logo fades out at center
      // Second half: promoTop jumps to top position for tagline
      if (t < 0.5) {
        promoTop.style.top = '50%';
        promoTop.style.transform = 'translate(-50%, -50%) scale(1)';
        const fadeOut = smooth(t / 0.5);
        promoTop.style.opacity = String(1 - fadeOut);
      } else {
        promoTop.style.top = '7%';
        promoTop.style.transform = 'translate(-50%, -50%) scale(1)';
        promoTop.style.opacity = '1';
      }
    }

    // Fade out the note and logo.
    const fadeOutP = smooth(Math.min(t / 0.4, 1));
    noteWrapper.style.opacity = String(1 - fadeOutP);
    if (logoSvg) logoSvg.style.opacity = String(1 - fadeOutP);

    // After fade out, show tagline at top position
    if (t >= 0.5) {
      if (logoSvg) logoSvg.style.opacity = '0';
      tagline.textContent = taglineEntries[0].text;
      const fadeIn = smooth((t - 0.5) / 0.5);
      tagline.style.opacity = String(fadeIn);
      tagline.style.transform = `translateY(${10 * (1 - fadeIn)}px)`;
    } else {
      tagline.style.opacity = '0';
    }

    if (phone) phone.style.opacity = String(smooth(Math.max(0, (t - 0.3) / 0.7)));
    return;
  }

  // ═══ PHASE C-I: After transition (7s+) ═══
  if (promoTop) {
    promoTop.style.top = '7%';
    promoTop.style.transform = 'translate(-50%, -50%) scale(1)';
    promoTop.style.opacity = '1';
  }
  if (logoSvg) logoSvg.style.opacity = '0';
  noteWrapper.style.opacity = '0';
  if (phone) phone.style.opacity = '1';

  // ── Dynamic tagline ──
  const FADE_DUR = 500;
  let activeTagline = null;
  for (const entry of taglineEntries) {
    if (ms >= entry.start && ms < entry.end) {
      activeTagline = entry;
      break;
    }
  }
  if (activeTagline) {
    tagline.textContent = activeTagline.text;
    const fadeInP = Math.min((ms - activeTagline.start) / FADE_DUR, 1);
    const timeToEnd = activeTagline.end - ms;
    const fadeOutP = timeToEnd < FADE_DUR ? timeToEnd / FADE_DUR : 1;
    const opacity = Math.min(smooth(fadeInP), fadeOutP);
    tagline.style.opacity = String(opacity);
    tagline.style.transform = `translateY(${14 * (1 - smooth(fadeInP))}px)`;
  } else {
    tagline.style.opacity = '0';
  }

  if (!window.appReady || !appDoc) return;
  const doc = appDoc;

  // ═══ Phase C: Setup overlay (7-13s) ═══
  const overlay = doc.getElementById('setup-overlay');
  if (ms < SETUP_END) {
    if (overlay) {
      overlay.classList.add('promo-visible', 'active');
      overlay.classList.remove('promo-hidden');
      if (ms > SETUP_FADE_START) {
        overlay.style.opacity = String(
          1 - smooth((ms - SETUP_FADE_START) / (SETUP_END - SETUP_FADE_START)),
        );
      } else {
        overlay.style.opacity = '';
      }
    }
    // Welcome → Role → Code (matching real app flow) with slide transitions
    const SETUP_TRANS = 500; // transition duration
    const setupPhases = [
      { start: SETUP_START, end: 9200, section: 'setup-welcome-area' },
      { start: 9200, end: 11000, section: 'setup-role-area' },
      { start: 11000, end: SETUP_END, section: 'setup-code-area' },
    ];
    for (const sp of setupPhases) {
      if (ms >= sp.start && ms < sp.end) {
        showSetupSection(sp.section);
        const el = doc.getElementById(sp.section);
        if (el) {
          // Fade-in at start of this phase
          const fadeIn = Math.min((ms - sp.start) / SETUP_TRANS, 1);
          const ep = smooth(fadeIn);
          el.style.opacity = String(ep);
          el.style.transform = `translateX(${20 * (1 - ep)}px)`;
          // Fade-out at end of this phase (if not the last before overlay disappears)
          const timeToEnd = sp.end - ms;
          if (timeToEnd < SETUP_TRANS && sp.section !== 'setup-code-area') {
            const fadeOut = timeToEnd / SETUP_TRANS;
            el.style.opacity = String(fadeOut);
          }
        }
        break;
      }
    }
    // Cycle welcome slides: slide 1 (7-8.2s), slide 2 (8.2-9.2s)
    {
      const slides = doc.querySelectorAll<HTMLElement>('.ob-slide');
      const track = doc.getElementById('ob-slider-track');
      if (slides.length > 0 && track) {
        const activateSlide = (idx: number): void => {
          slides.forEach((s, i) => {
            if (i === idx) {
              s.classList.add('active');
              s.querySelectorAll<HTMLElement>('.ob-title, .ob-desc, .ob-icon-circle').forEach(
                (el) => (el.style.opacity = '1'),
              );
            } else {
              s.classList.remove('active');
              s.querySelectorAll<HTMLElement>('.ob-title, .ob-desc, .ob-icon-circle').forEach(
                (el) => (el.style.opacity = '0'),
              );
            }
          });
          const dots = doc.querySelectorAll<HTMLElement>('.ob-dot');
          dots.forEach((d, i) =>
            i === idx ? d.classList.add('active') : d.classList.remove('active'),
          );
        };
        if (ms <= 8200) {
          activateSlide(0);
          track.style.transform = 'translateX(0)';
        } else if (ms > 8200 && ms < 9200) {
          activateSlide(1);
          track.style.transform = 'translateX(-100%)';
        }
      }
    }
    return;
  }

  if (overlay) {
    overlay.classList.remove('promo-visible', 'active');
    overlay.classList.add('promo-hidden');
  }
  clearAppEntranceClasses();

  // ═══ Visualizer ═══
  if (ms >= D_START + 700 && ms < D_FADEOUT + FADEOUT_DUR) {
    const canvas = doc.querySelector<HTMLCanvasElement>('canvas#visualizerCanvas');
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const dpr = 2;
      if (canvas.width !== rect.width * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      const cx = rect.width / 2,
        cy = rect.height / 2;
      const t = (ms - D_START - 700) / 1000;
      const bassPulse =
        Math.sin(t * 1.8) * 0.12 + Math.sin(t * 3.1) * 0.06 + Math.sin(t * 0.7) * 0.04;
      const highPulse = Math.sin(t * 2.5) * 0.1 + Math.sin(t * 4.7) * 0.08;
      const scale = rect.width / 200;
      const bassR = (70 + bassPulse * 80) * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(bassR, cx * 0.88), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.40)';
      ctx.fill();
      const highR = (45 + highPulse * 55) * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(highR, cx * 0.6), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(96, 165, 250, 0.50)';
      ctx.fill();
      ctx.restore();
    }
  }

  // ═══ Fade-out previous tab before switching ═══
  const fadeouts = [
    { start: D_FADEOUT, dur: FADEOUT_DUR, tab: 'play' },
    { start: E_FADEOUT, dur: FADEOUT_DUR, tab: 'playlist' },
    { start: F_FADEOUT, dur: FADEOUT_DUR, tab: 'connect' },
    { start: G_FADEOUT, dur: FADEOUT_DUR, tab: 'settings' },
  ];
  for (const fo of fadeouts) {
    if (ms >= fo.start && ms < fo.start + fo.dur) {
      const tabEl = doc.getElementById('tab-' + fo.tab);
      if (tabEl) {
        const p = smooth((ms - fo.start) / fo.dur);
        tabEl.style.opacity = String(1 - p);
        tabEl.style.transform = `translateX(${-16 * p}px)`;
      }
    }
  }

  // ═══ Phase D-I: Tab content reveals ═══
  for (const e of appEntries) {
    if (ms < e.t) continue;
    const progress = Math.min((ms - e.t) / e.dur, 1);
    const ep = smooth(progress);

    if (e.type === 'reveal') {
      const el = revealEls[e.sel];
      if (el) {
        el.style.opacity = String(ep);
        const dist = e.fromTop ? -30 : 20;
        el.style.transform = `translateY(${dist * (1 - ep)}px)`;
      }
    } else if (e.type === 'reveal-track') {
      const items = doc.querySelectorAll<HTMLElement>('.track-item');
      const el = items[e.idx];
      if (el) {
        el.style.opacity = String(ep);
        el.style.transform = `translateY(${18 * (1 - ep)}px)`;
      }
    } else if (e.type === 'reveal-el') {
      const parentEl = doc.getElementById(e.parent);
      if (parentEl) {
        let el;
        if (typeof e.nth === 'number') {
          el = parentEl.querySelectorAll<HTMLElement>(e.sel)[e.nth];
        } else {
          el = parentEl.querySelector<HTMLElement>(e.sel);
        }
        if (el) {
          el.style.opacity = String(ep);
          el.style.transform = `translateY(${20 * (1 - ep)}px)`;
        }
      }
    } else if (e.type === 'tab') {
      if (!e._switched) {
        switchTab(e.tab);
        e._switched = true;
      }
      const tabEl = doc.getElementById('tab-' + e.tab);
      if (tabEl) {
        tabEl.style.opacity = String(ep);
        tabEl.style.transform = `translateX(${24 * (1 - ep)}px)`;
      }
    }
  }

  // Settings: smooth scroll down to audio section
  if (currentTab === 'settings' && ms >= G_SCROLL_START && ms < G_SCROLL_END) {
    const tabBody = doc.querySelector<HTMLElement>('#tab-settings .tab-body');
    const audioPanel = doc.querySelector<HTMLElement>('.settings-subtab-panel[data-panel="audio"]');
    if (audioPanel && tabBody) {
      const targetScroll = audioPanel.offsetTop - tabBody.offsetTop;
      const scrollProgress = smooth(
        Math.min((ms - G_SCROLL_START) / (G_SCROLL_END - G_SCROLL_START), 1),
      );
      tabBody.scrollTop = targetScroll * scrollProgress;
    }
  }

  // ═══ Playing indicator (equalizer bars) animation ═══
  // Animate when playlist tab is visible (or play tab with active track)
  const playingBars = doc.querySelectorAll<HTMLElement>('.playing-indicator .bar');
  if (playingBars.length > 0) {
    const t = ms / 1000;
    // Three bars with different sine wave frequencies for organic feel
    const heights = [
      0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 4.2)),
      0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 5.7 + 1.2)),
      0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 3.8 + 2.5)),
    ];
    playingBars.forEach((bar, i) => {
      bar.style.height = `${heights[i] * 100}%`;
      bar.style.animation = 'none';
    });
  }
};

// Auto-play
const params = new URLSearchParams(location.search);
if (params.get('autoplay') === 'true') {
  const waitForReady = setInterval(() => {
    if (window.appReady) {
      clearInterval(waitForReady);
      const startTime = performance.now();
      (function loop() {
        const elapsed = performance.now() - startTime;
        window.__promoSetTime(elapsed);
        if (elapsed < 50000) requestAnimationFrame(loop);
      })();
    }
  }, 100);
}
