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
        'MUSIXQUARE turns multiple phones, tablets, and laptops into one sound system. No installation—just share one code.',
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
      'remote.pin_text': 'Taking playlist recs tonight',
      'remote.host_name': 'HOST',
      'remote.host_msg1': 'you in yet?',
      'remote.peer_name': 'Peer 1',
      'remote.peer_msg1': 'joining from the café',
      'remote.peer_ts_msg': 'i really like this part',
      'remote.host_msg2': "this one's really good",
      'remote.whisper_sender': 'whisper to HOST',
      'remote.whisper_msg': 'try pinning a playlist rec request',

      'sync.h2': 'Synchronized playback.<br>Across networks.',
      'sync.lead':
        'Each device measures its round-trip latency against the host, then aligns playback to a shared master clock.',
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
      'standin.feature_value': 'System audio sharing mode',
      'standin.platform_label': 'Platform',
      'standin.platform_value': 'Chromium-based browsers on computers',
      'standin.caveat':
        'Note: System audio sharing mode has unavoidable latency, so the host should lower their device volume as much as possible.',

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
        '방을 열면 여섯 자리 코드가 생겨요. 지원되는 브라우저에서는 금방 연결할 수 있어요.',
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
      'remote.pin_text': '오늘 밤 플리 추천받아요',
      'remote.host_name': 'HOST',
      'remote.host_msg1': '들어왔어?',
      'remote.peer_name': 'Peer 1',
      'remote.peer_msg1': '아 카페임ㅋㅋ',
      'remote.peer_ts_msg': '이 부분 진짜 좋은 듯',
      'remote.host_msg2': '오 이거 마음에 든다',
      'remote.whisper_sender': 'HOST에게 귓속말',
      'remote.whisper_msg': '공지로 플리 추천 좀 받아봐',

      'sync.h2': '네트워크를 넘어<br>동기화된 재생',
      'sync.lead':
        '각 기기가 방장과의 왕복 지연 시간을 측정한 뒤, 공유 마스터 클록에 맞춰 재생해요.',
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
      'standin.feature_value': '시스템 오디오 공유 모드',
      'standin.platform_label': '플랫폼',
      'standin.platform_value': '컴퓨터의 Chromium 기반 브라우저',
      'standin.caveat':
        '참고: 시스템 오디오 공유 모드는 지연이 필연적으로 발생해요. 사용 시 방장은 본인 기기의 볼륨을 최대한 낮추어야 해요.',

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
    | 'th';
  type TranslationKey = keyof (typeof baseDictionaries)['en'];
  type TranslationDictionary = Readonly<Record<TranslationKey, string> & Record<string, string>>;

  interface StaticLanguageRuntime {
    normalize(value: unknown): string | null;
    resolve(fallback: unknown): string;
    htmlLang(code: unknown): string;
    locale(code: unknown): string;
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
    'remote.pin_text': 'プレイリストのおすすめ募集中',
    'remote.host_name': 'HOST',
    'remote.host_msg1': '入れた？',
    'remote.peer_name': 'Peer 1',
    'remote.peer_msg1': 'カフェから参加中',
    'remote.peer_ts_msg': 'ここすごく好き',
    'remote.host_msg2': 'これいいね',
    'remote.whisper_sender': 'HOSTへの個別メッセージ',
    'remote.whisper_msg': 'プレイリストのおすすめ募集をお知らせに固定してみて',
    'sync.h2': 'ネットワークを越えて<br>同期再生',
    'sync.lead':
      '各デバイスがホストとの往復遅延を測定し、共有マスタークロックに合わせて再生をそろえます。',
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
    'standin.feature_value': 'システムオーディオ共有モード',
    'standin.platform_label': 'プラットフォーム',
    'standin.platform_value': 'パソコン上のChromiumベースブラウザ',
    'standin.caveat':
      '注: システムオーディオ共有モードでは遅延が避けられないため、ホスト側の音量はできるだけ下げてください。',
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
    'remote.pin_text': '欢迎推荐播放列表',
    'remote.host_name': '房主',
    'remote.host_msg1': '进来了吗？',
    'remote.peer_name': '参与者 1',
    'remote.peer_msg1': '我在咖啡馆',
    'remote.peer_ts_msg': '这段真的很喜欢',
    'remote.host_msg2': '这首不错',
    'remote.whisper_sender': '私聊房主',
    'remote.whisper_msg': '在公告里问问大家推荐什么歌单吧',
    'sync.h2': '跨越网络<br>同步播放',
    'sync.lead': '每台设备都会测量与房主设备之间的往返延迟，再按照共享主时钟对齐播放。',
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
    'standin.feature_value': '系统音频共享模式',
    'standin.platform_label': '平台',
    'standin.platform_value': '电脑上的 Chromium 内核浏览器',
    'standin.caveat': '注意：系统音频共享模式不可避免会有延迟，房主设备应尽量调低音量。',
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
    'remote.pin_text': '今晚徵求播放清單推薦',
    'remote.host_name': '房主',
    'remote.host_msg1': '進來了嗎？',
    'remote.peer_name': '參與者 1',
    'remote.peer_msg1': '我在咖啡廳',
    'remote.peer_ts_msg': '這段真的很喜歡',
    'remote.host_msg2': '這首不錯',
    'remote.whisper_sender': '私訊房主',
    'remote.whisper_msg': '試著把徵求播放清單推薦的訊息釘選為公告吧',
    'sync.h2': '跨越不同網路<br>也能同步播放',
    'sync.lead': '每台裝置都會測量與房主裝置之間的往返延遲，再依照共用主時鐘對齊播放。',
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
    'standin.feature_value': '系統音訊分享模式',
    'standin.platform_label': '平台',
    'standin.platform_value': '電腦上以 Chromium 為核心的瀏覽器',
    'standin.caveat': '注意：系統音訊分享模式不可避免會有延遲，因此房主應盡量調低自己裝置的音量。',
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
    'remote.pin_text': 'Esta noche se aceptan recomendaciones para la lista de reproducción',
    'remote.host_name': 'ANFITRIÓN',
    'remote.host_msg1': '¿ya entraste?',
    'remote.peer_name': 'Participante 1',
    'remote.peer_msg1': 'me conecto desde el café',
    'remote.peer_ts_msg': 'esta parte me encanta',
    'remote.host_msg2': 'esta está buenísima',
    'remote.whisper_sender': 'privado para ANFITRIÓN',
    'remote.whisper_msg': 'pide recomendaciones para la lista de reproducción en el aviso',
    'sync.h2': 'Reproducción sincronizada<br>entre distintas redes',
    'sync.lead':
      'Cada dispositivo mide la latencia de ida y vuelta con el anfitrión y alinea la reproducción con un reloj maestro compartido.',
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
    'standin.feature_value': 'Modo de compartir audio del sistema',
    'standin.platform_label': 'Plataforma',
    'standin.platform_value': 'Navegadores basados en Chromium en ordenadores',
    'standin.caveat':
      'Nota: el modo de compartir audio del sistema tiene una latencia inevitable. El anfitrión debe bajar el volumen de su dispositivo todo lo posible.',
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
    'remote.pin_text': 'Mandem recomendações para a playlist',
    'remote.host_name': 'ANFITRIÃO',
    'remote.host_msg1': 'entrou?',
    'remote.peer_name': 'Participante 1',
    'remote.peer_msg1': 'tô entrando aqui do café',
    'remote.peer_ts_msg': 'essa parte é muito boa',
    'remote.host_msg2': 'curti essa',
    'remote.whisper_sender': 'privado para ANFITRIÃO',
    'remote.whisper_msg': 'pede recomendações de playlist no aviso',
    'sync.h2': 'Reprodução sincronizada<br>mesmo entre redes',
    'sync.lead':
      'Cada dispositivo mede o tempo de ida e volta até o anfitrião e alinha a reprodução a um relógio mestre compartilhado.',
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
    'standin.feature_value': 'Modo de compartilhamento de áudio do sistema',
    'standin.platform_label': 'Plataforma',
    'standin.platform_value': 'Navegadores baseados em Chromium em computadores',
    'standin.caveat':
      'Observação: o modo de compartilhamento de áudio do sistema tem latência inevitável. O anfitrião deve reduzir o próprio volume ao máximo.',
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
    'remote.pin_text': 'Je prends vos recos de playlist ce soir',
    'remote.host_name': 'HÔTE',
    'remote.host_msg1': 'tu es là ?',
    'remote.peer_name': 'Participant 1',
    'remote.peer_msg1': 'je me connecte depuis le café',
    'remote.peer_ts_msg': 'ce passage est vraiment bien',
    'remote.host_msg2': 'ce morceau est vraiment bon',
    'remote.whisper_sender': 'message privé à l’HÔTE',
    'remote.whisper_msg': 'essaie d’épingler une demande de recos de playlist',
    'sync.h2': 'Lecture synchronisée<br>d’un réseau à l’autre',
    'sync.lead':
      'Chaque appareil mesure la latence aller-retour avec l’hôte, puis aligne la lecture sur une horloge maîtresse commune.',
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
    'standin.feature_value': 'Mode de partage de l’audio système',
    'standin.platform_label': 'Plateforme',
    'standin.platform_value': 'Navigateurs pour ordinateur basés sur Chromium',
    'standin.caveat':
      'Remarque : le mode de partage de l’audio système entraîne une latence inévitable. L’hôte doit donc baisser autant que possible le volume de son appareil.',
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
    'remote.pin_label': 'HINWEIS · HOST',
    'remote.pin_text': 'Playlist-Tipps willkommen',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'bist du drin?',
    'remote.peer_name': 'Teilnehmer 1',
    'remote.peer_msg1': 'bin im Café',
    'remote.peer_ts_msg': 'die Stelle ist richtig gut',
    'remote.host_msg2': 'der Track ist stark',
    'remote.whisper_sender': 'Private Nachricht an HOST',
    'remote.whisper_msg': 'frag per Hinweis nach Playlist-Tipps',
    'sync.h2': 'Synchrone Wiedergabe<br>über Netzwerke hinweg',
    'sync.lead':
      'Jedes Gerät misst die Latenz für Hin- und Rückweg zum Host und richtet die Wiedergabe an einem gemeinsamen Referenztakt aus.',
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
    'standin.feature_value': 'Systemaudio-Freigabemodus',
    'standin.platform_label': 'Plattform',
    'standin.platform_value': 'Chromium-basierte Browser auf Computern',
    'standin.caveat':
      'Hinweis: Beim Teilen von Systemaudio entsteht unvermeidbare Latenz. Der Host sollte die Lautstärke des eigenen Geräts so weit wie möglich senken.',
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
    'remote.pin_text': 'Vanavond graag tips voor de afspeellijst',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'ben je al binnen?',
    'remote.peer_name': 'Peer 1',
    'remote.peer_msg1': 'ik doe mee vanuit het café',
    'remote.peer_ts_msg': 'dit stuk vind ik echt goed',
    'remote.host_msg2': 'deze is echt goed',
    'remote.whisper_sender': 'fluisterbericht aan HOST',
    'remote.whisper_msg': 'vraag in de mededeling om tips voor de afspeellijst',
    'sync.h2': 'Synchroon afspelen<br>over verschillende netwerken',
    'sync.lead':
      'Elk apparaat meet de roundtriplatentie naar de host en synchroniseert het afspelen vervolgens met een gedeelde masterklok.',
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
    'standin.feature_value': 'Systeem-audio delen',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Chromium-browsers op computers',
    'standin.caveat':
      'Let op: bij het delen van systeem-audio is vertraging onvermijdelijk. De host moet daarom het volume van het eigen apparaat zo laag mogelijk zetten.',
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
    'remote.pin_text': 'Consigli per la playlist benvenuti',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'sei entrato?',
    'remote.peer_name': 'Partecipante 1',
    'remote.peer_msg1': 'sono al bar',
    'remote.peer_ts_msg': 'questa parte è davvero bella',
    'remote.host_msg2': 'questa mi piace',
    'remote.whisper_sender': 'messaggio privato a HOST',
    'remote.whisper_msg': 'chiedi consigli per la playlist nell’avviso',
    'sync.h2': 'Riproduzione sincronizzata<br>anche tra reti diverse',
    'sync.lead':
      'Ogni dispositivo misura la latenza di andata e ritorno verso l’host, quindi allinea la riproduzione a un riferimento temporale condiviso.',
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
    'standin.feature_value': 'Modalità di condivisione audio di sistema',
    'standin.platform_label': 'Piattaforma',
    'standin.platform_value': 'Browser basati su Chromium sui computer',
    'standin.caveat':
      'Nota: la condivisione dell’audio di sistema introduce una latenza inevitabile. L’host dovrebbe abbassare il più possibile il volume del proprio dispositivo.',
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
    'remote.pin_text': 'Dziś wieczorem czekamy na propozycje do playlisty',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'już jesteś?',
    'remote.peer_name': 'Uczestnik 1',
    'remote.peer_msg1': 'jestem w kawiarni',
    'remote.peer_ts_msg': 'ten fragment jest super',
    'remote.host_msg2': 'ten kawałek jest świetny',
    'remote.whisper_sender': 'prywatna wiadomość do hosta',
    'remote.whisper_msg': 'spróbuj przypiąć ogłoszenie z prośbą o propozycje do playlisty',
    'sync.h2': 'Zsynchronizowane odtwarzanie<br>w różnych sieciach',
    'sync.lead':
      'Każde urządzenie mierzy opóźnienie w obie strony względem hosta, a następnie dopasowuje odtwarzanie do wspólnego zegara głównego.',
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
    'standin.feature_value': 'Tryb udostępniania dźwięku systemowego',
    'standin.platform_label': 'Platforma',
    'standin.platform_value': 'Przeglądarki oparte na Chromium działające na komputerach',
    'standin.caveat':
      'Uwaga: tryb udostępniania dźwięku systemowego wiąże się z nieuniknionym opóźnieniem, dlatego host powinien maksymalnie zmniejszyć głośność swojego urządzenia.',
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
    'remote.pin_text': 'Сегодня принимаем рекомендации для плейлиста',
    'remote.host_name': 'ХОСТ',
    'remote.host_msg1': 'зашёл?',
    'remote.peer_name': 'Участник 1',
    'remote.peer_msg1': 'я из кафе',
    'remote.peer_ts_msg': 'вот этот момент прям классный',
    'remote.host_msg2': 'этот трек зашёл',
    'remote.whisper_sender': 'личное сообщение для ХОСТА',
    'remote.whisper_msg': 'попроси в объявлении накидать треков',
    'sync.h2': 'Синхронное воспроизведение<br>между разными сетями',
    'sync.lead':
      'Каждое устройство измеряет задержку до хоста и обратно, а затем выравнивает воспроизведение по общим эталонным часам.',
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
    'standin.feature_value': 'Режим трансляции системного звука',
    'standin.platform_label': 'Платформа',
    'standin.platform_value': 'Браузеры на базе Chromium на компьютерах',
    'standin.caveat':
      'Примечание: в режиме трансляции системного звука задержка неизбежна. Хосту стоит максимально снизить громкость своего устройства.',
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
    'remote.pin_text': 'Çalma listesi önerilerine açığız',
    'remote.host_name': 'ODA SAHİBİ',
    'remote.host_msg1': 'girdin mi?',
    'remote.peer_name': 'Katılımcı 1',
    'remote.peer_msg1': 'kafeden bağlandım',
    'remote.peer_ts_msg': 'bu kısım çok iyi',
    'remote.host_msg2': 'bu parça iyiymiş',
    'remote.whisper_sender': 'ODA SAHİBİNE özel',
    'remote.whisper_msg': 'duyuruda çalma listesi önerisi iste',
    'sync.h2': 'Ağlar arasında<br>senkronize oynatma',
    'sync.lead':
      'Her cihaz oda sahibine gidiş-dönüş gecikmesini ölçer ve oynatmayı ortak ana saate göre hizalar.',
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
    'standin.feature_value': 'Sistem sesi paylaşım modu',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Bilgisayarlardaki Chromium tabanlı tarayıcılar',
    'standin.caveat':
      'Not: Sistem sesi paylaşım modunda kaçınılmaz gecikme olur. Oda sahibi kendi cihazının sesini mümkün olduğunca kısmalıdır.',
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
      'MUSIXQUARE menghubungkan beberapa ponsel, tablet, dan laptop menjadi satu sistem suara. Tanpa instalasi—cukup bagikan satu kode.',
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
    'remote.pin_text': 'Menerima rekomendasi daftar putar malam ini',
    'remote.host_name': 'HOST',
    'remote.host_msg1': 'sudah gabung?',
    'remote.peer_name': 'Peserta 1',
    'remote.peer_msg1': 'lagi di kafe',
    'remote.peer_ts_msg': 'bagian ini enak banget',
    'remote.host_msg2': 'lagu ini enak',
    'remote.whisper_sender': 'pesan pribadi kepada HOST',
    'remote.whisper_msg': 'coba sematkan permintaan rekomendasi daftar putar',
    'sync.h2': 'Pemutaran tersinkronisasi.<br>Lintas jaringan.',
    'sync.lead':
      'Setiap perangkat mengukur latensi bolak-balik ke host, lalu menyelaraskan pemutaran dengan jam utama bersama.',
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
    'standin.feature_value': 'Mode berbagi audio sistem',
    'standin.platform_label': 'Platform',
    'standin.platform_value': 'Browser berbasis Chromium di komputer',
    'standin.caveat':
      'Catatan: mode berbagi audio sistem memiliki latensi yang tidak bisa dihindari. Host sebaiknya menurunkan volume perangkatnya serendah mungkin.',
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
      'MUSIXQUARE kết nối nhiều điện thoại, máy tính bảng và máy tính xách tay thành một hệ thống âm thanh. Không cần cài đặt—chỉ cần chia sẻ một mã.',
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
    'remote.pin_text': 'Tối nay nhận đề xuất cho danh sách phát',
    'remote.host_name': 'CHỦ PHÒNG',
    'remote.host_msg1': 'bạn vào chưa?',
    'remote.peer_name': 'Người tham gia 1',
    'remote.peer_msg1': 'mình đang tham gia từ quán cà phê',
    'remote.peer_ts_msg': 'mình rất thích đoạn này',
    'remote.host_msg2': 'bài này thật sự hay',
    'remote.whisper_sender': 'nhắn riêng cho CHỦ PHÒNG',
    'remote.whisper_msg': 'thử ghim thông báo xin đề xuất cho danh sách phát',
    'sync.h2': 'Phát đồng bộ.<br>Dù khác mạng.',
    'sync.lead':
      'Mỗi thiết bị đo độ trễ khứ hồi với chủ phòng, sau đó căn chỉnh việc phát theo một đồng hồ chủ dùng chung.',
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
    'standin.feature_value': 'Chế độ chia sẻ âm thanh hệ thống',
    'standin.platform_label': 'Nền tảng',
    'standin.platform_value': 'Trình duyệt nền Chromium trên máy tính',
    'standin.caveat':
      'Lưu ý: chế độ chia sẻ âm thanh hệ thống không thể tránh khỏi độ trễ, vì vậy chủ phòng nên giảm âm lượng thiết bị của mình xuống mức thấp nhất có thể.',
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
    'remote.pin_text': 'รับคำแนะนำเพลย์ลิสต์',
    'remote.host_name': 'เจ้าของห้อง',
    'remote.host_msg1': 'เข้ามารึยัง?',
    'remote.peer_name': 'ผู้เข้าร่วม 1',
    'remote.peer_msg1': 'อยู่คาเฟ่อะ',
    'remote.peer_ts_msg': 'ท่อนนี้ดีมาก',
    'remote.host_msg2': 'เพลงนี้ดีนะ',
    'remote.whisper_sender': 'ข้อความส่วนตัวถึงเจ้าของห้อง',
    'remote.whisper_msg': 'ลองปักประกาศขอเพลงแนะนำดู',
    'sync.h2': 'เล่นแบบซิงก์กัน<br>ข้ามเครือข่าย',
    'sync.lead':
      'แต่ละอุปกรณ์วัดเวลาไป-กลับกับอุปกรณ์ของเจ้าของห้อง แล้วจัดเวลาเล่นให้ตรงกับนาฬิกาหลักร่วมกัน',
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
    'standin.feature_value': 'โหมดแชร์เสียงระบบ',
    'standin.platform_label': 'แพลตฟอร์ม',
    'standin.platform_value': 'เบราว์เซอร์ Chromium บนคอมพิวเตอร์',
    'standin.caveat':
      'หมายเหตุ: โหมดแชร์เสียงระบบมีค่าหน่วงที่หลีกเลี่ยงไม่ได้ เจ้าของห้องจึงควรลดเสียงอุปกรณ์ของตัวเองให้มากที่สุด',
    'cta.h2': 'เริ่มเลย',
    'cta.btn': 'เปิด MUSIXQUARE',
    'footer.app': 'แอป',
    'footer.history': 'ประวัติ',
    'footer.designsystem': 'ระบบดีไซน์',
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
    const [primary] = raw.split('-');
    return isLocaleCode(primary) ? primary : 'en';
  }

  function fallbackHtmlLang(lang: LocaleCode): string {
    if (lang === 'zh-hans') return 'zh-Hans';
    if (lang === 'zh-hant') return 'zh-Hant';
    if (lang === 'pt-br') return 'pt-BR';
    return lang;
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
    document.documentElement.lang = staticLang ? staticLang.htmlLang(lang) : fallbackHtmlLang(lang);
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
    // Locale meta swap (primary + alternate).
    const ogLocale = document.querySelector('meta[property="og:locale"]');
    const ogAlt = document.querySelector('meta[property="og:locale:alternate"]');
    if (ogLocale)
      ogLocale.setAttribute(
        'content',
        staticLang ? staticLang.locale(lang) : fallbackOgLocales[lang] || 'en_US',
      );
    if (ogAlt) ogAlt.setAttribute('content', lang === 'en' ? 'ko_KR' : 'en_US');

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
