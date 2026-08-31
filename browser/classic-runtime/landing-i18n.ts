/**
 * Locale dictionary and DOM bindings for the About page.
 *
 * This external script runs after the page markup so the production CSP does
 * not need `script-src 'unsafe-inline'`. Translations intentionally preserve
 * product and protocol names where localizing them would reduce clarity.
 */

(function () {
  const baseDictionaries = {
    en: {
      'meta.title': 'About · MUSIXQUARE',
      'meta.description':
        'MUSIXQUARE turns multiple phones, tablets, and laptops into one synchronized sound system. Browser-native. No install.',
      'meta.og_title': 'About · MUSIXQUARE',
      'meta.og_description':
        'Every device, one system. Multi-device synchronized audio, no install.',
      'meta.og_image_alt': 'MUSIXQUARE: Every device, one system.',
      'meta.tw_title': 'About · MUSIXQUARE',
      'meta.tw_description': 'Every device, one system.',

      'header.logo_aria': 'Back to top',
      'header.try': 'Try it now',
      'header.try_aria': 'Try MUSIXQUARE now',

      'hero.h1': 'Every device,<br>one system.',
      'hero.lead':
        'MUSIXQUARE turns multiple phones, tablets, and laptops into one sound system. No installation. Just share one code.',
      'hero.btn_ghost': 'How it works',
      'hero.rooms_opened': '{{count}} rooms opened so far.',

      'array.h2': 'Surround, without<br>surround speakers.',
      'array.lead':
        'Each device plays one role: left, right, subwoofer, or full stereo. The room itself becomes the system.',
      'array.aria': 'Left phone, center laptop, right phone. Three-device surround setup.',

      'code.h2': 'Six digits.<br>Nothing else.',
      'code.lead':
        'Start a session and share the six-digit code. Anyone with a supported browser can join in seconds.',
      'code.aria_code': 'Example room code',
      'code.aria_qr': 'QR code for musixquare.com',
      'code.copy_btn': 'Copy invite link',
      'code.toast_success': 'Invite link copied',
      'code.toast_fail': 'Copy failed',

      'remote.h2': 'Not in the room?<br>No problem.',
      'remote.lead': 'Chat, listen to music, or watch YouTube together, even from across town.',
      'remote.chat_label': 'Chat',
      'remote.chat_value': 'Real-time chat',
      'remote.whisper_label': 'Whisper',
      'remote.whisper_value': 'Private 1:1 messages',
      'remote.cowatch_label': 'Co-watch',
      'remote.cowatch_value': 'YouTube together, in sync',
      'remote.reach_label': 'Reach',
      'remote.reach_value': 'Supported browsers, across networks',
      'remote.caveat': "Note: channel separation and audio effects aren't available for YouTube.",
      'remote.pin_label': 'NOTICE · HOST',
      'remote.pin_text': 'Taking playlist recs',
      'remote.host_name': 'HOST',
      'remote.host_msg1': 'where are you?',
      'remote.peer_name': 'Peer 1',
      'remote.peer_msg1': 'working from a café lol',
      'remote.peer_ts_msg': "this song's pretty good",
      'remote.host_msg2': "i'll play it later",
      'remote.whisper_sender': 'whisper to HOST',
      'remote.whisper_msg': 'ask for playlist recs in the notice',

      'sync.h2': 'Synchronized playback.<br>Across networks.',
      'sync.lead': 'Each device checks the delay and keeps playback precisely aligned.',
      'sync.video_label': 'MEDIA',
      'sync.video_value': 'Synchronized media playback',
      'sync.transport_label': 'Transport',
      'sync.transport_value': 'Peer-to-peer, WebRTC',
      'sync.effects_label': 'Effects',
      'sync.effects_value': '5-band EQ · Reverb · Virtualizer',
      'sync.platforms_label': 'Platforms',
      'sync.platforms_value': 'iOS · Android · macOS · Windows',
      'sync.host_label': 'Host',
      'sync.meta': '60-sample NTP-style sync',

      'standin.h2': 'No speakers on<br>your computer?',
      'standin.lead':
        'MUSIXQUARE works as a quick stand-in. A phone and a tablet from your bag are enough to start.',
      'standin.aria': 'Silent computer above two active phones acting as left and right speakers',
      'standin.desktop_label': 'Desktop',
      'standin.desktop_value': 'Phones or tablets on the desk become the speakers',
      'standin.laptop_label': 'Laptop',
      'standin.laptop_value': 'Multiple devices instead of weak built-in speakers',
      'standin.feature_label': 'Feature',
      'standin.feature_value': 'System Audio Sharing (Beta)',
      'standin.platform_label': 'Platform',
      'standin.platform_value': 'Chromium-based browsers on computers',
      'standin.caveat':
        'Beta: desktop Chromium only, up to four connected devices including the publisher. Every Standard-room share and every Cloudflare-relayed (SFU) share ends after two hours; a verified PRO LAN-direct share may continue while room authority remains healthy. Live audio has unavoidable latency, so the sharing device should lower its volume.',

      'cta.h2': 'Start a session.',
      'cta.btn': 'Launch MUSIXQUARE',

      'footer.app': 'App',
      'footer.history': 'History',
      'footer.designsystem': 'Design System',
    },

    ko: {
      'meta.title': 'MUSIXQUARE 소개',
      'meta.description':
        'MUSIXQUARE는 여러 개의 폰, 태블릿, 노트북을 하나의 동기화된 사운드 시스템으로 만들어요. 브라우저에서 바로, 설치 없이.',
      'meta.og_title': 'MUSIXQUARE 소개',
      'meta.og_description': '모든 기기, 하나의 시스템. 여러 기기 동기 재생, 설치 없이.',
      'meta.og_image_alt': 'MUSIXQUARE: 모든 기기, 하나의 시스템.',
      'meta.tw_title': 'MUSIXQUARE 소개',
      'meta.tw_description': '모든 기기, 하나의 시스템.',

      'header.logo_aria': '맨 위로 이동',
      'header.try': '지금 사용해 보기',
      'header.try_aria': 'MUSIXQUARE 지금 사용해 보기',

      'hero.h1': '모든 기기를<br>하나의 시스템으로',
      'hero.lead':
        'MUSIXQUARE는 여러 개의 폰, 태블릿, 노트북을 하나의 사운드 시스템으로 묶어줘요. 설치 없이 코드 하나만 공유하면 돼요.',
      'hero.btn_ghost': '자세히 보기',
      'hero.rooms_opened': '지금까지 {{count}}개의 방이 열렸어요.',

      'array.h2': '서라운드 스피커 없이<br>서라운드 사운드 만들기',
      'array.lead':
        '각 기기는 왼쪽, 오른쪽, 서브우퍼 또는 스테레오 중 한 가지 역할을 맡아요. 방 자체가 하나의 시스템이 돼요.',
      'array.aria': '왼쪽 폰, 가운데 노트북, 오른쪽 폰. 기기 3대로 구성한 서라운드 설정.',

      'code.h2': '여섯 자리 숫자만<br>있으면 돼요',
      'code.lead':
        '방을 열고 여섯 자리 숫자만 공유해요. 브라우저만 있으면 누구나 몇 초 안에 참여할 수 있어요.',
      'code.aria_code': '예시 방 코드',
      'code.aria_qr': 'musixquare.com QR 코드',
      'code.copy_btn': '초대 링크 복사하기',
      'code.toast_success': '초대 링크가 복사되었어요',
      'code.toast_fail': '복사에 실패했어요',

      'remote.h2': '같은 공간이 아니어도<br>괜찮아요',
      'remote.lead': '멀리 떨어져 있어도 채팅하면서 음악을 듣거나 YouTube를 볼 수 있어요.',
      'remote.chat_label': '채팅',
      'remote.chat_value': '실시간 채팅',
      'remote.whisper_label': '귓속말',
      'remote.whisper_value': '1:1 비공개 메시지',
      'remote.cowatch_label': '함께 보기',
      'remote.cowatch_value': 'YouTube 동기화 재생',
      'remote.reach_label': '가능 환경',
      'remote.reach_value': '지원되는 브라우저에서 네트워크 간 연결',
      'remote.caveat': '참고: YouTube 모드에서는 채널 분리와 음향 효과를 쓸 수 없어요.',
      'remote.pin_label': '공지 · HOST',
      'remote.pin_text': '플리 추천받습니다',
      'remote.host_name': 'HOST',
      'remote.host_msg1': '어디야?',
      'remote.peer_name': 'Peer 1',
      'remote.peer_msg1': '카페에서 작업중ㅋㅋ',
      'remote.peer_ts_msg': '이 곡 좋은 듯',
      'remote.host_msg2': '이따 틀어줄게',
      'remote.whisper_sender': 'HOST에게 귓속말',
      'remote.whisper_msg': '공지로 플리 추천 좀 받아봐',

      'sync.h2': '네트워크를 넘어<br>프레임 단위로 정확하게',
      'sync.lead': '각 기기가 지연을 측정하고 칼같이 정렬해요.',
      'sync.video_label': '미디어',
      'sync.video_value': '동기화된 미디어 재생',
      'sync.transport_label': '전송',
      'sync.transport_value': 'P2P, WebRTC',
      'sync.effects_label': '효과',
      'sync.effects_value': '5밴드 이퀄라이저, 리버브, 버추얼라이저',
      'sync.platforms_label': '플랫폼',
      'sync.platforms_value': 'iOS · Android · macOS · Windows',
      'sync.host_label': 'HOST',
      'sync.meta': '60샘플 NTP 방식 동기화',

      'standin.h2': '혹시 컴퓨터에<br>스피커가 없다면',
      'standin.lead':
        'MUSIXQUARE가 좋은 임시방편이 될 수 있어요. 가방 속 폰과 태블릿이면 충분해요.',
      'standin.aria': '음소거된 컴퓨터 아래에 좌우 스피커 역할을 하는 폰 두 대',
      'standin.desktop_label': '데스크톱',
      'standin.desktop_value': '책상 위 폰이나 태블릿으로 스피커 셋업',
      'standin.laptop_label': '노트북',
      'standin.laptop_value': '빈약한 노트북 스피커 대신 여러 개의 디바이스',
      'standin.feature_label': '기능',
      'standin.feature_value': '시스템 오디오 공유 (Beta)',
      'standin.platform_label': '플랫폼',
      'standin.platform_value': '컴퓨터의 Chromium 기반 브라우저',
      'standin.caveat':
        'Beta: 컴퓨터용 Chromium 브라우저에서만 지원하며, 송신 중인 기기를 포함해 최대 4대까지 연결할 수 있어요. 일반방 공유와 Cloudflare 경유(SFU) 공유는 2시간 후 종료돼요. 검증된 PRO LAN 직결 공유는 방 권한 연결이 정상인 동안 계속할 수 있어요. 실시간 오디오는 지연이 불가피하므로 송신 중인 기기의 볼륨을 낮춰 주세요.',

      'cta.h2': '지금 시작해봐요!',
      'cta.btn': 'MUSIXQUARE 시작하기',

      'footer.app': 'App',
      'footer.history': 'History',
      'footer.designsystem': 'Design System',
    },
  };

  type LocaleCode =
    | 'en'
    | 'ko'
    | 'ja'
    | 'zh-hans'
    | 'zh-hant'
    | 'es'
    | 'pt-br'
    | 'fr'
    | 'de'
    | 'nl'
    | 'it'
    | 'pl'
    | 'ru'
    | 'tr'
    | 'id'
    | 'vi'
    | 'th'
    | 'hi'
    | 'bn'
    | 'ta'
    | 'te'
    | 'ms'
    | 'fil'
    | 'ar'
    | 'ur'
    | 'he'
    | 'uk'
    | 'ro'
    | 'cs'
    | 'el'
    | 'fa'
    | 'mr'
    | 'gu'
    | 'kn'
    | 'ml'
    | 'pa'
    | 'sv'
    | 'da'
    | 'nb'
    | 'fi'
    | 'hu'
    | 'bg';
  type TranslationKey = keyof (typeof baseDictionaries)['en'];
  type TranslationDictionary = Readonly<Record<TranslationKey, string> & Record<string, string>>;

  interface StaticLanguageRuntime {
    normalize(value: unknown): string | null;
    resolve(fallback: unknown): string;
    htmlLang(code: unknown): string;
    locale(code: unknown): string;
    setDocumentLang(code: unknown): void;
    update(code: unknown): void;
  }

  interface StaticLanguageChangeDetail {
    readonly lang?: unknown;
  }

  const englishDictionary: TranslationDictionary = baseDictionaries.en;
  const i18n: Partial<Record<LocaleCode, TranslationDictionary>> = baseDictionaries;
  const landingWindow: Window & {
    MXQRStaticLang?: StaticLanguageRuntime;
    __landingLang?: string;
    __landingT?: (key: string, fallback?: string) => string;
  } = window;

  function addLang(code: Exclude<LocaleCode, 'en' | 'ko'>, dict: TranslationDictionary): void {
    i18n[code] = dict;
  }

  addLang('ja', {
    'meta.title': 'MUSIXQUAREについて',
    'meta.description':
      'MUSIXQUAREは、複数のスマートフォン、タブレット、ノートPCをひとつの同期サウンドシステムにつなげます。ブラウザですぐ使えて、インストールは不要です。',
    'meta.og_title': 'MUSIXQUAREについて',
    'meta.og_description':
      'すべての端末を、ひとつの音へ。インストール不要のマルチデバイス同期オーディオ。',
    'meta.og_image_alt': 'MUSIXQUARE: すべての端末を、ひとつの音へ。',
    'meta.tw_title': 'MUSIXQUAREについて',
    'meta.tw_description': 'すべての端末を、ひとつの音へ。',
    'header.logo_aria': 'ページ上部へ戻る',
    'header.try': '今すぐ試す',
    'header.try_aria': 'MUSIXQUAREを今すぐ試す',
    'hero.h1': 'すべての端末を<br>ひとつの音へ',
    'hero.lead':
      'MUSIXQUAREは、複数のスマートフォン、タブレット、ノートPCをひとつのサウンドシステムにつなげます。インストール不要。コードをひとつ共有するだけです。',
    'hero.btn_ghost': 'しくみを見る',
    'hero.rooms_opened': 'これまでに{{count}}のルームが開かれました。',
    'array.h2': 'サラウンドスピーカーなしで<br>サラウンドを',
    'array.lead':
      '各デバイスが左、右、サブウーファー、ステレオの役割を担います。部屋全体をサラウンドシステムにできます。',
    'array.aria':
      '左のスマートフォン、中央のノートPC、右のスマートフォン。3台構成のサラウンド設定。',
    'code.h2': '6桁の数字だけで<br>つながります',
    'code.lead':
      'ルームを作成して6桁のコードを共有します。対応ブラウザを使っていれば、数秒で参加できます。',
    'code.aria_code': 'ルームコードの例',
    'code.aria_qr': 'musixquare.com のQRコード',
    'code.copy_btn': '招待リンクをコピー',
    'code.toast_success': '招待リンクをコピーしました',
    'code.toast_fail': 'コピーできませんでした',
    'remote.h2': '同じ場所にいなくても<br>大丈夫',
    'remote.lead': '離れていても、チャットしながら音楽を聴いたりYouTubeを一緒に見たりできます。',
    'remote.chat_label': 'チャット',
    'remote.chat_value': 'リアルタイムチャット',
    'remote.whisper_label': '個別メッセージ',
    'remote.whisper_value': '1対1の個別メッセージ',
    'remote.cowatch_label': '一緒に視聴',
    'remote.cowatch_value': 'YouTubeを同期して再生',
    'remote.reach_label': '対応環境',
    'remote.reach_value': '対応ブラウザなら、異なるネットワーク間でも接続可能',
    'remote.caveat': '注: YouTubeモードでは、チャンネル分離とオーディオ効果は使えません。',
    'remote.pin_label': 'お知らせ · HOST',
    'remote.pin_text': 'プレイリスト募集中',
    'remote.host_name': 'HOST',
    'remote.host_msg1': '今どこ？',
    'remote.peer_name': 'Peer 1',
    'remote.peer_msg1': 'カフェで作業中w',
    'remote.peer_ts_msg': 'この曲いいかも',
    'remote.host_msg2': 'あとで流すね',
    'remote.whisper_sender': 'HOSTへの個別メッセージ',
    'remote.whisper_msg': 'お知らせでおすすめ募集してみて',
    'sync.h2': 'ネットワークを越えて<br>同期再生',
    'sync.lead': '各デバイスが遅れを測り、再生のタイミングをぴったりそろえます。',
    'sync.video_label': 'メディア',
    'sync.video_value': '同期メディア再生',
    'sync.transport_label': '転送',
    'sync.transport_value': 'P2P, WebRTC',
    'sync.effects_label': 'エフェクト',
    'sync.effects_value': '5バンドEQ · リバーブ · バーチャライザー',
    'sync.platforms_label': 'プラットフォーム',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'HOST',
    'sync.meta': '60サンプルのNTP方式同期',
    'standin.h2': 'パソコンに<br>スピーカーがないときは',
    'standin.lead':
      'MUSIXQUAREが手軽な代わりになります。バッグの中のスマートフォンとタブレットがあれば十分です。',
    'standin.aria':
      'ミュートされたパソコンの下に、左右のスピーカーとして動作する2台のスマートフォン',
    'standin.desktop_label': 'デスクトップ',
    'standin.desktop_value': '机の上のスマートフォンやタブレットをスピーカーに',
    'standin.laptop_label': 'ノートPC',
    'standin.laptop_value': '物足りない内蔵スピーカーの代わりに複数のデバイスを使用',
    'standin.feature_label': '機能',
    'standin.feature_value': 'システムオーディオ共有（Beta）',
    'standin.platform_label': 'プラットフォーム',
    'standin.platform_value': 'パソコン上のChromiumベースブラウザ',
    'standin.caveat':
      'Beta: パソコンのChromiumブラウザのみ。共有元を含め最大4台です。通常ルームの共有とCloudflare経由（SFU）の共有は2時間で終了します。検証済みのPRO LAN直接共有は、ルーム権限との接続が正常な間は継続できます。ライブ音声には遅延があるため、共有元デバイスの音量を下げてください。',
    'cta.h2': '今すぐ始めましょう',
    'cta.btn': 'MUSIXQUAREを始める',
    'footer.app': 'アプリ',
    'footer.history': '履歴',
    'footer.designsystem': 'デザインシステム',
  });

  addLang('zh-hans', {
    'meta.title': '关于 MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE 可把多台手机、平板和笔记本电脑变成一套同步音响系统。直接在浏览器中使用，无需安装。',
    'meta.og_title': '关于 MUSIXQUARE',
    'meta.og_description': '所有设备，一个系统。多设备音频同步，无需安装。',
    'meta.og_image_alt': 'MUSIXQUARE：所有设备，一个系统。',
    'meta.tw_title': '关于 MUSIXQUARE',
    'meta.tw_description': '所有设备，一个系统。',
    'header.logo_aria': '返回顶部',
    'header.try': '立即试用',
    'header.try_aria': '立即试用 MUSIXQUARE',
    'hero.h1': '所有设备<br>组成一个系统',
    'hero.lead':
      'MUSIXQUARE 可以把多台手机、平板和笔记本电脑连成一套音响系统。无需安装，分享一个邀请码即可。',
    'hero.btn_ghost': '了解工作原理',
    'hero.rooms_opened': '截至目前已创建 {{count}} 个房间。',
    'array.h2': '没有环绕音箱<br>也能做出环绕声',
    'array.lead':
      '每台设备都可以用作左音箱、右音箱、低音炮或完整的立体声音箱。整个房间就是一套音响系统。',
    'array.aria': '由左侧手机、中间的笔记本电脑和右侧手机组成的环绕系统。',
    'code.h2': '只要六位数字<br>就能加入',
    'code.lead': '创建房间后会生成六位代码。使用受支持浏览器的设备都能快速加入。',
    'code.aria_code': '房间代码示例',
    'code.aria_qr': 'musixquare.com 的二维码',
    'code.copy_btn': '复制邀请链接',
    'code.toast_success': '邀请链接已复制',
    'code.toast_fail': '复制失败',
    'remote.h2': '不在同一个空间<br>也没关系',
    'remote.lead': '即使相隔很远，也可以一边聊天，一边听音乐或一起看 YouTube。',
    'remote.chat_label': '聊天',
    'remote.chat_value': '实时聊天',
    'remote.whisper_label': '私聊',
    'remote.whisper_value': '1 对 1 私密消息',
    'remote.cowatch_label': '一起看',
    'remote.cowatch_value': '同步播放 YouTube',
    'remote.reach_label': '适用范围',
    'remote.reach_value': '受支持的浏览器，可跨网络连接',
    'remote.caveat': '注意：YouTube 模式不支持声道分离和音效。',
    'remote.pin_label': '公告 · 房主',
    'remote.pin_text': '求歌单推荐',
    'remote.host_name': '房主',
    'remote.host_msg1': '在哪儿？',
    'remote.peer_name': '参与者 1',
    'remote.peer_msg1': '在咖啡店干活呢哈哈',
    'remote.peer_ts_msg': '这首好像不错',
    'remote.host_msg2': '待会儿放给你听',
    'remote.whisper_sender': '私聊房主',
    'remote.whisper_msg': '发个公告求歌单推荐吧',
    'sync.h2': '跨越网络<br>同步播放',
    'sync.lead': '每台设备都会测量延迟，把播放时间准确对齐。',
    'sync.video_label': '媒体',
    'sync.video_value': '同步媒体播放',
    'sync.transport_label': '传输',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': '效果',
    'sync.effects_value': '5 段 EQ · 混响 · 虚拟环绕',
    'sync.platforms_label': '平台',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': '房主',
    'sync.meta': '60 个样本的 NTP 方式同步',
    'standin.h2': '电脑没有<br>扬声器？',
    'standin.lead': 'MUSIXQUARE 可以临时充当音箱。随手拿出手机和平板就能开始。',
    'standin.aria': '静音电脑下方有两部手机，分别作为左右扬声器工作',
    'standin.desktop_label': '台式机',
    'standin.desktop_value': '桌上的手机或平板就能成为扬声器',
    'standin.laptop_label': '笔记本',
    'standin.laptop_value': '用多台设备替代音质单薄的内置扬声器',
    'standin.feature_label': '功能',
    'standin.feature_value': '系统音频共享（Beta）',
    'standin.platform_label': '平台',
    'standin.platform_value': '电脑上的 Chromium 内核浏览器',
    'standin.caveat':
      'Beta：仅支持电脑端 Chromium 浏览器，包含发布设备最多四台。普通房间共享和经 Cloudflare 中继的（SFU）共享会在两小时后结束；经验证的 PRO 局域网直连共享可在房间权限连接正常期间继续。实时音频无法避免延迟，请调低共享设备音量。',
    'cta.h2': '现在就开始',
    'cta.btn': '打开 MUSIXQUARE',
    'footer.app': '应用',
    'footer.history': '历史',
    'footer.designsystem': '设计系统',
  });

  addLang('zh-hant', {
    'meta.title': '關於 MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE 可將多台手機、平板與筆電變成一套同步音響系統。直接在瀏覽器使用，無需安裝。',
    'meta.og_title': '關於 MUSIXQUARE',
    'meta.og_description': '所有裝置，一套系統。無需安裝的多裝置同步音訊。',
    'meta.og_image_alt': 'MUSIXQUARE：所有裝置，一套系統。',
    'meta.tw_title': '關於 MUSIXQUARE',
    'meta.tw_description': '所有裝置，一套系統。',
    'header.logo_aria': '回到頁首',
    'header.try': '立即試用',
    'header.try_aria': '立即試用 MUSIXQUARE',
    'hero.h1': '所有裝置<br>變成一套系統',
    'hero.lead':
      'MUSIXQUARE 可以把多台手機、平板和筆電連成一套音響系統。無需安裝，只要分享一組邀請碼。',
    'hero.btn_ghost': '了解運作方式',
    'hero.rooms_opened': '至今已開啟 {{count}} 個房間。',
    'array.h2': '不用環繞喇叭<br>也能做出環繞音效',
    'array.lead':
      '每台裝置各自扮演一種角色：左喇叭、右喇叭、重低音或完整立體聲。整個房間就是一套音響系統。',
    'array.aria': '左側手機、中央筆電、右側手機。由三台裝置組成的環繞音效配置。',
    'code.h2': '只要六位數字<br>就能加入',
    'code.lead': '建立房間並分享六位數邀請碼。使用支援瀏覽器的裝置都能在幾秒內加入。',
    'code.aria_code': '房間邀請碼範例',
    'code.aria_qr': 'musixquare.com 的 QR 碼',
    'code.copy_btn': '複製邀請連結',
    'code.toast_success': '已複製邀請連結',
    'code.toast_fail': '複製失敗',
    'remote.h2': '不在同一個空間<br>也沒關係',
    'remote.lead': '即使距離很遠，也可以邊聊天邊聽音樂，或一起看 YouTube。',
    'remote.chat_label': '聊天',
    'remote.chat_value': '即時聊天',
    'remote.whisper_label': '私訊',
    'remote.whisper_value': '一對一私訊',
    'remote.cowatch_label': '一起看',
    'remote.cowatch_value': '同步播放 YouTube',
    'remote.reach_label': '支援範圍',
    'remote.reach_value': '支援的瀏覽器皆可跨網路連線',
    'remote.caveat': '注意：YouTube 模式不支援聲道分離與音效。',
    'remote.pin_label': '公告 · 房主',
    'remote.pin_text': '求推薦歌單',
    'remote.host_name': '房主',
    'remote.host_msg1': '在哪？',
    'remote.peer_name': '參與者 1',
    'remote.peer_msg1': '在咖啡廳工作中哈哈',
    'remote.peer_ts_msg': '這首不錯欸',
    'remote.host_msg2': '晚點播給你聽',
    'remote.whisper_sender': '私訊房主',
    'remote.whisper_msg': '發個公告問大家有沒有推薦歌單',
    'sync.h2': '跨越不同網路<br>也能同步播放',
    'sync.lead': '每台裝置都會測量延遲，把播放時間精準對齊。',
    'sync.video_label': '媒體',
    'sync.video_value': '同步媒體播放',
    'sync.transport_label': '傳輸',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': '效果',
    'sync.effects_value': '5 段 EQ · 殘響 · 虛擬環繞',
    'sync.platforms_label': '平台',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': '房主',
    'sync.meta': 'NTP 式同步（60 次取樣）',
    'standin.h2': '電腦沒有<br>喇叭嗎？',
    'standin.lead': 'MUSIXQUARE 可以暫時充當喇叭。只要拿出包包裡的手機和平板，就能開始使用。',
    'standin.aria': '靜音電腦下方有兩支手機，分別作為左右喇叭運作',
    'standin.desktop_label': '桌機',
    'standin.desktop_value': '桌上的手機或平板就能成為喇叭',
    'standin.laptop_label': '筆電',
    'standin.laptop_value': '用多台裝置取代音質單薄的內建喇叭',
    'standin.feature_label': '功能',
    'standin.feature_value': '系統音訊分享（Beta）',
    'standin.platform_label': '平台',
    'standin.platform_value': '電腦上以 Chromium 為核心的瀏覽器',
    'standin.caveat':
      'Beta：僅支援電腦版 Chromium 瀏覽器，包含分享裝置最多四台。一般房間分享和經 Cloudflare 中繼的（SFU）分享會在兩小時後結束；通過驗證的 PRO 區域網路直連分享可在房間權限連線正常期間繼續。即時音訊無法避免延遲，請調低分享裝置音量。',
    'cta.h2': '現在就開始',
    'cta.btn': '啟動 MUSIXQUARE',
    'footer.app': 'App',
    'footer.history': '歷史',
    'footer.designsystem': '設計系統',
  });

  addLang('es', {
    'meta.title': 'Acerca de MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE convierte varios teléfonos, tabletas y portátiles en un único sistema de sonido sincronizado. Funciona en el navegador, sin instalar nada.',
    'meta.og_title': 'Acerca de MUSIXQUARE',
    'meta.og_description':
      'Todos los dispositivos, un solo sistema. Audio sincronizado entre varios dispositivos, sin instalación.',
    'meta.og_image_alt': 'MUSIXQUARE: todos los dispositivos, un solo sistema.',
    'meta.tw_title': 'Acerca de MUSIXQUARE',
    'meta.tw_description': 'Todos los dispositivos, un solo sistema.',
    'header.logo_aria': 'Volver arriba',
    'header.try': 'Probar ahora',
    'header.try_aria': 'Probar MUSIXQUARE ahora',
    'hero.h1': 'Todos los dispositivos<br>un solo sistema',
    'hero.lead':
      'MUSIXQUARE reúne teléfonos, tabletas y portátiles en un solo sistema de sonido. Sin instalación: solo comparte un código.',
    'hero.btn_ghost': 'Ver cómo funciona',
    'hero.rooms_opened': 'Ya se han abierto {{count}} salas.',
    'array.h2': 'Sonido envolvente<br>sin altavoces envolventes',
    'array.lead':
      'Cada dispositivo puede asumir el papel de izquierda, derecha, subwoofer o estéreo completo. Toda la sala se convierte en el sistema.',
    'array.aria':
      'Teléfono izquierdo, portátil en el centro y teléfono derecho. Configuración envolvente de tres dispositivos.',
    'code.h2': 'Solo seis dígitos<br>y listo',
    'code.lead':
      'Abre una sala y comparte el código de seis dígitos. Cualquier dispositivo con un navegador compatible puede conectarse en segundos.',
    'code.aria_code': 'Ejemplo de código de sala',
    'code.aria_qr': 'Código QR de musixquare.com',
    'code.copy_btn': 'Copiar enlace de invitación',
    'code.toast_success': 'Enlace de invitación copiado',
    'code.toast_fail': 'No se pudo copiar',
    'remote.h2': 'Aunque no estén juntos<br>no hay problema',
    'remote.lead': 'Pueden chatear, escuchar música o ver YouTube juntos incluso a distancia.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Chat en tiempo real',
    'remote.whisper_label': 'Privado',
    'remote.whisper_value': 'Mensajes 1:1 privados',
    'remote.cowatch_label': 'Ver juntos',
    'remote.cowatch_value': 'YouTube sincronizado',
    'remote.reach_label': 'Alcance',
    'remote.reach_value': 'Navegadores compatibles, entre distintas redes',
    'remote.caveat': 'Nota: el modo YouTube no permite separación de canales ni efectos de audio.',
    'remote.pin_label': 'AVISO · ANFITRIÓN',
    'remote.pin_text': '¿Alguna playlist para recomendar?',
    'remote.host_name': 'ANFITRIÓN',
    'remote.host_msg1': '¿dónde estás?',
    'remote.peer_name': 'Participante 1',
    'remote.peer_msg1': 'trabajando en una cafetería jaja',
    'remote.peer_ts_msg': 'este tema suena bien',
    'remote.host_msg2': 'lo pongo luego',
    'remote.whisper_sender': 'privado para ANFITRIÓN',
    'remote.whisper_msg': 'pide recomendaciones de playlists en el aviso',
    'sync.h2': 'Reproducción sincronizada<br>entre distintas redes',
    'sync.lead': 'Cada dispositivo mide el retraso y ajusta la reproducción con precisión.',
    'sync.video_label': 'Multimedia',
    'sync.video_value': 'Reproducción multimedia sincronizada',
    'sync.transport_label': 'Transporte',
    'sync.transport_value': 'P2P, WebRTC',
    'sync.effects_label': 'Efectos',
    'sync.effects_value': 'EQ de 5 bandas · Reverberación · Virtualizador',
    'sync.platforms_label': 'Plataformas',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Anfitrión',
    'sync.meta': 'Sincronización tipo NTP con 60 muestras',
    'standin.h2': '¿Tu ordenador<br>no tiene altavoces?',
    'standin.lead':
      'MUSIXQUARE puede sacarte del apuro. Basta con un teléfono y una tableta de la mochila para empezar.',
    'standin.aria':
      'Ordenador silenciado sobre dos teléfonos activos que funcionan como altavoces izquierdo y derecho',
    'standin.desktop_label': 'Ordenador de sobremesa',
    'standin.desktop_value':
      'Los teléfonos o las tabletas del escritorio se convierten en altavoces',
    'standin.laptop_label': 'Portátil',
    'standin.laptop_value': 'Varios dispositivos en lugar de altavoces integrados débiles',
    'standin.feature_label': 'Función',
    'standin.feature_value': 'Compartir audio del sistema (Beta)',
    'standin.platform_label': 'Plataforma',
    'standin.platform_value': 'Navegadores basados en Chromium en ordenadores',
    'standin.caveat':
      'Beta: solo Chromium de escritorio, hasta cuatro dispositivos conectados incluido el emisor. Cada sesión de sala estándar y cada sesión retransmitida por Cloudflare (SFU) termina a las dos horas; una sesión PRO verificada con conexión LAN directa puede continuar mientras la autoridad de la sala esté disponible. El audio en vivo tiene latencia inevitable; baja el volumen del dispositivo emisor.',
    'cta.h2': 'Abre una sala.',
    'cta.btn': 'Abrir MUSIXQUARE',
    'footer.app': 'App',
    'footer.history': 'Historia',
    'footer.designsystem': 'Sistema de diseño',
  });

  addLang('pt-br', {
    'meta.title': 'Sobre o MUSIXQUARE',
    'meta.description':
      'O MUSIXQUARE transforma vários celulares, tablets e notebooks em um sistema de som sincronizado. Funciona direto no navegador, sem instalação.',
    'meta.og_title': 'Sobre o MUSIXQUARE',
    'meta.og_description':
      'Todos os dispositivos, um só sistema. Áudio sincronizado em vários dispositivos, sem instalar nada.',
    'meta.og_image_alt': 'MUSIXQUARE: todos os dispositivos, um só sistema.',
    'meta.tw_title': 'Sobre o MUSIXQUARE',
    'meta.tw_description': 'Todos os dispositivos, um só sistema.',
    'header.logo_aria': 'Voltar ao topo',
    'header.try': 'Testar agora',
    'header.try_aria': 'Testar o MUSIXQUARE agora',
    'hero.h1': 'Todos os dispositivos<br>um só sistema',
    'hero.lead':
      'O MUSIXQUARE junta celulares, tablets e notebooks em um só sistema de som. Sem instalação: é só compartilhar um código.',
    'hero.btn_ghost': 'Ver como funciona',
    'hero.rooms_opened': '{{count}} salas já foram abertas.',
    'array.h2': 'Som surround<br>sem caixas surround',
    'array.lead':
      'Cada dispositivo pode assumir a função de esquerda, direita, subwoofer ou estéreo completo. O ambiente vira o sistema.',
    'array.aria':
      'Celular à esquerda, notebook ao centro e celular à direita. Configuração surround com três dispositivos.',
    'code.h2': 'Só seis dígitos<br>e pronto',
    'code.lead':
      'Abra uma sala e compartilhe o código de seis dígitos. Qualquer dispositivo com um navegador compatível entra em segundos.',
    'code.aria_code': 'Exemplo de código da sala',
    'code.aria_qr': 'Código QR de musixquare.com',
    'code.copy_btn': 'Copiar link de convite',
    'code.toast_success': 'Link de convite copiado',
    'code.toast_fail': 'Não foi possível copiar',
    'remote.h2': 'Mesmo longe<br>tudo bem',
    'remote.lead':
      'Dá para conversar, ouvir música ou assistir ao YouTube juntos mesmo à distância.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Chat em tempo real',
    'remote.whisper_label': 'Privado',
    'remote.whisper_value': 'Mensagens privadas 1:1',
    'remote.cowatch_label': 'Assistir junto',
    'remote.cowatch_value': 'YouTube sincronizado',
    'remote.reach_label': 'Alcance',
    'remote.reach_value': 'Navegadores compatíveis, mesmo em redes diferentes',
    'remote.caveat':
      'Observação: no modo YouTube, separação de canais e efeitos de áudio não ficam disponíveis.',
    'remote.pin_label': 'AVISO · ANFITRIÃO',
    'remote.pin_text': 'Mandem sugestões de playlist',
    'remote.host_name': 'ANFITRIÃO',
    'remote.host_msg1': 'onde você tá?',
    'remote.peer_name': 'Participante 1',
    'remote.peer_msg1': 'trabalhando num café kkk',
    'remote.peer_ts_msg': 'essa música é boa, hein',
    'remote.host_msg2': 'depois eu coloco',
    'remote.whisper_sender': 'privado para ANFITRIÃO',
    'remote.whisper_msg': 'pede sugestões de playlist no aviso',
    'sync.h2': 'Reprodução sincronizada<br>mesmo entre redes',
    'sync.lead': 'Cada dispositivo mede o atraso e alinha a reprodução com precisão.',
    'sync.video_label': 'Mídia',
    'sync.video_value': 'Reprodução de mídia sincronizada',
    'sync.transport_label': 'Transporte',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Efeitos',
    'sync.effects_value': 'EQ de 5 bandas · Reverberação · Virtualizador',
    'sync.platforms_label': 'Plataformas',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'ANFITRIÃO',
    'sync.meta': 'Sincronização tipo NTP com 60 amostras',
    'standin.h2': 'Seu computador<br>não tem caixas de som?',
    'standin.lead':
      'O MUSIXQUARE resolve na hora. Um celular e um tablet na mochila já bastam para começar.',
    'standin.aria':
      'Computador sem som acima de dois celulares ativos funcionando como caixas esquerda e direita',
    'standin.desktop_label': 'Desktop',
    'standin.desktop_value': 'Celulares ou tablets na mesa viram as caixas de som',
    'standin.laptop_label': 'Notebook',
    'standin.laptop_value':
      'Vários dispositivos no lugar de alto-falantes integrados com som fraco',
    'standin.feature_label': 'Recurso',
    'standin.feature_value': 'Compartilhamento de áudio do sistema (Beta)',
    'standin.platform_label': 'Plataforma',
    'standin.platform_value': 'Navegadores baseados em Chromium em computadores',
    'standin.caveat':
      'Beta: somente Chromium no computador, até quatro dispositivos conectados incluindo o transmissor. Todo compartilhamento em sala Standard e todo compartilhamento retransmitido pela Cloudflare (SFU) termina após duas horas; um compartilhamento PRO LAN-direct verificado pode continuar enquanto a autoridade da sala estiver disponível. O áudio ao vivo tem latência inevitável; reduza o volume do dispositivo transmissor.',
    'cta.h2': 'Comece agora',
    'cta.btn': 'Abrir o MUSIXQUARE',
    'footer.app': 'App',
    'footer.history': 'História',
    'footer.designsystem': 'Sistema de design',
  });

  addLang('fr', {
    'meta.title': 'À propos de MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE transforme plusieurs téléphones, tablettes et ordinateurs portables en un système audio synchronisé. Tout se fait dans le navigateur, sans installation.',
    'meta.og_title': 'À propos de MUSIXQUARE',
    'meta.og_description':
      'Tous les appareils, un seul système. Audio synchronisé sur plusieurs appareils, sans installation.',
    'meta.og_image_alt': 'MUSIXQUARE : tous les appareils, un seul système.',
    'meta.tw_title': 'À propos de MUSIXQUARE',
    'meta.tw_description': 'Tous les appareils, un seul système.',
    'header.logo_aria': 'Retour en haut de la page',
    'header.try': 'Essayer maintenant',
    'header.try_aria': 'Essayer MUSIXQUARE maintenant',
    'hero.h1': 'Tous les appareils<br>un seul système',
    'hero.lead':
      'MUSIXQUARE réunit plusieurs téléphones, tablettes et ordinateurs portables en un seul système audio. Aucune installation : il suffit de partager un code.',
    'hero.btn_ghost': 'Voir comment ça marche',
    'hero.rooms_opened': '{{count}} salons créés à ce jour.',
    'array.h2': 'Du son surround<br>sans enceintes surround',
    'array.lead':
      'Chaque appareil remplit un rôle : enceinte gauche, enceinte droite, caisson de basses ou stéréo complète. La pièce elle-même devient le système.',
    'array.aria':
      'Téléphone à gauche, ordinateur portable au centre, téléphone à droite. Configuration surround à trois appareils.',
    'code.h2': 'Six chiffres<br>et c’est parti',
    'code.lead':
      'Créez un salon et partagez le code à six chiffres. Toute personne utilisant un navigateur compatible peut rejoindre le salon en quelques secondes.',
    'code.aria_code': 'Exemple de code de salon',
    'code.aria_qr': 'Code QR pour musixquare.com',
    'code.copy_btn': 'Copier le lien d’invitation',
    'code.toast_success': 'Lien d’invitation copié',
    'code.toast_fail': 'Impossible de copier',
    'remote.h2': 'Pas dans le salon ?<br>Aucun souci',
    'remote.lead':
      'Vous pouvez discuter, écouter de la musique ou regarder YouTube ensemble, même à distance.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Chat en temps réel',
    'remote.whisper_label': 'Message privé',
    'remote.whisper_value': 'Messages privés individuels',
    'remote.cowatch_label': 'Regarder ensemble',
    'remote.cowatch_value': 'YouTube synchronisé',
    'remote.reach_label': 'Compatibilité',
    'remote.reach_value': 'Navigateurs compatibles, même sur des réseaux différents',
    'remote.caveat':
      'Remarque : le mode YouTube ne permet pas la séparation des canaux ni les effets audio.',
    'remote.pin_label': 'ANNONCE · HÔTE',
    'remote.pin_text': 'Des playlists à conseiller ?',
    'remote.host_name': 'HÔTE',
    'remote.host_msg1': 't’es où ?',
    'remote.peer_name': 'Participant 1',
    'remote.peer_msg1': 'je bosse dans un café mdr',
    'remote.peer_ts_msg': 'ce morceau est pas mal',
    'remote.host_msg2': 'je le passe plus tard',
    'remote.whisper_sender': 'message privé à l’HÔTE',
    'remote.whisper_msg': 'demande des recos de playlists dans l’annonce',
    'sync.h2': 'Lecture synchronisée<br>d’un réseau à l’autre',
    'sync.lead': 'Chaque appareil mesure le décalage et aligne précisément la lecture.',
    'sync.video_label': 'Média',
    'sync.video_value': 'Lecture synchronisée des médias',
    'sync.transport_label': 'Transport',
    'sync.transport_value': 'Pair à pair · WebRTC',
    'sync.effects_label': 'Effets',
    'sync.effects_value': 'Égaliseur 5 bandes · Réverbération · Effet spatial',
    'sync.platforms_label': 'Plateformes',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Hôte',
    'sync.meta': 'Synchronisation de type NTP sur 60 échantillons',
    'standin.h2': 'Pas d’enceintes<br>sur votre ordinateur ?',
    'standin.lead':
      'MUSIXQUARE peut remplacer ponctuellement des enceintes. Un téléphone et une tablette sortis de votre sac suffisent pour commencer.',
    'standin.aria':
      'Ordinateur sans son au-dessus de deux téléphones actifs servant d’enceintes gauche et droite',
    'standin.desktop_label': 'Ordinateur de bureau',
    'standin.desktop_value': 'Les téléphones ou tablettes sur le bureau deviennent les enceintes',
    'standin.laptop_label': 'Ordinateur portable',
    'standin.laptop_value':
      'Plusieurs appareils remplacent les haut-parleurs intégrés au son trop faible',
    'standin.feature_label': 'Fonction',
    'standin.feature_value': 'Partage de l’audio système (Beta)',
    'standin.platform_label': 'Plateforme',
    'standin.platform_value': 'Navigateurs pour ordinateur basés sur Chromium',
    'standin.caveat':
      'Beta : Chromium sur ordinateur uniquement, jusqu’à quatre appareils connectés, émetteur compris. Chaque partage en salon Standard et chaque partage relayé par Cloudflare (SFU) prend fin après deux heures ; un partage PRO LAN-direct vérifié peut continuer tant que l’autorité du salon reste joignable. L’audio en direct a une latence inévitable ; baissez le volume de l’appareil émetteur.',
    'cta.h2': 'Créez un salon.',
    'cta.btn': 'Lancer MUSIXQUARE',
    'footer.app': 'Application',
    'footer.history': 'Historique',
    'footer.designsystem': 'Design System',
  });

  addLang('de', {
    'meta.title': 'Über MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE macht mehrere Smartphones, Tablets und Laptops zu einem synchronisierten Soundsystem. Direkt im Browser, ohne Installation.',
    'meta.og_title': 'Über MUSIXQUARE',
    'meta.og_description':
      'Alle Geräte, ein System. Synchrones Audio über mehrere Geräte, ohne Installation.',
    'meta.og_image_alt': 'MUSIXQUARE: Alle Geräte, ein System.',
    'meta.tw_title': 'Über MUSIXQUARE',
    'meta.tw_description': 'Alle Geräte, ein System.',
    'header.logo_aria': 'Nach oben',
    'header.try': 'Jetzt ausprobieren',
    'header.try_aria': 'MUSIXQUARE jetzt ausprobieren',
    'hero.h1': 'Alle Geräte<br>ein System',
    'hero.lead':
      'MUSIXQUARE verbindet mehrere Smartphones, Tablets und Laptops zu einem Soundsystem. Keine Installation, einfach einen Code teilen.',
    'hero.btn_ghost': 'So funktioniert es',
    'hero.rooms_opened': 'Bisher wurden {{count}} Räume geöffnet.',
    'array.h2': 'Surround-Sound<br>ohne Surround-Lautsprecher',
    'array.lead':
      'Jedes Gerät übernimmt eine Rolle: links, rechts, Subwoofer oder vollständiges Stereo. Der ganze Raum wird zum System.',
    'array.aria':
      'Linkes Smartphone, Laptop in der Mitte, rechtes Smartphone. Surround-Setup mit drei Geräten.',
    'code.h2': 'Sechs Ziffern<br>reichen aus',
    'code.lead':
      'Raum öffnen, sechsstelligen Code teilen. Mit einem unterstützten Browser ist jedes Gerät in Sekunden verbunden.',
    'code.aria_code': 'Beispiel-Raumcode',
    'code.aria_qr': 'QR-Code für musixquare.com',
    'code.copy_btn': 'Einladungslink kopieren',
    'code.toast_success': 'Einladungslink kopiert',
    'code.toast_fail': 'Kopieren fehlgeschlagen',
    'remote.h2': 'Nicht im selben Raum?<br>Kein Problem',
    'remote.lead':
      'Chatten, Musik hören oder YouTube gemeinsam ansehen, auch wenn ihr nicht am selben Ort seid.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Echtzeit-Chat',
    'remote.whisper_label': 'Privat',
    'remote.whisper_value': 'Private 1:1-Nachrichten',
    'remote.cowatch_label': 'Gemeinsam schauen',
    'remote.cowatch_value': 'YouTube synchron ansehen',
    'remote.reach_label': 'Verfügbarkeit',
    'remote.reach_value': 'Unterstützte Browser, auch über verschiedene Netzwerke',
    'remote.caveat':
      'Hinweis: Im YouTube-Modus sind Kanaltrennung und Audioeffekte nicht verfügbar.',
    'remote.pin_label': 'ANKÜNDIGUNG · HOST',
    'remote.pin_text': 'Playlist-Tipps gesucht',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'wo bist du?',
    'remote.peer_name': 'Teilnehmer 1',
    'remote.peer_msg1': 'arbeite gerade im Café haha',
    'remote.peer_ts_msg': 'der Song ist echt gut',
    'remote.host_msg2': 'spiel ich später',
    'remote.whisper_sender': 'Private Nachricht an HOST',
    'remote.whisper_msg': 'frag in der Ankündigung nach Playlist-Tipps',
    'sync.h2': 'Synchrone Wiedergabe<br>über Netzwerke hinweg',
    'sync.lead': 'Jedes Gerät misst die Verzögerung und richtet die Wiedergabe präzise aus.',
    'sync.video_label': 'Medien',
    'sync.video_value': 'Synchrone Medienwiedergabe',
    'sync.transport_label': 'Transport',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Effekte',
    'sync.effects_value': '5-Band-EQ · Hall · Virtualisierung',
    'sync.platforms_label': 'Plattformen',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'HOST',
    'sync.meta': 'NTP-ähnliche Synchronisierung mit 60 Messungen',
    'standin.h2': 'Keine Lautsprecher<br>am Computer?',
    'standin.lead':
      'MUSIXQUARE hilft schnell aus. Ein Smartphone und ein Tablet aus der Tasche reichen zum Starten.',
    'standin.aria':
      'Stummgeschalteter Computer über zwei aktiven Smartphones, die als linker und rechter Lautsprecher dienen',
    'standin.desktop_label': 'Desktop',
    'standin.desktop_value':
      'Smartphones oder Tablets auf dem Schreibtisch werden zu Lautsprechern',
    'standin.laptop_label': 'Laptop',
    'standin.laptop_value': 'Mehrere Geräte statt schwacher integrierter Lautsprecher',
    'standin.feature_label': 'Funktion',
    'standin.feature_value': 'Systemaudio teilen (Beta)',
    'standin.platform_label': 'Plattform',
    'standin.platform_value': 'Chromium-basierte Browser auf Computern',
    'standin.caveat':
      'Beta: nur Chromium auf Computern, bis zu vier verbundene Geräte einschließlich Sender. Jede Freigabe in einem Standard-Raum und jede über Cloudflare übertragene Freigabe (SFU) endet nach zwei Stunden; eine verifizierte PRO-LAN-Direktfreigabe kann fortgesetzt werden, solange die Raumautorisierung erreichbar bleibt. Live-Audio hat unvermeidbare Latenz; die Lautstärke des sendenden Geräts sollte gesenkt werden.',
    'cta.h2': 'Jetzt starten',
    'cta.btn': 'MUSIXQUARE starten',
    'footer.app': 'App',
    'footer.history': 'Geschichte',
    'footer.designsystem': 'Designsystem',
  });

  addLang('nl', {
    'meta.title': 'Over MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE maakt van meerdere telefoons, tablets en laptops één gesynchroniseerd geluidssysteem. Direct in de browser, zonder installatie.',
    'meta.og_title': 'Over MUSIXQUARE',
    'meta.og_description':
      'Alle apparaten, één systeem. Gesynchroniseerde audio op meerdere apparaten, zonder installatie.',
    'meta.og_image_alt': 'MUSIXQUARE: alle apparaten, één systeem.',
    'meta.tw_title': 'Over MUSIXQUARE',
    'meta.tw_description': 'Alle apparaten, één systeem.',
    'header.logo_aria': 'Terug naar boven',
    'header.try': 'Nu proberen',
    'header.try_aria': 'MUSIXQUARE nu proberen',
    'hero.h1': 'Elk apparaat,<br>één systeem',
    'hero.lead':
      'MUSIXQUARE maakt van meerdere telefoons, tablets en laptops één geluidssysteem. Geen installatie: deel gewoon één code.',
    'hero.btn_ghost': 'Zo werkt het',
    'hero.rooms_opened': 'Tot nu toe zijn {{count}} kamers geopend.',
    'array.h2': 'Surroundgeluid<br>zonder surroundspeakers',
    'array.lead':
      'Elk apparaat krijgt één rol: links, rechts, subwoofer of volledig stereogeluid. De ruimte zelf wordt het systeem.',
    'array.aria':
      'Telefoon links, laptop in het midden en telefoon rechts. Surroundopstelling met drie apparaten.',
    'code.h2': 'Zes cijfers<br>meer is niet nodig',
    'code.lead':
      'Start een sessie en deel de zescijferige uitnodigingscode. Iedereen met een ondersteunde browser kan binnen enkele seconden deelnemen.',
    'code.aria_code': 'Voorbeeld van een uitnodigingscode',
    'code.aria_qr': 'QR-code voor musixquare.com',
    'code.copy_btn': 'Uitnodigingslink kopiëren',
    'code.toast_success': 'Uitnodigingslink gekopieerd',
    'code.toast_fail': 'Kopiëren mislukt',
    'remote.h2': 'Niet in dezelfde ruimte?<br>Geen probleem',
    'remote.lead':
      'Chat, luister naar muziek of kijk samen naar YouTube, zelfs als je niet op dezelfde plek bent.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Realtimechat',
    'remote.whisper_label': 'Fluisterbericht',
    'remote.whisper_value': 'Privéberichten één-op-één',
    'remote.cowatch_label': 'Samen kijken',
    'remote.cowatch_value': 'Samen synchroon YouTube kijken',
    'remote.reach_label': 'Bereik',
    'remote.reach_value': 'Ondersteunde browsers, ook over verschillende netwerken',
    'remote.caveat':
      'Let op: kanaalsplitsing en audio-effecten zijn niet beschikbaar in de YouTube-modus.',
    'remote.pin_label': 'MEDEDELING · HOST',
    'remote.pin_text': 'Playlisttips gezocht',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'waar ben je?',
    'remote.peer_name': 'Peer 1',
    'remote.peer_msg1': 'aan het werk in een café haha',
    'remote.peer_ts_msg': 'dit nummer is best goed',
    'remote.host_msg2': 'ik zet ’m straks op',
    'remote.whisper_sender': 'fluisterbericht aan HOST',
    'remote.whisper_msg': 'vraag in de mededeling om playlisttips',
    'sync.h2': 'Synchroon afspelen<br>over verschillende netwerken',
    'sync.lead': 'Elk apparaat meet de vertraging en laat het afspelen precies gelijklopen.',
    'sync.video_label': 'MEDIA',
    'sync.video_value': 'Synchroon afspelen van media',
    'sync.transport_label': 'Overdracht',
    'sync.transport_value': 'P2P, WebRTC',
    'sync.effects_label': 'Effecten',
    'sync.effects_value': '5-bands-EQ · Reverb · Virtualizer',
    'sync.platforms_label': 'Platformen',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Host',
    'sync.meta': 'NTP-achtige synchronisatie met 60 metingen',
    'standin.h2': 'Heeft je computer<br>geen luidsprekers?',
    'standin.lead':
      'MUSIXQUARE biedt snel uitkomst. Met een telefoon en een tablet uit je tas kun je meteen beginnen.',
    'standin.aria':
      'Stille computer boven twee actieve telefoons die als linker- en rechterluidspreker werken',
    'standin.desktop_label': 'Desktop-pc',
    'standin.desktop_value': 'Telefoons of tablets op het bureau worden de luidsprekers',
    'standin.laptop_label': 'Laptop',
    'standin.laptop_value': 'Meerdere apparaten in plaats van zwakke ingebouwde luidsprekers',
    'standin.feature_label': 'Functie',
    'standin.feature_value': 'Systeem-audio delen (Beta)',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Chromium-browsers op computers',
    'standin.caveat':
      'Beta: alleen Chromium op computers, maximaal vier verbonden apparaten inclusief zender. Elke sessie in een Standard-kamer en elke via Cloudflare doorgestuurde sessie (SFU) eindigt na twee uur; een geverifieerde PRO LAN-direct-sessie kan doorgaan zolang de kamerautoriteit bereikbaar blijft. Live audio heeft onvermijdelijke vertraging; zet het volume van het delende apparaat lager.',
    'cta.h2': 'Start een sessie',
    'cta.btn': 'MUSIXQUARE openen',
    'footer.app': 'App',
    'footer.history': 'Geschiedenis',
    'footer.designsystem': 'Designsysteem',
  });

  addLang('it', {
    'meta.title': 'Informazioni su MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE trasforma più telefoni, tablet e laptop in un sistema audio sincronizzato. Funziona nel browser, senza installazione.',
    'meta.og_title': 'Informazioni su MUSIXQUARE',
    'meta.og_description':
      'Tutti i dispositivi, un solo sistema. Audio sincronizzato su più dispositivi, senza installazione.',
    'meta.og_image_alt': 'MUSIXQUARE: tutti i dispositivi, un solo sistema.',
    'meta.tw_title': 'Informazioni su MUSIXQUARE',
    'meta.tw_description': 'Tutti i dispositivi, un solo sistema.',
    'header.logo_aria': 'Torna in cima',
    'header.try': 'Provalo ora',
    'header.try_aria': 'Prova MUSIXQUARE ora',
    'hero.h1': 'Ogni dispositivo<br>un solo sistema',
    'hero.lead':
      'MUSIXQUARE collega più telefoni, tablet e laptop in un unico sistema audio. Nessuna installazione: basta condividere un codice.',
    'hero.btn_ghost': 'Scopri come funziona',
    'hero.rooms_opened': 'Finora sono state aperte {{count}} stanze.',
    'array.h2': 'Surround<br>senza casse surround',
    'array.lead':
      'Ogni dispositivo può fungere da canale sinistro, canale destro, subwoofer o stereo completo. L’intera stanza diventa il sistema.',
    'array.aria':
      'Telefono a sinistra, laptop al centro, telefono a destra. Configurazione surround a tre dispositivi.',
    'code.h2': 'Bastano sei cifre<br>e sei dentro',
    'code.lead':
      'Apri una stanza e condividi il codice a sei cifre. Qualsiasi dispositivo con un browser supportato può entrare in pochi secondi.',
    'code.aria_code': 'Esempio di codice stanza',
    'code.aria_qr': 'Codice QR per musixquare.com',
    'code.copy_btn': 'Copia link di invito',
    'code.toast_success': 'Link di invito copiato',
    'code.toast_fail': 'Copia non riuscita',
    'remote.h2': 'Non siete nello stesso posto?<br>Nessun problema',
    'remote.lead': 'Potete chattare, ascoltare musica o guardare YouTube insieme anche a distanza.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Chat in tempo reale',
    'remote.whisper_label': 'Privato',
    'remote.whisper_value': 'Messaggi privati 1:1',
    'remote.cowatch_label': 'Guarda insieme',
    'remote.cowatch_value': 'YouTube sincronizzato',
    'remote.reach_label': 'Accesso',
    'remote.reach_value': 'Browser supportati, anche su reti diverse',
    'remote.caveat':
      'Nota: in modalità YouTube la separazione dei canali e gli effetti audio non sono disponibili.',
    'remote.pin_label': 'AVVISO · HOST',
    'remote.pin_text': 'Qualche playlist da consigliare?',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'dove sei?',
    'remote.peer_name': 'Partecipante 1',
    'remote.peer_msg1': 'sto lavorando al bar ahah',
    'remote.peer_ts_msg': 'questa canzone non è male',
    'remote.host_msg2': 'la metto dopo',
    'remote.whisper_sender': 'messaggio privato a HOST',
    'remote.whisper_msg': 'chiedi nell’avviso se hanno playlist da consigliare',
    'sync.h2': 'Riproduzione sincronizzata<br>anche tra reti diverse',
    'sync.lead': 'Ogni dispositivo misura il ritardo e allinea con precisione la riproduzione.',
    'sync.video_label': 'Contenuti',
    'sync.video_value': 'Riproduzione multimediale sincronizzata',
    'sync.transport_label': 'Trasporto',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Effetti',
    'sync.effects_value': 'EQ a 5 bande · Riverbero · Virtualizzazione',
    'sync.platforms_label': 'Piattaforme',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'HOST',
    'sync.meta': 'Sincronizzazione tipo NTP con 60 campioni',
    'standin.h2': 'Il computer<br>non ha altoparlanti?',
    'standin.lead':
      'MUSIXQUARE può essere una soluzione veloce. Bastano un telefono e un tablet nella borsa.',
    'standin.aria':
      'Computer silenziato sopra due telefoni attivi usati come altoparlanti sinistro e destro',
    'standin.desktop_label': 'Desktop',
    'standin.desktop_value': 'Telefoni o tablet sulla scrivania diventano altoparlanti',
    'standin.laptop_label': 'Laptop',
    'standin.laptop_value': 'Più dispositivi al posto di altoparlanti integrati di scarsa qualità',
    'standin.feature_label': 'Funzione',
    'standin.feature_value': 'Condivisione audio di sistema (Beta)',
    'standin.platform_label': 'Piattaforma',
    'standin.platform_value': 'Browser basati su Chromium sui computer',
    'standin.caveat':
      'Beta: solo Chromium su computer, fino a quattro dispositivi connessi incluso chi trasmette. Ogni condivisione in una stanza Standard e ogni condivisione inoltrata da Cloudflare (SFU) termina dopo due ore; una condivisione PRO LAN-direct verificata può continuare finché l’autorità della stanza resta raggiungibile. L’audio live ha latenza inevitabile; abbassa il volume del dispositivo che condivide.',
    'cta.h2': 'Inizia ora',
    'cta.btn': 'Avvia MUSIXQUARE',
    'footer.app': 'App',
    'footer.history': 'Storia',
    'footer.designsystem': 'Sistema di design',
  });

  addLang('pl', {
    'meta.title': 'O MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE zmienia wiele telefonów, tabletów i laptopów w zsynchronizowany system dźwiękowy. Działa w przeglądarce, bez instalacji.',
    'meta.og_title': 'O MUSIXQUARE',
    'meta.og_description':
      'Wszystkie urządzenia, jeden system. Synchronizowany dźwięk na wielu urządzeniach, bez instalacji.',
    'meta.og_image_alt': 'MUSIXQUARE: wszystkie urządzenia, jeden system.',
    'meta.tw_title': 'O MUSIXQUARE',
    'meta.tw_description': 'Wszystkie urządzenia, jeden system.',
    'header.logo_aria': 'Wróć na górę',
    'header.try': 'Wypróbuj teraz',
    'header.try_aria': 'Wypróbuj MUSIXQUARE teraz',
    'hero.h1': 'Wszystkie urządzenia,<br>jeden system',
    'hero.lead':
      'MUSIXQUARE łączy wiele telefonów, tabletów i laptopów w jeden system dźwiękowy. Bez instalacji: wystarczy udostępnić kod.',
    'hero.btn_ghost': 'Zobacz, jak to działa',
    'hero.rooms_opened': 'Liczba dotychczas otwartych pokoi: {{count}}.',
    'array.h2': 'Dźwięk surround<br>bez głośników surround',
    'array.lead':
      'Każde urządzenie ma jedną rolę: lewy głośnik, prawy głośnik, subwoofer albo pełne stereo. Cały pokój staje się systemem.',
    'array.aria':
      'Telefon po lewej, laptop pośrodku, telefon po prawej. Konfiguracja surround złożona z trzech urządzeń.',
    'code.h2': 'Wystarczy sześć cyfr<br>i gotowe',
    'code.lead':
      'Utwórz pokój i udostępnij sześciocyfrowy kod. Każdy, kto korzysta z obsługiwanej przeglądarki, może dołączyć w kilka sekund.',
    'code.aria_code': 'Przykładowy kod pokoju',
    'code.aria_qr': 'Kod QR dla musixquare.com',
    'code.copy_btn': 'Skopiuj link z zaproszeniem',
    'code.toast_success': 'Skopiowano link z zaproszeniem',
    'code.toast_fail': 'Nie udało się skopiować',
    'remote.h2': 'Nie jesteś w pokoju?<br>Żaden problem',
    'remote.lead':
      'Możesz czatować, słuchać muzyki albo oglądać YouTube razem z innymi, nawet z daleka.',
    'remote.chat_label': 'Czat',
    'remote.chat_value': 'Czat w czasie rzeczywistym',
    'remote.whisper_label': 'Wiadomość prywatna',
    'remote.whisper_value': 'Wiadomości prywatne jeden na jeden',
    'remote.cowatch_label': 'Wspólne oglądanie',
    'remote.cowatch_value': 'Zsynchronizowane oglądanie YouTube',
    'remote.reach_label': 'Zasięg',
    'remote.reach_value': 'Obsługiwane przeglądarki, także w różnych sieciach',
    'remote.caveat':
      'Uwaga: w trybie YouTube separacja kanałów i efekty dźwiękowe nie są dostępne.',
    'remote.pin_label': 'OGŁOSZENIE · HOST',
    'remote.pin_text': 'Polecajcie playlisty',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'gdzie jesteś?',
    'remote.peer_name': 'Uczestnik 1',
    'remote.peer_msg1': 'pracuję w kawiarni haha',
    'remote.peer_ts_msg': 'chyba fajny ten kawałek',
    'remote.host_msg2': 'puszczę go później',
    'remote.whisper_sender': 'prywatna wiadomość do hosta',
    'remote.whisper_msg': 'zapytaj w ogłoszeniu o polecane playlisty',
    'sync.h2': 'Zsynchronizowane odtwarzanie<br>w różnych sieciach',
    'sync.lead': 'Każde urządzenie mierzy opóźnienie i precyzyjnie wyrównuje odtwarzanie.',
    'sync.video_label': 'Media',
    'sync.video_value': 'Zsynchronizowane odtwarzanie multimediów',
    'sync.transport_label': 'Transport',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Efekty',
    'sync.effects_value': 'Korektor 5-pasmowy · Pogłos · Efekt przestrzenny',
    'sync.platforms_label': 'Platformy',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Host',
    'sync.meta': 'Synchronizacja typu NTP z 60 próbkami',
    'standin.h2': 'Komputer<br>nie ma głośników?',
    'standin.lead': 'MUSIXQUARE może szybko zastąpić głośniki. Wystarczą telefon i tablet z torby.',
    'standin.aria':
      'Komputer bez dźwięku nad dwoma aktywnymi telefonami pełniącymi rolę lewego i prawego głośnika',
    'standin.desktop_label': 'Komputer stacjonarny',
    'standin.desktop_value': 'Telefon lub tablet na biurku staje się głośnikiem',
    'standin.laptop_label': 'Laptop',
    'standin.laptop_value': 'Kilka urządzeń zastępuje słabe wbudowane głośniki',
    'standin.feature_label': 'Funkcja',
    'standin.feature_value': 'Udostępnianie dźwięku systemowego (Beta)',
    'standin.platform_label': 'Platforma',
    'standin.platform_value': 'Przeglądarki oparte na Chromium działające na komputerach',
    'standin.caveat':
      'Beta: tylko Chromium na komputerze, maksymalnie cztery urządzenia łącznie z nadającym. Każde udostępnianie w pokoju Standard i każde udostępnianie przekazywane przez Cloudflare (SFU) kończy się po dwóch godzinach; zweryfikowane udostępnianie PRO LAN-direct może trwać, dopóki autoryzacja pokoju pozostaje dostępna. Dźwięk na żywo ma nieuniknione opóźnienie; zmniejsz głośność urządzenia udostępniającego.',
    'cta.h2': 'Utwórz pokój.',
    'cta.btn': 'Uruchom MUSIXQUARE',
    'footer.app': 'Aplikacja',
    'footer.history': 'Historia',
    'footer.designsystem': 'System projektowy',
  });

  addLang('ru', {
    'meta.title': 'О MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE превращает несколько телефонов, планшетов и ноутбуков в синхронизированную аудиосистему. Работает прямо в браузере, без установки.',
    'meta.og_title': 'О MUSIXQUARE',
    'meta.og_description':
      'Все устройства, одна система. Синхронный звук на нескольких устройствах, без установки.',
    'meta.og_image_alt': 'MUSIXQUARE: все устройства, одна система.',
    'meta.tw_title': 'О MUSIXQUARE',
    'meta.tw_description': 'Все устройства, одна система.',
    'header.logo_aria': 'Вернуться наверх',
    'header.try': 'Попробовать',
    'header.try_aria': 'Попробовать MUSIXQUARE',
    'hero.h1': 'Все устройства<br>одна система',
    'hero.lead':
      'MUSIXQUARE объединяет несколько телефонов, планшетов и ноутбуков в единую аудиосистему. Без установки: просто поделитесь одним кодом.',
    'hero.btn_ghost': 'Как это работает',
    'hero.rooms_opened': 'Уже открыто {{count}} комнат.',
    'array.h2': 'Объёмный звук<br>без специальных колонок',
    'array.lead':
      'Каждое устройство может взять на себя одну роль: левый, правый, сабвуфер или полноценное стерео. Вся комната становится системой.',
    'array.aria':
      'Телефон слева, ноутбук в центре, телефон справа. Система объёмного звука из трёх устройств.',
    'code.h2': 'Шесть цифр<br>и всё готово',
    'code.lead':
      'Откройте комнату и поделитесь шестизначным кодом. Любое устройство с поддерживаемым браузером подключится за несколько секунд.',
    'code.aria_code': 'Пример кода комнаты',
    'code.aria_qr': 'QR-код для musixquare.com',
    'code.copy_btn': 'Скопировать ссылку-приглашение',
    'code.toast_success': 'Ссылка-приглашение скопирована',
    'code.toast_fail': 'Не удалось скопировать',
    'remote.h2': 'Не в одной комнате?<br>Ничего страшного',
    'remote.lead':
      'Можно переписываться, слушать музыку или вместе смотреть YouTube даже на расстоянии.',
    'remote.chat_label': 'Чат',
    'remote.chat_value': 'Чат в реальном времени',
    'remote.whisper_label': 'Личное сообщение',
    'remote.whisper_value': 'Личные сообщения один на один',
    'remote.cowatch_label': 'Смотреть вместе',
    'remote.cowatch_value': 'Синхронный просмотр YouTube',
    'remote.reach_label': 'Доступ',
    'remote.reach_value': 'Поддерживаемые браузеры в разных сетях',
    'remote.caveat': 'Примечание: в режиме YouTube недоступны разделение каналов и аудиоэффекты.',
    'remote.pin_label': 'ОБЪЯВЛЕНИЕ · ХОСТ',
    'remote.pin_text': 'Кидайте плейлисты',
    'remote.host_name': 'ХОСТ',
    'remote.host_msg1': 'ты где?',
    'remote.peer_name': 'Участник 1',
    'remote.peer_msg1': 'работаю в кофейне ахах',
    'remote.peer_ts_msg': 'кажется, трек неплохой',
    'remote.host_msg2': 'потом включу',
    'remote.whisper_sender': 'личное сообщение ХОСТУ',
    'remote.whisper_msg': 'попроси в объявлении посоветовать плейлисты',
    'sync.h2': 'Синхронное воспроизведение<br>между разными сетями',
    'sync.lead': 'Каждое устройство измеряет задержку и точно выравнивает воспроизведение.',
    'sync.video_label': 'Медиа',
    'sync.video_value': 'Синхронное воспроизведение медиа',
    'sync.transport_label': 'Передача',
    'sync.transport_value': 'P2P, WebRTC',
    'sync.effects_label': 'Эффекты',
    'sync.effects_value': '5-полосный эквалайзер · Реверберация · Виртуализатор',
    'sync.platforms_label': 'Платформы',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Хост',
    'sync.meta': 'Синхронизация в стиле NTP по 60 замерам',
    'standin.h2': 'На компьютере<br>нет колонок?',
    'standin.lead': 'MUSIXQUARE может быстро выручить. Достаточно телефона и планшета из сумки.',
    'standin.aria':
      'Компьютер без звука над двумя активными телефонами, которые работают как левая и правая колонки',
    'standin.desktop_label': 'Компьютер',
    'standin.desktop_value': 'Телефоны или планшеты на столе становятся колонками',
    'standin.laptop_label': 'Ноутбук',
    'standin.laptop_value': 'Несколько устройств вместо слабых встроенных динамиков',
    'standin.feature_label': 'Функция',
    'standin.feature_value': 'Трансляция системного звука (Beta)',
    'standin.platform_label': 'Платформа',
    'standin.platform_value': 'Браузеры на базе Chromium на компьютерах',
    'standin.caveat':
      'Beta: только Chromium на компьютере, до четырёх устройств вместе с источником. Каждая трансляция в обычной комнате и каждая трансляция через Cloudflare (SFU) завершается через два часа; проверенная прямая PRO-трансляция по локальной сети может продолжаться, пока доступна авторизация комнаты. У живого звука неизбежна задержка; уменьшите громкость устройства-источника.',
    'cta.h2': 'Создайте комнату.',
    'cta.btn': 'Запустить MUSIXQUARE',
    'footer.app': 'Приложение',
    'footer.history': 'История',
    'footer.designsystem': 'Дизайн-система',
  });

  addLang('tr', {
    'meta.title': 'MUSIXQUARE Hakkında',
    'meta.description':
      'MUSIXQUARE birden fazla telefonu, tableti ve dizüstü bilgisayarı senkronize bir ses sistemine dönüştürür. Tarayıcıda çalışır, kurulum gerekmez.',
    'meta.og_title': 'MUSIXQUARE Hakkında',
    'meta.og_description':
      'Tüm cihazlar, tek sistem. Kurulum gerektirmeyen çok cihazlı senkron ses.',
    'meta.og_image_alt': 'MUSIXQUARE: tüm cihazlar, tek sistem.',
    'meta.tw_title': 'MUSIXQUARE Hakkında',
    'meta.tw_description': 'Tüm cihazlar, tek sistem.',
    'header.logo_aria': 'Başa dön',
    'header.try': 'Hemen dene',
    'header.try_aria': 'MUSIXQUARE’i hemen dene',
    'hero.h1': 'Her cihaz<br>tek sistem',
    'hero.lead':
      'MUSIXQUARE birden fazla telefonu, tableti ve dizüstü bilgisayarı tek bir ses sisteminde birleştirir. Kurulum yok; tek bir kod paylaşman yeterli.',
    'hero.btn_ghost': 'Nasıl çalışır',
    'hero.rooms_opened': 'Şimdiye kadar {{count}} oda açıldı.',
    'array.h2': 'Çevresel hoparlör olmadan<br>çevresel ses',
    'array.lead':
      'Her cihaz sol, sağ, subwoofer veya tam stereo rolünü üstlenebilir. Odanın tamamı sisteme dönüşür.',
    'array.aria':
      'Solda telefon, ortada dizüstü bilgisayar, sağda telefon. Üç cihazlı çevresel ses kurulumu.',
    'code.h2': 'Altı hane yeter<br>hepsi bu',
    'code.lead':
      'Bir oda aç ve altı haneli kodu paylaş. Desteklenen bir tarayıcıya sahip her cihaz saniyeler içinde katılabilir.',
    'code.aria_code': 'Örnek oda kodu',
    'code.aria_qr': 'musixquare.com QR kodu',
    'code.copy_btn': 'Davet bağlantısını kopyala',
    'code.toast_success': 'Davet bağlantısı kopyalandı',
    'code.toast_fail': 'Kopyalanamadı',
    'remote.h2': 'Aynı yerde değil misin?<br>Sorun değil',
    'remote.lead':
      'Uzakta olsan bile sohbet edebilir, müzik dinleyebilir veya YouTube’u birlikte izleyebilirsin.',
    'remote.chat_label': 'Sohbet',
    'remote.chat_value': 'Gerçek zamanlı sohbet',
    'remote.whisper_label': 'Özel',
    'remote.whisper_value': '1:1 özel mesajlar',
    'remote.cowatch_label': 'Birlikte izle',
    'remote.cowatch_value': 'Senkron YouTube',
    'remote.reach_label': 'Erişim',
    'remote.reach_value': 'Desteklenen tarayıcılar, farklı ağlar arasında',
    'remote.caveat': 'Not: YouTube modunda kanal ayırma ve ses efektleri kullanılamaz.',
    'remote.pin_label': 'DUYURU · ODA SAHİBİ',
    'remote.pin_text': 'Playlist önerisi alayım',
    'remote.host_name': 'ODA SAHİBİ',
    'remote.host_msg1': 'neredesin?',
    'remote.peer_name': 'Katılımcı 1',
    'remote.peer_msg1': 'kafede çalışıyorum haha',
    'remote.peer_ts_msg': 'bu şarkı iyi gibi',
    'remote.host_msg2': 'sonra açarım',
    'remote.whisper_sender': 'ODA SAHİBİNE özel mesaj',
    'remote.whisper_msg': 'duyuruda playlist önerisi istesene',
    'sync.h2': 'Ağlar arasında<br>senkronize oynatma',
    'sync.lead': 'Her cihaz gecikmeyi ölçer ve oynatmayı hassas biçimde hizalar.',
    'sync.video_label': 'Medya',
    'sync.video_value': 'Senkronize medya oynatma',
    'sync.transport_label': 'Aktarım',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Efektler',
    'sync.effects_value': '5 bant EQ · Yankı · Sanallaştırıcı',
    'sync.platforms_label': 'Platformlar',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'ODA SAHİBİ',
    'sync.meta': '60 örnekli NTP tarzı senkronizasyon',
    'standin.h2': 'Bilgisayarında<br>hoparlör yok mu?',
    'standin.lead':
      'MUSIXQUARE hızlı bir çözüm olabilir. Çantandaki telefon ve tablet başlamak için yeterli.',
    'standin.aria':
      'Sesi kapalı bilgisayarın altında sol ve sağ hoparlör görevi gören iki aktif telefon',
    'standin.desktop_label': 'Masaüstü',
    'standin.desktop_value': 'Masadaki telefon veya tabletler hoparlöre dönüşür',
    'standin.laptop_label': 'Dizüstü',
    'standin.laptop_value': 'Zayıf dahili hoparlörler yerine birden çok cihaz',
    'standin.feature_label': 'Özellik',
    'standin.feature_value': 'Sistem sesi paylaşımı (Beta)',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Bilgisayarlardaki Chromium tabanlı tarayıcılar',
    'standin.caveat':
      'Beta: yalnızca bilgisayarda Chromium, yayıncı dahil en fazla dört cihaz. Her Standard oda paylaşımı ve Cloudflare üzerinden aktarılan her paylaşım (SFU) iki saat sonra sona erer; doğrulanmış bir PRO LAN-direct paylaşımı oda yetkisi erişilebilir kaldığı sürece devam edebilir. Canlı seste kaçınılmaz gecikme vardır; paylaşan cihazın sesini kısın.',
    'cta.h2': 'Şimdi başla',
    'cta.btn': 'MUSIXQUARE’i aç',
    'footer.app': 'Uygulama',
    'footer.history': 'Tarihçe',
    'footer.designsystem': 'Tasarım Sistemi',
  });

  addLang('id', {
    'meta.title': 'Tentang MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE mengubah beberapa ponsel, tablet, dan laptop menjadi satu sistem suara tersinkronisasi. Langsung di browser, tanpa instalasi.',
    'meta.og_title': 'Tentang MUSIXQUARE',
    'meta.og_description':
      'Semua perangkat, satu sistem. Audio tersinkronisasi di beberapa perangkat, tanpa instalasi.',
    'meta.og_image_alt': 'MUSIXQUARE: semua perangkat, satu sistem.',
    'meta.tw_title': 'Tentang MUSIXQUARE',
    'meta.tw_description': 'Semua perangkat, satu sistem.',
    'header.logo_aria': 'Kembali ke atas halaman',
    'header.try': 'Coba sekarang',
    'header.try_aria': 'Coba MUSIXQUARE sekarang',
    'hero.h1': 'Semua perangkat,<br>satu sistem.',
    'hero.lead':
      'MUSIXQUARE menghubungkan beberapa ponsel, tablet, dan laptop menjadi satu sistem suara. Tanpa instalasi, cukup bagikan satu kode.',
    'hero.btn_ghost': 'Lihat cara kerjanya',
    'hero.rooms_opened': 'Sejauh ini {{count}} ruang telah dibuka.',
    'array.h2': 'Suara surround<br>tanpa speaker surround',
    'array.lead':
      'Setiap perangkat memainkan satu peran: speaker kiri, speaker kanan, subwoofer, atau stereo penuh. Seluruh ruang menjadi satu sistem audio.',
    'array.aria':
      'Ponsel di kiri, laptop di tengah, ponsel di kanan. Susunan surround dengan tiga perangkat.',
    'code.h2': 'Enam digit.<br>Itu saja.',
    'code.lead':
      'Buat ruang lalu bagikan kode enam digit. Siapa pun yang menggunakan browser yang didukung dapat bergabung dalam hitungan detik.',
    'code.aria_code': 'Contoh kode ruang',
    'code.aria_qr': 'Kode QR untuk musixquare.com',
    'code.copy_btn': 'Salin tautan undangan',
    'code.toast_success': 'Tautan undangan disalin',
    'code.toast_fail': 'Gagal menyalin',
    'remote.h2': 'Berada di tempat lain?<br>Tidak masalah.',
    'remote.lead':
      'Tetap bisa mengobrol, mendengarkan musik, atau menonton YouTube bersama dari jarak jauh.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Chat waktu nyata',
    'remote.whisper_label': 'Pesan pribadi',
    'remote.whisper_value': 'Pesan pribadi satu lawan satu',
    'remote.cowatch_label': 'Nonton bareng',
    'remote.cowatch_value': 'YouTube bersama dan tersinkronisasi',
    'remote.reach_label': 'Jangkauan',
    'remote.reach_value': 'Browser yang didukung, lintas jaringan',
    'remote.caveat':
      'Catatan: pemisahan kanal dan efek audio tidak tersedia saat menggunakan YouTube.',
    'remote.pin_label': 'PENGUMUMAN · HOST',
    'remote.pin_text': 'Minta rekomendasi playlist dong',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'lagi di mana?',
    'remote.peer_name': 'Peserta 1',
    'remote.peer_msg1': 'lagi kerja di kafe wkwk',
    'remote.peer_ts_msg': 'lagu ini enak juga',
    'remote.host_msg2': 'nanti aku putar',
    'remote.whisper_sender': 'pesan pribadi kepada HOST',
    'remote.whisper_msg': 'coba minta rekomendasi playlist di pengumuman',
    'sync.h2': 'Pemutaran tersinkronisasi.<br>Lintas jaringan.',
    'sync.lead': 'Setiap perangkat mengukur jeda lalu menyelaraskan pemutaran dengan tepat.',
    'sync.video_label': 'Media',
    'sync.video_value': 'Pemutaran media tersinkronisasi',
    'sync.transport_label': 'Transmisi',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Efek',
    'sync.effects_value': 'EQ 5 pita · Gema · Virtualisasi',
    'sync.platforms_label': 'Platform',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Host',
    'sync.meta': 'Sinkronisasi ala NTP dengan 60 sampel',
    'standin.h2': 'Komputer Anda<br>tidak punya speaker?',
    'standin.lead':
      'MUSIXQUARE dapat menjadi pengganti speaker sementara. Ponsel dan tablet di tas Anda sudah cukup untuk mulai.',
    'standin.aria':
      'Komputer tanpa suara di atas dua ponsel aktif yang berperan sebagai speaker kiri dan kanan',
    'standin.desktop_label': 'Komputer desktop',
    'standin.desktop_value': 'Ponsel atau tablet di meja menjadi speaker',
    'standin.laptop_label': 'Laptop',
    'standin.laptop_value': 'Beberapa perangkat menggantikan speaker bawaan yang lemah',
    'standin.feature_label': 'Fitur',
    'standin.feature_value': 'Berbagi audio sistem (Beta)',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Browser berbasis Chromium di komputer',
    'standin.caveat':
      'Beta: hanya Chromium di komputer, maksimal empat perangkat termasuk pengirim. Setiap sesi ruang Standard dan setiap sesi yang direlai melalui Cloudflare (SFU) berakhir setelah dua jam; sesi PRO LAN-direct yang terverifikasi dapat berlanjut selama otoritas ruang tetap dapat dijangkau. Audio langsung memiliki latensi yang tak terhindarkan; kecilkan volume perangkat pengirim.',
    'cta.h2': 'Mulai sesi.',
    'cta.btn': 'Buka MUSIXQUARE',
    'footer.app': 'Aplikasi',
    'footer.history': 'Riwayat',
    'footer.designsystem': 'Sistem Desain',
  });

  addLang('vi', {
    'meta.title': 'Giới thiệu MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE biến nhiều điện thoại, máy tính bảng và máy tính xách tay thành một hệ thống âm thanh đồng bộ. Chạy ngay trong trình duyệt, không cần cài đặt.',
    'meta.og_title': 'Giới thiệu MUSIXQUARE',
    'meta.og_description':
      'Mọi thiết bị, một hệ thống. Âm thanh đồng bộ trên nhiều thiết bị, không cần cài đặt.',
    'meta.og_image_alt': 'MUSIXQUARE: mọi thiết bị, một hệ thống.',
    'meta.tw_title': 'Giới thiệu MUSIXQUARE',
    'meta.tw_description': 'Mọi thiết bị, một hệ thống.',
    'header.logo_aria': 'Trở về đầu trang',
    'header.try': 'Thử ngay',
    'header.try_aria': 'Thử MUSIXQUARE ngay',
    'hero.h1': 'Mọi thiết bị,<br>một hệ thống.',
    'hero.lead':
      'MUSIXQUARE kết nối nhiều điện thoại, máy tính bảng và máy tính xách tay thành một hệ thống âm thanh. Không cần cài đặt, chỉ cần chia sẻ một mã.',
    'hero.btn_ghost': 'Xem cách hoạt động',
    'hero.rooms_opened': 'Đã có {{count}} phòng được mở.',
    'array.h2': 'Âm thanh vòm<br>không cần loa vòm.',
    'array.lead':
      'Mỗi thiết bị đảm nhận một vai trò: kênh trái, kênh phải, loa siêu trầm hoặc âm thanh nổi đầy đủ. Cả căn phòng trở thành một hệ thống âm thanh.',
    'array.aria':
      'Điện thoại bên trái, máy tính xách tay ở giữa, điện thoại bên phải. Thiết lập âm thanh vòm với ba thiết bị.',
    'code.h2': 'Chỉ sáu chữ số<br>là đủ',
    'code.lead':
      'Mở một phòng và chia sẻ mã sáu chữ số. Bất kỳ ai dùng trình duyệt được hỗ trợ đều có thể tham gia chỉ trong vài giây.',
    'code.aria_code': 'Mã phòng mẫu',
    'code.aria_qr': 'Mã QR cho musixquare.com',
    'code.copy_btn': 'Sao chép liên kết mời',
    'code.toast_success': 'Đã sao chép liên kết mời',
    'code.toast_fail': 'Không thể sao chép',
    'remote.h2': 'Không ở cùng một phòng?<br>Không sao cả.',
    'remote.lead': 'Bạn vẫn có thể trò chuyện, nghe nhạc hoặc xem YouTube cùng nhau dù đang ở xa.',
    'remote.chat_label': 'Trò chuyện',
    'remote.chat_value': 'Trò chuyện thời gian thực',
    'remote.whisper_label': 'Tin nhắn riêng',
    'remote.whisper_value': 'Tin nhắn riêng 1:1',
    'remote.cowatch_label': 'Cùng xem',
    'remote.cowatch_value': 'Cùng xem YouTube, luôn đồng bộ',
    'remote.reach_label': 'Phạm vi',
    'remote.reach_value': 'Trình duyệt được hỗ trợ, kể cả khi khác mạng',
    'remote.caveat': 'Lưu ý: chế độ YouTube không hỗ trợ tách kênh và hiệu ứng âm thanh.',
    'remote.pin_label': 'THÔNG BÁO · CHỦ PHÒNG',
    'remote.pin_text': 'Xin vài playlist hay',
    'remote.host_name': 'CHỦ PHÒNG',
    'remote.host_msg1': 'đang ở đâu?',
    'remote.peer_name': 'Người tham gia 1',
    'remote.peer_msg1': 'đang ngồi làm ở quán cà phê haha',
    'remote.peer_ts_msg': 'bài này nghe hay đấy',
    'remote.host_msg2': 'lát mở cho nghe',
    'remote.whisper_sender': 'nhắn riêng cho CHỦ PHÒNG',
    'remote.whisper_msg': 'đăng thông báo xin gợi ý playlist đi',
    'sync.h2': 'Phát đồng bộ.<br>Dù khác mạng.',
    'sync.lead': 'Mỗi thiết bị đo độ trễ rồi căn chỉnh phát thật chính xác.',
    'sync.video_label': 'ĐA PHƯƠNG TIỆN',
    'sync.video_value': 'Phát nội dung đa phương tiện đồng bộ',
    'sync.transport_label': 'Truyền tải',
    'sync.transport_value': 'Ngang hàng (P2P), WebRTC',
    'sync.effects_label': 'Hiệu ứng',
    'sync.effects_value': 'EQ 5 băng tần · Độ vang · Hiệu ứng ảo',
    'sync.platforms_label': 'Nền tảng',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Chủ phòng',
    'sync.meta': 'Đồng bộ kiểu NTP với 60 mẫu',
    'standin.h2': 'Máy tính của bạn<br>không có loa?',
    'standin.lead':
      'MUSIXQUARE là giải pháp thay thế nhanh chóng. Bạn chỉ cần một chiếc điện thoại và một chiếc máy tính bảng trong túi là có thể bắt đầu.',
    'standin.aria':
      'Máy tính không phát tiếng ở phía trên hai chiếc điện thoại đang hoạt động như loa trái và loa phải',
    'standin.desktop_label': 'Máy tính để bàn',
    'standin.desktop_value': 'Điện thoại hoặc máy tính bảng đặt trên bàn trở thành loa',
    'standin.laptop_label': 'Máy tính xách tay',
    'standin.laptop_value': 'Nhiều thiết bị thay thế loa tích hợp yếu',
    'standin.feature_label': 'Tính năng',
    'standin.feature_value': 'Chia sẻ âm thanh hệ thống (Beta)',
    'standin.platform_label': 'Nền tảng',
    'standin.platform_value': 'Trình duyệt nền Chromium trên máy tính',
    'standin.caveat':
      'Beta: chỉ Chromium trên máy tính, tối đa bốn thiết bị kể cả thiết bị phát. Mọi phiên chia sẻ trong phòng Standard và mọi phiên được chuyển tiếp qua Cloudflare (SFU) đều kết thúc sau hai giờ; phiên PRO LAN-direct đã xác minh có thể tiếp tục khi quyền điều phối phòng vẫn còn khả dụng. Âm thanh trực tiếp có độ trễ không tránh khỏi; hãy giảm âm lượng thiết bị phát.',
    'cta.h2': 'Mở một phòng.',
    'cta.btn': 'Mở MUSIXQUARE',
    'footer.app': 'Ứng dụng',
    'footer.history': 'Lịch sử',
    'footer.designsystem': 'Hệ thống thiết kế',
  });

  addLang('th', {
    'meta.title': 'เกี่ยวกับ MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE รวมอุปกรณ์หลายเครื่อง ทั้งโทรศัพท์ แท็บเล็ต และแล็ปท็อป ให้ซิงก์กันเป็นระบบเสียงเดียว ใช้งานผ่านเบราว์เซอร์ ไม่ต้องติดตั้ง',
    'meta.og_title': 'เกี่ยวกับ MUSIXQUARE',
    'meta.og_description': 'ทุกอุปกรณ์เป็นระบบเดียวกัน เสียงซิงก์กันบนหลายอุปกรณ์โดยไม่ต้องติดตั้ง',
    'meta.og_image_alt': 'MUSIXQUARE: ทุกอุปกรณ์เป็นระบบเดียวกัน',
    'meta.tw_title': 'เกี่ยวกับ MUSIXQUARE',
    'meta.tw_description': 'ทุกอุปกรณ์เป็นระบบเดียวกัน',
    'header.logo_aria': 'กลับไปด้านบน',
    'header.try': 'ลองใช้เลย',
    'header.try_aria': 'ลองใช้ MUSIXQUARE เลย',
    'hero.h1': 'ทุกอุปกรณ์<br>เป็นระบบเดียวกัน',
    'hero.lead':
      'MUSIXQUARE เชื่อมอุปกรณ์หลายเครื่อง ทั้งโทรศัพท์ แท็บเล็ต และแล็ปท็อป ให้เป็นระบบเสียงเดียว ไม่ต้องติดตั้ง แค่แชร์โค้ดเดียว',
    'hero.btn_ghost': 'ดูวิธีทำงาน',
    'hero.rooms_opened': 'เปิดห้องไปแล้ว {{count}} ห้อง',
    'array.h2': 'เสียงรอบทิศทาง<br>โดยไม่ต้องมีลำโพงรอบทิศทาง',
    'array.lead':
      'แต่ละอุปกรณ์รับหน้าที่เป็นซ้าย ขวา ซับวูฟเฟอร์ หรือสเตอริโอเต็มรูปแบบได้ ทั้งห้องจึงกลายเป็นระบบเสียงเดียวกัน',
    'array.aria':
      'โทรศัพท์ด้านซ้าย แล็ปท็อปตรงกลาง และโทรศัพท์ด้านขวา ชุดเสียงรอบทิศทางจากสามอุปกรณ์',
    'code.h2': 'แค่เลขหกหลัก<br>ก็พอ',
    'code.lead':
      'เปิดห้องแล้วแชร์โค้ดหกหลัก อุปกรณ์ที่ใช้เบราว์เซอร์ที่รองรับก็เข้าร่วมได้ในไม่กี่วินาที',
    'code.aria_code': 'ตัวอย่างโค้ดห้อง',
    'code.aria_qr': 'คิวอาร์โค้ดสำหรับ musixquare.com',
    'code.copy_btn': 'คัดลอกลิงก์เชิญ',
    'code.toast_success': 'คัดลอกลิงก์เชิญแล้ว',
    'code.toast_fail': 'คัดลอกไม่สำเร็จ',
    'remote.h2': 'ไม่ได้อยู่ที่เดียวกัน<br>ก็ไม่เป็นไร',
    'remote.lead': 'คุยกัน ฟังเพลง หรือดู YouTube พร้อมกันได้ แม้อยู่คนละที่',
    'remote.chat_label': 'แชต',
    'remote.chat_value': 'แชตแบบเรียลไทม์',
    'remote.whisper_label': 'ส่วนตัว',
    'remote.whisper_value': 'ข้อความส่วนตัว 1:1',
    'remote.cowatch_label': 'ดูด้วยกัน',
    'remote.cowatch_value': 'YouTube ที่ซิงก์กัน',
    'remote.reach_label': 'รองรับ',
    'remote.reach_value': 'เบราว์เซอร์ที่รองรับ เชื่อมต่อข้ามเครือข่ายได้',
    'remote.caveat': 'หมายเหตุ: โหมด YouTube ไม่รองรับการแยกช่องเสียงและเอฟเฟกต์เสียง',
    'remote.pin_label': 'ประกาศ · เจ้าของห้อง',
    'remote.pin_text': 'แนะนำเพลย์ลิสต์หน่อย',
    'remote.host_name': 'เจ้าของห้อง',
    'remote.host_msg1': 'อยู่ไหน?',
    'remote.peer_name': 'ผู้เข้าร่วม 1',
    'remote.peer_msg1': 'ทำงานอยู่คาเฟ่ 555',
    'remote.peer_ts_msg': 'เพลงนี้ดีแฮะ',
    'remote.host_msg2': 'เดี๋ยวเปิดให้',
    'remote.whisper_sender': 'ข้อความส่วนตัวถึงเจ้าของห้อง',
    'remote.whisper_msg': 'ประกาศขอเพลย์ลิสต์แนะนำหน่อย',
    'sync.h2': 'เล่นแบบซิงก์กัน<br>ข้ามเครือข่าย',
    'sync.lead': 'แต่ละอุปกรณ์วัดความหน่วง แล้วจัดเวลาเล่นให้ตรงกันอย่างแม่นยำ',
    'sync.video_label': 'สื่อ',
    'sync.video_value': 'เล่นสื่อแบบซิงก์กัน',
    'sync.transport_label': 'การส่งข้อมูล',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'เอฟเฟกต์',
    'sync.effects_value': 'EQ 5 ย่าน · เสียงก้อง · เอฟเฟกต์เสมือน',
    'sync.platforms_label': 'แพลตฟอร์ม',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'เจ้าของห้อง',
    'sync.meta': 'ซิงก์แบบ NTP ด้วย 60 ตัวอย่าง',
    'standin.h2': 'คอมพิวเตอร์<br>ไม่มีลำโพง?',
    'standin.lead': 'MUSIXQUARE ใช้แทนได้ทันที แค่มีโทรศัพท์กับแท็บเล็ตในกระเป๋าก็เริ่มได้',
    'standin.aria':
      'คอมพิวเตอร์ที่ปิดเสียงอยู่เหนือโทรศัพท์สองเครื่องที่ทำหน้าที่เป็นลำโพงซ้ายและขวา',
    'standin.desktop_label': 'เดสก์ท็อป',
    'standin.desktop_value': 'โทรศัพท์หรือแท็บเล็ตบนโต๊ะกลายเป็นลำโพง',
    'standin.laptop_label': 'แล็ปท็อป',
    'standin.laptop_value': 'ใช้อุปกรณ์หลายเครื่องแทนลำโพงในตัวที่เสียงเบา',
    'standin.feature_label': 'ฟีเจอร์',
    'standin.feature_value': 'แชร์เสียงระบบ (Beta)',
    'standin.platform_label': 'แพลตฟอร์ม',
    'standin.platform_value': 'เบราว์เซอร์ Chromium บนคอมพิวเตอร์',
    'standin.caveat':
      'Beta: ใช้ได้เฉพาะ Chromium บนคอมพิวเตอร์ สูงสุดสี่อุปกรณ์รวมเครื่องที่แชร์ การแชร์ในห้อง Standard และการแชร์ผ่าน Cloudflare (SFU) จะสิ้นสุดหลังสองชั่วโมง ส่วนการแชร์ PRO แบบ LAN-direct ที่ผ่านการตรวจสอบสามารถทำงานต่อได้ตราบใดที่ยังติดต่อสิทธิ์ของห้องได้ เสียงสดมีความหน่วงที่หลีกเลี่ยงไม่ได้ โปรดลดเสียงของเครื่องที่แชร์',
    'cta.h2': 'เริ่มเลย',
    'cta.btn': 'เปิด MUSIXQUARE',
    'footer.app': 'แอป',
    'footer.history': 'ประวัติ',
    'footer.designsystem': 'ระบบดีไซน์',
  });

  addLang('ms', {
    'meta.title': 'Perihal · MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE mengubah beberapa telefon, tablet dan komputer riba menjadi satu sistem bunyi terselaras. Terus dalam pelayar. Tanpa pemasangan.',
    'meta.og_title': 'Perihal · MUSIXQUARE',
    'meta.og_description':
      'Setiap peranti, satu sistem. Audio terselaras merentas berbilang peranti, tanpa pemasangan.',
    'meta.og_image_alt': 'MUSIXQUARE: Setiap peranti, satu sistem.',
    'meta.tw_title': 'Perihal · MUSIXQUARE',
    'meta.tw_description': 'Setiap peranti, satu sistem.',

    'header.logo_aria': 'Kembali ke bahagian atas',
    'header.try': 'Cuba sekarang',
    'header.try_aria': 'Cuba MUSIXQUARE sekarang',

    'hero.h1': 'Setiap peranti,<br>satu sistem.',
    'hero.lead':
      'MUSIXQUARE menyatukan beberapa telefon, tablet dan komputer riba sebagai satu sistem bunyi. Tanpa pemasangan. Hanya kongsikan satu kod.',
    'hero.btn_ghost': 'Cara ia berfungsi',
    'hero.rooms_opened': 'Bilik dibuka setakat ini: {{count}}.',

    'array.h2': 'Bunyi surround, tanpa<br>pembesar suara surround.',
    'array.lead':
      'Setiap peranti memainkan satu peranan: kiri, kanan, subwufer atau stereo penuh. Ruang itu sendiri menjadi sistem bunyi.',
    'array.aria':
      'Telefon di kiri, komputer riba di tengah dan telefon di kanan. Susunan surround tiga peranti.',

    'code.h2': 'Enam digit.<br>Itu sahaja.',
    'code.lead':
      'Mulakan sesi dan kongsikan kod enam digit. Sesiapa yang menggunakan pelayar yang disokong boleh menyertai dalam beberapa saat.',
    'code.aria_code': 'Contoh kod bilik',
    'code.aria_qr': 'Kod QR untuk musixquare.com',
    'code.copy_btn': 'Salin pautan jemputan',
    'code.toast_success': 'Pautan jemputan disalin',
    'code.toast_fail': 'Gagal menyalin',

    'remote.h2': 'Tidak berada di bilik yang sama?<br>Tiada masalah.',
    'remote.lead':
      'Berbual, dengar muzik atau tonton YouTube bersama-sama walaupun berada di seberang bandar.',
    'remote.chat_label': 'Sembang',
    'remote.chat_value': 'Sembang masa nyata',
    'remote.whisper_label': 'Mesej peribadi',
    'remote.whisper_value': 'Mesej peribadi satu dengan satu',
    'remote.cowatch_label': 'Tonton bersama',
    'remote.cowatch_value': 'YouTube bersama-sama, secara selaras',
    'remote.reach_label': 'Jangkauan',
    'remote.reach_value': 'Pelayar yang disokong, merentas rangkaian',
    'remote.caveat': 'Nota: pemisahan saluran dan kesan audio tidak tersedia untuk YouTube.',
    'remote.pin_label': 'NOTIS · HOST',
    'remote.pin_text': 'Minta cadangan senarai main',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'awak di mana?',
    'remote.peer_name': 'Peserta 1',
    'remote.peer_msg1': 'tengah kerja di kafe haha',
    'remote.peer_ts_msg': 'sedap juga lagu ni',
    'remote.host_msg2': 'nanti saya mainkan',
    'remote.whisper_sender': 'mesej peribadi kepada HOST',
    'remote.whisper_msg': 'minta cadangan senarai main dalam notis',

    'sync.h2': 'Main balik terselaras.<br>Merentas rangkaian.',
    'sync.lead':
      'Setiap peranti mengukur kelewatan dan memastikan main balik kekal selaras dengan tepat.',
    'sync.video_label': 'MEDIA',
    'sync.video_value': 'Main balik media terselaras',
    'sync.transport_label': 'Penghantaran',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Kesan',
    'sync.effects_value': 'EQ 5 jalur · Gema · Virtualizer',
    'sync.platforms_label': 'Platform',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Host',
    'sync.meta': 'Penyelarasan gaya NTP dengan 60 sampel',

    'standin.h2': 'Komputer anda<br>tiada pembesar suara?',
    'standin.lead':
      'MUSIXQUARE boleh menjadi pengganti segera. Telefon dan tablet dalam beg anda sudah memadai untuk bermula.',
    'standin.aria':
      'Komputer tanpa bunyi di atas dua telefon aktif yang bertindak sebagai pembesar suara kiri dan kanan',
    'standin.desktop_label': 'Komputer meja',
    'standin.desktop_value': 'Telefon atau tablet di atas meja menjadi pembesar suara',
    'standin.laptop_label': 'Komputer riba',
    'standin.laptop_value': 'Beberapa peranti menggantikan pembesar suara terbina dalam yang lemah',
    'standin.feature_label': 'Ciri',
    'standin.feature_value': 'Perkongsian Audio Sistem (Beta)',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Pelayar berasaskan Chromium pada komputer',
    'standin.caveat':
      'Beta: Chromium pada komputer sahaja, sehingga empat peranti bersambung termasuk peranti penghantar. Setiap perkongsian bilik Standard dan setiap perkongsian yang disampaikan melalui Cloudflare (SFU) tamat selepas dua jam; perkongsian PRO LAN-direct yang disahkan boleh diteruskan selagi autoriti bilik kekal dapat dicapai dan berfungsi dengan baik. Audio langsung mempunyai kependaman yang tidak dapat dielakkan, jadi rendahkan kelantangan peranti yang berkongsi.',

    'cta.h2': 'Mulakan sesi.',
    'cta.btn': 'Lancarkan MUSIXQUARE',

    'footer.app': 'Aplikasi',
    'footer.history': 'Sejarah',
    'footer.designsystem': 'Sistem Reka Bentuk',
  });

  addLang('fil', {
    'meta.title': 'Tungkol sa · MUSIXQUARE',
    'meta.description':
      'Ginagawang isang naka-sync na sound system ng MUSIXQUARE ang maraming phone, tablet, at laptop. Direkta sa browser. Walang kailangang i-install.',
    'meta.og_title': 'Tungkol sa · MUSIXQUARE',
    'meta.og_description':
      'Bawat device, iisang system. Naka-sync na audio sa maraming device, walang installation.',
    'meta.og_image_alt': 'MUSIXQUARE: Bawat device, iisang system.',
    'meta.tw_title': 'Tungkol sa · MUSIXQUARE',
    'meta.tw_description': 'Bawat device, iisang system.',

    'header.logo_aria': 'Bumalik sa itaas',
    'header.try': 'Subukan ngayon',
    'header.try_aria': 'Subukan ang MUSIXQUARE ngayon',

    'hero.h1': 'Bawat device,<br>iisang system.',
    'hero.lead':
      'Pinagsasama ng MUSIXQUARE ang maraming phone, tablet, at laptop bilang iisang sound system. Walang installation. Mag-share lang ng isang code.',
    'hero.btn_ghost': 'Paano ito gumagana',
    'hero.rooms_opened': 'Mga room na nabuksan hanggang ngayon: {{count}}.',

    'array.h2': 'Surround sound, kahit walang<br>surround speaker.',
    'array.lead':
      'May isang papel ang bawat device: kaliwa, kanan, subwoofer, o full stereo. Ang mismong room ang nagiging system.',
    'array.aria':
      'Phone sa kaliwa, laptop sa gitna, at phone sa kanan. Tatlong-device na surround setup.',

    'code.h2': 'Anim na digit.<br>Iyon lang.',
    'code.lead':
      'Magsimula ng session at i-share ang anim na digit na code. Makakasali sa loob ng ilang segundo ang sinumang may suportadong browser.',
    'code.aria_code': 'Halimbawang room code',
    'code.aria_qr': 'QR code para sa musixquare.com',
    'code.copy_btn': 'Kopyahin ang invite link',
    'code.toast_success': 'Nakopya ang invite link',
    'code.toast_fail': 'Hindi nakopya',

    'remote.h2': 'Wala sa iisang room?<br>Walang problema.',
    'remote.lead':
      'Mag-chat, makinig ng musika, o manood ng YouTube nang sabay kahit nasa magkabilang panig ng bayan.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Real-time na chat',
    'remote.whisper_label': 'Pribadong mensahe',
    'remote.whisper_value': 'Pribadong 1:1 na mensahe',
    'remote.cowatch_label': 'Sabay manood',
    'remote.cowatch_value': 'Sabay at naka-sync na YouTube',
    'remote.reach_label': 'Abot',
    'remote.reach_value': 'Mga suportadong browser, kahit magkaibang network',
    'remote.caveat': 'Tandaan: hindi available ang channel separation at audio effects sa YouTube.',
    'remote.pin_label': 'PAALALA · HOST',
    'remote.pin_text': 'Tumatanggap ng playlist recs',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'nasaan ka?',
    'remote.peer_name': 'Participant 1',
    'remote.peer_msg1': 'nagtatrabaho sa café haha',
    'remote.peer_ts_msg': 'ang ganda pala ng kantang ito',
    'remote.host_msg2': 'ipatugtog ko mamaya',
    'remote.whisper_sender': 'pribadong mensahe sa HOST',
    'remote.whisper_msg': 'humingi ka ng playlist recs sa paalala',

    'sync.h2': 'Naka-sync na playback.<br>Kahit magkaibang network.',
    'sync.lead':
      'Sinusukat ng bawat device ang delay at pinananatiling tumpak na magkahanay ang playback.',
    'sync.video_label': 'MEDIA',
    'sync.video_value': 'Naka-sync na media playback',
    'sync.transport_label': 'Transport',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Effects',
    'sync.effects_value': '5-band EQ · Reverb · Virtualizer',
    'sync.platforms_label': 'Mga platform',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Host',
    'sync.meta': '60-sample na NTP-style sync',

    'standin.h2': 'Walang speaker<br>ang computer mo?',
    'standin.lead':
      'Puwedeng maging mabilis na kapalit ang MUSIXQUARE. Sapat na ang phone at tablet mula sa bag mo para magsimula.',
    'standin.aria':
      'Tahimik na computer sa ibabaw ng dalawang aktibong phone na nagsisilbing kaliwa at kanang speaker',
    'standin.desktop_label': 'Desktop',
    'standin.desktop_value': 'Nagiging mga speaker ang mga phone o tablet sa mesa',
    'standin.laptop_label': 'Laptop',
    'standin.laptop_value': 'Maraming device kapalit ng mahihinang built-in speaker',
    'standin.feature_label': 'Feature',
    'standin.feature_value': 'System Audio Sharing (Beta)',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Mga Chromium-based browser sa computer',
    'standin.caveat':
      'Beta: Chromium sa computer lang, hanggang apat na nakakonektang device kasama ang nagpapadala. Natatapos pagkalipas ng dalawang oras ang bawat pagbabahagi sa Standard room at bawat pagbabahaging ni-relay sa Cloudflare (SFU); maaaring magpatuloy ang na-verify na PRO LAN-direct share habang maayos ang koneksyon sa awtoridad ng room. Hindi maiiwasan ang latency sa live audio, kaya hinaan ang volume ng device na nagbabahagi.',

    'cta.h2': 'Magsimula ng session.',
    'cta.btn': 'Buksan ang MUSIXQUARE',

    'footer.app': 'App',
    'footer.history': 'Kasaysayan',
    'footer.designsystem': 'Design System',
  });

  addLang('uk', {
    'meta.title': 'Про MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE перетворює кілька телефонів, планшетів і ноутбуків на єдину синхронізовану звукову систему. Працює у браузері. Без інсталяції.',
    'meta.og_title': 'Про MUSIXQUARE',
    'meta.og_description':
      'Кожен пристрій: єдина система. Синхронізований звук на кількох пристроях без інсталяції.',
    'meta.og_image_alt': 'MUSIXQUARE: кожен пристрій, єдина система.',
    'meta.tw_title': 'Про MUSIXQUARE',
    'meta.tw_description': 'Кожен пристрій, єдина система.',

    'header.logo_aria': 'Повернутися нагору',
    'header.try': 'Спробувати зараз',
    'header.try_aria': 'Спробувати MUSIXQUARE зараз',

    'hero.h1': 'Кожен пристрій:<br>єдина система.',
    'hero.lead':
      'MUSIXQUARE об’єднує кілька телефонів, планшетів і ноутбуків в одну звукову систему. Без інсталяції. Просто поділіться одним кодом.',
    'hero.btn_ghost': 'Як це працює',
    'hero.rooms_opened': 'Кімнат відкрито: {{count}}.',

    'array.h2': 'Об’ємний звук<br>без surround-акустики.',
    'array.lead':
      'Кожен пристрій виконує одну роль: лівий, правий, сабвуфер або повне стерео. Сама кімната стає звуковою системою.',
    'array.aria':
      'Телефон ліворуч, ноутбук у центрі та телефон праворуч. Схема об’ємного звуку з трьох пристроїв.',

    'code.h2': 'Шість цифр.<br>І більше нічого.',
    'code.lead':
      'Почніть сеанс і поділіться шестизначним кодом. Користувачі підтримуваних браузерів зможуть приєднатися за кілька секунд.',
    'code.aria_code': 'Приклад коду кімнати',
    'code.aria_qr': 'QR-код для musixquare.com',
    'code.copy_btn': 'Копіювати посилання-запрошення',
    'code.toast_success': 'Посилання-запрошення скопійовано',
    'code.toast_fail': 'Не вдалося скопіювати',

    'remote.h2': 'Ви не в одній кімнаті?<br>Не проблема.',
    'remote.lead':
      'Спілкуйтеся, слухайте музику або дивіться YouTube разом, навіть перебуваючи в різних частинах міста.',
    'remote.chat_label': 'Чат',
    'remote.chat_value': 'Чат у реальному часі',
    'remote.whisper_label': 'Приватне повідомлення',
    'remote.whisper_value': 'Приватні повідомлення один на один',
    'remote.cowatch_label': 'Спільний перегляд',
    'remote.cowatch_value': 'Синхронний перегляд YouTube разом',
    'remote.reach_label': 'Доступність',
    'remote.reach_value': 'Підтримувані браузери в різних мережах',
    'remote.caveat': 'Примітка: для YouTube недоступні розділення каналів і звукові ефекти.',
    'remote.pin_label': 'ОГОЛОШЕННЯ · HOST',
    'remote.pin_text': 'Приймаю поради для списку відтворення',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'ти де?',
    'remote.peer_name': 'Учасник 1',
    'remote.peer_msg1': 'працюю в кафе, ахаха',
    'remote.peer_ts_msg': 'непогана пісня',
    'remote.host_msg2': 'увімкну її пізніше',
    'remote.whisper_sender': 'приватне повідомлення для HOST',
    'remote.whisper_msg': 'попроси поради для списку в оголошенні',

    'sync.h2': 'Синхронне відтворення.<br>У різних мережах.',
    'sync.lead': 'Кожен пристрій вимірює затримку й підтримує точне узгодження відтворення.',
    'sync.video_label': 'МЕДІА',
    'sync.video_value': 'Синхронне відтворення медіа',
    'sync.transport_label': 'Передавання',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Ефекти',
    'sync.effects_value': '5-смуговий EQ · Реверберація · Віртуалізатор',
    'sync.platforms_label': 'Платформи',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Host',
    'sync.meta': 'NTP-подібна синхронізація за 60 вимірами',

    'standin.h2': 'На комп’ютері<br>немає динаміків?',
    'standin.lead':
      'MUSIXQUARE швидко їх замінить. Для початку достатньо телефона й планшета з вашої сумки.',
    'standin.aria':
      'Комп’ютер без звуку над двома активними телефонами, які працюють як лівий і правий динаміки',
    'standin.desktop_label': 'Настільний комп’ютер',
    'standin.desktop_value': 'Телефони або планшети на столі стають динаміками',
    'standin.laptop_label': 'Ноутбук',
    'standin.laptop_value': 'Кілька пристроїв замість слабких вбудованих динаміків',
    'standin.feature_label': 'Функція',
    'standin.feature_value': 'Трансляція системного звуку (Beta)',
    'standin.platform_label': 'Платформа',
    'standin.platform_value': 'Браузери на основі Chromium для комп’ютерів',
    'standin.caveat':
      'Beta: лише Chromium на комп’ютерах, щонайбільше чотири підключені пристрої разом із передавачем. Кожна трансляція в кімнаті Standard і кожна трансляція через ретранслятор Cloudflare (SFU) завершується через дві години; перевірена трансляція PRO LAN-direct може тривати, доки повноваження кімнати залишаються доступними та справними. Живий звук має неминучу затримку, тому на пристрої, який транслює звук, варто зменшити гучність.',

    'cta.h2': 'Почніть сеанс.',
    'cta.btn': 'Запустити MUSIXQUARE',

    'footer.app': 'Застосунок',
    'footer.history': 'Історія',
    'footer.designsystem': 'Система дизайну',
  });

  addLang('ro', {
    'meta.title': 'Despre · MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE transformă mai multe telefoane, tablete și laptopuri într-un singur sistem audio sincronizat. Direct în browser. Fără instalare.',
    'meta.og_title': 'Despre · MUSIXQUARE',
    'meta.og_description':
      'Fiecare dispozitiv, un singur sistem. Sunet sincronizat pe mai multe dispozitive, fără instalare.',
    'meta.og_image_alt': 'MUSIXQUARE: Fiecare dispozitiv, un singur sistem.',
    'meta.tw_title': 'Despre · MUSIXQUARE',
    'meta.tw_description': 'Fiecare dispozitiv, un singur sistem.',

    'header.logo_aria': 'Înapoi sus',
    'header.try': 'Încearcă acum',
    'header.try_aria': 'Încearcă MUSIXQUARE acum',

    'hero.h1': 'Fiecare dispozitiv,<br>un singur sistem.',
    'hero.lead':
      'MUSIXQUARE unește mai multe telefoane, tablete și laptopuri într-un singur sistem audio. Fără instalare. Distribuie doar un cod.',
    'hero.btn_ghost': 'Cum funcționează',
    'hero.rooms_opened': 'Camere deschise până acum: {{count}}.',

    'array.h2': 'Sunet surround, fără<br>difuzoare surround.',
    'array.lead':
      'Fiecare dispozitiv are un rol: stânga, dreapta, subwoofer sau stereo complet. Camera însăși devine sistemul audio.',
    'array.aria':
      'Telefon în stânga, laptop în centru și telefon în dreapta. Configurație surround cu trei dispozitive.',

    'code.h2': 'Șase cifre.<br>Nimic altceva.',
    'code.lead':
      'Pornește o sesiune și distribuie codul din șase cifre. Oricine folosește un browser compatibil poate intra în câteva secunde.',
    'code.aria_code': 'Exemplu de cod al camerei',
    'code.aria_qr': 'Cod QR pentru musixquare.com',
    'code.copy_btn': 'Copiază linkul de invitație',
    'code.toast_success': 'Linkul de invitație a fost copiat',
    'code.toast_fail': 'Copierea a eșuat',

    'remote.h2': 'Nu ești în aceeași cameră?<br>Nicio problemă.',
    'remote.lead':
      'Discută, ascultă muzică sau urmărește YouTube împreună cu ceilalți, chiar și din locuri diferite ale orașului.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Chat în timp real',
    'remote.whisper_label': 'Mesaj privat',
    'remote.whisper_value': 'Mesaje private unu-la-unu',
    'remote.cowatch_label': 'Vizionare împreună',
    'remote.cowatch_value': 'YouTube împreună, sincronizat',
    'remote.reach_label': 'Acoperire',
    'remote.reach_value': 'Browsere compatibile, în rețele diferite',
    'remote.caveat':
      'Notă: separarea canalelor și efectele audio nu sunt disponibile pentru YouTube.',
    'remote.pin_label': 'ANUNȚ · HOST',
    'remote.pin_text': 'Aștept recomandări pentru lista de redare',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'unde ești?',
    'remote.peer_name': 'Participant 1',
    'remote.peer_msg1': 'lucrez dintr-o cafenea :))',
    'remote.peer_ts_msg': 'piesa asta chiar e bună',
    'remote.host_msg2': 'o pun mai târziu',
    'remote.whisper_sender': 'mesaj privat către HOST',
    'remote.whisper_msg': 'cere recomandări pentru listă în anunț',

    'sync.h2': 'Redare sincronizată.<br>Între rețele.',
    'sync.lead': 'Fiecare dispozitiv măsoară întârzierea și menține redarea aliniată cu precizie.',
    'sync.video_label': 'MEDIA',
    'sync.video_value': 'Redare media sincronizată',
    'sync.transport_label': 'Transport',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Efecte',
    'sync.effects_value': 'EQ cu 5 benzi · Reverberație · Virtualizator',
    'sync.platforms_label': 'Platforme',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Gazdă',
    'sync.meta': 'Sincronizare de tip NTP pe 60 de eșantioane',

    'standin.h2': 'Computerul nu are<br>difuzoare?',
    'standin.lead':
      'MUSIXQUARE poate fi un înlocuitor rapid. Un telefon și o tabletă din geantă sunt suficiente pentru a începe.',
    'standin.aria':
      'Computer fără sunet, deasupra a două telefoane active care funcționează ca difuzoare stânga și dreapta',
    'standin.desktop_label': 'Computer desktop',
    'standin.desktop_value': 'Telefoanele sau tabletele de pe birou devin difuzoare',
    'standin.laptop_label': 'Laptop',
    'standin.laptop_value': 'Mai multe dispozitive în locul difuzoarelor integrate slabe',
    'standin.feature_label': 'Funcție',
    'standin.feature_value': 'Partajarea sunetului sistemului (Beta)',
    'standin.platform_label': 'Platformă',
    'standin.platform_value': 'Browsere bazate pe Chromium pe computere',
    'standin.caveat':
      'Beta: numai Chromium pe computere, maximum patru dispozitive conectate, inclusiv dispozitivul care transmite. Fiecare partajare într-o cameră Standard și fiecare partajare retransmisă prin Cloudflare (SFU) se încheie după două ore; o partajare PRO LAN-direct verificată poate continua cât timp autoritatea camerei rămâne accesibilă și funcțională. Sunetul live are o latență inevitabilă, așadar volumul dispozitivului care partajează trebuie redus.',

    'cta.h2': 'Pornește o sesiune.',
    'cta.btn': 'Deschide MUSIXQUARE',

    'footer.app': 'Aplicație',
    'footer.history': 'Istoric',
    'footer.designsystem': 'Sistem de design',
  });

  addLang('cs', {
    'meta.title': 'O službě · MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE promění několik telefonů, tabletů a notebooků v jeden synchronizovaný zvukový systém. Přímo v prohlížeči. Bez instalace.',
    'meta.og_title': 'O službě · MUSIXQUARE',
    'meta.og_description':
      'Každé zařízení, jeden systém. Synchronizovaný zvuk na více zařízeních bez instalace.',
    'meta.og_image_alt': 'MUSIXQUARE: Každé zařízení, jeden systém.',
    'meta.tw_title': 'O službě · MUSIXQUARE',
    'meta.tw_description': 'Každé zařízení, jeden systém.',

    'header.logo_aria': 'Zpět nahoru',
    'header.try': 'Vyzkoušet',
    'header.try_aria': 'Vyzkoušet MUSIXQUARE',

    'hero.h1': 'Každé zařízení,<br>jeden systém.',
    'hero.lead':
      'MUSIXQUARE spojí několik telefonů, tabletů a notebooků do jednoho zvukového systému. Bez instalace. Stačí sdílet jeden kód.',
    'hero.btn_ghost': 'Jak to funguje',
    'hero.rooms_opened': 'Dosud otevřeno místností: {{count}}.',

    'array.h2': 'Prostorový zvuk<br>bez surround reproduktorů.',
    'array.lead':
      'Každé zařízení zastává jednu roli: levý kanál, pravý kanál, subwoofer nebo plné stereo. Samotná místnost se stane zvukovým systémem.',
    'array.aria':
      'Telefon vlevo, notebook uprostřed a telefon vpravo. Prostorová sestava ze tří zařízení.',

    'code.h2': 'Šest číslic.<br>Nic víc.',
    'code.lead':
      'Spusťte relaci a sdílejte šestimístný kód. Každý s podporovaným prohlížečem se může připojit během několika sekund.',
    'code.aria_code': 'Ukázkový kód místnosti',
    'code.aria_qr': 'QR kód pro musixquare.com',
    'code.copy_btn': 'Kopírovat zvací odkaz',
    'code.toast_success': 'Zvací odkaz byl zkopírován',
    'code.toast_fail': 'Kopírování se nezdařilo',

    'remote.h2': 'Nejste ve stejné místnosti?<br>To nevadí.',
    'remote.lead':
      'Chatujte, poslouchejte hudbu nebo sledujte YouTube společně, i když jste každý v jiné části města.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Chat v reálném čase',
    'remote.whisper_label': 'Soukromá zpráva',
    'remote.whisper_value': 'Soukromé zprávy jeden na jednoho',
    'remote.cowatch_label': 'Společné sledování',
    'remote.cowatch_value': 'YouTube společně a synchronně',
    'remote.reach_label': 'Dosah',
    'remote.reach_value': 'Podporované prohlížeče v různých sítích',
    'remote.caveat':
      'Poznámka: při použití YouTube nejsou dostupné oddělené kanály ani zvukové efekty.',
    'remote.pin_label': 'OZNÁMENÍ · HOST',
    'remote.pin_text': 'Sem s tipy do playlistu',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'kde jsi?',
    'remote.peer_name': 'Účastník 1',
    'remote.peer_msg1': 'pracuju z kavárny :D',
    'remote.peer_ts_msg': 'tahle skladba je docela dobrá',
    'remote.host_msg2': 'pustím ji později',
    'remote.whisper_sender': 'soukromá zpráva pro HOST',
    'remote.whisper_msg': 'zeptej se v oznámení na tipy do playlistu',

    'sync.h2': 'Synchronizované přehrávání.<br>Napříč sítěmi.',
    'sync.lead': 'Každé zařízení měří zpoždění a udržuje přehrávání přesně zarovnané.',
    'sync.video_label': 'MÉDIA',
    'sync.video_value': 'Synchronizované přehrávání médií',
    'sync.transport_label': 'Přenos',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Efekty',
    'sync.effects_value': '5pásmový EQ · Dozvuk · Virtualizér',
    'sync.platforms_label': 'Platformy',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Hostitel',
    'sync.meta': 'Synchronizace ve stylu NTP z 60 vzorků',

    'standin.h2': 'Počítač nemá<br>reproduktory?',
    'standin.lead':
      'MUSIXQUARE je rychle zastoupí. Pro začátek stačí telefon a tablet z vaší tašky.',
    'standin.aria':
      'Počítač bez zvuku nad dvěma aktivními telefony, které fungují jako levý a pravý reproduktor',
    'standin.desktop_label': 'Stolní počítač',
    'standin.desktop_value': 'Telefony nebo tablety na stole se promění v reproduktory',
    'standin.laptop_label': 'Notebook',
    'standin.laptop_value': 'Více zařízení místo slabých vestavěných reproduktorů',
    'standin.feature_label': 'Funkce',
    'standin.feature_value': 'Sdílení systémového zvuku (Beta)',
    'standin.platform_label': 'Platforma',
    'standin.platform_value': 'Prohlížeče založené na platformě Chromium v počítačích',
    'standin.caveat':
      'Beta: pouze Chromium na počítačích, nejvýše čtyři připojená zařízení včetně vysílajícího zařízení. Každé sdílení v místnosti Standard a každé sdílení přenášené přes Cloudflare (SFU) skončí po dvou hodinách; ověřené sdílení PRO LAN-direct může pokračovat, dokud zůstává spojení pro ověření oprávnění místnosti dostupné a funkční. Živý zvuk má nevyhnutelnou latenci, proto je vhodné snížit hlasitost sdílejícího zařízení.',

    'cta.h2': 'Spusťte relaci.',
    'cta.btn': 'Spustit MUSIXQUARE',

    'footer.app': 'Aplikace',
    'footer.history': 'Historie',
    'footer.designsystem': 'Design systém',
  });

  addLang('el', {
    'meta.title': 'Σχετικά · MUSIXQUARE',
    'meta.description':
      'Το MUSIXQUARE μετατρέπει πολλά τηλέφωνα, tablet και laptop σε ένα συγχρονισμένο ηχοσύστημα. Απευθείας στον φυλλομετρητή. Χωρίς εγκατάσταση.',
    'meta.og_title': 'Σχετικά · MUSIXQUARE',
    'meta.og_description':
      'Κάθε συσκευή, ένα σύστημα. Συγχρονισμένος ήχος σε πολλές συσκευές, χωρίς εγκατάσταση.',
    'meta.og_image_alt': 'MUSIXQUARE: Κάθε συσκευή, ένα σύστημα.',
    'meta.tw_title': 'Σχετικά · MUSIXQUARE',
    'meta.tw_description': 'Κάθε συσκευή, ένα σύστημα.',

    'header.logo_aria': 'Επιστροφή στην κορυφή',
    'header.try': 'Δοκιμάστε τώρα',
    'header.try_aria': 'Δοκιμάστε το MUSIXQUARE τώρα',

    'hero.h1': 'Κάθε συσκευή,<br>ένα σύστημα.',
    'hero.lead':
      'Το MUSIXQUARE ενώνει πολλά τηλέφωνα, tablet και laptop σε ένα ηχοσύστημα. Χωρίς εγκατάσταση. Απλώς κοινοποιήστε έναν κωδικό.',
    'hero.btn_ghost': 'Πώς λειτουργεί',
    'hero.rooms_opened': 'Δωμάτια που έχουν ανοίξει: {{count}}.',

    'array.h2': 'Ήχος surround, χωρίς<br>ηχεία surround.',
    'array.lead':
      'Κάθε συσκευή αναλαμβάνει έναν ρόλο: αριστερό, δεξί, subwoofer ή πλήρες στερεοφωνικό. Το ίδιο το δωμάτιο γίνεται το ηχοσύστημα.',
    'array.aria':
      'Τηλέφωνο αριστερά, laptop στο κέντρο και τηλέφωνο δεξιά. Διάταξη surround τριών συσκευών.',

    'code.h2': 'Έξι ψηφία.<br>Τίποτε άλλο.',
    'code.lead':
      'Ξεκινήστε μια συνεδρία και κοινοποιήστε τον εξαψήφιο κωδικό. Όποιος χρησιμοποιεί υποστηριζόμενο φυλλομετρητή μπορεί να συνδεθεί σε λίγα δευτερόλεπτα.',
    'code.aria_code': 'Παράδειγμα κωδικού δωματίου',
    'code.aria_qr': 'Κωδικός QR για το musixquare.com',
    'code.copy_btn': 'Αντιγραφή συνδέσμου πρόσκλησης',
    'code.toast_success': 'Ο σύνδεσμος πρόσκλησης αντιγράφηκε',
    'code.toast_fail': 'Η αντιγραφή απέτυχε',

    'remote.h2': 'Δεν είστε στο ίδιο δωμάτιο;<br>Κανένα πρόβλημα.',
    'remote.lead':
      'Συνομιλήστε, ακούστε μουσική ή παρακολουθήστε YouTube μαζί, ακόμα κι από διαφορετικά σημεία της πόλης.',
    'remote.chat_label': 'Συνομιλία',
    'remote.chat_value': 'Συνομιλία σε πραγματικό χρόνο',
    'remote.whisper_label': 'Ιδιωτικό μήνυμα',
    'remote.whisper_value': 'Ιδιωτικά μηνύματα ένας προς έναν',
    'remote.cowatch_label': 'Κοινή προβολή',
    'remote.cowatch_value': 'YouTube μαζί και συγχρονισμένα',
    'remote.reach_label': 'Εμβέλεια',
    'remote.reach_value': 'Υποστηριζόμενοι φυλλομετρητές σε διαφορετικά δίκτυα',
    'remote.caveat':
      'Σημείωση: ο διαχωρισμός καναλιών και τα ηχητικά εφέ δεν είναι διαθέσιμα για το YouTube.',
    'remote.pin_label': 'ΑΝΑΚΟΙΝΩΣΗ · HOST',
    'remote.pin_text': 'Περιμένω προτάσεις για τη λίστα',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'πού είσαι;',
    'remote.peer_name': 'Μέλος 1',
    'remote.peer_msg1': 'δουλεύω από ένα καφέ χαχα',
    'remote.peer_ts_msg': 'ωραίο είναι αυτό το τραγούδι',
    'remote.host_msg2': 'θα το βάλω αργότερα',
    'remote.whisper_sender': 'ιδιωτικό μήνυμα προς HOST',
    'remote.whisper_msg': 'ζήτησε προτάσεις για τη λίστα στην ανακοίνωση',

    'sync.h2': 'Συγχρονισμένη αναπαραγωγή.<br>Σε διαφορετικά δίκτυα.',
    'sync.lead':
      'Κάθε συσκευή μετρά την καθυστέρηση και διατηρεί την αναπαραγωγή ευθυγραμμισμένη με ακρίβεια.',
    'sync.video_label': 'ΠΟΛΥΜΕΣΑ',
    'sync.video_value': 'Συγχρονισμένη αναπαραγωγή πολυμέσων',
    'sync.transport_label': 'Μετάδοση',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Εφέ',
    'sync.effects_value': 'EQ 5 ζωνών · Αντήχηση · Virtualizer',
    'sync.platforms_label': 'Πλατφόρμες',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Οικοδεσπότης',
    'sync.meta': 'Συγχρονισμός τύπου NTP με 60 δείγματα',

    'standin.h2': 'Ο υπολογιστής δεν έχει<br>ηχεία;',
    'standin.lead':
      'Το MUSIXQUARE τα αντικαθιστά άμεσα. Ένα τηλέφωνο και ένα tablet από την τσάντα σας αρκούν για να ξεκινήσετε.',
    'standin.aria':
      'Υπολογιστής χωρίς ήχο πάνω από δύο ενεργά τηλέφωνα που λειτουργούν ως αριστερό και δεξί ηχείο',
    'standin.desktop_label': 'Επιτραπέζιος υπολογιστής',
    'standin.desktop_value': 'Τα τηλέφωνα ή τα tablet στο γραφείο γίνονται ηχεία',
    'standin.laptop_label': 'Laptop',
    'standin.laptop_value': 'Πολλές συσκευές αντί για αδύναμα ενσωματωμένα ηχεία',
    'standin.feature_label': 'Λειτουργία',
    'standin.feature_value': 'Κοινοποίηση ήχου συστήματος (Beta)',
    'standin.platform_label': 'Πλατφόρμα',
    'standin.platform_value': 'Φυλλομετρητές βασισμένοι στο Chromium σε υπολογιστές',
    'standin.caveat':
      'Beta: μόνο Chromium σε υπολογιστές, έως τέσσερις συνδεδεμένες συσκευές μαζί με τη συσκευή μετάδοσης. Κάθε κοινοποίηση σε δωμάτιο Standard και κάθε κοινοποίηση που αναμεταδίδεται μέσω Cloudflare (SFU) λήγει μετά από δύο ώρες· μια επαληθευμένη κοινοποίηση PRO LAN-direct μπορεί να συνεχιστεί όσο η εξουσιοδότηση του δωματίου παραμένει προσβάσιμη και λειτουργική. Ο ζωντανός ήχος έχει αναπόφευκτη καθυστέρηση, επομένως πρέπει να μειώνεται η ένταση της συσκευής που κοινοποιεί.',

    'cta.h2': 'Ξεκινήστε μια συνεδρία.',
    'cta.btn': 'Εκκίνηση MUSIXQUARE',

    'footer.app': 'Εφαρμογή',
    'footer.history': 'Ιστορικό',
    'footer.designsystem': 'Σύστημα σχεδίασης',
  });

  addLang('ar', {
    'meta.title': 'حول MUSIXQUARE',
    'meta.description':
      'يحوّل MUSIXQUARE عدة هواتف وأجهزة لوحية وحواسيب محمولة إلى نظام صوتي واحد متزامن. يعمل مباشرة في المتصفح. بلا تثبيت.',
    'meta.og_title': 'حول MUSIXQUARE',
    'meta.og_description': 'كل جهاز، نظام واحد. صوت متزامن عبر أجهزة متعددة، بلا تثبيت.',
    'meta.og_image_alt': 'MUSIXQUARE: كل جهاز، نظام واحد.',
    'meta.tw_title': 'حول MUSIXQUARE',
    'meta.tw_description': 'كل جهاز، نظام واحد.',

    'header.logo_aria': 'العودة إلى أعلى الصفحة',
    'header.try': 'جرّبه الآن',
    'header.try_aria': 'جرّب MUSIXQUARE الآن',

    'hero.h1': 'كل جهاز،<br>نظام واحد.',
    'hero.lead':
      'يحوّل MUSIXQUARE عدة هواتف وأجهزة لوحية وحواسيب محمولة إلى نظام صوتي واحد. لا حاجة إلى التثبيت؛ ما عليك سوى مشاركة رمز واحد.',
    'hero.btn_ghost': 'كيف يعمل',
    'hero.rooms_opened': 'عدد الغرف المفتوحة حتى الآن: {{count}}.',

    'array.h2': 'صوت محيطي من دون<br>مكبرات صوت محيطية.',
    'array.lead':
      'يؤدي كل جهاز دورًا واحدًا: اليسار أو اليمين أو مضخم الصوت أو ستيريو كامل. وتصبح الغرفة نفسها هي النظام.',
    'array.aria':
      'هاتف على اليسار، وحاسوب محمول في الوسط، وهاتف على اليمين. إعداد صوت محيطي من ثلاثة أجهزة.',

    'code.h2': 'ستة أرقام.<br>لا شيء آخر.',
    'code.lead':
      'ابدأ جلسة وشارك الرمز المكوّن من ستة أرقام. يمكن لأي شخص لديه متصفح مدعوم الانضمام خلال ثوانٍ.',
    'code.aria_code': 'مثال على رمز الغرفة',
    'code.aria_qr': 'رمز QR لموقع musixquare.com',
    'code.copy_btn': 'نسخ رابط الدعوة',
    'code.toast_success': 'تم نسخ رابط الدعوة',
    'code.toast_fail': 'تعذر النسخ',

    'remote.h2': 'لست في الغرفة؟<br>لا مشكلة.',
    'remote.lead':
      'تحدث بالدردشة أو استمع إلى الموسيقى أو شاهد YouTube مع الآخرين، حتى من الطرف الآخر من المدينة.',
    'remote.chat_label': 'الدردشة',
    'remote.chat_value': 'دردشة في الوقت الفعلي',
    'remote.whisper_label': 'همس',
    'remote.whisper_value': 'رسائل خاصة بين شخصين',
    'remote.cowatch_label': 'مشاهدة مشتركة',
    'remote.cowatch_value': 'مشاهدة YouTube معًا وبشكل متزامن',
    'remote.reach_label': 'نطاق الاتصال',
    'remote.reach_value': 'متصفحات مدعومة عبر شبكات مختلفة',
    'remote.caveat': 'ملاحظة: لا تتوفر ميزة فصل القنوات ولا المؤثرات الصوتية مع YouTube.',
    'remote.pin_label': 'إشعار · HOST',
    'remote.pin_text': 'أرسلوا اقتراحات لقائمة التشغيل',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'أين أنت؟',
    'remote.peer_name': 'المشارك 1',
    'remote.peer_msg1': 'أعمل من مقهى ههه',
    'remote.peer_ts_msg': 'هذه الأغنية جميلة',
    'remote.host_msg2': 'سأشغّلها لاحقًا',
    'remote.whisper_sender': 'همس إلى HOST',
    'remote.whisper_msg': 'اطلب اقتراحات لقائمة التشغيل في الإشعار',

    'sync.h2': 'تشغيل متزامن.<br>عبر الشبكات.',
    'sync.lead': 'يقيس كل جهاز زمن التأخير ويحافظ على محاذاة التشغيل بدقة.',
    'sync.video_label': 'الوسائط',
    'sync.video_value': 'تشغيل وسائط متزامن',
    'sync.transport_label': 'النقل',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'المؤثرات',
    'sync.effects_value': 'EQ بخمسة نطاقات · صدى · مؤثر افتراضي',
    'sync.platforms_label': 'المنصات',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'المضيف',
    'sync.meta': 'مزامنة بأسلوب NTP باستخدام 60 عينة',

    'standin.h2': 'لا توجد مكبرات صوت<br>في حاسوبك؟',
    'standin.lead': 'يعمل MUSIXQUARE كبديل سريع. يكفي هاتف وجهاز لوحي من حقيبتك للبدء.',
    'standin.aria': 'حاسوب صامت فوق هاتفين نشطين يعملان كمكبري صوت أيسر وأيمن',
    'standin.desktop_label': 'حاسوب مكتبي',
    'standin.desktop_value': 'تصبح الهواتف أو الأجهزة اللوحية على المكتب مكبرات الصوت',
    'standin.laptop_label': 'حاسوب محمول',
    'standin.laptop_value': 'عدة أجهزة بدلًا من مكبرات الصوت المدمجة الضعيفة',
    'standin.feature_label': 'الميزة',
    'standin.feature_value': 'مشاركة صوت النظام (Beta)',
    'standin.platform_label': 'المنصة',
    'standin.platform_value': 'متصفحات مبنية على Chromium في أجهزة الكمبيوتر',
    'standin.caveat':
      'Beta: متاح فقط على Chromium في أجهزة الكمبيوتر، وبحد أقصى أربعة أجهزة متصلة، بما فيها الجهاز الناشر. تنتهي كل مشاركة في غرفة Standard وكل مشاركة مُرحّلة عبر Cloudflare (SFU) بعد ساعتين؛ ويمكن لمشاركة PRO موثّقة عبر LAN-direct أن تستمر ما دام نظام التحكم في الغرفة يعمل بصورة سليمة. لا يمكن تجنب زمن التأخير في الصوت المباشر، لذا ينبغي خفض مستوى صوت الجهاز الذي يشارك الصوت.',

    'cta.h2': 'ابدأ جلسة.',
    'cta.btn': 'تشغيل MUSIXQUARE',

    'footer.app': 'التطبيق',
    'footer.history': 'السجل',
    'footer.designsystem': 'نظام التصميم',
  });

  addLang('fa', {
    'meta.title': 'دربارهٔ MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE چند تلفن، تبلت و لپ‌تاپ را به یک سیستم صوتی همگام تبدیل می‌کند. مستقیم در مرورگر. بدون نصب.',
    'meta.og_title': 'دربارهٔ MUSIXQUARE',
    'meta.og_description': 'هر دستگاه، یک سیستم. صدای همگام روی چند دستگاه، بدون نصب.',
    'meta.og_image_alt': 'MUSIXQUARE: هر دستگاه، یک سیستم.',
    'meta.tw_title': 'دربارهٔ MUSIXQUARE',
    'meta.tw_description': 'هر دستگاه، یک سیستم.',

    'header.logo_aria': 'بازگشت به بالای صفحه',
    'header.try': 'همین حالا امتحان کنید',
    'header.try_aria': 'همین حالا MUSIXQUARE را امتحان کنید',

    'hero.h1': 'هر دستگاه،<br>یک سیستم.',
    'hero.lead':
      'MUSIXQUARE چند تلفن، تبلت و لپ‌تاپ را به یک سیستم صوتی تبدیل می‌کند. نیازی به نصب نیست؛ فقط یک کد را به اشتراک بگذارید.',
    'hero.btn_ghost': 'روش کار',
    'hero.rooms_opened': 'تعداد اتاق‌های بازشده تا امروز: {{count}}.',

    'array.h2': 'صدای فراگیر، بدون<br>بلندگوهای فراگیر.',
    'array.lead':
      'هر دستگاه یک نقش دارد: چپ، راست، ساب‌ووفر یا استریوی کامل. خود اتاق به سیستم صوتی تبدیل می‌شود.',
    'array.aria': 'تلفن در چپ، لپ‌تاپ در مرکز و تلفن در راست. چیدمان صدای فراگیر با سه دستگاه.',

    'code.h2': 'شش رقم.<br>همین.',
    'code.lead':
      'یک جلسه آغاز کنید و کد شش‌رقمی را به اشتراک بگذارید. هر کسی با مرورگر پشتیبانی‌شده می‌تواند ظرف چند ثانیه بپیوندد.',
    'code.aria_code': 'نمونهٔ کد اتاق',
    'code.aria_qr': 'کد QR برای musixquare.com',
    'code.copy_btn': 'کپی پیوند دعوت',
    'code.toast_success': 'پیوند دعوت کپی شد',
    'code.toast_fail': 'کپی انجام نشد',

    'remote.h2': 'در اتاق نیستید؟<br>مشکلی نیست.',
    'remote.lead': 'حتی از آن سوی شهر با هم گفت‌وگو کنید، موسیقی گوش دهید یا YouTube تماشا کنید.',
    'remote.chat_label': 'گفت‌وگو',
    'remote.chat_value': 'گفت‌وگوی بی‌درنگ',
    'remote.whisper_label': 'پیام خصوصی',
    'remote.whisper_value': 'پیام خصوصی یک‌به‌یک',
    'remote.cowatch_label': 'تماشای مشترک',
    'remote.cowatch_value': 'تماشای YouTube با هم و به‌صورت همگام',
    'remote.reach_label': 'دسترسی',
    'remote.reach_value': 'مرورگرهای پشتیبانی‌شده، میان شبکه‌های مختلف',
    'remote.caveat': 'توجه: جداسازی کانال‌ها و جلوه‌های صوتی برای YouTube در دسترس نیست.',
    'remote.pin_label': 'اعلان · HOST',
    'remote.pin_text': 'پیشنهاد برای فهرست پخش بدهید',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'کجایی؟',
    'remote.peer_name': 'شرکت‌کننده 1',
    'remote.peer_msg1': 'دارم توی کافه کار می‌کنم خخ',
    'remote.peer_ts_msg': 'این آهنگ خیلی خوبه',
    'remote.host_msg2': 'بعداً پخشش می‌کنم',
    'remote.whisper_sender': 'پیام خصوصی به HOST',
    'remote.whisper_msg': 'در اعلان پیشنهاد فهرست پخش بخواه',

    'sync.h2': 'پخش همگام.<br>میان شبکه‌ها.',
    'sync.lead': 'هر دستگاه تأخیر را اندازه می‌گیرد و پخش را دقیقاً هماهنگ نگه می‌دارد.',
    'sync.video_label': 'رسانه',
    'sync.video_value': 'پخش همگام رسانه',
    'sync.transport_label': 'انتقال',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'جلوه‌ها',
    'sync.effects_value': 'EQ پنج‌باند · ریورب · مجازی‌ساز',
    'sync.platforms_label': 'پلتفرم‌ها',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'میزبان',
    'sync.meta': 'همگام‌سازی به روش NTP با 60 نمونه',

    'standin.h2': 'کامپیوترتان<br>بلندگو ندارد؟',
    'standin.lead':
      'MUSIXQUARE یک جایگزین سریع است. برای شروع، یک تلفن و تبلت از داخل کیف‌تان کافی است.',
    'standin.aria': 'کامپیوتر بی‌صدا بالای دو تلفن فعال که نقش بلندگوی چپ و راست را دارند',
    'standin.desktop_label': 'کامپیوتر رومیزی',
    'standin.desktop_value': 'تلفن‌ها یا تبلت‌های روی میز به بلندگو تبدیل می‌شوند',
    'standin.laptop_label': 'لپ‌تاپ',
    'standin.laptop_value': 'چند دستگاه به‌جای بلندگوهای داخلی ضعیف',
    'standin.feature_label': 'قابلیت',
    'standin.feature_value': 'اشتراک‌گذاری صدای سیستم (Beta)',
    'standin.platform_label': 'پلتفرم',
    'standin.platform_value': 'مرورگرهای مبتنی بر Chromium در کامپیوتر',
    'standin.caveat':
      'Beta: فقط Chromium روی کامپیوتر، با حداکثر چهار دستگاه متصل شامل دستگاه فرستنده. هر اشتراک‌گذاری در اتاق Standard و هر اشتراک‌گذاری انتقال‌یافته از Cloudflare (SFU) پس از دو ساعت پایان می‌یابد؛ اشتراک‌گذاری تأییدشدهٔ PRO از مسیر LAN-direct می‌تواند تا زمانی که سامانهٔ کنترل اتاق به‌درستی کار می‌کند ادامه یابد. صدای زنده به‌ناچار تأخیر دارد، بنابراین دستگاه فرستنده باید صدای خود را کم کند.',

    'cta.h2': 'یک جلسه آغاز کنید.',
    'cta.btn': 'اجرای MUSIXQUARE',

    'footer.app': 'برنامه',
    'footer.history': 'تاریخچه',
    'footer.designsystem': 'سیستم طراحی',
  });

  addLang('ur', {
    'meta.title': 'MUSIXQUARE کے بارے میں',
    'meta.description':
      'MUSIXQUARE متعدد فونز، ٹیبلٹس اور لیپ ٹاپس کو ایک ہم وقت ساؤنڈ سسٹم میں بدل دیتا ہے۔ براہ راست براؤزر میں۔ کسی انسٹالیشن کی ضرورت نہیں۔',
    'meta.og_title': 'MUSIXQUARE کے بارے میں',
    'meta.og_description': 'ہر ڈیوائس، ایک سسٹم۔ متعدد ڈیوائسز پر ہم وقت آڈیو، بغیر انسٹالیشن۔',
    'meta.og_image_alt': 'MUSIXQUARE: ہر ڈیوائس، ایک سسٹم۔',
    'meta.tw_title': 'MUSIXQUARE کے بارے میں',
    'meta.tw_description': 'ہر ڈیوائس، ایک سسٹم۔',

    'header.logo_aria': 'صفحے کے اوپر واپس جائیں',
    'header.try': 'ابھی آزمائیں',
    'header.try_aria': 'MUSIXQUARE ابھی آزمائیں',

    'hero.h1': 'ہر ڈیوائس،<br>ایک سسٹم۔',
    'hero.lead':
      'MUSIXQUARE متعدد فونز، ٹیبلٹس اور لیپ ٹاپس کو ایک ساؤنڈ سسٹم میں بدل دیتا ہے۔ کسی انسٹالیشن کی ضرورت نہیں؛ بس ایک کوڈ شیئر کریں۔',
    'hero.btn_ghost': 'یہ کیسے کام کرتا ہے',
    'hero.rooms_opened': 'اب تک کھولے گئے رومز: {{count}}۔',

    'array.h2': 'سراؤنڈ اسپیکرز کے بغیر<br>سراؤنڈ ساؤنڈ۔',
    'array.lead':
      'ہر ڈیوائس کا ایک کردار ہے: بایاں، دایاں، سب ووفر یا مکمل اسٹیریو۔ کمرہ خود سسٹم بن جاتا ہے۔',
    'array.aria':
      'بائیں جانب فون، درمیان میں لیپ ٹاپ اور دائیں جانب فون۔ تین ڈیوائسز پر مشتمل سراؤنڈ سیٹ اپ۔',

    'code.h2': 'چھ ہندسے۔<br>بس اتنا ہی۔',
    'code.lead':
      'ایک سیشن شروع کریں اور چھ ہندسوں کا کوڈ شیئر کریں۔ مطابقت رکھنے والا براؤزر استعمال کرنے والا کوئی بھی شخص چند سیکنڈ میں شامل ہو سکتا ہے۔',
    'code.aria_code': 'روم کوڈ کی مثال',
    'code.aria_qr': 'musixquare.com کے لیے QR کوڈ',
    'code.copy_btn': 'دعوتی لنک کاپی کریں',
    'code.toast_success': 'دعوتی لنک کاپی ہو گیا',
    'code.toast_fail': 'کاپی نہیں ہو سکی',

    'remote.h2': 'روم میں موجود نہیں؟<br>کوئی مسئلہ نہیں۔',
    'remote.lead': 'شہر کے دوسرے حصے سے بھی چیٹ کریں، موسیقی سنیں یا مل کر YouTube دیکھیں۔',
    'remote.chat_label': 'چیٹ',
    'remote.chat_value': 'ریئل ٹائم چیٹ',
    'remote.whisper_label': 'سرگوشی',
    'remote.whisper_value': 'نجی 1:1 پیغامات',
    'remote.cowatch_label': 'مل کر دیکھیں',
    'remote.cowatch_value': 'YouTube ساتھ اور ہم وقت دیکھیں',
    'remote.reach_label': 'رسائی',
    'remote.reach_value': 'مطابقت رکھنے والے براؤزرز، مختلف نیٹ ورکس پر',
    'remote.caveat': 'نوٹ: YouTube کے ساتھ چینل کی علیحدگی اور آڈیو ایفیکٹس دستیاب نہیں ہیں۔',
    'remote.pin_label': 'نوٹس · HOST',
    'remote.pin_text': 'پلے لسٹ کے لیے تجاویز دیں',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'کہاں ہو؟',
    'remote.peer_name': 'شریک 1',
    'remote.peer_msg1': 'کیفے سے کام کر رہا ہوں ہاہا',
    'remote.peer_ts_msg': 'یہ گانا کافی اچھا ہے',
    'remote.host_msg2': 'بعد میں چلا دوں گا',
    'remote.whisper_sender': 'HOST کو سرگوشی',
    'remote.whisper_msg': 'نوٹس میں پلے لسٹ کی تجاویز مانگو',

    'sync.h2': 'ہم وقت پلے بیک۔<br>مختلف نیٹ ورکس پر۔',
    'sync.lead': 'ہر ڈیوائس تاخیر کی پیمائش کرتی ہے اور پلے بیک کو درست طور پر ہم آہنگ رکھتی ہے۔',
    'sync.video_label': 'میڈیا',
    'sync.video_value': 'ہم وقت میڈیا پلے بیک',
    'sync.transport_label': 'ترسیل',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'ایفیکٹس',
    'sync.effects_value': '5-بینڈ EQ · ریورب · ورچوئلائزر',
    'sync.platforms_label': 'پلیٹ فارمز',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'میزبان',
    'sync.meta': 'NTP طرز کی ہم زمانی، 60 نمونوں کے ساتھ',

    'standin.h2': 'آپ کے کمپیوٹر میں<br>اسپیکرز نہیں ہیں؟',
    'standin.lead':
      'MUSIXQUARE فوری متبادل کے طور پر کام کرتا ہے۔ آغاز کے لیے بیگ میں موجود ایک فون اور ٹیبلٹ ہی کافی ہیں۔',
    'standin.aria':
      'ایک خاموش کمپیوٹر کے نیچے دو فعال فون جو بائیں اور دائیں اسپیکرز کا کام کر رہے ہیں',
    'standin.desktop_label': 'ڈیسک ٹاپ',
    'standin.desktop_value': 'میز پر موجود فون یا ٹیبلٹس اسپیکرز بن جاتے ہیں',
    'standin.laptop_label': 'لیپ ٹاپ',
    'standin.laptop_value': 'کمزور بلٹ اِن اسپیکرز کے بجائے متعدد ڈیوائسز',
    'standin.feature_label': 'فیچر',
    'standin.feature_value': 'سسٹم آڈیو شیئرنگ (Beta)',
    'standin.platform_label': 'پلیٹ فارم',
    'standin.platform_value': 'کمپیوٹرز پر Chromium پر مبنی براؤزرز',
    'standin.caveat':
      'Beta: صرف کمپیوٹر پر Chromium، اور نشر کرنے والی ڈیوائس سمیت زیادہ سے زیادہ چار منسلک ڈیوائسز۔ Standard روم کی ہر شیئرنگ اور Cloudflare کے ذریعے ریلے ہونے والی (SFU) ہر شیئرنگ دو گھنٹے بعد ختم ہو جاتی ہے؛ تصدیق شدہ PRO LAN-direct شیئرنگ اس وقت تک جاری رہ سکتی ہے جب تک روم کا کنٹرول نظام درست طور پر کام کرتا رہے۔ لائیو آڈیو میں تاخیر ناگزیر ہے، اس لیے شیئر کرنے والی ڈیوائس کا والیوم کم رکھیں۔',

    'cta.h2': 'ایک سیشن شروع کریں۔',
    'cta.btn': 'MUSIXQUARE چلائیں',

    'footer.app': 'ایپ',
    'footer.history': 'تاریخ',
    'footer.designsystem': 'ڈیزائن سسٹم',
  });

  addLang('he', {
    'meta.title': 'אודות MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE הופך כמה טלפונים, טאבלטים ומחשבים ניידים למערכת שמע מסונכרנת אחת. ישירות בדפדפן. בלי התקנה.',
    'meta.og_title': 'אודות MUSIXQUARE',
    'meta.og_description': 'כל מכשיר, מערכת אחת. שמע מסונכרן בכמה מכשירים, בלי התקנה.',
    'meta.og_image_alt': 'MUSIXQUARE: כל מכשיר, מערכת אחת.',
    'meta.tw_title': 'אודות MUSIXQUARE',
    'meta.tw_description': 'כל מכשיר, מערכת אחת.',

    'header.logo_aria': 'חזרה לראש הדף',
    'header.try': 'נסו עכשיו',
    'header.try_aria': 'נסו את MUSIXQUARE עכשיו',

    'hero.h1': 'כל מכשיר,<br>מערכת אחת.',
    'hero.lead':
      'MUSIXQUARE הופך כמה טלפונים, טאבלטים ומחשבים ניידים למערכת שמע אחת. אין צורך בהתקנה; פשוט משתפים קוד אחד.',
    'hero.btn_ghost': 'איך זה עובד',
    'hero.rooms_opened': 'מספר החדרים שנפתחו עד כה: {{count}}.',

    'array.h2': 'צליל היקפי בלי<br>רמקולים היקפיים.',
    'array.lead':
      'לכל מכשיר יש תפקיד אחד: שמאל, ימין, סאב-וופר או סטריאו מלא. החדר עצמו הופך למערכת.',
    'array.aria': 'טלפון משמאל, מחשב נייד במרכז וטלפון מימין. מערך צליל היקפי של שלושה מכשירים.',

    'code.h2': 'שש ספרות.<br>זה הכול.',
    'code.lead':
      'פותחים חדר ומשתפים את הקוד בן שש הספרות. כל מי שמשתמש בדפדפן נתמך יכול להצטרף בתוך שניות.',
    'code.aria_code': 'דוגמה לקוד חדר',
    'code.aria_qr': 'קוד QR עבור musixquare.com',
    'code.copy_btn': 'העתקת קישור ההזמנה',
    'code.toast_success': 'קישור ההזמנה הועתק',
    'code.toast_fail': 'ההעתקה נכשלה',

    'remote.h2': 'לא נמצאים בחדר?<br>אין בעיה.',
    'remote.lead': 'אפשר להתכתב, להאזין למוזיקה או לצפות יחד ב-YouTube, גם מהצד השני של העיר.',
    'remote.chat_label': 'צ׳אט',
    'remote.chat_value': 'צ׳אט בזמן אמת',
    'remote.whisper_label': 'לחישה',
    'remote.whisper_value': 'הודעות פרטיות אחד על אחד',
    'remote.cowatch_label': 'צפייה משותפת',
    'remote.cowatch_value': 'YouTube יחד ובסנכרון',
    'remote.reach_label': 'טווח',
    'remote.reach_value': 'דפדפנים נתמכים, בין רשתות שונות',
    'remote.caveat': 'הערה: אין תמיכה בהפרדת ערוצים או באפקטים קוליים ב-YouTube.',
    'remote.pin_label': 'הודעה · HOST',
    'remote.pin_text': 'מחפש המלצות לפלייליסט',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'איפה אתה?',
    'remote.peer_name': 'משתתף 1',
    'remote.peer_msg1': 'עובד מבית קפה חח',
    'remote.peer_ts_msg': 'השיר הזה די טוב',
    'remote.host_msg2': 'אנגן אותו אחר כך',
    'remote.whisper_sender': 'לחישה אל HOST',
    'remote.whisper_msg': 'בקש המלצות לפלייליסט בהודעה',

    'sync.h2': 'הפעלה מסונכרנת.<br>בין רשתות.',
    'sync.lead': 'כל מכשיר מודד את ההשהיה ושומר על תיאום מדויק של ההפעלה.',
    'sync.video_label': 'מדיה',
    'sync.video_value': 'הפעלת מדיה מסונכרנת',
    'sync.transport_label': 'תעבורה',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'אפקטים',
    'sync.effects_value': 'EQ ב-5 תחומים · הדהוד · וירטואלייזר',
    'sync.platforms_label': 'פלטפורמות',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'מארח',
    'sync.meta': 'סנכרון בסגנון NTP עם 60 דגימות',

    'standin.h2': 'אין רמקולים<br>במחשב?',
    'standin.lead': 'MUSIXQUARE יכול לשמש כתחליף מהיר. מספיקים טלפון וטאבלט מהתיק כדי להתחיל.',
    'standin.aria': 'מחשב שקט מעל שני טלפונים פעילים המשמשים כרמקול שמאלי ורמקול ימני',
    'standin.desktop_label': 'מחשב שולחני',
    'standin.desktop_value': 'טלפונים או טאבלטים על השולחן הופכים לרמקולים',
    'standin.laptop_label': 'מחשב נייד',
    'standin.laptop_value': 'כמה מכשירים במקום הרמקולים המובנים והחלשים',
    'standin.feature_label': 'תכונה',
    'standin.feature_value': 'שיתוף שמע המערכת (Beta)',
    'standin.platform_label': 'פלטפורמה',
    'standin.platform_value': 'דפדפנים מבוססי Chromium במחשבים',
    'standin.caveat':
      'Beta: זמין רק ב-Chromium במחשבים, לעד ארבעה מכשירים מחוברים כולל המכשיר המשדר. כל שיתוף בחדר Standard וכל שיתוף שמועבר דרך Cloudflare (SFU) מסתיימים לאחר שעתיים; שיתוף PRO מאומת דרך LAN-direct יכול להימשך כל עוד מנגנון השליטה בחדר פועל באופן תקין. באודיו חי יש השהיה בלתי נמנעת, ולכן יש להנמיך את עוצמת הקול במכשיר המשתף.',

    'cta.h2': 'פותחים חדר.',
    'cta.btn': 'פתיחת MUSIXQUARE',

    'footer.app': 'יישום',
    'footer.history': 'היסטוריה',
    'footer.designsystem': 'מערכת עיצוב',
  });

  addLang('sv', {
    'meta.title': 'Om MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE förvandlar flera telefoner, surfplattor och bärbara datorer till ett synkroniserat ljudsystem. Direkt i webbläsaren. Ingen installation.',
    'meta.og_title': 'Om MUSIXQUARE',
    'meta.og_description':
      'Varje enhet, ett system. Synkroniserat ljud på flera enheter, utan installation.',
    'meta.og_image_alt': 'MUSIXQUARE: Varje enhet, ett system.',
    'meta.tw_title': 'Om MUSIXQUARE',
    'meta.tw_description': 'Varje enhet, ett system.',

    'header.logo_aria': 'Tillbaka till sidans början',
    'header.try': 'Prova nu',
    'header.try_aria': 'Prova MUSIXQUARE nu',

    'hero.h1': 'Varje enhet,<br>ett system.',
    'hero.lead':
      'MUSIXQUARE förvandlar flera telefoner, surfplattor och bärbara datorer till ett ljudsystem. Ingen installation. Dela bara en kod.',
    'hero.btn_ghost': 'Så fungerar det',
    'hero.rooms_opened': 'Antal öppnade rum hittills: {{count}}.',

    'array.h2': 'Surroundljud utan<br>surroundhögtalare.',
    'array.lead':
      'Varje enhet får en roll: vänster, höger, subwoofer eller full stereo. Själva rummet blir systemet.',
    'array.aria':
      'Telefon till vänster, bärbar dator i mitten och telefon till höger. Surroundkonfiguration med tre enheter.',

    'code.h2': 'Sex siffror.<br>Inget mer.',
    'code.lead':
      'Starta en session och dela den sexsiffriga koden. Alla med en webbläsare som stöds kan ansluta på några sekunder.',
    'code.aria_code': 'Exempel på rumskod',
    'code.aria_qr': 'QR-kod för musixquare.com',
    'code.copy_btn': 'Kopiera inbjudningslänk',
    'code.toast_success': 'Inbjudningslänken har kopierats',
    'code.toast_fail': 'Det gick inte att kopiera',

    'remote.h2': 'Inte i samma rum?<br>Inga problem.',
    'remote.lead':
      'Chatta, lyssna på musik eller titta på YouTube tillsammans, även från andra sidan stan.',
    'remote.chat_label': 'Chatt',
    'remote.chat_value': 'Chatt i realtid',
    'remote.whisper_label': 'Viskning',
    'remote.whisper_value': 'Privata meddelanden en till en',
    'remote.cowatch_label': 'Titta tillsammans',
    'remote.cowatch_value': 'YouTube tillsammans, synkroniserat',
    'remote.reach_label': 'Räckvidd',
    'remote.reach_value': 'Webbläsare som stöds, över olika nätverk',
    'remote.caveat': 'Obs! Kanalseparering och ljudeffekter är inte tillgängliga för YouTube.',
    'remote.pin_label': 'ANSLAG · HOST',
    'remote.pin_text': 'Tar gärna emot tips till spellistan',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'var är du?',
    'remote.peer_name': 'Deltagare 1',
    'remote.peer_msg1': 'jobbar från ett kafé haha',
    'remote.peer_ts_msg': 'den här låten är rätt bra',
    'remote.host_msg2': 'jag spelar den senare',
    'remote.whisper_sender': 'viskning till HOST',
    'remote.whisper_msg': 'be om tips till spellistan i anslaget',

    'sync.h2': 'Synkroniserad uppspelning.<br>Över olika nätverk.',
    'sync.lead': 'Varje enhet mäter fördröjningen och håller uppspelningen noggrant synkroniserad.',
    'sync.video_label': 'MEDIA',
    'sync.video_value': 'Synkroniserad medieuppspelning',
    'sync.transport_label': 'Överföring',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Effekter',
    'sync.effects_value': '5-bands-EQ · Efterklang · Virtualisering',
    'sync.platforms_label': 'Plattformar',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Värd',
    'sync.meta': 'NTP-liknande synkronisering med 60 mätvärden',

    'standin.h2': 'Saknar datorn<br>högtalare?',
    'standin.lead':
      'MUSIXQUARE fungerar som en snabb ersättare. En telefon och en surfplatta ur väskan räcker för att börja.',
    'standin.aria':
      'Tyst dator ovanför två aktiva telefoner som fungerar som vänster och höger högtalare',
    'standin.desktop_label': 'Stationär dator',
    'standin.desktop_value': 'Telefoner eller surfplattor på skrivbordet blir högtalare',
    'standin.laptop_label': 'Bärbar dator',
    'standin.laptop_value': 'Flera enheter i stället för svaga inbyggda högtalare',
    'standin.feature_label': 'Funktion',
    'standin.feature_value': 'Delning av systemljud (Beta)',
    'standin.platform_label': 'Plattform',
    'standin.platform_value': 'Chromium-baserade webbläsare på datorer',
    'standin.caveat':
      'Beta: endast Chromium på datorer, med högst fyra anslutna enheter inklusive den sändande enheten. Varje delning i ett Standard-rum och varje delning som förmedlas via Cloudflare (SFU) avslutas efter två timmar; en verifierad PRO-delning via LAN-direct kan fortsätta så länge rummets styrfunktion fungerar som den ska. Direktsänt ljud har oundviklig fördröjning, så den delande enheten bör sänka volymen.',

    'cta.h2': 'Starta en session.',
    'cta.btn': 'Starta MUSIXQUARE',

    'footer.app': 'App',
    'footer.history': 'Historik',
    'footer.designsystem': 'Designsystem',
  });

  addLang('hi', {
    'meta.title': 'MUSIXQUARE के बारे में',
    'meta.description':
      'MUSIXQUARE कई फ़ोन, टैबलेट और लैपटॉप को एक सिंक किए हुए साउंड सिस्टम में बदलता है। सीधे ब्राउज़र में। किसी इंस्टॉलेशन की ज़रूरत नहीं।',
    'meta.og_title': 'MUSIXQUARE के बारे में',
    'meta.og_description':
      'हर डिवाइस, एक सिस्टम। कई डिवाइसों पर सिंक किया हुआ ऑडियो, बिना इंस्टॉल किए।',
    'meta.og_image_alt': 'MUSIXQUARE: हर डिवाइस, एक सिस्टम।',
    'meta.tw_title': 'MUSIXQUARE के बारे में',
    'meta.tw_description': 'हर डिवाइस, एक सिस्टम।',

    'header.logo_aria': 'सबसे ऊपर जाएँ',
    'header.try': 'अभी आज़माएँ',
    'header.try_aria': 'MUSIXQUARE अभी आज़माएँ',

    'hero.h1': 'हर डिवाइस,<br>एक सिस्टम।',
    'hero.lead':
      'MUSIXQUARE कई फ़ोन, टैबलेट और लैपटॉप को एक साउंड सिस्टम में बदलता है। कुछ इंस्टॉल नहीं करना। बस एक कोड साझा करें।',
    'hero.btn_ghost': 'यह कैसे काम करता है',
    'hero.rooms_opened': 'अब तक {{count}} रूम खोले गए हैं।',

    'array.h2': 'सराउंड स्पीकर के बिना<br>सराउंड साउंड।',
    'array.lead':
      'हर डिवाइस एक भूमिका निभाता है: बायाँ, दायाँ, सबवूफ़र या पूरा स्टीरियो। रूम खुद ही सिस्टम बन जाता है।',
    'array.aria': 'बाईं ओर फ़ोन, बीच में लैपटॉप, दाईं ओर फ़ोन। तीन डिवाइसों वाला सराउंड सेटअप।',

    'code.h2': 'छह अंक।<br>बस इतना ही।',
    'code.lead':
      'एक सेशन शुरू करके छह अंकों का कोड साझा करें। समर्थित ब्राउज़र वाला कोई भी व्यक्ति कुछ ही सेकंड में शामिल हो सकता है।',
    'code.aria_code': 'रूम कोड का उदाहरण',
    'code.aria_qr': 'musixquare.com का QR कोड',
    'code.copy_btn': 'आमंत्रण लिंक कॉपी करें',
    'code.toast_success': 'आमंत्रण लिंक कॉपी हो गया',
    'code.toast_fail': 'कॉपी नहीं हो सका',

    'remote.h2': 'रूम में नहीं हैं?<br>कोई समस्या नहीं।',
    'remote.lead': 'चाहे शहर के दूसरे छोर पर हों, चैट करें, संगीत सुनें या साथ में YouTube देखें।',
    'remote.chat_label': 'चैट',
    'remote.chat_value': 'रियल-टाइम चैट',
    'remote.whisper_label': 'निजी संदेश',
    'remote.whisper_value': 'निजी 1:1 संदेश',
    'remote.cowatch_label': 'साथ देखें',
    'remote.cowatch_value': 'YouTube साथ में, सिंक में',
    'remote.reach_label': 'पहुँच',
    'remote.reach_value': 'अलग-अलग नेटवर्क पर समर्थित ब्राउज़र',
    'remote.caveat': 'ध्यान दें: YouTube में चैनल अलग करना और ऑडियो इफ़ेक्ट उपलब्ध नहीं हैं।',
    'remote.pin_label': 'सूचना · होस्ट',
    'remote.pin_text': 'प्लेलिस्ट के सुझाव भेजें',
    'remote.host_name': 'होस्ट',
    'remote.host_msg1': 'कहाँ हो?',
    'remote.peer_name': 'पीयर 1',
    'remote.peer_msg1': 'कैफ़े से काम कर रहा हूँ, हाहा',
    'remote.peer_ts_msg': 'यह गाना काफ़ी अच्छा है',
    'remote.host_msg2': 'इसे बाद में चलाऊँगा',
    'remote.whisper_sender': 'होस्ट को निजी संदेश',
    'remote.whisper_msg': 'सूचना में प्लेलिस्ट के सुझाव माँगो',

    'sync.h2': 'सिंक किया हुआ प्लेबैक।<br>अलग-अलग नेटवर्क पर।',
    'sync.lead': 'हर डिवाइस देरी जाँचता है और प्लेबैक को सटीक रूप से मिला कर रखता है।',
    'sync.video_label': 'मीडिया',
    'sync.video_value': 'सिंक किया हुआ मीडिया प्लेबैक',
    'sync.transport_label': 'ट्रांसपोर्ट',
    'sync.transport_value': 'Peer-to-peer, WebRTC',
    'sync.effects_label': 'इफ़ेक्ट',
    'sync.effects_value': '5-बैंड EQ · रीवर्ब · वर्चुअलाइज़र',
    'sync.platforms_label': 'प्लेटफ़ॉर्म',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'होस्ट',
    'sync.meta': '60-सैंपल NTP-शैली सिंक',

    'standin.h2': 'कंप्यूटर में<br>स्पीकर नहीं हैं?',
    'standin.lead':
      'MUSIXQUARE तुरंत अस्थायी स्पीकर सिस्टम का काम करता है। शुरुआत के लिए आपके बैग का एक फ़ोन और टैबलेट ही काफ़ी है।',
    'standin.aria': 'ऊपर शांत कंप्यूटर और नीचे बाएँ व दाएँ स्पीकर की तरह चल रहे दो सक्रिय फ़ोन',
    'standin.desktop_label': 'डेस्कटॉप',
    'standin.desktop_value': 'मेज़ पर रखे फ़ोन या टैबलेट स्पीकर बन जाते हैं',
    'standin.laptop_label': 'लैपटॉप',
    'standin.laptop_value': 'कमज़ोर बिल्ट-इन स्पीकर की जगह कई डिवाइस',
    'standin.feature_label': 'फ़ीचर',
    'standin.feature_value': 'सिस्टम ऑडियो शेयरिंग (Beta)',
    'standin.platform_label': 'प्लेटफ़ॉर्म',
    'standin.platform_value': 'कंप्यूटर पर Chromium आधारित ब्राउज़र',
    'standin.caveat':
      'Beta: केवल कंप्यूटर के Chromium ब्राउज़र पर; भेजने वाले डिवाइस समेत अधिकतम 4 कनेक्टेड डिवाइस। हर Standard रूम शेयर और Cloudflare के ज़रिए रिले किया गया हर शेयर (SFU) 2 घंटे बाद समाप्त हो जाता है। सत्यापित PRO LAN-direct शेयर तब तक जारी रह सकता है, जब तक रूम की अनुमति से कनेक्शन उपलब्ध और सही रूप से काम कर रहा हो। लाइव ऑडियो में देरी होना अनिवार्य है, इसलिए साझा करने वाले डिवाइस का वॉल्यूम कम रखें।',

    'cta.h2': 'सेशन शुरू करें।',
    'cta.btn': 'MUSIXQUARE खोलें',

    'footer.app': 'ऐप',
    'footer.history': 'इतिहास',
    'footer.designsystem': 'डिज़ाइन सिस्टम',
  });

  addLang('bn', {
    'meta.title': 'MUSIXQUARE সম্পর্কে',
    'meta.description':
      'MUSIXQUARE একাধিক ফোন, ট্যাবলেট ও ল্যাপটপকে একটি সিঙ্ক করা সাউন্ড সিস্টেমে পরিণত করে। সরাসরি ব্রাউজারে। ইনস্টল করার দরকার নেই।',
    'meta.og_title': 'MUSIXQUARE সম্পর্কে',
    'meta.og_description':
      'প্রতিটি ডিভাইস, একটি সিস্টেম। একাধিক ডিভাইসে সিঙ্ক করা অডিও, ইনস্টল ছাড়াই।',
    'meta.og_image_alt': 'MUSIXQUARE: প্রতিটি ডিভাইস, একটি সিস্টেম।',
    'meta.tw_title': 'MUSIXQUARE সম্পর্কে',
    'meta.tw_description': 'প্রতিটি ডিভাইস, একটি সিস্টেম।',

    'header.logo_aria': 'একেবারে ওপরে যান',
    'header.try': 'এখনই ব্যবহার করে দেখুন',
    'header.try_aria': 'MUSIXQUARE এখনই ব্যবহার করে দেখুন',

    'hero.h1': 'প্রতিটি ডিভাইস,<br>একটি সিস্টেম।',
    'hero.lead':
      'MUSIXQUARE একাধিক ফোন, ট্যাবলেট ও ল্যাপটপকে একটি সাউন্ড সিস্টেমে পরিণত করে। কিছু ইনস্টল করতে হবে না। শুধু একটি কোড শেয়ার করুন।',
    'hero.btn_ghost': 'কীভাবে কাজ করে',
    'hero.rooms_opened': 'এখন পর্যন্ত {{count}}টি রুম খোলা হয়েছে।',

    'array.h2': 'সারাউন্ড স্পিকার ছাড়াই<br>সারাউন্ড সাউন্ড।',
    'array.lead':
      'প্রতিটি ডিভাইস একটি ভূমিকা নেয়: বাম, ডান, সাবউফার অথবা পূর্ণ স্টেরিও। রুমটিই একটি সিস্টেম হয়ে ওঠে।',
    'array.aria': 'বামে ফোন, মাঝে ল্যাপটপ, ডানে ফোন। তিন ডিভাইসের সারাউন্ড সেটআপ।',

    'code.h2': 'ছয়টি সংখ্যা।<br>আর কিছু নয়।',
    'code.lead':
      'একটি সেশন শুরু করে ছয় সংখ্যার কোডটি শেয়ার করুন। সমর্থিত ব্রাউজার থাকলে যে কেউ কয়েক সেকেন্ডের মধ্যে যোগ দিতে পারবেন।',
    'code.aria_code': 'রুম কোডের উদাহরণ',
    'code.aria_qr': 'musixquare.com-এর QR কোড',
    'code.copy_btn': 'আমন্ত্রণ লিংক কপি করুন',
    'code.toast_success': 'আমন্ত্রণ লিংক কপি হয়েছে',
    'code.toast_fail': 'কপি করা যায়নি',

    'remote.h2': 'রুমে নেই?<br>কোনো সমস্যা নেই।',
    'remote.lead': 'শহরের অন্য প্রান্তে থেকেও চ্যাট করুন, গান শুনুন অথবা একসঙ্গে YouTube দেখুন।',
    'remote.chat_label': 'চ্যাট',
    'remote.chat_value': 'রিয়েল-টাইম চ্যাট',
    'remote.whisper_label': 'ব্যক্তিগত বার্তা',
    'remote.whisper_value': 'ব্যক্তিগত 1:1 বার্তা',
    'remote.cowatch_label': 'একসঙ্গে দেখা',
    'remote.cowatch_value': 'একসঙ্গে YouTube, সিঙ্ক করে',
    'remote.reach_label': 'সংযোগের পরিধি',
    'remote.reach_value': 'আলাদা নেটওয়ার্কে সমর্থিত ব্রাউজার',
    'remote.caveat': 'মনে রাখবেন: YouTube-এ চ্যানেল আলাদা করা ও অডিও ইফেক্ট পাওয়া যায় না।',
    'remote.pin_label': 'নোটিশ · হোস্ট',
    'remote.pin_text': 'প্লেলিস্টের পরামর্শ দিন',
    'remote.host_name': 'হোস্ট',
    'remote.host_msg1': 'কোথায় আছ?',
    'remote.peer_name': 'পিয়ার 1',
    'remote.peer_msg1': 'ক্যাফে থেকে কাজ করছি, হাহা',
    'remote.peer_ts_msg': 'গানটা বেশ ভালো',
    'remote.host_msg2': 'পরে চালাব',
    'remote.whisper_sender': 'হোস্টকে ব্যক্তিগত বার্তা',
    'remote.whisper_msg': 'নোটিশে প্লেলিস্টের পরামর্শ চাইতে বলো',

    'sync.h2': 'সিঙ্ক করা প্লেব্যাক।<br>আলাদা নেটওয়ার্কেও।',
    'sync.lead': 'প্রতিটি ডিভাইস বিলম্ব পরীক্ষা করে এবং প্লেব্যাক সুনির্দিষ্টভাবে মিলিয়ে রাখে।',
    'sync.video_label': 'মিডিয়া',
    'sync.video_value': 'সিঙ্ক করা মিডিয়া প্লেব্যাক',
    'sync.transport_label': 'ট্রান্সপোর্ট',
    'sync.transport_value': 'Peer-to-peer, WebRTC',
    'sync.effects_label': 'ইফেক্ট',
    'sync.effects_value': '5-ব্যান্ড EQ · রিভার্ব · ভার্চুয়ালাইজার',
    'sync.platforms_label': 'প্ল্যাটফর্ম',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'হোস্ট',
    'sync.meta': '60-স্যাম্পল NTP-ধাঁচের সিঙ্ক',

    'standin.h2': 'কম্পিউটারে<br>স্পিকার নেই?',
    'standin.lead':
      'MUSIXQUARE দ্রুত বিকল্প স্পিকার সিস্টেম হিসেবে কাজ করে। শুরু করতে ব্যাগের একটি ফোন ও একটি ট্যাবলেটই যথেষ্ট।',
    'standin.aria': 'ওপরে নীরব কম্পিউটার এবং নিচে বাম ও ডান স্পিকার হিসেবে চলা দুটি সক্রিয় ফোন',
    'standin.desktop_label': 'ডেস্কটপ',
    'standin.desktop_value': 'ডেস্কে রাখা ফোন বা ট্যাবলেট স্পিকার হয়ে যায়',
    'standin.laptop_label': 'ল্যাপটপ',
    'standin.laptop_value': 'দুর্বল বিল্ট-ইন স্পিকারের বদলে একাধিক ডিভাইস',
    'standin.feature_label': 'ফিচার',
    'standin.feature_value': 'সিস্টেম অডিও শেয়ারিং (Beta)',
    'standin.platform_label': 'প্ল্যাটফর্ম',
    'standin.platform_value': 'কম্পিউটারে Chromium-ভিত্তিক ব্রাউজার',
    'standin.caveat':
      'Beta: শুধু কম্পিউটারের Chromium ব্রাউজারে; যে ডিভাইস থেকে পাঠানো হচ্ছে সেটিসহ সর্বোচ্চ 4টি সংযুক্ত ডিভাইস। প্রতিটি Standard রুম শেয়ার এবং Cloudflare-এর মাধ্যমে রিলে করা প্রতিটি শেয়ার (SFU) 2 ঘণ্টা পর শেষ হয়। যাচাই করা PRO LAN-direct শেয়ার রুমের অনুমোদন সংযোগ সচল ও ঠিকভাবে কার্যকর থাকা পর্যন্ত চলতে পারে। লাইভ অডিওতে বিলম্ব অনিবার্য, তাই যে ডিভাইস থেকে শেয়ার করা হচ্ছে তার ভলিউম কমিয়ে রাখুন।',

    'cta.h2': 'একটি সেশন শুরু করুন।',
    'cta.btn': 'MUSIXQUARE চালু করুন',

    'footer.app': 'অ্যাপ',
    'footer.history': 'ইতিহাস',
    'footer.designsystem': 'ডিজাইন সিস্টেম',
  });

  addLang('ta', {
    'meta.title': 'MUSIXQUARE பற்றி',
    'meta.description':
      'MUSIXQUARE பல தொலைபேசிகள், டேப்லெட்டுகள் மற்றும் மடிக்கணினிகளை ஒரே ஒத்திசைக்கப்பட்ட ஒலி அமைப்பாக மாற்றுகிறது. உலாவியிலேயே இயங்கும். நிறுவல் தேவையில்லை.',
    'meta.og_title': 'MUSIXQUARE பற்றி',
    'meta.og_description':
      'ஒவ்வொரு சாதனமும், ஒரே அமைப்பு. பல சாதனங்களில் ஒத்திசைக்கப்பட்ட ஆடியோ, நிறுவல் தேவையில்லை.',
    'meta.og_image_alt': 'MUSIXQUARE: ஒவ்வொரு சாதனமும், ஒரே அமைப்பு.',
    'meta.tw_title': 'MUSIXQUARE பற்றி',
    'meta.tw_description': 'ஒவ்வொரு சாதனமும், ஒரே அமைப்பு.',

    'header.logo_aria': 'மேலே திரும்பிச் செல்',
    'header.try': 'இப்போதே முயன்று பார்',
    'header.try_aria': 'MUSIXQUARE-ஐ இப்போதே முயன்று பார்',

    'hero.h1': 'ஒவ்வொரு சாதனமும்,<br>ஒரே அமைப்பு.',
    'hero.lead':
      'MUSIXQUARE பல தொலைபேசிகள், டேப்லெட்டுகள் மற்றும் மடிக்கணினிகளை ஒரே ஒலி அமைப்பாக மாற்றுகிறது. எதையும் நிறுவ வேண்டாம். ஒரே ஒரு குறியீட்டைப் பகிருங்கள்.',
    'hero.btn_ghost': 'இது எவ்வாறு இயங்குகிறது',
    'hero.rooms_opened': 'இதுவரை {{count}} அறைகள் திறக்கப்பட்டுள்ளன.',

    'array.h2': 'சரவுண்ட் ஸ்பீக்கர்கள் இல்லாமல்<br>சரவுண்ட் ஒலி.',
    'array.lead':
      'ஒவ்வொரு சாதனமும் ஒரு பங்கை வகிக்கிறது: இடது, வலது, சப்வூஃபர் அல்லது முழு ஸ்டீரியோ. அறையே அமைப்பாக மாறுகிறது.',
    'array.aria':
      'இடதுபுறம் தொலைபேசி, நடுவில் மடிக்கணினி, வலதுபுறம் தொலைபேசி. மூன்று சாதன சரவுண்ட் அமைப்பு.',

    'code.h2': 'ஆறு இலக்கங்கள்.<br>வேறெதுவும் இல்லை.',
    'code.lead':
      'ஓர் அமர்வைத் தொடங்கி ஆறு இலக்கக் குறியீட்டைப் பகிருங்கள். ஆதரிக்கப்படும் உலாவி உள்ள எவரும் சில வினாடிகளில் சேரலாம்.',
    'code.aria_code': 'மாதிரி அறைக் குறியீடு',
    'code.aria_qr': 'musixquare.com-க்கான QR குறியீடு',
    'code.copy_btn': 'அழைப்பு இணைப்பை நகலெடு',
    'code.toast_success': 'அழைப்பு இணைப்பு நகலெடுக்கப்பட்டது',
    'code.toast_fail': 'நகலெடுக்க முடியவில்லை',

    'remote.h2': 'அறையில் இல்லையா?<br>பிரச்சினை இல்லை.',
    'remote.lead':
      'நகரின் மறுபுறம் இருந்தாலும் அரட்டையடிக்கலாம், இசை கேட்கலாம் அல்லது ஒன்றாக YouTube பார்க்கலாம்.',
    'remote.chat_label': 'அரட்டை',
    'remote.chat_value': 'நிகழ்நேர அரட்டை',
    'remote.whisper_label': 'தனிச் செய்தி',
    'remote.whisper_value': 'தனிப்பட்ட 1:1 செய்திகள்',
    'remote.cowatch_label': 'ஒன்றாகப் பார்',
    'remote.cowatch_value': 'YouTube-ஐ ஒன்றாக, ஒத்திசைந்து பார்',
    'remote.reach_label': 'இணைப்பு எல்லை',
    'remote.reach_value': 'வெவ்வேறு நெட்வொர்க்குகளில் ஆதரிக்கப்படும் உலாவிகள்',
    'remote.caveat': 'குறிப்பு: YouTube-இல் சேனல் பிரிப்பும் ஆடியோ விளைவுகளும் கிடைக்காது.',
    'remote.pin_label': 'அறிவிப்பு · ஹோஸ்ட்',
    'remote.pin_text': 'பிளேலிஸ்ட் பரிந்துரைகள் வரவேற்கப்படுகின்றன',
    'remote.host_name': 'ஹோஸ்ட்',
    'remote.host_msg1': 'எங்கே இருக்கிறாய்?',
    'remote.peer_name': 'பியர் 1',
    'remote.peer_msg1': 'கஃபேவிலிருந்து வேலை செய்கிறேன், ஹாஹா',
    'remote.peer_ts_msg': 'இந்தப் பாடல் நன்றாக இருக்கிறது',
    'remote.host_msg2': 'பிறகு இதை இயக்குகிறேன்',
    'remote.whisper_sender': 'ஹோஸ்டுக்குத் தனிச் செய்தி',
    'remote.whisper_msg': 'அறிவிப்பில் பிளேலிஸ்ட் பரிந்துரைகளைக் கேள்',

    'sync.h2': 'ஒத்திசைக்கப்பட்ட பிளேபேக்.<br>வெவ்வேறு நெட்வொர்க்குகளில்.',
    'sync.lead':
      'ஒவ்வொரு சாதனமும் தாமதத்தைச் சரிபார்த்து பிளேபேக்கைத் துல்லியமாகச் சீரமைத்து வைத்திருக்கும்.',
    'sync.video_label': 'மீடியா',
    'sync.video_value': 'ஒத்திசைக்கப்பட்ட மீடியா பிளேபேக்',
    'sync.transport_label': 'பரிமாற்றம்',
    'sync.transport_value': 'Peer-to-peer, WebRTC',
    'sync.effects_label': 'விளைவுகள்',
    'sync.effects_value': '5-பேண்ட் EQ · ரீவர்ப் · விர்ச்சுவலைசர்',
    'sync.platforms_label': 'தளங்கள்',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'ஹோஸ்ட்',
    'sync.meta': '60-மாதிரி NTP-பாணி ஒத்திசைவு',

    'standin.h2': 'உங்கள் கணினியில்<br>ஸ்பீக்கர்கள் இல்லையா?',
    'standin.lead':
      'MUSIXQUARE உடனடி மாற்று ஸ்பீக்கர் அமைப்பாகச் செயல்படும். தொடங்க உங்கள் பையில் உள்ள ஒரு தொலைபேசியும் ஒரு டேப்லெட்டும் போதும்.',
    'standin.aria':
      'மேலே ஒலியில்லாத கணினி, கீழே இடது மற்றும் வலது ஸ்பீக்கர்களாக இயங்கும் இரண்டு தொலைபேசிகள்',
    'standin.desktop_label': 'டெஸ்க்டாப்',
    'standin.desktop_value':
      'மேசையில் உள்ள தொலைபேசிகள் அல்லது டேப்லெட்டுகள் ஸ்பீக்கர்களாக மாறுகின்றன',
    'standin.laptop_label': 'மடிக்கணினி',
    'standin.laptop_value': 'பலவீனமான உள்ளமைந்த ஸ்பீக்கர்களுக்குப் பதிலாகப் பல சாதனங்கள்',
    'standin.feature_label': 'அம்சம்',
    'standin.feature_value': 'சிஸ்டம் ஆடியோ பகிர்வு (Beta)',
    'standin.platform_label': 'தளம்',
    'standin.platform_value': 'கணினிகளில் Chromium சார்ந்த உலாவிகள்',
    'standin.caveat':
      'Beta: கணினியின் Chromium உலாவியில் மட்டுமே; அனுப்பும் சாதனம் உட்பட அதிகபட்சம் 4 இணைக்கப்பட்ட சாதனங்கள். ஒவ்வொரு Standard அறைப் பகிர்வும் Cloudflare வழியாக ரிலே செய்யப்படும் ஒவ்வொரு பகிர்வும் (SFU) 2 மணி நேரத்திற்குப் பிறகு முடியும். சரிபார்க்கப்பட்ட PRO LAN-direct பகிர்வு, அறை அதிகார இணைப்பு கிடைக்கக்கூடியதாகவும் ஆரோக்கியமாகவும் இருக்கும் வரை தொடரலாம். நேரலை ஆடியோவில் தாமதத்தைத் தவிர்க்க முடியாது; எனவே பகிரும் சாதனத்தின் ஒலியளவைக் குறைக்கவும்.',

    'cta.h2': 'ஓர் அமர்வைத் தொடங்குங்கள்.',
    'cta.btn': 'MUSIXQUARE-ஐத் தொடங்கு',

    'footer.app': 'பயன்பாடு',
    'footer.history': 'வரலாறு',
    'footer.designsystem': 'வடிவமைப்பு முறைமை',
  });

  addLang('te', {
    'meta.title': 'MUSIXQUARE గురించి',
    'meta.description':
      'MUSIXQUARE అనేక ఫోన్‌లు, టాబ్లెట్‌లు, ల్యాప్‌టాప్‌లను ఒక సింక్ చేసిన సౌండ్ సిస్టమ్‌గా మారుస్తుంది. నేరుగా బ్రౌజర్‌లో. ఇన్‌స్టాల్ చేయాల్సిన అవసరం లేదు.',
    'meta.og_title': 'MUSIXQUARE గురించి',
    'meta.og_description':
      'ప్రతి పరికరం, ఒకే సిస్టమ్. అనేక పరికరాల్లో సింక్ చేసిన ఆడియో, ఇన్‌స్టాల్ అవసరం లేదు.',
    'meta.og_image_alt': 'MUSIXQUARE: ప్రతి పరికరం, ఒకే సిస్టమ్.',
    'meta.tw_title': 'MUSIXQUARE గురించి',
    'meta.tw_description': 'ప్రతి పరికరం, ఒకే సిస్టమ్.',

    'header.logo_aria': 'పైకి తిరిగి వెళ్లు',
    'header.try': 'ఇప్పుడే ప్రయత్నించు',
    'header.try_aria': 'MUSIXQUAREను ఇప్పుడే ప్రయత్నించు',

    'hero.h1': 'ప్రతి పరికరం,<br>ఒకే సిస్టమ్.',
    'hero.lead':
      'MUSIXQUARE అనేక ఫోన్‌లు, టాబ్లెట్‌లు, ల్యాప్‌టాప్‌లను ఒక సౌండ్ సిస్టమ్‌గా మారుస్తుంది. ఏదీ ఇన్‌స్టాల్ చేయాల్సిన అవసరం లేదు. ఒక కోడ్‌ను షేర్ చేస్తే చాలు.',
    'hero.btn_ghost': 'ఇది ఎలా పనిచేస్తుంది',
    'hero.rooms_opened': 'ఇప్పటివరకు {{count}} గదులు తెరవబడ్డాయి.',

    'array.h2': 'సరౌండ్ స్పీకర్లు లేకుండానే<br>సరౌండ్ సౌండ్.',
    'array.lead':
      'ప్రతి పరికరం ఒక పాత్రను పోషిస్తుంది: ఎడమ, కుడి, సబ్‌వూఫర్ లేదా పూర్తి స్టీరియో. గదే సిస్టమ్‌గా మారుతుంది.',
    'array.aria': 'ఎడమవైపు ఫోన్, మధ్యలో ల్యాప్‌టాప్, కుడివైపు ఫోన్. మూడు పరికరాల సరౌండ్ సెటప్.',

    'code.h2': 'ఆరు అంకెలు.<br>ఇంకేమీ లేదు.',
    'code.lead':
      'ఒక సెషన్‌ను ప్రారంభించి ఆరు అంకెల కోడ్‌ను షేర్ చేయండి. మద్దతు ఉన్న బ్రౌజర్ ఉన్న ఎవరైనా కొన్ని సెకన్లలో చేరవచ్చు.',
    'code.aria_code': 'ఉదాహరణ గది కోడ్',
    'code.aria_qr': 'musixquare.com కోసం QR కోడ్',
    'code.copy_btn': 'ఆహ్వాన లింక్‌ను కాపీ చేయి',
    'code.toast_success': 'ఆహ్వాన లింక్ కాపీ అయింది',
    'code.toast_fail': 'కాపీ చేయడం సాధ్యపడలేదు',

    'remote.h2': 'గదిలో లేరా?<br>సమస్య లేదు.',
    'remote.lead':
      'పట్టణానికి అవతలి వైపు నుంచైనా చాట్ చేయండి, సంగీతం వినండి లేదా కలిసి YouTube చూడండి.',
    'remote.chat_label': 'చాట్',
    'remote.chat_value': 'రియల్-టైమ్ చాట్',
    'remote.whisper_label': 'ప్రైవేట్ సందేశం',
    'remote.whisper_value': 'ప్రైవేట్ 1:1 సందేశాలు',
    'remote.cowatch_label': 'కలిసి చూడటం',
    'remote.cowatch_value': 'కలిసి YouTube, సింక్‌లో',
    'remote.reach_label': 'అందుబాటు',
    'remote.reach_value': 'వేర్వేరు నెట్‌వర్క్‌లలో మద్దతు ఉన్న బ్రౌజర్‌లు',
    'remote.caveat': 'గమనిక: YouTubeలో ఛానెల్ విభజన, ఆడియో ఎఫెక్ట్‌లు అందుబాటులో ఉండవు.',
    'remote.pin_label': 'నోటీస్ · హోస్ట్',
    'remote.pin_text': 'ప్లేలిస్ట్ సూచనలు పంపండి',
    'remote.host_name': 'హోస్ట్',
    'remote.host_msg1': 'ఎక్కడ ఉన్నావు?',
    'remote.peer_name': 'పీర్ 1',
    'remote.peer_msg1': 'కేఫ్ నుండి పని చేస్తున్నా, హాహా',
    'remote.peer_ts_msg': 'ఈ పాట బాగుంది',
    'remote.host_msg2': 'దీన్ని తర్వాత ప్లే చేస్తా',
    'remote.whisper_sender': 'హోస్ట్‌కు ప్రైవేట్ సందేశం',
    'remote.whisper_msg': 'నోటీస్‌లో ప్లేలిస్ట్ సూచనలు అడుగు',

    'sync.h2': 'సింక్ చేసిన ప్లేబ్యాక్.<br>వేర్వేరు నెట్‌వర్క్‌లలో.',
    'sync.lead': 'ప్రతి పరికరం ఆలస్యాన్ని తనిఖీ చేసి ప్లేబ్యాక్‌ను ఖచ్చితంగా సరిపోల్చి ఉంచుతుంది.',
    'sync.video_label': 'మీడియా',
    'sync.video_value': 'సింక్ చేసిన మీడియా ప్లేబ్యాక్',
    'sync.transport_label': 'డేటా ప్రసారం',
    'sync.transport_value': 'Peer-to-peer, WebRTC',
    'sync.effects_label': 'ఎఫెక్ట్‌లు',
    'sync.effects_value': '5-బ్యాండ్ EQ · రీవర్బ్ · వర్చువలైజర్',
    'sync.platforms_label': 'ప్లాట్‌ఫారమ్‌లు',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'హోస్ట్',
    'sync.meta': '60-శాంపిల్ NTP-శైలి సింక్',

    'standin.h2': 'మీ కంప్యూటర్‌లో<br>స్పీకర్లు లేవా?',
    'standin.lead':
      'MUSIXQUARE వెంటనే ప్రత్యామ్నాయ స్పీకర్ సిస్టమ్‌గా పనిచేస్తుంది. ప్రారంభించడానికి మీ బ్యాగ్‌లోని ఒక ఫోన్, ఒక టాబ్లెట్ చాలు.',
    'standin.aria':
      'పైన నిశ్శబ్ద కంప్యూటర్, కింద ఎడమ మరియు కుడి స్పీకర్లుగా పనిచేస్తున్న రెండు ఫోన్‌లు',
    'standin.desktop_label': 'డెస్క్‌టాప్',
    'standin.desktop_value': 'డెస్క్‌పై ఉన్న ఫోన్‌లు లేదా టాబ్లెట్‌లు స్పీకర్లుగా మారతాయి',
    'standin.laptop_label': 'ల్యాప్‌టాప్',
    'standin.laptop_value': 'బలహీనమైన బిల్ట్-ఇన్ స్పీకర్లకు బదులుగా అనేక పరికరాలు',
    'standin.feature_label': 'ఫీచర్',
    'standin.feature_value': 'సిస్టమ్ ఆడియో షేరింగ్ (Beta)',
    'standin.platform_label': 'ప్లాట్‌ఫారమ్',
    'standin.platform_value': 'కంప్యూటర్లలో Chromium ఆధారిత బ్రౌజర్‌లు',
    'standin.caveat':
      'Beta: కంప్యూటర్‌లోని Chromium బ్రౌజర్‌లో మాత్రమే; పంపే పరికరంతో కలిపి గరిష్ఠంగా 4 కనెక్ట్ అయిన పరికరాలు. ప్రతి Standard గది షేర్, Cloudflare ద్వారా రిలే చేసిన ప్రతి షేర్ (SFU) 2 గంటల తర్వాత ముగుస్తుంది. ధృవీకరించిన PRO LAN-direct షేర్, గది అధికారం కనెక్షన్ అందుబాటులో ఉండి సక్రమంగా పనిచేసేంత వరకు కొనసాగవచ్చు. లైవ్ ఆడియోలో ఆలస్యం తప్పనిసరి, కాబట్టి షేర్ చేస్తున్న పరికరం వాల్యూమ్‌ను తగ్గించండి.',

    'cta.h2': 'ఒక సెషన్‌ను ప్రారంభించండి.',
    'cta.btn': 'MUSIXQUAREను ప్రారంభించు',

    'footer.app': 'యాప్',
    'footer.history': 'చరిత్ర',
    'footer.designsystem': 'డిజైన్ సిస్టమ్',
  });

  addLang('hu', {
    'meta.title': 'Névjegy · MUSIXQUARE',
    'meta.description':
      'A MUSIXQUARE több telefont, táblagépet és laptopot egyetlen szinkronizált hangrendszerré alakít. Közvetlenül a böngészőben, telepítés nélkül.',
    'meta.og_title': 'Névjegy · MUSIXQUARE',
    'meta.og_description':
      'Minden eszköz, egy rendszer. Több eszközön szinkronizált hang, telepítés nélkül.',
    'meta.og_image_alt': 'MUSIXQUARE: Minden eszköz, egy rendszer.',
    'meta.tw_title': 'Névjegy · MUSIXQUARE',
    'meta.tw_description': 'Minden eszköz, egy rendszer.',

    'header.logo_aria': 'Vissza az oldal tetejére',
    'header.try': 'Próbáld ki most',
    'header.try_aria': 'A MUSIXQUARE kipróbálása most',

    'hero.h1': 'Minden eszköz,<br>egy rendszer.',
    'hero.lead':
      'A MUSIXQUARE több telefont, táblagépet és laptopot egyetlen hangrendszerré kapcsol össze. Nincs telepítés. Csak ossz meg egy kódot.',
    'hero.btn_ghost': 'Így működik',
    'hero.rooms_opened': 'Eddig {{count}} szoba nyílt.',

    'array.h2': 'Térhangzás,<br>külön hangszórórendszer nélkül.',
    'array.lead':
      'Minden eszköz egy szerepet kap: bal, jobb, mélynyomó vagy teljes sztereó. Maga a szoba válik a rendszerré.',
    'array.aria':
      'Bal oldali telefon, középen laptop, jobb oldali telefon. Három eszközből álló térhangzás.',

    'code.h2': 'Hat számjegy.<br>Semmi más.',
    'code.lead':
      'Indíts munkamenetet, és oszd meg a hatjegyű kódot. Támogatott böngészővel bárki másodpercek alatt csatlakozhat.',
    'code.aria_code': 'Példa szobakód',
    'code.aria_qr': 'A musixquare.com QR-kódja',
    'code.copy_btn': 'Meghívóhivatkozás másolása',
    'code.toast_success': 'Meghívóhivatkozás másolva',
    'code.toast_fail': 'A másolás nem sikerült',

    'remote.h2': 'Nem vagy a szobában?<br>Nem gond.',
    'remote.lead':
      'Csevegj, hallgass zenét vagy nézz YouTube-ot együtt másokkal, akár a város két végéből.',
    'remote.chat_label': 'Csevegés',
    'remote.chat_value': 'Valós idejű csevegés',
    'remote.whisper_label': 'Privát üzenet',
    'remote.whisper_value': 'Privát 1:1 üzenetek',
    'remote.cowatch_label': 'Közös videózás',
    'remote.cowatch_value': 'YouTube együtt, szinkronban',
    'remote.reach_label': 'Elérés',
    'remote.reach_value': 'Támogatott böngészők, különböző hálózatokon',
    'remote.caveat':
      'Megjegyzés: YouTube használatakor a csatornaszétválasztás és a hangeffektusok nem érhetők el.',
    'remote.pin_label': 'KÖZLEMÉNY · HÁZIGAZDA',
    'remote.pin_text': 'Lejátszásilista-tippek jöhetnek',
    'remote.host_name': 'HÁZIGAZDA',
    'remote.host_msg1': 'merre vagy?',
    'remote.peer_name': '1. résztvevő',
    'remote.peer_msg1': 'egy kávézóból dolgozom, haha',
    'remote.peer_ts_msg': 'ez a szám egész jó',
    'remote.host_msg2': 'később lejátszom',
    'remote.whisper_sender': 'privát üzenet a HÁZIGAZDÁNAK',
    'remote.whisper_msg': 'kérj lejátszásilista-tippeket a közleményben',

    'sync.h2': 'Szinkronizált lejátszás.<br>Hálózatokon át.',
    'sync.lead': 'Minden eszköz megméri a késleltetést, és pontosan összehangolja a lejátszást.',
    'sync.video_label': 'MÉDIA',
    'sync.video_value': 'Szinkronizált médialejátszás',
    'sync.transport_label': 'Adatátvitel',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Effektek',
    'sync.effects_value': '5 sávos EQ · Zengetés · Virtualizáló',
    'sync.platforms_label': 'Platformok',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Házigazda',
    'sync.meta': '60 mintás, NTP-jellegű szinkronizálás',

    'standin.h2': 'Nincs hangszóró<br>a számítógépeden?',
    'standin.lead':
      'A MUSIXQUARE gyors megoldást kínál helyettük. Az induláshoz elég egy telefon és egy táblagép a táskádból.',
    'standin.aria':
      'Néma számítógép két aktív telefon fölött; a telefonok bal és jobb hangszóróként működnek',
    'standin.desktop_label': 'Asztali gép',
    'standin.desktop_value': 'Az asztalon lévő telefonok vagy táblagépek lesznek a hangszórók',
    'standin.laptop_label': 'Laptop',
    'standin.laptop_value': 'Több eszköz a gyenge beépített hangszórók helyett',
    'standin.feature_label': 'Funkció',
    'standin.feature_value': 'Rendszerhang-megosztás (Beta)',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Chromium-alapú böngészők számítógépen',
    'standin.caveat':
      'Beta: csak számítógépen futó Chromium-alapú böngészőkben, és a közvetítővel együtt legfeljebb négy csatlakoztatott eszközt támogat. Minden Standard-szobában indított megosztás és minden Cloudflare által közvetített (SFU) megosztás két óra után véget ér; az ellenőrzött PRO LAN-direct megosztás addig folytatódhat, amíg a szoba jogosultság-ellenőrzése megfelelően működik. Az élő hang szükségszerűen késik, ezért a közvetítő eszköz hangerejét csökkenteni kell.',

    'cta.h2': 'Indíts munkamenetet.',
    'cta.btn': 'A MUSIXQUARE indítása',

    'footer.app': 'Alkalmazás',
    'footer.history': 'Előzmények',
    'footer.designsystem': 'Dizájnrendszer',
  });

  addLang('bg', {
    'meta.title': 'За MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE превръща няколко телефона, таблета и лаптопа в една синхронизирана озвучителна система. Работи директно в браузъра, без инсталиране.',
    'meta.og_title': 'За MUSIXQUARE',
    'meta.og_description':
      'Всяко устройство, една система. Синхронизиран звук на няколко устройства, без инсталиране.',
    'meta.og_image_alt': 'MUSIXQUARE: Всяко устройство, една система.',
    'meta.tw_title': 'За MUSIXQUARE',
    'meta.tw_description': 'Всяко устройство, една система.',

    'header.logo_aria': 'Обратно в началото на страницата',
    'header.try': 'Изпробвай сега',
    'header.try_aria': 'Изпробвай MUSIXQUARE сега',

    'hero.h1': 'Всички устройства,<br>една система.',
    'hero.lead':
      'MUSIXQUARE свързва няколко телефона, таблета и лаптопа в една озвучителна система. Без инсталиране. Нужно е само да споделиш един код.',
    'hero.btn_ghost': 'Как работи',
    'hero.rooms_opened': 'Отворени стаи досега: {{count}}.',

    'array.h2': 'Съраунд звук<br>без отделна система от говорители.',
    'array.lead':
      'Всяко устройство поема една роля: ляво, дясно, субуфер или пълно стерео. Самата стая се превръща в системата.',
    'array.aria':
      'Телефон отляво, лаптоп в центъра и телефон отдясно. Съраунд конфигурация с три устройства.',

    'code.h2': 'Шест цифри.<br>Нищо друго.',
    'code.lead':
      'Стартирай сесия и сподели шестцифрения код. Всеки с поддържан браузър може да се присъедини за секунди.',
    'code.aria_code': 'Примерен код за стая',
    'code.aria_qr': 'QR код за musixquare.com',
    'code.copy_btn': 'Копиране на връзката за покана',
    'code.toast_success': 'Връзката за покана е копирана',
    'code.toast_fail': 'Копирането е неуспешно',

    'remote.h2': 'Не си в стаята?<br>Няма проблем.',
    'remote.lead':
      'Разговаряй, слушай музика или гледай YouTube заедно с другите дори от различни краища на града.',
    'remote.chat_label': 'Чат',
    'remote.chat_value': 'Чат в реално време',
    'remote.whisper_label': 'Лично съобщение',
    'remote.whisper_value': 'Лични съобщения 1:1',
    'remote.cowatch_label': 'Съвместно гледане',
    'remote.cowatch_value': 'YouTube заедно, в синхрон',
    'remote.reach_label': 'Обхват',
    'remote.reach_value': 'Поддържани браузъри в различни мрежи',
    'remote.caveat': 'Бележка: разделянето по канали и звуковите ефекти не са достъпни за YouTube.',
    'remote.pin_label': 'ИЗВЕСТИЕ · ХОСТ',
    'remote.pin_text': 'Приемам предложения за плейлиста',
    'remote.host_name': 'ХОСТ',
    'remote.host_msg1': 'къде си?',
    'remote.peer_name': 'Участник 1',
    'remote.peer_msg1': 'работя от едно кафене, хаха',
    'remote.peer_ts_msg': 'тази песен е доста добра',
    'remote.host_msg2': 'ще я пусна по-късно',
    'remote.whisper_sender': 'лично съобщение до ХОСТ',
    'remote.whisper_msg': 'поискай предложения за плейлиста в известието',

    'sync.h2': 'Синхронно възпроизвеждане.<br>През различни мрежи.',
    'sync.lead':
      'Всяко устройство измерва закъснението, за да поддържа възпроизвеждането прецизно синхронизирано.',
    'sync.video_label': 'МЕДИЯ',
    'sync.video_value': 'Синхронизирано възпроизвеждане на медия',
    'sync.transport_label': 'Пренос',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Ефекти',
    'sync.effects_value': '5-лентов EQ · Реверберация · Виртуализатор',
    'sync.platforms_label': 'Платформи',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Хост',
    'sync.meta': 'Синхронизиране в стил NTP с 60 проби',

    'standin.h2': 'Компютърът ти<br>няма говорители?',
    'standin.lead':
      'MUSIXQUARE може бързо да ги замести. Един телефон и един таблет от чантата ти са достатъчни, за да започнеш.',
    'standin.aria':
      'Компютър без звук над два активни телефона, които служат като ляв и десен говорител',
    'standin.desktop_label': 'Настолен компютър',
    'standin.desktop_value': 'Телефоните или таблетите на бюрото се превръщат в говорители',
    'standin.laptop_label': 'Лаптоп',
    'standin.laptop_value': 'Няколко устройства вместо слабите вградени говорители',
    'standin.feature_label': 'Функция',
    'standin.feature_value': 'Споделяне на системен звук (Beta)',
    'standin.platform_label': 'Платформа',
    'standin.platform_value': 'Браузъри, базирани на Chromium, на компютър',
    'standin.caveat':
      'Beta: само в браузъри, базирани на Chromium, на компютър и с поддръжка на до четири свързани устройства, включително изпращащото. Всяко споделяне, започнато в Standard стая, и всяко споделяне, препредавано през Cloudflare (SFU), приключва след два часа; потвърдено PRO LAN-direct споделяне може да продължи, докато проверката на правата за стаята работи нормално. Звукът на живо неизбежно има закъснение, затова силата на звука на изпращащото устройство трябва да бъде намалена.',

    'cta.h2': 'Стартирай сесия.',
    'cta.btn': 'Стартиране на MUSIXQUARE',

    'footer.app': 'Приложение',
    'footer.history': 'История',
    'footer.designsystem': 'Дизайн система',
  });

  addLang('da', {
    'meta.title': 'Om MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE forvandler flere telefoner, tablets og bærbare computere til ét synkroniseret lydsystem. Direkte i browseren. Ingen installation.',
    'meta.og_title': 'Om MUSIXQUARE',
    'meta.og_description':
      'Hver enhed, ét system. Synkroniseret lyd på flere enheder, uden installation.',
    'meta.og_image_alt': 'MUSIXQUARE: Hver enhed, ét system.',
    'meta.tw_title': 'Om MUSIXQUARE',
    'meta.tw_description': 'Hver enhed, ét system.',

    'header.logo_aria': 'Tilbage til toppen',
    'header.try': 'Prøv det nu',
    'header.try_aria': 'Prøv MUSIXQUARE nu',

    'hero.h1': 'Hver enhed,<br>ét system.',
    'hero.lead':
      'MUSIXQUARE forvandler flere telefoner, tablets og bærbare computere til ét lydsystem. Ingen installation. Del blot én kode.',
    'hero.btn_ghost': 'Sådan fungerer det',
    'hero.rooms_opened': 'Der er indtil videre åbnet {{count}} rum.',

    'array.h2': 'Surroundlyd uden<br>surroundhøjttalere.',
    'array.lead':
      'Hver enhed får én rolle: venstre, højre, subwoofer eller fuld stereo. Selve rummet bliver til systemet.',
    'array.aria':
      'Telefon til venstre, bærbar computer i midten og telefon til højre. Surroundopsætning med tre enheder.',

    'code.h2': 'Seks cifre.<br>Ikke andet.',
    'code.lead':
      'Start en session, og del den sekscifrede kode. Alle med en understøttet browser kan deltage på få sekunder.',
    'code.aria_code': 'Eksempel på rumkode',
    'code.aria_qr': 'QR-kode til musixquare.com',
    'code.copy_btn': 'Kopiér invitationslink',
    'code.toast_success': 'Invitationslinket er kopieret',
    'code.toast_fail': 'Kopieringen mislykkedes',

    'remote.h2': 'Ikke i samme rum?<br>Intet problem.',
    'remote.lead': 'Chat, lyt til musik, eller se YouTube sammen, selv fra den anden ende af byen.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Chat i realtid',
    'remote.whisper_label': 'Privat besked',
    'remote.whisper_value': 'Private 1:1-beskeder',
    'remote.cowatch_label': 'Se sammen',
    'remote.cowatch_value': 'YouTube sammen og synkroniseret',
    'remote.reach_label': 'Rækkevidde',
    'remote.reach_value': 'Understøttede browsere på tværs af netværk',
    'remote.caveat': 'Bemærk: Kanalseparation og lydeffekter er ikke tilgængelige for YouTube.',
    'remote.pin_label': 'OPSLAG · HOST',
    'remote.pin_text': 'Modtager gerne forslag til afspilningslisten',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'hvor er du?',
    'remote.peer_name': 'Deltager 1',
    'remote.peer_msg1': 'arbejder fra en café lol',
    'remote.peer_ts_msg': 'den her sang er ret god',
    'remote.host_msg2': 'jeg spiller den senere',
    'remote.whisper_sender': 'privat besked til HOST',
    'remote.whisper_msg': 'bed om forslag til afspilningslisten i opslaget',

    'sync.h2': 'Synkroniseret afspilning.<br>På tværs af netværk.',
    'sync.lead': 'Hver enhed måler forsinkelsen og holder afspilningen præcist justeret.',
    'sync.video_label': 'MEDIA',
    'sync.video_value': 'Synkroniseret medieafspilning',
    'sync.transport_label': 'Overførsel',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Effekter',
    'sync.effects_value': '5-bånds-EQ · Efterklang · Virtualisering',
    'sync.platforms_label': 'Platforme',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Vært',
    'sync.meta': 'NTP-lignende synkronisering med 60 målinger',

    'standin.h2': 'Ingen højttalere på<br>din computer?',
    'standin.lead':
      'MUSIXQUARE fungerer som en hurtig erstatning. En telefon og en tablet fra tasken er nok til at komme i gang.',
    'standin.aria':
      'Lydløs computer over to aktive telefoner, der fungerer som venstre og højre højttaler',
    'standin.desktop_label': 'Stationær computer',
    'standin.desktop_value': 'Telefoner eller tablets på skrivebordet bliver til højttalere',
    'standin.laptop_label': 'Bærbar computer',
    'standin.laptop_value': 'Flere enheder i stedet for svage indbyggede højttalere',
    'standin.feature_label': 'Funktion',
    'standin.feature_value': 'Deling af systemlyd (Beta)',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Chromium-baserede browsere på computere',
    'standin.caveat':
      'Beta: kun Chromium på computere og højst fire tilsluttede enheder inklusive den publicerende enhed. Al deling i Standard-rum og al deling, der videresendes via Cloudflare (SFU), afsluttes efter to timer; en verificeret PRO LAN-direct-deling kan fortsætte, så længe rummets styringsfunktion fungerer korrekt. Live-lyd har uundgåelig forsinkelse, så den delende enhed bør skrue ned for lydstyrken.',

    'cta.h2': 'Start en session.',
    'cta.btn': 'Start MUSIXQUARE',

    'footer.app': 'App',
    'footer.history': 'Historik',
    'footer.designsystem': 'Designsystem',
  });

  addLang('nb', {
    'meta.title': 'Om MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE gjør flere telefoner, nettbrett og bærbare datamaskiner om til ett synkronisert lydsystem. Rett i nettleseren. Ingen installasjon.',
    'meta.og_title': 'Om MUSIXQUARE',
    'meta.og_description':
      'Hver enhet, ett system. Synkronisert lyd på flere enheter, uten installasjon.',
    'meta.og_image_alt': 'MUSIXQUARE: Hver enhet, ett system.',
    'meta.tw_title': 'Om MUSIXQUARE',
    'meta.tw_description': 'Hver enhet, ett system.',

    'header.logo_aria': 'Tilbake til toppen',
    'header.try': 'Prøv nå',
    'header.try_aria': 'Prøv MUSIXQUARE nå',

    'hero.h1': 'Hver enhet,<br>ett system.',
    'hero.lead':
      'MUSIXQUARE gjør flere telefoner, nettbrett og bærbare datamaskiner om til ett lydsystem. Ingen installasjon. Bare del én kode.',
    'hero.btn_ghost': 'Slik fungerer det',
    'hero.rooms_opened': 'Antall rom som er åpnet hittil: {{count}}.',

    'array.h2': 'Surroundlyd uten<br>surroundhøyttalere.',
    'array.lead':
      'Hver enhet får én rolle: venstre, høyre, subwoofer eller full stereo. Selve rommet blir systemet.',
    'array.aria':
      'Telefon til venstre, bærbar datamaskin i midten og telefon til høyre. Surroundoppsett med tre enheter.',

    'code.h2': 'Seks sifre.<br>Ikke noe mer.',
    'code.lead':
      'Start en økt og del den sekssifrede koden. Alle med en støttet nettleser kan bli med på få sekunder.',
    'code.aria_code': 'Eksempel på romkode',
    'code.aria_qr': 'QR-kode for musixquare.com',
    'code.copy_btn': 'Kopier invitasjonslenke',
    'code.toast_success': 'Invitasjonslenken er kopiert',
    'code.toast_fail': 'Kopieringen mislyktes',

    'remote.h2': 'Ikke i samme rom?<br>Ikke noe problem.',
    'remote.lead':
      'Chat, lytt til musikk eller se YouTube sammen, selv fra den andre siden av byen.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Chat i sanntid',
    'remote.whisper_label': 'Privat melding',
    'remote.whisper_value': 'Private 1:1-meldinger',
    'remote.cowatch_label': 'Se sammen',
    'remote.cowatch_value': 'YouTube sammen og synkronisert',
    'remote.reach_label': 'Rekkevidde',
    'remote.reach_value': 'Støttede nettlesere på tvers av nettverk',
    'remote.caveat': 'Merk: Kanalseparasjon og lydeffekter er ikke tilgjengelige for YouTube.',
    'remote.pin_label': 'OPPSLAG · HOST',
    'remote.pin_text': 'Tar gjerne imot forslag til spillelisten',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'hvor er du?',
    'remote.peer_name': 'Deltaker 1',
    'remote.peer_msg1': 'jobber fra en kafé lol',
    'remote.peer_ts_msg': 'denne sangen er ganske bra',
    'remote.host_msg2': 'jeg spiller den senere',
    'remote.whisper_sender': 'privat melding til HOST',
    'remote.whisper_msg': 'be om forslag til spillelisten i oppslaget',

    'sync.h2': 'Synkronisert avspilling.<br>På tvers av nettverk.',
    'sync.lead': 'Hver enhet måler forsinkelsen og holder avspillingen presist justert.',
    'sync.video_label': 'MEDIA',
    'sync.video_value': 'Synkronisert medieavspilling',
    'sync.transport_label': 'Overføring',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Effekter',
    'sync.effects_value': '5-bånds-EQ · Romklang · Virtualisering',
    'sync.platforms_label': 'Plattformer',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Vert',
    'sync.meta': 'NTP-lignende synkronisering med 60 målinger',

    'standin.h2': 'Har ikke datamaskinen<br>høyttalere?',
    'standin.lead':
      'MUSIXQUARE fungerer som en rask erstatning. En telefon og et nettbrett fra vesken er nok til å komme i gang.',
    'standin.aria':
      'Lydløs datamaskin over to aktive telefoner som fungerer som venstre og høyre høyttaler',
    'standin.desktop_label': 'Stasjonær datamaskin',
    'standin.desktop_value': 'Telefoner eller nettbrett på skrivebordet blir høyttalere',
    'standin.laptop_label': 'Bærbar datamaskin',
    'standin.laptop_value': 'Flere enheter i stedet for svake innebygde høyttalere',
    'standin.feature_label': 'Funksjon',
    'standin.feature_value': 'Deling av systemlyd (Beta)',
    'standin.platform_label': 'Plattform',
    'standin.platform_value': 'Chromium-baserte nettlesere på datamaskiner',
    'standin.caveat':
      'Beta: bare Chromium på datamaskiner, med opptil fire tilkoblede enheter inkludert den publiserende enheten. All deling i Standard-rom og all deling som videresendes via Cloudflare (SFU), avsluttes etter to timer; en verifisert PRO LAN-direct-deling kan fortsette så lenge rommets styringsfunksjon fungerer som den skal. Live-lyd har uunngåelig forsinkelse, så enheten som deler, bør senke volumet.',

    'cta.h2': 'Start en økt.',
    'cta.btn': 'Start MUSIXQUARE',

    'footer.app': 'App',
    'footer.history': 'Historikk',
    'footer.designsystem': 'Designsystem',
  });

  addLang('fi', {
    'meta.title': 'Tietoja MUSIXQUAREsta',
    'meta.description':
      'MUSIXQUARE tekee useista puhelimista, tableteista ja kannettavista tietokoneista yhden synkronoidun äänentoistojärjestelmän. Suoraan selaimessa. Ei asennusta.',
    'meta.og_title': 'Tietoja MUSIXQUAREsta',
    'meta.og_description':
      'Jokainen laite, yksi järjestelmä. Synkronoitu ääni useilla laitteilla, ilman asennusta.',
    'meta.og_image_alt': 'MUSIXQUARE: Jokainen laite, yksi järjestelmä.',
    'meta.tw_title': 'Tietoja MUSIXQUAREsta',
    'meta.tw_description': 'Jokainen laite, yksi järjestelmä.',

    'header.logo_aria': 'Takaisin sivun alkuun',
    'header.try': 'Kokeile nyt',
    'header.try_aria': 'Kokeile MUSIXQUAREa nyt',

    'hero.h1': 'Jokainen laite,<br>yksi järjestelmä.',
    'hero.lead':
      'MUSIXQUARE tekee useista puhelimista, tableteista ja kannettavista tietokoneista yhden äänentoistojärjestelmän. Ei asennusta. Jaa vain yksi koodi.',
    'hero.btn_ghost': 'Näin se toimii',
    'hero.rooms_opened': 'Tähän mennessä avattuja huoneita: {{count}}.',

    'array.h2': 'Tilaääntä ilman<br>tilaäänikaiuttimia.',
    'array.lead':
      'Jokaisella laitteella on yksi rooli: vasen, oikea, bassokaiutin tai täysi stereoääni. Itse huoneesta tulee järjestelmä.',
    'array.aria':
      'Puhelin vasemmalla, kannettava tietokone keskellä ja puhelin oikealla. Kolmen laitteen tilaäänikokoonpano.',

    'code.h2': 'Kuusi numeroa.<br>Siinä kaikki.',
    'code.lead':
      'Aloita istunto ja jaa kuusinumeroinen koodi. Kuka tahansa tuetulla selaimella voi liittyä muutamassa sekunnissa.',
    'code.aria_code': 'Esimerkkihuoneen koodi',
    'code.aria_qr': 'musixquare.com-sivuston QR-koodi',
    'code.copy_btn': 'Kopioi kutsulinkki',
    'code.toast_success': 'Kutsulinkki kopioitu',
    'code.toast_fail': 'Kopiointi epäonnistui',

    'remote.h2': 'Et ole samassa huoneessa?<br>Ei haittaa.',
    'remote.lead':
      'Keskustele, kuuntele musiikkia tai katso YouTubea yhdessä, vaikka kaupungin toiselta puolelta.',
    'remote.chat_label': 'Chat',
    'remote.chat_value': 'Reaaliaikainen chat',
    'remote.whisper_label': 'Yksityisviesti',
    'remote.whisper_value': 'Kahdenkeskiset yksityisviestit',
    'remote.cowatch_label': 'Katso yhdessä',
    'remote.cowatch_value': 'YouTube yhdessä ja synkronoituna',
    'remote.reach_label': 'Kattavuus',
    'remote.reach_value': 'Tuetut selaimet eri verkoissa',
    'remote.caveat': 'Huomaa: Kanavajako ja äänitehosteet eivät ole käytettävissä YouTubessa.',
    'remote.pin_label': 'ILMOITUS · HOST',
    'remote.pin_text': 'Otan vastaan soittolistavinkkejä',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'missä olet?',
    'remote.peer_name': 'Osallistuja 1',
    'remote.peer_msg1': 'teen töitä kahvilassa lol',
    'remote.peer_ts_msg': 'tämä kappale on aika hyvä',
    'remote.host_msg2': 'toistan sen myöhemmin',
    'remote.whisper_sender': 'yksityisviesti HOSTille',
    'remote.whisper_msg': 'pyydä ilmoituksessa vinkkejä soittolistalle',

    'sync.h2': 'Synkronoitu toisto.<br>Eri verkkojen välillä.',
    'sync.lead': 'Jokainen laite mittaa viiveen ja pitää toiston tarkasti kohdistettuna.',
    'sync.video_label': 'MEDIA',
    'sync.video_value': 'Synkronoitu median toisto',
    'sync.transport_label': 'Siirtotapa',
    'sync.transport_value': 'P2P · WebRTC',
    'sync.effects_label': 'Tehosteet',
    'sync.effects_value': '5-kaistainen EQ · Kaiku · Virtualisointi',
    'sync.platforms_label': 'Alustat',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'Isäntä',
    'sync.meta': '60 mittauksen NTP-tyylinen synkronointi',

    'standin.h2': 'Eikö tietokoneessasi ole<br>kaiuttimia?',
    'standin.lead':
      'MUSIXQUARE toimii nopeana korvikkeena. Alkuun pääsee laukusta löytyvällä puhelimella ja tabletilla.',
    'standin.aria':
      'Äänetön tietokone kahden aktiivisen, vasempana ja oikeana kaiuttimena toimivan puhelimen yläpuolella',
    'standin.desktop_label': 'Pöytätietokone',
    'standin.desktop_value': 'Pöydällä olevista puhelimista tai tableteista tulee kaiuttimia',
    'standin.laptop_label': 'Kannettava tietokone',
    'standin.laptop_value': 'Useita laitteita heikkojen sisäänrakennettujen kaiuttimien sijaan',
    'standin.feature_label': 'Ominaisuus',
    'standin.feature_value': 'Järjestelmän äänen jakaminen (Beta)',
    'standin.platform_label': 'Alusta',
    'standin.platform_value': 'Tietokoneiden Chromium-pohjaiset selaimet',
    'standin.caveat':
      'Beta: vain tietokoneiden Chromium-selaimissa, enintään neljä yhdistettyä laitetta, lähettävä laite mukaan lukien. Jokainen Standard-huoneen jako ja jokainen Cloudflaren välittämä jako (SFU) päättyy kahden tunnin kuluttua; vahvistettu PRO LAN-direct -jako voi jatkua niin kauan kuin huoneen hallintatoiminto toimii normaalisti. Reaaliaikaiseen äänentoistoon liittyy väistämätöntä viivettä, joten jakavan laitteen äänenvoimakkuutta kannattaa pienentää.',

    'cta.h2': 'Aloita istunto.',
    'cta.btn': 'Käynnistä MUSIXQUARE',

    'footer.app': 'Sovellus',
    'footer.history': 'Historia',
    'footer.designsystem': 'Suunnittelujärjestelmä',
  });

  addLang('mr', {
    'meta.title': 'MUSIXQUARE विषयी',
    'meta.description':
      'MUSIXQUARE अनेक फोन, टॅबलेट आणि लॅपटॉपना एका समक्रमित ध्वनीप्रणालीत रूपांतरित करते. थेट ब्राउझरमध्ये. इन्स्टॉल करण्याची गरज नाही.',
    'meta.og_title': 'MUSIXQUARE विषयी',
    'meta.og_description':
      'प्रत्येक डिव्हाइस, एकच सिस्टम. अनेक डिव्हाइसवर समक्रमित ऑडिओ, इन्स्टॉल करण्याची गरज नाही.',
    'meta.og_image_alt': 'MUSIXQUARE: प्रत्येक डिव्हाइस, एकच सिस्टम.',
    'meta.tw_title': 'MUSIXQUARE विषयी',
    'meta.tw_description': 'प्रत्येक डिव्हाइस, एकच सिस्टम.',

    'header.logo_aria': 'वर परत जा',
    'header.try': 'आत्ताच वापरून पाहा',
    'header.try_aria': 'MUSIXQUARE आत्ताच वापरून पाहा',

    'hero.h1': 'प्रत्येक डिव्हाइस,<br>एकच सिस्टम.',
    'hero.lead':
      'MUSIXQUARE अनेक फोन, टॅबलेट आणि लॅपटॉपना एका साउंड सिस्टममध्ये जोडते. इन्स्टॉल करण्याची गरज नाही. फक्त एक कोड शेअर करा.',
    'hero.btn_ghost': 'हे कसे काम करते',
    'hero.rooms_opened': 'आतापर्यंत {{count}} रूम उघडल्या.',

    'array.h2': 'सराउंड स्पीकरशिवाय<br>सराउंड साउंड.',
    'array.lead':
      'प्रत्येक डिव्हाइस एक भूमिका बजावते: डावा, उजवा, सबवूफर किंवा पूर्ण स्टिरिओ. रूमच संपूर्ण सिस्टम बनते.',
    'array.aria': 'डावीकडे फोन, मध्यभागी लॅपटॉप, उजवीकडे फोन. तीन डिव्हाइसचा सराउंड सेटअप.',

    'code.h2': 'सहा अंक.<br>बस इतकेच.',
    'code.lead':
      'सेशन सुरू करा आणि सहा अंकी कोड शेअर करा. समर्थित ब्राउझर असलेला कोणीही काही सेकंदांत सहभागी होऊ शकतो.',
    'code.aria_code': 'रूम कोडचे उदाहरण',
    'code.aria_qr': 'musixquare.com साठी QR कोड',
    'code.copy_btn': 'आमंत्रण लिंक कॉपी करा',
    'code.toast_success': 'आमंत्रण लिंक कॉपी झाली',
    'code.toast_fail': 'कॉपी करता आली नाही',

    'remote.h2': 'रूममध्ये नाही?<br>काही हरकत नाही.',
    'remote.lead': 'शहराच्या दुसऱ्या टोकावरूनही चॅट करा, संगीत ऐका किंवा YouTube वर एकत्र पाहा.',
    'remote.chat_label': 'चॅट',
    'remote.chat_value': 'रिअल-टाइम चॅट',
    'remote.whisper_label': 'कुजबुज',
    'remote.whisper_value': 'खासगी 1:1 संदेश',
    'remote.cowatch_label': 'एकत्र पाहणे',
    'remote.cowatch_value': 'YouTube एकत्र, सिंकमध्ये',
    'remote.reach_label': 'पोहोच',
    'remote.reach_value': 'समर्थित ब्राउझर, वेगवेगळ्या नेटवर्कवर',
    'remote.caveat': 'टीप: YouTube वापरताना चॅनेल विभाजन आणि ऑडिओ इफेक्ट उपलब्ध नसतात.',
    'remote.pin_label': 'सूचना · होस्ट',
    'remote.pin_text': 'प्लेलिस्टसाठी शिफारसी हव्यात',
    'remote.host_name': 'होस्ट',
    'remote.host_msg1': 'तू कुठे आहेस?',
    'remote.peer_name': 'सहभागी 1',
    'remote.peer_msg1': 'कॅफेमधून काम करतोय, हाहा',
    'remote.peer_ts_msg': 'हे गाणं खूप छान आहे',
    'remote.host_msg2': 'नंतर लावतो',
    'remote.whisper_sender': 'होस्टला कुजबुज',
    'remote.whisper_msg': 'सूचनेत प्लेलिस्टसाठी शिफारसी माग',

    'sync.h2': 'समक्रमित प्लेबॅक.<br>वेगवेगळ्या नेटवर्कवरही.',
    'sync.lead': 'प्रत्येक डिव्हाइस विलंब तपासते आणि प्लेबॅक अचूकपणे जुळवून ठेवते.',
    'sync.video_label': 'मीडिया',
    'sync.video_value': 'समक्रमित मीडिया प्लेबॅक',
    'sync.transport_label': 'ट्रान्सपोर्ट',
    'sync.transport_value': 'Peer-to-peer, WebRTC',
    'sync.effects_label': 'इफेक्ट',
    'sync.effects_value': '5-बँड EQ · रिव्हर्ब · व्हर्च्युअलायझर',
    'sync.platforms_label': 'प्लॅटफॉर्म',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'होस्ट',
    'sync.meta': '60 नमुन्यांचा NTP-शैलीतील सिंक',

    'standin.h2': 'कंप्युटरला<br>स्पीकर नाहीत?',
    'standin.lead':
      'MUSIXQUARE तात्पुरत्या स्पीकर सिस्टमचे काम करते. सुरुवात करण्यासाठी तुमच्या बॅगेतील एक फोन आणि एक टॅबलेट पुरेसे आहेत.',
    'standin.aria':
      'वर आवाज नसलेला कंप्युटर आणि खाली डावा व उजवा स्पीकर म्हणून काम करणारे दोन सक्रिय फोन',
    'standin.desktop_label': 'डेस्कटॉप',
    'standin.desktop_value': 'डेस्कवरील फोन किंवा टॅबलेट स्पीकर बनतात',
    'standin.laptop_label': 'लॅपटॉप',
    'standin.laptop_value': 'कमकुवत अंगभूत स्पीकरऐवजी अनेक डिव्हाइस',
    'standin.feature_label': 'वैशिष्ट्य',
    'standin.feature_value': 'सिस्टम ऑडिओ शेअरिंग (Beta)',
    'standin.platform_label': 'प्लॅटफॉर्म',
    'standin.platform_value': 'कंप्युटरवरील Chromium-आधारित ब्राउझर',
    'standin.caveat':
      'Beta: केवळ डेस्कटॉपवरील Chromium; ऑडिओ पाठवणाऱ्या डिव्हाइससह जास्तीत जास्त चार जोडलेली डिव्हाइस. Standard रूममधील प्रत्येक शेअर आणि Cloudflare मार्फत रिले होणारा (SFU) प्रत्येक शेअर दोन तासांनंतर बंद होतो; पडताळलेला PRO LAN-direct शेअर मात्र रूमची नियंत्रण व्यवस्था सुरळीत असेपर्यंत सुरू राहू शकतो. लाइव्ह ऑडिओमध्ये काही विलंब टाळता येत नाही, त्यामुळे ऑडिओ शेअर करणाऱ्या डिव्हाइसचा आवाज कमी ठेवावा.',

    'cta.h2': 'सेशन सुरू करा.',
    'cta.btn': 'MUSIXQUARE सुरू करा',

    'footer.app': 'अ‍ॅप',
    'footer.history': 'इतिहास',
    'footer.designsystem': 'डिझाइन सिस्टम',
  });

  addLang('gu', {
    'meta.title': 'MUSIXQUARE વિશે',
    'meta.description':
      'MUSIXQUARE અનેક ફોન, ટૅબ્લેટ અને લેપટોપને એક સિંક થયેલી સાઉન્ડ સિસ્ટમમાં ફેરવે છે. સીધું બ્રાઉઝરમાં. ઇન્સ્ટૉલ કરવાની જરૂર નથી.',
    'meta.og_title': 'MUSIXQUARE વિશે',
    'meta.og_description':
      'દરેક ડિવાઇસ, એક જ સિસ્ટમ. અનેક ડિવાઇસ પર સિંક થયેલો ઑડિયો, ઇન્સ્ટૉલ કરવાની જરૂર નથી.',
    'meta.og_image_alt': 'MUSIXQUARE: દરેક ડિવાઇસ, એક જ સિસ્ટમ.',
    'meta.tw_title': 'MUSIXQUARE વિશે',
    'meta.tw_description': 'દરેક ડિવાઇસ, એક જ સિસ્ટમ.',

    'header.logo_aria': 'ઉપર પાછા જાઓ',
    'header.try': 'હમણાં અજમાવો',
    'header.try_aria': 'MUSIXQUARE હમણાં અજમાવો',

    'hero.h1': 'દરેક ડિવાઇસ,<br>એક જ સિસ્ટમ.',
    'hero.lead':
      'MUSIXQUARE અનેક ફોન, ટૅબ્લેટ અને લેપટોપને એક સાઉન્ડ સિસ્ટમમાં જોડે છે. ઇન્સ્ટૉલ કરવાની જરૂર નથી. ફક્ત એક કોડ શેર કરો.',
    'hero.btn_ghost': 'તે કેવી રીતે કામ કરે છે',
    'hero.rooms_opened': 'અત્યાર સુધીમાં {{count}} રૂમ ખૂલ્યા છે.',

    'array.h2': 'સરાઉન્ડ સ્પીકર વિના<br>સરાઉન્ડ સાઉન્ડ.',
    'array.lead':
      'દરેક ડિવાઇસ એક ભૂમિકા ભજવે છે: ડાબું, જમણું, સબવૂફર અથવા સંપૂર્ણ સ્ટીરિયો. આખો રૂમ જ સિસ્ટમ બની જાય છે.',
    'array.aria': 'ડાબે ફોન, વચ્ચે લેપટોપ, જમણે ફોન. ત્રણ ડિવાઇસનું સરાઉન્ડ સેટઅપ.',

    'code.h2': 'છ અંક.<br>બસ એટલું જ.',
    'code.lead':
      'સત્ર શરૂ કરો અને છ અંકનો કોડ શેર કરો. સપોર્ટેડ બ્રાઉઝર ધરાવતી કોઈ પણ વ્યક્તિ થોડી જ સેકન્ડમાં જોડાઈ શકે છે.',
    'code.aria_code': 'રૂમ કોડનું ઉદાહરણ',
    'code.aria_qr': 'musixquare.com માટેનો QR કોડ',
    'code.copy_btn': 'આમંત્રણ લિંક કૉપિ કરો',
    'code.toast_success': 'આમંત્રણ લિંક કૉપિ થઈ',
    'code.toast_fail': 'કૉપિ થઈ શકી નહીં',

    'remote.h2': 'રૂમમાં નથી?<br>કોઈ વાંધો નહીં.',
    'remote.lead': 'શહેરના બીજા છેડેથી પણ ચેટ કરો, સંગીત સાંભળો અથવા YouTube પર સાથે જુઓ.',
    'remote.chat_label': 'ચેટ',
    'remote.chat_value': 'રિયલ-ટાઇમ ચેટ',
    'remote.whisper_label': 'ખાનગી વાત',
    'remote.whisper_value': 'ખાનગી 1:1 સંદેશા',
    'remote.cowatch_label': 'સાથે જુઓ',
    'remote.cowatch_value': 'YouTube સાથે, સિંકમાં',
    'remote.reach_label': 'ઉપલબ્ધતા',
    'remote.reach_value': 'સપોર્ટેડ બ્રાઉઝર, અલગ અલગ નેટવર્ક પર',
    'remote.caveat': 'નોંધ: YouTube માટે ચૅનલ વિભાજન અને ઑડિયો ઇફેક્ટ ઉપલબ્ધ નથી.',
    'remote.pin_label': 'સૂચના · હોસ્ટ',
    'remote.pin_text': 'પ્લેલિસ્ટ માટે સૂચનો આપો',
    'remote.host_name': 'હોસ્ટ',
    'remote.host_msg1': 'તમે ક્યાં છો?',
    'remote.peer_name': 'સાથી 1',
    'remote.peer_msg1': 'કૅફેમાંથી કામ કરું છું, હાહા',
    'remote.peer_ts_msg': 'આ ગીત બહુ સરસ છે',
    'remote.host_msg2': 'પછી વગાડીશ',
    'remote.whisper_sender': 'હોસ્ટને ખાનગી સંદેશ',
    'remote.whisper_msg': 'સૂચનામાં પ્લેલિસ્ટ માટે ભલામણો માંગો',

    'sync.h2': 'સિંક થયેલું પ્લેબૅક.<br>અલગ નેટવર્ક પર પણ.',
    'sync.lead': 'દરેક ડિવાઇસ વિલંબ તપાસે છે અને પ્લેબૅકને ચોકસાઈથી એકસરખું રાખે છે.',
    'sync.video_label': 'મીડિયા',
    'sync.video_value': 'સિંક થયેલું મીડિયા પ્લેબૅક',
    'sync.transport_label': 'ટ્રાન્સપોર્ટ',
    'sync.transport_value': 'Peer-to-peer, WebRTC',
    'sync.effects_label': 'ઇફેક્ટ',
    'sync.effects_value': '5-બૅન્ડ EQ · રિવર્બ · વર્ચ્યુઅલાઇઝર',
    'sync.platforms_label': 'પ્લૅટફોર્મ',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'હોસ્ટ',
    'sync.meta': '60 નમૂનાનો NTP-શૈલીનો સિંક',

    'standin.h2': 'કમ્પ્યુટરમાં<br>સ્પીકર નથી?',
    'standin.lead':
      'MUSIXQUARE ઝટપટ વિકલ્પ તરીકે કામ કરે છે. શરૂઆત કરવા માટે તમારી બૅગમાં રહેલો એક ફોન અને એક ટૅબ્લેટ પૂરતા છે.',
    'standin.aria':
      'ઉપર અવાજ વિનાનું કમ્પ્યુટર અને નીચે ડાબા તથા જમણા સ્પીકર તરીકે કામ કરતા બે સક્રિય ફોન',
    'standin.desktop_label': 'ડેસ્કટૉપ',
    'standin.desktop_value': 'ડેસ્ક પરના ફોન અથવા ટૅબ્લેટ સ્પીકર બની જાય છે',
    'standin.laptop_label': 'લેપટોપ',
    'standin.laptop_value': 'નબળા બિલ્ટ-ઇન સ્પીકરને બદલે અનેક ડિવાઇસ',
    'standin.feature_label': 'સુવિધા',
    'standin.feature_value': 'સિસ્ટમ ઑડિયો શેરિંગ (Beta)',
    'standin.platform_label': 'પ્લૅટફોર્મ',
    'standin.platform_value': 'કમ્પ્યુટર પર Chromium-આધારિત બ્રાઉઝર',
    'standin.caveat':
      'Beta: ફક્ત ડેસ્કટૉપ Chromium; ઑડિયો મોકલતા ડિવાઇસ સહિત વધુમાં વધુ ચાર જોડાયેલા ડિવાઇસ. Standard રૂમનું દરેક શેર અને Cloudflare મારફતે રિલે થતું (SFU) દરેક શેર બે કલાક પછી બંધ થાય છે; ચકાસાયેલું PRO LAN-direct શેર રૂમની નિયંત્રણ વ્યવસ્થા યોગ્ય રીતે કાર્ય કરતી હોય ત્યાં સુધી ચાલુ રહી શકે છે. લાઇવ ઑડિયોમાં થોડો વિલંબ અનિવાર્ય છે, તેથી ઑડિયો શેર કરતા ડિવાઇસનું વૉલ્યુમ ઓછું રાખવું જોઈએ.',

    'cta.h2': 'સત્ર શરૂ કરો.',
    'cta.btn': 'MUSIXQUARE શરૂ કરો',

    'footer.app': 'ઍપ',
    'footer.history': 'ઇતિહાસ',
    'footer.designsystem': 'ડિઝાઇન સિસ્ટમ',
  });

  addLang('kn', {
    'meta.title': 'MUSIXQUARE ಕುರಿತು',
    'meta.description':
      'MUSIXQUARE ಹಲವು ಫೋನ್‌ಗಳು, ಟ್ಯಾಬ್ಲೆಟ್‌ಗಳು ಮತ್ತು ಲ್ಯಾಪ್‌ಟಾಪ್‌ಗಳನ್ನು ಒಂದೇ ಸಿಂಕ್ ಆದ ಸೌಂಡ್ ಸಿಸ್ಟಮ್ ಆಗಿ ರೂಪಿಸುತ್ತದೆ. ನೇರವಾಗಿ ಬ್ರೌಸರ್‌ನಲ್ಲಿ. ಇನ್‌ಸ್ಟಾಲ್ ಮಾಡುವ ಅಗತ್ಯವಿಲ್ಲ.',
    'meta.og_title': 'MUSIXQUARE ಕುರಿತು',
    'meta.og_description':
      'ಪ್ರತಿ ಸಾಧನ, ಒಂದೇ ಸಿಸ್ಟಮ್. ಹಲವು ಸಾಧನಗಳಲ್ಲಿ ಸಿಂಕ್ ಆದ ಆಡಿಯೊ, ಇನ್‌ಸ್ಟಾಲ್ ಮಾಡುವ ಅಗತ್ಯವಿಲ್ಲ.',
    'meta.og_image_alt': 'MUSIXQUARE: ಪ್ರತಿ ಸಾಧನ, ಒಂದೇ ಸಿಸ್ಟಮ್.',
    'meta.tw_title': 'MUSIXQUARE ಕುರಿತು',
    'meta.tw_description': 'ಪ್ರತಿ ಸಾಧನ, ಒಂದೇ ಸಿಸ್ಟಮ್.',

    'header.logo_aria': 'ಮೇಲಕ್ಕೆ ಹಿಂತಿರುಗಿ',
    'header.try': 'ಈಗಲೇ ಪ್ರಯತ್ನಿಸಿ',
    'header.try_aria': 'MUSIXQUARE ಅನ್ನು ಈಗಲೇ ಪ್ರಯತ್ನಿಸಿ',

    'hero.h1': 'ಪ್ರತಿ ಸಾಧನ,<br>ಒಂದೇ ಸಿಸ್ಟಮ್.',
    'hero.lead':
      'MUSIXQUARE ಹಲವು ಫೋನ್‌ಗಳು, ಟ್ಯಾಬ್ಲೆಟ್‌ಗಳು ಮತ್ತು ಲ್ಯಾಪ್‌ಟಾಪ್‌ಗಳನ್ನು ಒಂದೇ ಸೌಂಡ್ ಸಿಸ್ಟಮ್‌ಗೆ ಜೋಡಿಸುತ್ತದೆ. ಇನ್‌ಸ್ಟಾಲ್ ಮಾಡುವ ಅಗತ್ಯವಿಲ್ಲ. ಒಂದೇ ಕೋಡ್ ಹಂಚಿಕೊಳ್ಳಿ.',
    'hero.btn_ghost': 'ಇದು ಹೇಗೆ ಕೆಲಸ ಮಾಡುತ್ತದೆ',
    'hero.rooms_opened': 'ಇದುವರೆಗೆ {{count}} ರೂಮ್‌ಗಳನ್ನು ತೆರೆಯಲಾಗಿದೆ.',

    'array.h2': 'ಸರೌಂಡ್ ಸ್ಪೀಕರ್‌ಗಳಿಲ್ಲದೆ<br>ಸರೌಂಡ್ ಸೌಂಡ್.',
    'array.lead':
      'ಪ್ರತಿ ಸಾಧನವು ಒಂದು ಪಾತ್ರ ವಹಿಸುತ್ತದೆ: ಎಡ, ಬಲ, ಸಬ್‌ವೂಫರ್ ಅಥವಾ ಪೂರ್ಣ ಸ್ಟೀರಿಯೊ. ರೂಮ್‌ವೇ ಸಿಸ್ಟಮ್ ಆಗುತ್ತದೆ.',
    'array.aria': 'ಎಡಕ್ಕೆ ಫೋನ್, ಮಧ್ಯದಲ್ಲಿ ಲ್ಯಾಪ್‌ಟಾಪ್, ಬಲಕ್ಕೆ ಫೋನ್. ಮೂರು ಸಾಧನಗಳ ಸರೌಂಡ್ ಸೆಟಪ್.',

    'code.h2': 'ಆರು ಅಂಕಿಗಳು.<br>ಅಷ್ಟೇ.',
    'code.lead':
      'ಸೆಷನ್ ಆರಂಭಿಸಿ ಮತ್ತು ಆರು ಅಂಕಿಯ ಕೋಡ್ ಹಂಚಿಕೊಳ್ಳಿ. ಬೆಂಬಲಿತ ಬ್ರೌಸರ್ ಇರುವ ಯಾರಾದರೂ ಕೆಲವೇ ಸೆಕೆಂಡುಗಳಲ್ಲಿ ಸೇರಬಹುದು.',
    'code.aria_code': 'ರೂಮ್ ಕೋಡ್ ಉದಾಹರಣೆ',
    'code.aria_qr': 'musixquare.com ಗಾಗಿ QR ಕೋಡ್',
    'code.copy_btn': 'ಆಮಂತ್ರಣ ಲಿಂಕ್ ನಕಲಿಸಿ',
    'code.toast_success': 'ಆಮಂತ್ರಣ ಲಿಂಕ್ ನಕಲಿಸಲಾಗಿದೆ',
    'code.toast_fail': 'ನಕಲಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ',

    'remote.h2': 'ರೂಮ್‌ನಲ್ಲಿ ಇಲ್ಲವೇ?<br>ಪರವಾಗಿಲ್ಲ.',
    'remote.lead':
      'ನಗರದ ಇನ್ನೊಂದು ತುದಿಯಿಂದಲೂ ಚಾಟ್ ಮಾಡಿ, ಸಂಗೀತ ಆಲಿಸಿ ಅಥವಾ YouTube ಅನ್ನು ಒಟ್ಟಿಗೆ ವೀಕ್ಷಿಸಿ.',
    'remote.chat_label': 'ಚಾಟ್',
    'remote.chat_value': 'ರಿಯಲ್-ಟೈಮ್ ಚಾಟ್',
    'remote.whisper_label': 'ಖಾಸಗಿ ಮಾತು',
    'remote.whisper_value': 'ಖಾಸಗಿ 1:1 ಸಂದೇಶಗಳು',
    'remote.cowatch_label': 'ಒಟ್ಟಿಗೆ ವೀಕ್ಷಣೆ',
    'remote.cowatch_value': 'YouTube ಒಟ್ಟಿಗೆ, ಸಿಂಕ್‌ನಲ್ಲಿ',
    'remote.reach_label': 'ಲಭ್ಯತೆ',
    'remote.reach_value': 'ಬೆಂಬಲಿತ ಬ್ರೌಸರ್‌ಗಳು, ಬೇರೆ ಬೇರೆ ನೆಟ್‌ವರ್ಕ್‌ಗಳಲ್ಲಿ',
    'remote.caveat': 'ಗಮನಿಸಿ: YouTube ನಲ್ಲಿ ಚಾನೆಲ್ ವಿಭಜನೆ ಮತ್ತು ಆಡಿಯೊ ಪರಿಣಾಮಗಳು ಲಭ್ಯವಿಲ್ಲ.',
    'remote.pin_label': 'ಸೂಚನೆ · ಹೋಸ್ಟ್',
    'remote.pin_text': 'ಪ್ಲೇಲಿಸ್ಟ್ ಸಲಹೆಗಳು ಬೇಕು',
    'remote.host_name': 'ಹೋಸ್ಟ್',
    'remote.host_msg1': 'ನೀವು ಎಲ್ಲಿದ್ದೀರಿ?',
    'remote.peer_name': 'ಸಹಭಾಗಿ 1',
    'remote.peer_msg1': 'ಕೆಫೆಯಿಂದ ಕೆಲಸ ಮಾಡುತ್ತಿದ್ದೇನೆ, ಹಹಾ',
    'remote.peer_ts_msg': 'ಈ ಹಾಡು ತುಂಬಾ ಚೆನ್ನಾಗಿದೆ',
    'remote.host_msg2': 'ನಂತರ ಪ್ಲೇ ಮಾಡುತ್ತೇನೆ',
    'remote.whisper_sender': 'ಹೋಸ್ಟ್‌ಗೆ ಖಾಸಗಿ ಸಂದೇಶ',
    'remote.whisper_msg': 'ಸೂಚನೆಯಲ್ಲಿ ಪ್ಲೇಲಿಸ್ಟ್ ಸಲಹೆಗಳನ್ನು ಕೇಳಿ',

    'sync.h2': 'ಸಿಂಕ್ ಮಾಡಿದ ಪ್ಲೇಬ್ಯಾಕ್.<br>ಬೇರೆ ಬೇರೆ ನೆಟ್‌ವರ್ಕ್‌ಗಳಲ್ಲೂ.',
    'sync.lead': 'ಪ್ರತಿ ಸಾಧನವು ವಿಳಂಬವನ್ನು ಪರಿಶೀಲಿಸಿ ಪ್ಲೇಬ್ಯಾಕ್ ಅನ್ನು ನಿಖರವಾಗಿ ಹೊಂದಿಸುತ್ತದೆ.',
    'sync.video_label': 'ಮೀಡಿಯಾ',
    'sync.video_value': 'ಸಿಂಕ್ ಮಾಡಿದ ಮೀಡಿಯಾ ಪ್ಲೇಬ್ಯಾಕ್',
    'sync.transport_label': 'ಟ್ರಾನ್ಸ್‌ಪೋರ್ಟ್',
    'sync.transport_value': 'Peer-to-peer, WebRTC',
    'sync.effects_label': 'ಪರಿಣಾಮಗಳು',
    'sync.effects_value': '5-ಬ್ಯಾಂಡ್ EQ · ರಿವರ್ಬ್ · ವರ್ಚುವಲೈಜರ್',
    'sync.platforms_label': 'ಪ್ಲಾಟ್‌ಫಾರ್ಮ್‌ಗಳು',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'ಹೋಸ್ಟ್',
    'sync.meta': '60 ಮಾದರಿಗಳ NTP-ಶೈಲಿಯ ಸಿಂಕ್',

    'standin.h2': 'ಕಂಪ್ಯೂಟರ್‌ನಲ್ಲಿ<br>ಸ್ಪೀಕರ್‌ಗಳಿಲ್ಲವೇ?',
    'standin.lead':
      'MUSIXQUARE ತ್ವರಿತ ಪರ್ಯಾಯವಾಗಿ ಕೆಲಸ ಮಾಡುತ್ತದೆ. ಪ್ರಾರಂಭಿಸಲು ನಿಮ್ಮ ಬ್ಯಾಗ್‌ನಲ್ಲಿರುವ ಒಂದು ಫೋನ್ ಮತ್ತು ಒಂದು ಟ್ಯಾಬ್ಲೆಟ್ ಸಾಕು.',
    'standin.aria':
      'ಮೇಲೆ ಧ್ವನಿಯಿಲ್ಲದ ಕಂಪ್ಯೂಟರ್ ಮತ್ತು ಕೆಳಗೆ ಎಡ ಹಾಗೂ ಬಲ ಸ್ಪೀಕರ್‌ಗಳಾಗಿ ಕೆಲಸ ಮಾಡುವ ಎರಡು ಸಕ್ರಿಯ ಫೋನ್‌ಗಳು',
    'standin.desktop_label': 'ಡೆಸ್ಕ್‌ಟಾಪ್',
    'standin.desktop_value': 'ಡೆಸ್ಕ್ ಮೇಲಿನ ಫೋನ್‌ಗಳು ಅಥವಾ ಟ್ಯಾಬ್ಲೆಟ್‌ಗಳು ಸ್ಪೀಕರ್‌ಗಳಾಗುತ್ತವೆ',
    'standin.laptop_label': 'ಲ್ಯಾಪ್‌ಟಾಪ್',
    'standin.laptop_value': 'ದುರ್ಬಲ ಬಿಲ್ಟ್-ಇನ್ ಸ್ಪೀಕರ್‌ಗಳ ಬದಲಿಗೆ ಹಲವು ಸಾಧನಗಳು',
    'standin.feature_label': 'ವೈಶಿಷ್ಟ್ಯ',
    'standin.feature_value': 'ಸಿಸ್ಟಮ್ ಆಡಿಯೊ ಹಂಚಿಕೆ (Beta)',
    'standin.platform_label': 'ಪ್ಲಾಟ್‌ಫಾರ್ಮ್',
    'standin.platform_value': 'ಕಂಪ್ಯೂಟರ್‌ಗಳಲ್ಲಿನ Chromium-ಆಧಾರಿತ ಬ್ರೌಸರ್‌ಗಳು',
    'standin.caveat':
      'Beta: ಡೆಸ್ಕ್‌ಟಾಪ್ Chromium ಮಾತ್ರ; ಆಡಿಯೊ ಕಳುಹಿಸುವ ಸಾಧನ ಸೇರಿದಂತೆ ಗರಿಷ್ಠ ನಾಲ್ಕು ಸಂಪರ್ಕಿತ ಸಾಧನಗಳು. Standard ರೂಮ್‌ನ ಪ್ರತಿಯೊಂದು ಹಂಚಿಕೆ ಮತ್ತು Cloudflare ಮೂಲಕ ರಿಲೇ ಆಗುವ (SFU) ಪ್ರತಿಯೊಂದು ಹಂಚಿಕೆ ಎರಡು ಗಂಟೆಗಳ ನಂತರ ಕೊನೆಗೊಳ್ಳುತ್ತದೆ; ಪರಿಶೀಲಿಸಿದ PRO LAN-direct ಹಂಚಿಕೆ ಮಾತ್ರ ರೂಮ್‌ನ ನಿಯಂತ್ರಣ ವ್ಯವಸ್ಥೆ ಸರಿಯಾಗಿ ಕಾರ್ಯನಿರ್ವಹಿಸುವವರೆಗೆ ಮುಂದುವರಿಯಬಹುದು. ಲೈವ್ ಆಡಿಯೊದಲ್ಲಿ ತಪ್ಪಿಸಲಾಗದ ವಿಳಂಬ ಇರುತ್ತದೆ, ಆದ್ದರಿಂದ ಹಂಚುವ ಸಾಧನವು ತನ್ನ ಧ್ವನಿಮಟ್ಟವನ್ನು ಕಡಿಮೆ ಮಾಡಬೇಕು.',

    'cta.h2': 'ಸೆಷನ್ ಆರಂಭಿಸಿ.',
    'cta.btn': 'MUSIXQUARE ಆರಂಭಿಸಿ',

    'footer.app': 'ಆ್ಯಪ್',
    'footer.history': 'ಇತಿಹಾಸ',
    'footer.designsystem': 'ವಿನ್ಯಾಸ ವ್ಯವಸ್ಥೆ',
  });

  addLang('ml', {
    'meta.title': 'MUSIXQUARE പരിചയം',
    'meta.description':
      'MUSIXQUARE നിരവധി ഫോണുകൾ, ടാബ്ലെറ്റുകൾ, ലാപ്‌ടോപ്പുകൾ എന്നിവയെ ഒരൊറ്റ സിങ്ക് ചെയ്ത ശബ്ദ സിസ്റ്റമാക്കി മാറ്റുന്നു. ബ്രൗസറിൽ നേരിട്ട്. ഇൻസ്റ്റാൾ ചെയ്യേണ്ടതില്ല.',
    'meta.og_title': 'MUSIXQUARE പരിചയം',
    'meta.og_description':
      'ഓരോ ഡിവൈസും, ഒരൊറ്റ സിസ്റ്റം. നിരവധി ഡിവൈസുകളിൽ സിങ്ക് ചെയ്ത ഓഡിയോ, ഇൻസ്റ്റാൾ ചെയ്യാതെ.',
    'meta.og_image_alt': 'MUSIXQUARE: ഓരോ ഡിവൈസും, ഒരൊറ്റ സിസ്റ്റം.',
    'meta.tw_title': 'MUSIXQUARE പരിചയം',
    'meta.tw_description': 'ഓരോ ഡിവൈസും, ഒരൊറ്റ സിസ്റ്റം.',

    'header.logo_aria': 'മുകളിലേക്ക് മടങ്ങുക',
    'header.try': 'ഇപ്പോൾ പരീക്ഷിക്കൂ',
    'header.try_aria': 'MUSIXQUARE ഇപ്പോൾ പരീക്ഷിക്കൂ',

    'hero.h1': 'ഓരോ ഡിവൈസും,<br>ഒരൊറ്റ സിസ്റ്റം.',
    'hero.lead':
      'MUSIXQUARE നിരവധി ഫോണുകൾ, ടാബ്ലെറ്റുകൾ, ലാപ്‌ടോപ്പുകൾ എന്നിവയെ ഒരൊറ്റ ശബ്ദ സിസ്റ്റമാക്കി മാറ്റുന്നു. ഒന്നും ഇൻസ്റ്റാൾ ചെയ്യേണ്ടതില്ല. ഒരു കോഡ് പങ്കിട്ടാൽ മതി.',
    'hero.btn_ghost': 'ഇത് എങ്ങനെ പ്രവർത്തിക്കുന്നു',
    'hero.rooms_opened': 'ഇതുവരെ {{count}} റൂമുകൾ തുറന്നു.',

    'array.h2': 'സറൗണ്ട് സ്പീക്കറുകളില്ലാതെ<br>സറൗണ്ട് ശബ്ദം.',
    'array.lead':
      'ഓരോ ഡിവൈസും ഓരോ റോൾ ഏറ്റെടുക്കുന്നു: ഇടത്, വലത്, സബ്‌വൂഫർ അല്ലെങ്കിൽ പൂർണ്ണ സ്റ്റീരിയോ. റൂം തന്നെ സിസ്റ്റമായി മാറുന്നു.',
    'array.aria':
      'ഇടതുവശത്ത് ഫോൺ, മധ്യത്തിൽ ലാപ്‌ടോപ്പ്, വലതുവശത്ത് ഫോൺ. മൂന്ന് ഡിവൈസുകളുള്ള സറൗണ്ട് സജ്ജീകരണം.',

    'code.h2': 'ആറ് അക്കങ്ങൾ.<br>മറ്റൊന്നുമില്ല.',
    'code.lead':
      'ഒരു സെഷൻ ആരംഭിച്ച് ആറ് അക്ക കോഡ് പങ്കിടുക. പിന്തുണയ്ക്കുന്ന ബ്രൗസറുള്ള ആർക്കും ഏതാനും സെക്കൻഡുകൾക്കകം ചേരാം.',
    'code.aria_code': 'ഉദാഹരണ റൂം കോഡ്',
    'code.aria_qr': 'musixquare.com-നുള്ള QR കോഡ്',
    'code.copy_btn': 'ക്ഷണ ലിങ്ക് പകർത്തുക',
    'code.toast_success': 'ക്ഷണ ലിങ്ക് പകർത്തി',
    'code.toast_fail': 'പകർത്താനായില്ല',

    'remote.h2': 'റൂമിലില്ലേ?<br>പ്രശ്നമില്ല.',
    'remote.lead':
      'നഗരത്തിന്റെ മറുവശത്തായാലും ചാറ്റ് ചെയ്യൂ, സംഗീതം കേൾക്കൂ, അല്ലെങ്കിൽ ഒരുമിച്ച് YouTube കാണൂ.',
    'remote.chat_label': 'ചാറ്റ്',
    'remote.chat_value': 'തത്സമയ ചാറ്റ്',
    'remote.whisper_label': 'സ്വകാര്യ സന്ദേശം',
    'remote.whisper_value': 'സ്വകാര്യ 1:1 സന്ദേശങ്ങൾ',
    'remote.cowatch_label': 'ഒരുമിച്ച് കാണൽ',
    'remote.cowatch_value': 'സിങ്കിൽ ഒരുമിച്ച് YouTube',
    'remote.reach_label': 'ബന്ധ പരിധി',
    'remote.reach_value': 'വ്യത്യസ്ത നെറ്റ്‌വർക്കുകളിലെ പിന്തുണയ്ക്കുന്ന ബ്രൗസറുകൾ',
    'remote.caveat': 'ശ്രദ്ധിക്കുക: YouTube-ൽ ചാനൽ വേർതിരിക്കലും ഓഡിയോ ഇഫക്റ്റുകളും ലഭ്യമല്ല.',
    'remote.pin_label': 'അറിയിപ്പ് · ഹോസ്റ്റ്',
    'remote.pin_text': 'പ്ലേലിസ്റ്റ് നിർദ്ദേശങ്ങൾ സ്വാഗതം',
    'remote.host_name': 'ഹോസ്റ്റ്',
    'remote.host_msg1': 'നീ എവിടെയാണ്?',
    'remote.peer_name': 'പിയർ 1',
    'remote.peer_msg1': 'കഫേയിൽ നിന്ന് ജോലി ചെയ്യുന്നു, ഹഹ',
    'remote.peer_ts_msg': 'ഈ പാട്ട് കൊള്ളാം',
    'remote.host_msg2': 'ഇത് പിന്നീട് പ്ലേ ചെയ്യാം',
    'remote.whisper_sender': 'ഹോസ്റ്റിന് സ്വകാര്യ സന്ദേശം',
    'remote.whisper_msg': 'അറിയിപ്പിൽ പ്ലേലിസ്റ്റ് നിർദ്ദേശങ്ങൾ ചോദിക്കൂ',

    'sync.h2': 'സിങ്ക് ചെയ്ത പ്ലേബാക്ക്.<br>വ്യത്യസ്ത നെറ്റ്‌വർക്കുകളിലും.',
    'sync.lead':
      'ഓരോ ഡിവൈസും കാലതാമസം പരിശോധിച്ച് പ്ലേബാക്ക് കൃത്യമായി പൊരുത്തപ്പെടുത്തി നിലനിർത്തുന്നു.',
    'sync.video_label': 'മീഡിയ',
    'sync.video_value': 'സിങ്ക് ചെയ്ത മീഡിയ പ്ലേബാക്ക്',
    'sync.transport_label': 'ഡാറ്റാ കൈമാറ്റം',
    'sync.transport_value': 'Peer-to-peer, WebRTC',
    'sync.effects_label': 'ഇഫക്റ്റുകൾ',
    'sync.effects_value': '5-ബാൻഡ് EQ · റീവർബ് · വിർച്വലൈസർ',
    'sync.platforms_label': 'പ്ലാറ്റ്‌ഫോമുകൾ',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'ഹോസ്റ്റ്',
    'sync.meta': '60-സാമ്പിൾ NTP മാതൃകയിലുള്ള സിങ്ക്',

    'standin.h2': 'നിങ്ങളുടെ കമ്പ്യൂട്ടറിൽ<br>സ്പീക്കറുകളില്ലേ?',
    'standin.lead':
      'MUSIXQUARE പെട്ടെന്നുള്ള ഒരു പകരം സ്പീക്കർ സിസ്റ്റമായി പ്രവർത്തിക്കുന്നു. തുടങ്ങാൻ നിങ്ങളുടെ ബാഗിലെ ഒരു ഫോണും ഒരു ടാബ്ലെറ്റും മതി.',
    'standin.aria':
      'മുകളിൽ ശബ്ദമില്ലാത്ത കമ്പ്യൂട്ടർ; താഴെ ഇടത്, വലത് സ്പീക്കറുകളായി പ്രവർത്തിക്കുന്ന രണ്ട് സജീവ ഫോണുകൾ',
    'standin.desktop_label': 'ഡെസ്‌ക്‌ടോപ്പ്',
    'standin.desktop_value': 'മേശപ്പുറത്തെ ഫോണുകളോ ടാബ്ലെറ്റുകളോ സ്പീക്കറുകളായി മാറുന്നു',
    'standin.laptop_label': 'ലാപ്‌ടോപ്പ്',
    'standin.laptop_value': 'ദുർബലമായ ബിൽറ്റ്-ഇൻ സ്പീക്കറുകൾക്ക് പകരം നിരവധി ഡിവൈസുകൾ',
    'standin.feature_label': 'സവിശേഷത',
    'standin.feature_value': 'സിസ്റ്റം ഓഡിയോ പങ്കിടൽ (Beta)',
    'standin.platform_label': 'പ്ലാറ്റ്‌ഫോം',
    'standin.platform_value': 'കമ്പ്യൂട്ടറുകളിലെ Chromium അടിസ്ഥാനമാക്കിയുള്ള ബ്രൗസറുകൾ',
    'standin.caveat':
      'Beta: കമ്പ്യൂട്ടറിലെ Chromium ബ്രൗസറിൽ മാത്രം; ഓഡിയോ അയയ്ക്കുന്ന ഡിവൈസ് ഉൾപ്പെടെ പരമാവധി 4 ബന്ധിപ്പിച്ച ഡിവൈസുകൾ. ഓരോ Standard റൂം പങ്കിടലും Cloudflare വഴി റിലേ ചെയ്യുന്ന ഓരോ പങ്കിടലും (SFU) 2 മണിക്കൂറിന് ശേഷം അവസാനിക്കും; പരിശോധിച്ചുറപ്പിച്ച PRO LAN-direct പങ്കിടൽ, റൂം നിയന്ത്രണ ബന്ധം സാധുവായും പ്രവർത്തനക്ഷമമായും തുടരുന്നിടത്തോളം മാത്രം തുടരാം. തത്സമയ ഓഡിയോയിൽ ഒഴിവാക്കാനാകാത്ത കാലതാമസമുണ്ട്; അതിനാൽ പങ്കിടുന്ന ഡിവൈസിന്റെ ശബ്ദനില കുറയ്ക്കണം.',

    'cta.h2': 'ഒരു സെഷൻ ആരംഭിക്കൂ.',
    'cta.btn': 'MUSIXQUARE തുറക്കുക',

    'footer.app': 'ആപ്പ്',
    'footer.history': 'ചരിത്രം',
    'footer.designsystem': 'ഡിസൈൻ സിസ്റ്റം',
  });

  addLang('pa', {
    'meta.title': 'ਬਾਰੇ · MUSIXQUARE',
    'meta.description':
      'MUSIXQUARE ਕਈ ਫ਼ੋਨਾਂ, ਟੈਬਲੇਟਾਂ ਅਤੇ ਲੈਪਟਾਪਾਂ ਨੂੰ ਇੱਕ ਸਿੰਕ ਕੀਤੇ ਆਡੀਓ ਸਿਸਟਮ ਵਿੱਚ ਬਦਲ ਦਿੰਦਾ ਹੈ। ਸਿੱਧਾ ਬ੍ਰਾਊਜ਼ਰ ਵਿੱਚ। ਕੋਈ ਇੰਸਟਾਲੇਸ਼ਨ ਨਹੀਂ।',
    'meta.og_title': 'ਬਾਰੇ · MUSIXQUARE',
    'meta.og_description': 'ਹਰ ਡਿਵਾਈਸ, ਇੱਕ ਸਿਸਟਮ। ਕਈ ਡਿਵਾਈਸਾਂ ਦਾ ਸਿੰਕ ਕੀਤਾ ਆਡੀਓ, ਬਿਨਾਂ ਇੰਸਟਾਲੇਸ਼ਨ।',
    'meta.og_image_alt': 'MUSIXQUARE: ਹਰ ਡਿਵਾਈਸ, ਇੱਕ ਸਿਸਟਮ।',
    'meta.tw_title': 'ਬਾਰੇ · MUSIXQUARE',
    'meta.tw_description': 'ਹਰ ਡਿਵਾਈਸ, ਇੱਕ ਸਿਸਟਮ।',
    'header.logo_aria': 'ਪੰਨੇ ਦੇ ਸਿਖਰ ਉੱਤੇ ਵਾਪਸ ਜਾਓ',
    'header.try': 'ਹੁਣੇ ਅਜ਼ਮਾਓ',
    'header.try_aria': 'MUSIXQUARE ਹੁਣੇ ਅਜ਼ਮਾਓ',
    'hero.h1': 'ਹਰ ਡਿਵਾਈਸ,<br>ਇੱਕ ਸਿਸਟਮ।',
    'hero.lead':
      'MUSIXQUARE ਕਈ ਫ਼ੋਨਾਂ, ਟੈਬਲੇਟਾਂ ਅਤੇ ਲੈਪਟਾਪਾਂ ਨੂੰ ਇੱਕ ਆਡੀਓ ਸਿਸਟਮ ਵਿੱਚ ਬਦਲ ਦਿੰਦਾ ਹੈ। ਕੋਈ ਇੰਸਟਾਲੇਸ਼ਨ ਨਹੀਂ। ਸਿਰਫ਼ ਇੱਕ ਕੋਡ ਸਾਂਝਾ ਕਰੋ।',
    'hero.btn_ghost': 'ਇਹ ਕਿਵੇਂ ਕੰਮ ਕਰਦਾ ਹੈ',
    'hero.rooms_opened': 'ਹੁਣ ਤੱਕ {{count}} ਰੂਮ ਖੋਲ੍ਹੇ ਗਏ ਹਨ।',
    'array.h2': 'ਸਰਾਊਂਡ ਸਪੀਕਰਾਂ ਤੋਂ ਬਿਨਾਂ<br>ਸਰਾਊਂਡ ਆਵਾਜ਼।',
    'array.lead':
      'ਹਰ ਡਿਵਾਈਸ ਇੱਕ ਭੂਮਿਕਾ ਨਿਭਾਉਂਦੀ ਹੈ: ਖੱਬਾ, ਸੱਜਾ, ਸਬਵੂਫ਼ਰ ਜਾਂ ਪੂਰਾ ਸਟੀਰੀਓ। ਰੂਮ ਹੀ ਸਿਸਟਮ ਬਣ ਜਾਂਦਾ ਹੈ।',
    'array.aria':
      'ਖੱਬੇ ਪਾਸੇ ਫ਼ੋਨ, ਵਿਚਕਾਰ ਲੈਪਟਾਪ, ਸੱਜੇ ਪਾਸੇ ਫ਼ੋਨ। ਤਿੰਨ ਡਿਵਾਈਸਾਂ ਵਾਲਾ ਸਰਾਊਂਡ ਸੈੱਟਅੱਪ।',
    'code.h2': 'ਛੇ ਅੰਕ।<br>ਹੋਰ ਕੁਝ ਨਹੀਂ।',
    'code.lead':
      'ਸੈਸ਼ਨ ਸ਼ੁਰੂ ਕਰੋ ਅਤੇ ਛੇ-ਅੰਕਾਂ ਵਾਲਾ ਕੋਡ ਸਾਂਝਾ ਕਰੋ। ਸਮਰਥਿਤ ਬ੍ਰਾਊਜ਼ਰ ਵਾਲਾ ਕੋਈ ਵੀ ਵਿਅਕਤੀ ਕੁਝ ਸਕਿੰਟਾਂ ਵਿੱਚ ਸ਼ਾਮਲ ਹੋ ਸਕਦਾ ਹੈ।',
    'code.aria_code': 'ਰੂਮ ਕੋਡ ਦੀ ਮਿਸਾਲ',
    'code.aria_qr': 'musixquare.com ਲਈ QR ਕੋਡ',
    'code.copy_btn': 'ਸੱਦਾ ਲਿੰਕ ਕਾਪੀ ਕਰੋ',
    'code.toast_success': 'ਸੱਦਾ ਲਿੰਕ ਕਾਪੀ ਹੋ ਗਿਆ',
    'code.toast_fail': 'ਕਾਪੀ ਨਹੀਂ ਹੋ ਸਕੀ',
    'remote.h2': 'ਰੂਮ ਵਿੱਚ ਨਹੀਂ ਹੋ?<br>ਕੋਈ ਗੱਲ ਨਹੀਂ।',
    'remote.lead': 'ਸ਼ਹਿਰ ਦੇ ਦੂਜੇ ਪਾਸੇ ਤੋਂ ਵੀ ਚੈਟ ਕਰੋ, ਸੰਗੀਤ ਸੁਣੋ ਜਾਂ ਇਕੱਠੇ YouTube ਵੇਖੋ।',
    'remote.chat_label': 'ਚੈਟ',
    'remote.chat_value': 'ਰੀਅਲ-ਟਾਈਮ ਚੈਟ',
    'remote.whisper_label': 'ਨਿੱਜੀ ਸੁਨੇਹਾ',
    'remote.whisper_value': 'ਨਿੱਜੀ 1:1 ਸੁਨੇਹੇ',
    'remote.cowatch_label': 'ਇਕੱਠੇ ਵੇਖੋ',
    'remote.cowatch_value': 'ਇਕੱਠੇ YouTube, ਸਿੰਕ ਵਿੱਚ',
    'remote.reach_label': 'ਪਹੁੰਚ',
    'remote.reach_value': 'ਵੱਖ-ਵੱਖ ਨੈੱਟਵਰਕਾਂ ਉੱਤੇ ਸਮਰਥਿਤ ਬ੍ਰਾਊਜ਼ਰ',
    'remote.caveat': 'ਨੋਟ: YouTube ਲਈ ਚੈਨਲ ਵੰਡ ਅਤੇ ਆਡੀਓ ਪ੍ਰਭਾਵ ਉਪਲਬਧ ਨਹੀਂ ਹਨ।',
    'remote.pin_label': 'ਸੂਚਨਾ · ਹੋਸਟ',
    'remote.pin_text': 'ਪਲੇਲਿਸਟ ਲਈ ਸੁਝਾਅ ਚਾਹੀਦੇ ਹਨ',
    'remote.host_name': 'ਹੋਸਟ',
    'remote.host_msg1': 'ਤੁਸੀਂ ਕਿੱਥੇ ਹੋ?',
    'remote.peer_name': 'ਪੀਅਰ 1',
    'remote.peer_msg1': 'ਕੈਫੇ ਤੋਂ ਕੰਮ ਕਰ ਰਿਹਾ ਹਾਂ ਹਾਹਾ',
    'remote.peer_ts_msg': 'ਇਹ ਗਾਣਾ ਕਾਫ਼ੀ ਵਧੀਆ ਹੈ',
    'remote.host_msg2': 'ਇਹ ਬਾਅਦ ਵਿੱਚ ਚਲਾਵਾਂਗੇ',
    'remote.whisper_sender': 'ਹੋਸਟ ਨੂੰ ਨਿੱਜੀ ਸੁਨੇਹਾ',
    'remote.whisper_msg': 'ਸੂਚਨਾ ਵਿੱਚ ਪਲੇਲਿਸਟ ਲਈ ਸੁਝਾਅ ਮੰਗੋ',
    'sync.h2': 'ਸਿੰਕ ਕੀਤਾ ਪਲੇਬੈਕ।<br>ਵੱਖ-ਵੱਖ ਨੈੱਟਵਰਕਾਂ ਉੱਤੇ।',
    'sync.lead': 'ਹਰ ਡਿਵਾਈਸ ਦੇਰੀ ਜਾਂਚਦੀ ਹੈ ਅਤੇ ਪਲੇਬੈਕ ਨੂੰ ਸਹੀ ਤਾਲਮੇਲ ਵਿੱਚ ਰੱਖਦੀ ਹੈ।',
    'sync.video_label': 'ਮੀਡੀਆ',
    'sync.video_value': 'ਸਿੰਕ ਕੀਤਾ ਮੀਡੀਆ ਪਲੇਬੈਕ',
    'sync.transport_label': 'ਟ੍ਰਾਂਸਪੋਰਟ',
    'sync.transport_value': 'Peer-to-peer, WebRTC',
    'sync.effects_label': 'ਪ੍ਰਭਾਵ',
    'sync.effects_value': '5-band EQ · ਰੀਵਰਬ · ਵਰਚੁਅਲਾਈਜ਼ਰ',
    'sync.platforms_label': 'ਪਲੇਟਫਾਰਮ',
    'sync.platforms_value': 'iOS · Android · macOS · Windows',
    'sync.host_label': 'ਹੋਸਟ',
    'sync.meta': '60-ਸੈਂਪਲ NTP-ਸ਼ੈਲੀ ਸਿੰਕ',
    'standin.h2': 'ਤੁਹਾਡੇ ਕੰਪਿਊਟਰ ਵਿੱਚ<br>ਸਪੀਕਰ ਨਹੀਂ ਹਨ?',
    'standin.lead':
      'MUSIXQUARE ਤੁਰੰਤ ਬਦਲ ਵਜੋਂ ਕੰਮ ਕਰਦਾ ਹੈ। ਤੁਹਾਡੇ ਬੈਗ ਵਿੱਚਲਾ ਇੱਕ ਫ਼ੋਨ ਅਤੇ ਇੱਕ ਟੈਬਲੇਟ ਸ਼ੁਰੂ ਕਰਨ ਲਈ ਕਾਫ਼ੀ ਹਨ।',
    'standin.aria':
      'ਉੱਪਰ ਬਿਨਾਂ ਆਵਾਜ਼ ਵਾਲਾ ਕੰਪਿਊਟਰ ਅਤੇ ਹੇਠਾਂ ਖੱਬੇ ਤੇ ਸੱਜੇ ਸਪੀਕਰ ਵਜੋਂ ਚੱਲ ਰਹੇ ਦੋ ਫ਼ੋਨ',
    'standin.desktop_label': 'ਡੈਸਕਟਾਪ',
    'standin.desktop_value': 'ਮੇਜ਼ ਉੱਤੇ ਰੱਖੇ ਫ਼ੋਨ ਜਾਂ ਟੈਬਲੇਟ ਸਪੀਕਰ ਬਣ ਜਾਂਦੇ ਹਨ',
    'standin.laptop_label': 'ਲੈਪਟਾਪ',
    'standin.laptop_value': 'ਕਮਜ਼ੋਰ ਬਿਲਟ-ਇਨ ਸਪੀਕਰਾਂ ਦੀ ਥਾਂ ਕਈ ਡਿਵਾਈਸਾਂ',
    'standin.feature_label': 'ਖ਼ੂਬੀ',
    'standin.feature_value': 'ਸਿਸਟਮ ਆਡੀਓ ਸਾਂਝਾ ਕਰਨਾ (Beta)',
    'standin.platform_label': 'ਪਲੇਟਫਾਰਮ',
    'standin.platform_value': 'ਕੰਪਿਊਟਰਾਂ ਉੱਤੇ Chromium-ਆਧਾਰਿਤ ਬ੍ਰਾਊਜ਼ਰ',
    'standin.caveat':
      'Beta: ਸਿਰਫ਼ ਡੈਸਕਟਾਪ Chromium, ਸਾਂਝਾ ਕਰਨ ਵਾਲੀ ਡਿਵਾਈਸ ਸਮੇਤ ਵੱਧ ਤੋਂ ਵੱਧ 4 ਜੁੜੀਆਂ ਡਿਵਾਈਸਾਂ। Standard ਰੂਮ ਵਿੱਚ ਕੀਤਾ ਹਰ ਸਾਂਝਾ ਸੈਸ਼ਨ ਅਤੇ Cloudflare ਰਾਹੀਂ ਰੀਲੇ ਕੀਤਾ ਹਰ (SFU) ਸਾਂਝਾ ਸੈਸ਼ਨ 2 ਘੰਟਿਆਂ ਬਾਅਦ ਖ਼ਤਮ ਹੋ ਜਾਂਦਾ ਹੈ; ਤਸਦੀਕਸ਼ੁਦਾ PRO LAN-direct ਸਾਂਝਾ ਸੈਸ਼ਨ ਉਦੋਂ ਤੱਕ ਜਾਰੀ ਰਹਿ ਸਕਦਾ ਹੈ ਜਦੋਂ ਤੱਕ ਰੂਮ ਦਾ ਨਿਯੰਤਰਣ ਕਨੈਕਸ਼ਨ ਠੀਕ ਅਤੇ ਉਪਲਬਧ ਰਹੇ। ਲਾਈਵ ਆਡੀਓ ਵਿੱਚ ਦੇਰੀ ਤੋਂ ਬਚਿਆ ਨਹੀਂ ਜਾ ਸਕਦਾ, ਇਸ ਲਈ ਸਾਂਝਾ ਕਰਨ ਵਾਲੀ ਡਿਵਾਈਸ ਦੀ ਆਵਾਜ਼ ਘੱਟ ਰੱਖਣੀ ਚਾਹੀਦੀ ਹੈ।',
    'cta.h2': 'ਸੈਸ਼ਨ ਸ਼ੁਰੂ ਕਰੋ।',
    'cta.btn': 'MUSIXQUARE ਖੋਲ੍ਹੋ',
    'footer.app': 'ਐਪ',
    'footer.history': 'ਇਤਿਹਾਸ',
    'footer.designsystem': 'ਡਿਜ਼ਾਈਨ ਸਿਸਟਮ',
  });

  const fallbackOgLocales = {
    en: 'en_US',
    ko: 'ko_KR',
    ja: 'ja_JP',
    'zh-hans': 'zh_CN',
    'zh-hant': 'zh_TW',
    es: 'es_ES',
    'pt-br': 'pt_BR',
    fr: 'fr_FR',
    de: 'de_DE',
    nl: 'nl_NL',
    it: 'it_IT',
    pl: 'pl_PL',
    ru: 'ru_RU',
    tr: 'tr_TR',
    id: 'id_ID',
    vi: 'vi_VN',
    th: 'th_TH',
    hi: 'hi_IN',
    bn: 'bn_BD',
    ta: 'ta_IN',
    te: 'te_IN',
    ms: 'ms_MY',
    fil: 'fil_PH',
    ar: 'ar_SA',
    ur: 'ur_PK',
    he: 'he_IL',
    uk: 'uk_UA',
    ro: 'ro_RO',
    cs: 'cs_CZ',
    el: 'el_GR',
    fa: 'fa_IR',
    mr: 'mr_IN',
    gu: 'gu_IN',
    kn: 'kn_IN',
    ml: 'ml_IN',
    pa: 'pa_IN',
    sv: 'sv_SE',
    da: 'da_DK',
    nb: 'nb_NO',
    fi: 'fi_FI',
    hu: 'hu_HU',
    bg: 'bg_BG',
  } as const satisfies Readonly<Record<LocaleCode, string>>;

  function isLocaleCode(value: unknown): value is LocaleCode {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(i18n, value);
  }

  function normalizeSelection(lang: unknown): LocaleCode {
    const staticLang = landingWindow.MXQRStaticLang;
    if (staticLang) {
      const normalized = staticLang.normalize(lang);
      return isLocaleCode(normalized) ? normalized : 'en';
    }
    const raw = String(lang || '')
      .trim()
      .toLowerCase()
      .replace(/_/gu, '-');
    if (!raw || raw === 'system') return 'en';
    if (isLocaleCode(raw)) return raw;
    if (raw === 'zh-hans' || raw.startsWith('zh-hans-')) return 'zh-hans';
    if (raw === 'zh-hant' || raw.startsWith('zh-hant-')) return 'zh-hant';
    if (raw.startsWith('zh')) {
      return /(?:tw|hk|mo|hant)/u.test(raw) ? 'zh-hant' : 'zh-hans';
    }
    if (raw === 'pt' || raw.startsWith('pt-')) return 'pt-br';
    if (raw === 'in' || raw.startsWith('in-')) return 'id';
    if (raw === 'iw' || raw.startsWith('iw-')) return 'he';
    if (raw === 'tl' || raw.startsWith('tl-')) return 'fil';
    const [primary] = raw.split('-');
    return isLocaleCode(primary) ? primary : 'en';
  }

  function fallbackHtmlLang(lang: LocaleCode): string {
    const htmlLangs: Readonly<Record<LocaleCode, string>> = {
      en: 'en',
      ko: 'ko',
      ja: 'ja',
      'zh-hans': 'zh-Hans',
      'zh-hant': 'zh-Hant',
      es: 'es',
      'pt-br': 'pt-BR',
      fr: 'fr',
      de: 'de',
      nl: 'nl',
      it: 'it',
      pl: 'pl',
      ru: 'ru',
      tr: 'tr',
      id: 'id',
      vi: 'vi',
      th: 'th',
      hi: 'hi-IN',
      bn: 'bn-BD',
      ta: 'ta-IN',
      te: 'te-IN',
      ms: 'ms-MY',
      fil: 'fil-PH',
      ar: 'ar',
      ur: 'ur-PK',
      he: 'he-IL',
      uk: 'uk-UA',
      ro: 'ro-RO',
      cs: 'cs-CZ',
      el: 'el-GR',
      fa: 'fa-IR',
      mr: 'mr-IN',
      gu: 'gu-IN',
      kn: 'kn-IN',
      ml: 'ml-IN',
      pa: 'pa-IN',
      sv: 'sv-SE',
      da: 'da-DK',
      nb: 'nb-NO',
      fi: 'fi-FI',
      hu: 'hu-HU',
      bg: 'bg-BG',
    };
    return htmlLangs[lang];
  }

  function contentLangFor(selection: unknown): LocaleCode {
    const selected = normalizeSelection(selection);
    return i18n[selected] ? selected : 'en';
  }

  function dictionaryFor(lang: LocaleCode): TranslationDictionary {
    return i18n[lang] ?? englishDictionary;
  }

  function t(lang: unknown, key: string | null): string {
    const lookupKey = key ?? '';
    const dict = dictionaryFor(contentLangFor(lang));
    const value = dict[lookupKey] ?? englishDictionary[lookupKey];
    return value ?? lookupKey;
  }

  // Exposed for main.ts toast calls. Reads current __landingLang at call time
  // so a runtime toggle is reflected without re-binding.
  landingWindow.__landingT = function (key: string, fallback?: string): string {
    const lang = contentLangFor(landingWindow.__landingLang || 'en');
    const value = dictionaryFor(lang)[key];
    return value != null ? value : fallback != null ? fallback : key;
  };

  function applyLang(selection: unknown): void {
    const staticLang = landingWindow.MXQRStaticLang;
    const selected = normalizeSelection(selection);
    const lang = contentLangFor(selected);
    if (staticLang) staticLang.setDocumentLang(lang);
    else {
      document.documentElement.lang = fallbackHtmlLang(lang);
      document.documentElement.dir =
        lang === 'ar' || lang === 'fa' || lang === 'he' || lang === 'ur' ? 'rtl' : 'ltr';
    }
    landingWindow.__landingLang = selected;

    // Text content. Values containing <br> use innerHTML so the line break renders;
    // everything else uses textContent to keep XSS surface minimal.
    const elements = document.querySelectorAll('[data-i18n]');
    for (const element of elements) {
      const value = t(lang, element.getAttribute('data-i18n'));
      if (value.includes('<br>')) element.innerHTML = value;
      else element.textContent = value;
    }

    // Attribute translations. Format: "attrName:key" (single attr per element for now).
    const attributeElements = document.querySelectorAll('[data-i18n-attr]');
    for (const attributeElement of attributeElements) {
      const spec = attributeElement.getAttribute('data-i18n-attr');
      if (!spec) continue;
      const [attributeName, translationKey, extra] = spec.split(':');
      if (attributeName && translationKey && extra === undefined) {
        attributeElement.setAttribute(attributeName, t(lang, translationKey));
      }
    }

    // Meta tags. Crawlers see the HTML defaults (English); JS swaps for users.
    document.title = t(lang, 'meta.title');
    const metaPairs = [
      ['meta[name="description"]', 'meta.description'],
      ['meta[property="og:title"]', 'meta.og_title'],
      ['meta[property="og:description"]', 'meta.og_description'],
      ['meta[property="og:image:alt"]', 'meta.og_image_alt'],
      ['meta[name="twitter:title"]', 'meta.tw_title'],
      ['meta[name="twitter:description"]', 'meta.tw_description'],
    ] as const satisfies readonly (readonly [string, TranslationKey])[];
    for (const [selector, translationKey] of metaPairs) {
      const metaElement = document.querySelector(selector);
      if (metaElement) metaElement.setAttribute('content', t(lang, translationKey));
    }
    // The primary locale follows the rendered content. Alternate locale tags describe
    // the complete set of localized documents and must remain exactly as materialized.
    const ogLocale = document.querySelector('meta[property="og:locale"]');
    if (ogLocale)
      ogLocale.setAttribute(
        'content',
        staticLang ? staticLang.locale(lang) : fallbackOgLocales[lang] || 'en_US',
      );

    if (staticLang) staticLang.update(selected);
  }

  function isStaticLanguageChangeDetail(value: unknown): value is StaticLanguageChangeDetail {
    return typeof value === 'object' && value !== null;
  }

  function handleStaticLanguageChange(event: Event): void {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    applyLang(isStaticLanguageChangeDetail(detail) ? detail.lang : undefined);
  }

  landingWindow.addEventListener('mxqr:static-language-change', handleStaticLanguageChange);

  applyLang(
    landingWindow.__landingLang ||
      (landingWindow.MXQRStaticLang && landingWindow.MXQRStaticLang.resolve('en')) ||
      'en',
  );
})();
