/**
 * MUSIXQUARE 2.0 — i18n (Internationalization)
 * Ported from original js/i18n.js
 *
 * Manages: Korean/English translation, DOM live-patching via MutationObserver.
 */

import { log } from '../core/log.ts';

// ─── Language State ──────────────────────────────────────────────

let _activeLanguageMode: 'ko' | 'en' | 'system' = 'system';
let _resolvedLanguage: 'ko' | 'en' = _resolveSystemLanguage();

// ─── Translation Dictionary ─────────────────────────────────────

const I18N_EN: Record<string, string> = {
  ", 방장이 알려주는": ", provided by the host",
  "동기화 버튼을 눌러서 싱크를 맞춰보세요.": "Press the sync button to adjust the sync.",
  "1개 요청 → 1개 응답": "1 request → 1 response",
  "3초 후 YouTube 재생...": "Playing YouTube in 3 seconds...",
  "3초 후 재생 시작...": "Starting playback in 3 seconds...",
  "6자리 숫자 코드로 연결할 수 있어요.": "You can connect with a 6-digit code.",
  "6자리 코드": "6-digit code",
  "6자리 코드를 입력해 주세요": "Please enter the 6-digit code",
  "HTTPS 필수: 보안 연결에서만 작동합니다.": "HTTPS required: works only on a secure connection.",
  "Host 연결 끊김 - 파일을 받을 수 없습니다": "Host disconnected — can't receive the file",
  "Host 요청: 싱크 초기화 및 재설정...": "Host request: reset and recalibrate sync...",
  "Host 직결로 전환되었습니다 (릴레이 끊김)": "Switched to direct Host connection (relay disconnected)",
  "Host만 실행할 수 있습니다.": "Only Host can run this.",
  "Host에 파일 요청 중...": "Requesting file from Host...",
  "ID 생성 중...": "Generating ID...",
  "L 채널 출력": "L channel output",
  "OP 권한 부여": "Grant OP",
  "OP 권한 회수": "Revoke OP",
  "Operator 권한이 부여되었습니다.": "Operator permission granted.",
  "Operator 권한이 해제되었습니다.": "Operator permission revoked.",
  "R 채널 출력": "R channel output",
  "Relay 응답 없음. Host 직결 전환...": "No relay response. Switching to direct Host...",
  "URL을 입력해 주세요": "Please enter a URL",
  "VPN/사내 보안망이 켜져 있으면 연결이 실패할 수 있어요.": "If a VPN/corporate network is on, the connection may fail.",
  "Wi-Fi가 없다면 호스트의 핫스팟에 연결해주세요": "No Wi‑Fi? Connect to the host's hotspot.",
  "YouTube API 로드 실패. 인터넷 연결 확인!": "Failed to load the YouTube API. Check your connection!",
  "YouTube 같이 보기 - 고급 오디오 효과가 비활성화됩니다": "Watch YouTube together — advanced audio effects are disabled.",
  "YouTube 로드 시간 초과. 다시 시도해주세요.": "YouTube load timed out. Please try again.",
  "YouTube 링크 입력": "Enter YouTube link",
  "YouTube 모드에서는 역할 설정과 음향 효과를 쓸 수 없어요.": "In YouTube mode, role settings and audio effects are unavailable.",
  "YouTube 모드에서는 정밀 동기화를 지원하지 않아요": "High-precision sync isn't available in YouTube mode.",
  "YouTube 미리보기 썸네일": "YouTube preview thumbnail",
  "YouTube 비디오 또는 플레이리스트 링크를 입력하세요.": "Enter a YouTube video or playlist link.",
  "YouTube 이동 실패": "Failed to open YouTube",
  "YouTube 재생 시작": "YouTube playback started",
  "YouTube 함께보기": "Watch YouTube together",
  "YouTube가 준비됐어요! 재생 버튼을 눌러 보세요.": "YouTube is ready! Press Play.",
  "\u201C모임에 참여할래요\u201D → 코드 입력 → 역할 선택(원본/왼쪽/오른쪽/저음)": "\u201CJoin a session\u201D → enter the code → choose a role (Original/Left/Right/Bass)",
  "\u201C제가 방장할래요\u201D → 코드 확인 → \u201C시작할래요!\u201D": "\u201CI'll host\u201D → check the code → \u201CStart!\u201D",
  "가상 베이스 강도": "Virtual bass intensity",
  "가상 베이스(방장 제어)": "Virtual bass (host-ctrl)",
  "가상 서라운드 너비 조절": "Adjust virtual surround width",
  "가상 서라운드(방장 제어)": "Virtual surround (host-ctrl)",
  "각 기기의 역할을 설정해 보세요.": "Set a role for each device.",
  "강도": "Intensity",
  "같은 Wi‑Fi인지 확인하고 다시 시도해주세요.": "Check that you're on the same Wi‑Fi and try again.",
  "거대한 오디오 시스템을 만들어 보세요.": "Create a giant audio system.",
  "고급 음향": "Advanced audio",
  "고급 효과를 시스템에 적용할 수 있어요.": "You can apply advanced effects system-wide.",
  "고정밀 동기화: 오디오를 준비하고 있어요…": "High-precision sync: preparing audio…",
  "공개된 링크만 함께 들을 수 있어요.": "Only public links can be played together.",
  "권한": "permission",
  "기기 파일에서 음악/영상을 선택": "Choose music/video from your device",
  "기기를 오른쪽에 놓아주세요": "Place the device on the right",
  "기기를 왼쪽에 놓아주세요": "Place the device on the left",
  "기기를 중앙에 놓아주세요": "Place the device in the center",
  "기본값 0%": "Default 0%",
  "기본값 0, 늘리면 가상 베이스(왜곡 증가)": "Default 0 — Higher = More Distortion",
  "기본값 0.1s": "Default 0.1s",
  "기본값 100, 줄이면 모노, 늘리면 서라운드": "Default 100 — lower = mono, higher = surround",
  "기본값 20.0kHz": "Default 20.0kHz",
  "기본값 20Hz": "Default 20Hz",
  "기본값 5.0s": "Default 5.0s",
  "기타 문의:": "Contact:",
  "나중에 설정에서 바꿀 수 있어요.": "You can change it later in Settings.",
  "남아있기": "Stay",
  "너비": "Width",
  "네트워크 상태를 확인한 후 다시 참가해 주세요.": "Check your network and try joining again.",
  "네트워크 연결 상태와 코드를 확인해주세요.": "Check your network connection and the code.",
  "네트워크 오류가 발생했어요. 같은 Wi‑Fi인지 확인해주세요.": "Network error occurred. Make sure you're on the same Wi‑Fi.",
  "네트워크 초기화 실패": "Network init failed",
  "네트워크 품질이 낮을 수 있어요. 공유기 가까이로 이동해 보세요.": "Network quality may be low. Try moving closer to the router.",
  "다운로드 마무리 중...": "Finishing download...",
  "다운로드 완료 후 재생됩니다": "Will play after download completes",
  "다음 설명": "Next",
  "다음 트랙": "Next track",
  "다음으로": "Next",
  "다크": "Dark",
  "닫기": "Close",
  "데모 로드 실패:": "Demo load failed:",
  "데모 미디어로 프로그램 테스트": "Test the app with demo media",
  "데모 음원 로드 완료. 재생을 시작합니다.": "Demo track loaded. Starting playback.",
  "데모 음원 로딩 중...": "Loading demo track...",
  "데이터 수신 불안정. Host 복구 요청...": "Data reception unstable. Requesting Host recovery...",
  "도움말": "Help",
  "도움이 필요할 때": "Need help?",
  "동기화": "Sync",
  "동시에 재생": "Play together",
  "동영상 또는 플레이리스트 링크를 입력하세요": "Enter a video or playlist link",
  "동일한 네트워크": "same network",
  "두 기기가 같은 네트워크인지 확인해 보세요.": "Make sure both devices are on the same network.",
  "라이트": "Light",
  "로우패스": "Low-pass",
  "로컬 네트워크 전용": "Local network only",
  "로컬 파일 선택": "Choose local file",
  "로컬(같은 Wi‑Fi/핫스팟)": "local (same Wi‑Fi/hotspot)",
  "로컬파일 불러오기": "Load local file",
  "로컬파일 불러오기:": "Load local file:",
  "를 입력해 연결해요.": " and enter it to connect.",
  "리버브 로우컷": "Reverb low-cut",
  "리버브 믹스": "Reverb mix",
  "리버브 반사 시간": "Reverb decay",
  "리버브 프리딜레이": "Reverb pre-delay",
  "리버브 하이컷": "Reverb high-cut",
  "리버브(방장 제어)": "Reverb (host-ctrl)",
  "리버브, 이퀄라이저, 가상 효과 등": "Reverb, EQ, virtual effects, and more",
  "릴레이 대기 중... 잠시만 기다려주세요": "Waiting for relay... please hold on",
  "릴레이 응답 없음. Host에서 직접 수신...": "No relay response. Receiving directly from Host...",
  "릴레이에 파일 요청 중...": "Requesting file via relay...",
  "링크를 붙여넣어 재생 목록에 추가": "Paste a link to add it to the playlist",
  "마지막이에요!": "Last step!",
  "메시지": "Message",
  "메시지 보내기": "Send message",
  "메시지 입력...": "Type a message...",
  "메인": "Home",
  "메인 화면으로 이동": "Go to Home",
  "모든 기기 Auto Sync 요청...": "Requesting Auto Sync on all devices...",
  "모든 기기 재동기화 요청...": "Requesting resync on all devices...",
  "모든 기기가": "All devices must be connected to the",
  "모든 기기를 동일한 Wi-Fi에 연결해주세요": "Connect all devices to the same Wi‑Fi",
  "모임에 참여할래요": "Join a session",
  "Sean Pitaro - Passport [NCS Release]": "Sean Pitaro - Passport [NCS Release]",
  "미디어 없음": "No media",
  "미디어 재생": "Play media",
  "미디어 재생하기": "Play media",
  "미디어 추가": "Add media",
  "미디어를 추가해주세요.": "Please add media.",
  "믹스": "Mix",
  "반복 모드 변경": "Change repeat mode",
  "반복 재생: 끔": "Repeat: Off",
  "반복 재생: 전체": "Repeat: All",
  "반복 재생: 한 곡": "Repeat: One",
  "반사 시간": "Decay time",
  "반사 지연": "Pre-delay",
  "방장 제외 최대 3대": "3 devices excluding the host",
  "방장:": "Host:",
  "방장만 미디어를 추가할 수 있어요.": "Only the host can add media.",
  "방장만 유튜브 링크를 추가할 수 있어요.": "Only the host can add YouTube links.",
  "방장에게는 3가지 선택지가 나와요.": "Hosts see three options.",
  "방장이 알려준 6자리 코드를 입력해주세요": "Enter the 6-digit code from the host",
  "배치": "Placement",
  "백그라운드 작업 오류가 발생했어요": "A background task error occurred",
  "복사하지 못했어요": "Couldn't copy",
  "볼륨 조절": "Adjust volume",
  "부여됨": "granted",
  "브라우저 업데이트 필요: 최신 iOS(15.2+)로 업데이트하세요.": "Browser update required: update to the latest iOS (15.2+).",
  "새 버전이 준비되었습니다. 새로고침하면 업데이트가 적용됩니다.": "A new version is ready. Refresh to update.",
  "새로고침": "Refresh",
  "서브우퍼": "Subwoofer",
  "서브우퍼 조절하기": "Adjust subwoofer",
  "서브우퍼 컷오프 주파수": "Subwoofer cutoff frequency",
  "서브우퍼:": "Subwoofer:",
  "설정": "Settings",
  "설정 · 도움말": "Settings · Help",
  "세션을 만들지 못했어요": "Couldn't create session",
  "세션이 가득 찼어요": "Session is full",
  "세션이 초기화되었습니다.": "Session has been reset.",
  "셔플 모드 변경": "Change shuffle mode",
  "셔플: 꺼짐": "Shuffle: Off",
  "셔플: 켜짐": "Shuffle: On",
  "데모 트랙 정보": "Demo Track",
  "스테레오(기본) 출력": "Stereo (default) output",
  "스피커로 재생하기": "Play through speakers",
  "시스템": "System",
  "시작하기": "Start",
  "아직 메시지가 없어요.": "No messages yet.",
  "안내": "Info",
  "안녕하세요! 본인의 역할을 선택해주세요.": "Hi! Please choose your role.",
  "앱 체험하기 (데모)": "Try it (Demo)",
  "앱 체험하기:": "Try the app:",
  "언어 · Language": "Language · 언어",
  "언제 어디서나 함께 듣는": "Listen together, anywhere",
  "업데이트": "Update",
  "에 연결되어야 해요.": ".",
  "에서 역할을 언제든 바꿀 수 있어요.": ".",
  "에서만 연결됩니다.": ".",
  "여러 기기를 무선으로 연결해": "Connect multiple devices wirelessly",
  "역할": "Role",
  "역할(출력 채널)": "Role (output channel)",
  "역할을 선택해 주세요": "Please select a role",
  "역할을 선택해 참가해 주세요.": "Select a role to join.",
  "역할을 선택해주세요": "Please select a role",
  "역할이 자동 설정되어 변경할 수 없어요.": "Role is auto-assigned and can't be changed.",
  "연결 실패": "Connection failed",
  "연결 오류: 파일 전송 실패": "Connection error: file transfer failed",
  "연결 준비 실패": "Failed to prepare connection",
  "연결 중...": "Connecting...",
  "연결 코드 6자리 입력": "Enter 6-digit code",
  "연결 코드를 입력해주세요.": "Please enter the connection code.",
  "연결된 모든 기기에서 동시에 재생돼요.": "Playback is synchronized on all connected devices.",
  "연결된 모든 기기에서 선택한 미디어가 동시에 재생돼요.": "The selected media plays simultaneously on all connected devices.",
  "연결됨": "connected",
  "연결에 문제가 생겼어요": "Connection issue occurred",
  "연결이 끊어졌어요": "Disconnected",
  "연결이 불안정해요:": "Unstable connection:",
  "연결이 안 되면: Wi‑Fi 재연결 → 앱 새로고침 순서로 확인해 주세요.": "If it won't connect: reconnect Wi‑Fi → refresh the app.",
  "연결하지 못했어요": "Couldn't connect",
  "연결할 수 있는 기기는": "You can connect up to",
  "영상 정보 불러오는 중...": "Loading video info...",
  "영상 정보를 불러올 수 없습니다": "Couldn't load video info",
  "예요.": ".",
  "오디오 디코딩 실패!": "Audio decode failed!",
  "오디오 디코딩 중...": "Decoding audio...",
  "오디오 메모리 로드 중...": "Loading audio into memory...",
  "오디오 엔진을 불러오지 못했어요. 네트워크를 확인해 보세요.": "Couldn't load the audio engine. Check your network.",
  "오디오 엔진을 준비하지 못했어요": "Couldn't prepare the audio engine",
  "오디오 엔진이 아직 준비되지 않았어요. 네트워크를 확인해 보세요.": "The audio engine isn't ready yet. Check your network.",
  "오디오를 준비하지 못했어요. 화면을 한 번 터치한 뒤 다시 시도해 보세요.": "Couldn't prepare audio. Tap the screen once and try again.",
  "오른쪽 스피커": "Right speaker",
  "오른쪽 스피커:": "Right speaker:",
  "완벽한 사운드 경험": "A perfect sound experience",
  "왼쪽 스피커": "Left speaker",
  "왼쪽 스피커:": "Left speaker:",
  "왼쪽, 오른쪽 소리를 따로 재생하고": "Play left and right channels separately, and",
  "우퍼 모드로 웅장한 저음을 느껴보세요.": "Feel powerful bass with Woofer mode.",
  "워커 메시지 처리 중 오류": "Error handling worker message",
  "워커 작업 중 오류 발생!": "Worker error occurred!",
  "유튜브 (호환 모드)": "YouTube (compatibility mode)",
  "유튜브(채널분리 미지원):": "YouTube (no channel split):",
  "유효하지 않은 YouTube 링크": "Invalid YouTube link",
  "유효하지 않은 시간입니다": "Invalid time",
  "유효한 YouTube 링크가 아닙니다": "Not a valid YouTube link",
  "을 선택해요.": ".",
  "이 기기 역할 설정하기": "Set this device's role",
  "이 기기로 어떤 소리를 낼까요?": "What should this device play?",
  "이 버전은": "This version works only on",
  "이 코드를 다른 기기에 입력해주세요": "Enter this code on your other devices",
  "이렇게 연결해요": "How to connect",
  "이전 설명": "Previous",
  "이전 트랙": "Previous track",
  "이제 다른 기기들과 연결해주세요.": "Now connect your other devices.",
  "이퀄라이저 (방장 제어)": "Equalizer (host-ctrl)",
  "일시정지": "Pause",
  "입체 음향": "Spatial audio",
  "자동 재생 취소됨 (OP)": "Auto-play canceled (OP)",
  "자동 재생을 취소했어요": "Auto-play canceled",
  "잠시 후 다시 시도해주세요.": "Please try again in a moment.",
  "잠시만요...": "Just a moment...",
  "재생 시작": "Play",
  "재생 위치 조절": "Seek",
  "재생 준비 완료": "Ready to play",
  "재생/일시정지": "Play/Pause",
  "재생목록": "Playlist",
  "재생할 미디어를 선택해주세요": "Select media to play",
  "저역 믹스 출력": "Bass mix output",
  "전체화면 전환": "Toggle fullscreen",
  "정지": "Stop",
  "정지 요청을 보냈어요": "Stop request sent",
  "제가 방장할래요": "I'll host",
  "준비 지연 중... Host 복구 요청": "Preparation delayed... requesting Host recovery",
  "중앙 스피커": "Center speaker",
  "중앙 스피커:": "Center speaker:",
  "직접 동기화 완료 (로컬 네트워크)": "Direct sync complete (local network)",
  "참가자": "Guest",
  "참가자:": "Guest:",
  "참가자가": "Guests choose the",
  "참가하는 중...": "Joining...",
  "참가하는 중…": "Joining…",
  "참가하지 못했어요. 같은 Wi‑Fi에 연결되어 있는지 확인해 보세요.": "Couldn't join. Make sure you're connected to the same Wi‑Fi.",
  "참가할 수 없어요": "Can't join",
  "채팅": "Chat",
  "채팅 닫기": "Close chat",
  "채팅 메시지 입력": "Type a chat message",
  "채팅 열기": "Open chat",
  "채팅을 시작하세요": "Start chatting",
  "첫 메시지를 보내 보세요!": "Send your first message!",
  "초기 화면": "Home screen",
  "초기 화면으로 돌아갈까요?": "Return to the start screen?",
  "초기화 및 재보정 시작...": "Starting reset and recalibration...",
  "초기화": "Reset",
  "초대 코드": "Invite code",
  "초대 코드 표시 및 복사": "Show & copy invite code",
  "초대 코드가 아직 없어요": "No invite code yet",
  "초대 코드는 설정과 도움말에서 확인할 수 있어요": "You can find the invite code in Settings and Help.",
  "초대와 공유": "Invite & Share",
  "최적 싱크 보정 적용 중...": "Applying optimal sync calibration...",
  "취소": "Cancel",
  "코드를 입력했는데 연결이 안 돼요:": "I entered the code but can't connect:",
  "클릭하여 초대코드 복사": "Click to copy invite code",
  "테마": "Theme",
  "파일 요청 중...": "Requesting file...",
  "파일을 보내고 있어요…": "Sending file…",
  "파일을 선택하거나 플레이리스트를 확인하세요": "Select a file or check the playlist",
  "파일을 선택할 수 없어요": "Can't select a file",
  "파일이 준비됐어요! 재생 버튼을 눌러 보세요.": "Your file is ready! Press Play.",
  "프리로드 누락 - 파일 수신 중...": "Preload missing — receiving file...",
  "프리로드 완료 대기 중...": "Waiting for preload to complete...",
  "프리로드 재생 실패 - 다시 로드합니다": "Preload playback failed — reloading",
  "프리로드된 파일 사용!": "Using preloaded file!",
  "프리앰프": "Preamp",
  "프리앰프 게인": "Preamp gain",
  "플레이리스트 펼치기/접기": "Expand/collapse playlist",
  "플레이리스트에 추가됨": "added to playlist",
  "필수 라이브러리 로드 실패": "Failed to load required libraries",
  "필요하면": "If needed, you can change the role anytime in",
  "하이패스": "High-pass",
  "현재 세션과 연결이 끊어져요.": "You will be disconnected from the current session.",
  "현재 세션은 연결 가능한 기기 수(방장 제외 3대)에 도달했어요.": "This session has reached the device limit (3 excluding the host).",
  "호스트 연결 없음. 로컬 초기화 완료.": "No host connection. Local reset complete.",
  "호스트가 광고를 보고 있는 것 같아요": "The host seems to be watching an ad",
  "호스트가 미디어를 재생하면": "When the host starts playback,",
  "호스트만 조작할 수 있어요": "Only the host can control this",
  "호스트만 파일을 추가할 수 있어요": "Only the host can add files",
  "호스트에 연결할 수 없어요": "Can't connect to the host",
  "호스트에서 연결이 종료되었습니다. 메인 화면으로 이동합니다.": "The host ended the connection. Returning to Home.",
  "호스트의 설정에 맞추어": "In sync with the host's settings",
  "호스트의 코드를 입력해주세요.": "Enter the host's code.",
  "홈 화면에 추가": "Add to Home Screen",
  "확인": "OK",
  "확인/새로고침": "OK / Refresh",
  "환경 제한으로 백그라운드 타이머(Worker)를 사용할 수 없어요.": "Due to environment limits, background timers (Worker) aren't available.",
  "환경 제한으로 파일 저장/전송(Worker)을 사용할 수 없어요.": "Due to environment limits, file save/transfer (Worker) isn't available.",
  "회수됨": "revoked",
};

// ─── Regex-based Dynamic Translations ────────────────────────────

type RegexHandler = (...args: string[]) => string;

const I18N_EN_REGEX: [RegExp, RegexHandler][] = [
  [/^초대 코드:\s*(\d{6})$/i, (_m, code) => `Invite code: ${code}`],
  [/^연결된 기기\s*(\d+)대\s*\|\s*초대 코드\s*(\d{6})$/i, (_m, cnt, code) => `Connected devices: ${cnt} | Invite code ${code}`],
  [/^(\d+)곡을 추가했어요$/i, (_m, cnt) => {
    const n = Number(cnt);
    if (!Number.isFinite(n)) return `Added ${cnt} tracks`;
    return n === 1 ? 'Added 1 track' : `Added ${n} tracks`;
  }],
  [/^"(.+)"\s*플레이리스트에 추가됨$/i, (_m, title) => `Added "${title}" to playlist`],
  [/^준비 중:\s*(.+)$/i, (_m, name) => `Preparing: ${name}`],
  [/^복구 대기 중:\s*(.+)$/i, (_m, name) => `Recovery pending: ${name}`],
  [/^파일 동기화 중:\s*(.+)$/i, (_m, name) => `Syncing file: ${name}`],
  [/^파일 저장 오류:\s*(.+)$/i, (_m, name) => `File save error: ${name}`],
  [/^(.+)가\s*연결됐어요$/i, (_m, name) => `${name} connected`],
  [/^(.+)\s*연결이 끊겼어요$/i, (_m, name) => `${name} disconnected`],
  [/^(.+)\s*연결 오류$/i, (_m, name) => `${name} connection error`],
  [/^(.+)로부터\s*전송 이어받기$/i, (_m, src) => `Resume transfer from ${src}`],
  [/^(.+)로부터\s*파일 수신 시작$/i, (_m, src) => `Started receiving file from ${src}`],
  [/^(.+)로부터\s*전송 재개\s*\((.+)부터\)$/i, (_m, src, start) => `Resuming transfer from ${src} (from ${start})`],
  [/^(.+)\s*수신 중\.\.\.\s*(.*)$/i, (_m, src, rest) => `Receiving from ${src}... ${rest}`],
  [/^자동 싱크 보정 완료,\s*\+?(\d+)ms$/i, (_m, ms) => `Auto sync calibration done, +${ms}ms`],
  [/^리버브 타입:\s*(.+)$/i, (_m, v) => `Reverb type: ${v}`],
  [/^Host 강제 동기화:\s*(.+)$/i, (_m, t) => `Host force sync: ${t}`],
  [/^Relay:\s*(.+)\s*연결됨$/i, (_m, id) => `Relay: ${id} connected`],
  [/^(.+)로\s*이동$/i, (_m, t) => `Seek to ${t}`],
  [/^다음 곡 준비 중\.\.\.\s*\((.+)\)$/i, (_m, name) => `Preparing next track... (${name})`],
];

// ─── Internal Helpers ────────────────────────────────────────────

let _i18nObserver: MutationObserver | null = null;
let _i18nApplying = false;
const _i18nOriginalText = new Map<Text, { raw: string; translated: string }>();
const _i18nOriginalAttr = new Map<Element, Record<string, { raw: string; translated: string }>>();
let _i18nKeyOrder: string[] | null = null;

function _i18nNorm(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// ─── Public API ──────────────────────────────────────────────────

export function i18nTranslate(str: string | null | undefined): string {
  if (str === null || str === undefined) return '';
  if (_resolvedLanguage !== 'en') return str ?? '';

  const raw = String(str);
  const lead = raw.match(/^\s*/)?.[0] ?? '';
  const trail = raw.match(/\s*$/)?.[0] ?? '';
  const core = raw.trim();
  const key = _i18nNorm(core);
  if (!key) return raw;

  // 1) Exact match
  let translated: string | undefined = I18N_EN[key];

  // 2) Regex rules
  if (!translated) {
    for (const [re, fn] of I18N_EN_REGEX) {
      const m = key.match(re);
      if (!m) continue;
      try {
        translated = fn(...m);
      } catch {
        translated = undefined;
      }
      break;
    }
  }

  // 3) Fragment replacement fallback
  if (!translated) {
    if (!_i18nKeyOrder) {
      _i18nKeyOrder = Object.keys(I18N_EN).sort((a, b) => b.length - a.length);
    }
    let out = key;
    for (const k of _i18nKeyOrder) {
      if (!out.includes(k)) continue;
      out = out.split(k).join(I18N_EN[k]);
    }
    translated = out;
  }

  let t = translated;
  if (lead) t = t.replace(/^\s+/, '');
  if (trail) t = t.replace(/\s+$/, '');
  return lead + t + trail;
}

export function getResolvedLanguage(): 'ko' | 'en' {
  return _resolvedLanguage;
}

// ─── DOM Translation ─────────────────────────────────────────────

function _i18nShouldSkipTextNode(node: Node): boolean {
  try {
    const p = node?.parentNode as Element | null;
    if (!p || p.nodeType !== 1) return false;
    const tag = p.tagName;
    return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT';
  } catch {
    return false;
  }
}

function _i18nTranslateTextNode(node: Text): void {
  if (!node || node.nodeType !== 3) return;
  if (_i18nShouldSkipTextNode(node)) return;

  const raw = node.data;
  if (!raw || !raw.trim()) return;

  const translated = i18nTranslate(raw);
  if (translated === raw) return;

  _i18nOriginalText.set(node, { raw, translated });
  node.data = translated;
}

function _i18nTranslateElementAttrs(el: Element): void {
  if (!el || el.nodeType !== 1) return;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;

  const attrs = ['aria-label', 'title', 'placeholder', 'alt'];
  for (const a of attrs) {
    if (!el.hasAttribute(a)) continue;
    const raw = el.getAttribute(a);
    if (!raw) continue;

    const translated = i18nTranslate(raw);
    if (translated === raw) continue;

    let store = _i18nOriginalAttr.get(el);
    if (!store) {
      store = {};
      _i18nOriginalAttr.set(el, store);
    }
    store[a] = { raw, translated };
    el.setAttribute(a, translated);
  }
}

function _i18nTranslateSubtree(root: Node): void {
  if (_resolvedLanguage !== 'en') return;
  if (!root) return;

  _i18nApplying = true;
  try {
    if (root.nodeType === 1) {
      _i18nTranslateElementAttrs(root as Element);
      (root as Element).querySelectorAll?.('*')?.forEach(el => _i18nTranslateElementAttrs(el));
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Text | null;
    while ((n = walker.nextNode() as Text | null)) {
      _i18nTranslateTextNode(n);
    }
  } finally {
    _i18nApplying = false;
  }
}

function _i18nRestoreAll(): void {
  _i18nApplying = true;
  try {
    for (const [node, st] of _i18nOriginalText.entries()) {
      try {
        if (!st) continue;
        if (node.data === st.translated) node.data = st.raw;
      } catch { /* ignore */ }
    }
    for (const [el, store] of _i18nOriginalAttr.entries()) {
      try {
        for (const [a, st] of Object.entries(store || {})) {
          if (!st) continue;
          if (el.getAttribute(a) === st.translated) el.setAttribute(a, st.raw);
        }
      } catch { /* ignore */ }
    }
    _i18nOriginalText.clear();
    _i18nOriginalAttr.clear();
  } finally {
    _i18nApplying = false;
  }
}

function _resolveSystemLanguage(): 'ko' | 'en' {
  try {
    const langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ''];
    const first = String(langs[0] || '').toLowerCase();
    return first.startsWith('ko') ? 'ko' : 'en';
  } catch {
    return 'ko';
  }
}

function _applyResolvedLanguage(resolved: string): void {
  _resolvedLanguage = resolved === 'en' ? 'en' : 'ko';
  try {
    document.documentElement.setAttribute('lang', _resolvedLanguage);
  } catch { /* ignore */ }

  if (!_i18nObserver && typeof MutationObserver !== 'undefined') {
    _i18nObserver = new MutationObserver((mutations) => {
      if (_i18nApplying) return;
      if (_resolvedLanguage !== 'en') return;

      _i18nApplying = true;
      try {
        for (const m of mutations) {
          if (m.type === 'characterData') {
            _i18nTranslateTextNode(m.target as Text);
          } else if (m.type === 'attributes') {
            _i18nTranslateElementAttrs(m.target as Element);
          } else if (m.type === 'childList') {
            m.addedNodes?.forEach(n => {
              if (n.nodeType === 3) _i18nTranslateTextNode(n as Text);
              else if (n.nodeType === 1) _i18nTranslateSubtree(n);
            });
            m.removedNodes?.forEach(n => {
              if (n.nodeType === 3) _i18nOriginalText.delete(n as Text);
              else if (n.nodeType === 1) {
                _i18nOriginalAttr.delete(n as Element);
                try {
                  const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
                  let tn: Text | null;
                  while ((tn = walker.nextNode() as Text | null)) _i18nOriginalText.delete(tn);
                } catch { /* detached node */ }
              }
            });
          }
        }
      } finally {
        _i18nApplying = false;
      }
    });
    try {
      _i18nObserver.observe(document.body || document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-label', 'title', 'placeholder', 'alt'],
      });
    } catch { /* ignore */ }
  }

  if (_resolvedLanguage === 'en') {
    _i18nTranslateSubtree(document.body || document.documentElement);
  } else {
    _i18nRestoreAll();
  }
}

function _updateLanguageSelector(mode: string): void {
  try {
    document.querySelectorAll('.lang-opt').forEach(el => el.classList.remove('active'));
    const id = mode === 'ko' ? 'lang-ko' : mode === 'en' ? 'lang-en' : 'lang-system';
    document.getElementById(id)?.classList.add('active');

    const pillIndex = mode === 'ko' ? 0 : mode === 'en' ? 1 : 2;
    document.querySelectorAll<HTMLElement>('.lang-selector').forEach(sel => {
      sel.style.setProperty('--pill-index', String(pillIndex));
    });
  } catch { /* ignore */ }
}

export function setLanguageMode(mode: string): void {
  if (mode !== 'ko' && mode !== 'en' && mode !== 'system') mode = 'system';
  _activeLanguageMode = mode as 'ko' | 'en' | 'system';
  _updateLanguageSelector(mode);

  // Toss: language persistence removed (always use system default)

  const resolved = (mode === 'system') ? _resolveSystemLanguage() : mode;
  _applyResolvedLanguage(resolved);
}

// ─── Init ────────────────────────────────────────────────────────

export function initI18n(): void {
  // Toss: always start with system language
  setLanguageMode('system');

  try {
    window.addEventListener('languagechange', () => {
      if (_activeLanguageMode !== 'system') return;
      _applyResolvedLanguage(_resolveSystemLanguage());
    });
  } catch { /* ignore */ }

  log.info('[i18n] Initialized');
}
