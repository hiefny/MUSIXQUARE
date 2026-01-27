/**
 * ============================================================================
 * MUSIXQUARE - Multi-Device Synchronized Audio Player
 * ============================================================================
 * * ?�러 ?�마?�폰??P2P�??�결?�여 ?�기?�된 ?�라?�드 ?�디???�스?�을 구축?�는 ????
 * * [DEPENDENCIES]
 * - Tone.js (Audio Engine)
 * - PeerJS (WebRTC P2P)
 * - QRCode.js (QR Generation)
 * * [SECTION INDEX]
 * - ?�역 변???�언 (Global Variables)
 * - Worker & Timer (Background Tasks)
 * - Audio Engine (Tone.js Nodes & Init)
 * - Onboarding & Session Actions
 * - Playlist & Track Management
 * - Playback Engine (Play, Pause, Stop)
 * - Audio Settings (EQ, Reverb, VB, Surround)
 * - Visualizer & UI Helpers
 * - Networking (PeerJS Initialization & ID Management)
 * - Peer Data Message Handlers (Sync, File Transfer)
 * - Relay & Broadcast Management
 * - UI Components (Toast, Loader, QR, Help)
 * - Chat System (Real-time Messaging & URL Detection)
 * - YouTube Integration (API IFrame Player)
 * - WINDOW EXPORTS (Public API for HTML/UI)
 * * ============================================================================
 * GLOBAL VARIABLES REFERENCE
 * ============================================================================
 * * [AUDIO ENGINE - Tone.js Nodes]
 * toneSplit       : Tone.Split - ?�테?�오 채널 분리
 * toneMerge       : Tone.Merge - 채널 병합 (최종 출력 ???�계)
 * gainL, gainR    : Tone.Gain - L/R 채널�??�립 게인
 * masterGain      : Tone.Gain - 마스??볼륨 �?최종 출력
 * widener         : Tone.StereoWidener - 가???�라?�드 ?�비 조절
 * preamp          : Tone.Gain - ?�퀄라?��? ??증폭 ?�계
 * globalLowPass   : Tone.Filter - ?�퍼/LFE 모드??가변 ?�??��??
 * eqNodes[]       : Tone.Filter[] - 5밴드 그래??EQ
 * reverb          : Tone.Reverb - 리버�??�진
 * rvbLowCut/HighCut : Tone.Filter - 리버�??�핑 ?�어???�터
 * rvbCrossFade    : Tone.CrossFade - 리버�?Wet/Dry 믹스
 * vbFilter/Cheby/Gain : Virtual Bass (Chebyshev) ?�진 체인
 * analyser        : Tone.Analyser - 비주?�라?��? ?�이??분석�?
 * * [PLAYBACK STATE]
 * currentState    : string - APP_STATE 머신 ?�태 (IDLE, PLAYING_...)
 * startedAt       : number - Tone.now() 기�? ?�랙 ?�생 ?�작 ?�점
 * pausedAt        : number - ?�시?��????�랙 ?�치 (�?
 * * [PLAYLIST]
 * playlist[]      : Array - ?�랙 객체 배열 { type, file, name, videoId... }
 * currentTrackIndex : number - ?�재 ?�생 ?�는 ?��?중인 ?�랙 ?�덱??
 * repeatMode      : number - 0=Off, 1=All, 2=One
 * * [NETWORK & SYNC]
 * peer            : Peer - PeerJS ?�스?�스
 * hostConn        : DataConnection - Guest?�Host ?�결 객체
 * connectedPeers[] : DataConnection[] - Host가 관리하??모든 Guest 목록
 * localOffset     : number - ?�동 ?�크 보정 �?(�?
 * autoSyncOffset  : number - ?�동 ?�이?�시 측정 보정 �?(�?
 * * [YOUTUBE]
 * youtubePlayer   : YT.Player - YouTube API 컨트롤러
 * * [TIMERS & CONTEXT]
 * managedTimers[]  : Object - 중앙 집중???�?�머 관�?(Chunk, Sync, Watchdog ??
 * transferContext : Object - 게스??�??�일 ?�송 �??�션 ?�태 공유 객체
 *   - transferContext.meta : Object - ?�재 ?�신 중인 ?�일 메�??�이??
 *   - transferContext.preloadMeta : Object - ?�리로드 ?�약???�일 메�??�이??
 *   - transferContext.receivedCount : number - ?�신??�?�� 개수
 *   - transferContext.transferState : string - ?�재 ?�송 ?�태
 * preloadSessionState : Map - ?�션�??�리로드 진행 ?�태 추적
 * * ============================================================================
 */

// ============================================================================
// [SECTION] WINDOW EXPORTS (Public API for HTML/UI)
// ============================================================================
window.openHelpModal = openHelpModal;
window.closeHelpModal = closeHelpModal;
window.toggleFullscreen = toggleFullscreen;
window.playPrevTrack = playPrevTrack;
window.togglePlay = togglePlay;
window.playNextTrack = playNextTrack;
window.toggleMute = toggleMute;
window.onVolInput = onVolInput;
window.onVolChange = onVolChange;
window.toggleChatDrawer = toggleChatDrawer;
window.handleManualSync = handleManualSync;
window.openMediaSourcePopup = openMediaSourcePopup;
window.toggleRepeat = toggleRepeat;
window.toggleShuffle = toggleShuffle;
window.copyLink = copyLink;
window.leaveSession = leaveSession;
window.joinSession = joinSession;
window.setTheme = setTheme;
window.toggleSurroundMode = toggleSurroundMode;
window.setChannel = setChannel;
window.setSurroundChannel = setSurroundChannel;
window.updateSettings = updateSettings;
window.resetReverb = resetReverb;
window.updateAudioEffect = updateAudioEffect;
window.resetEQ = resetEQ;
window.setPreamp = setPreamp;
window.setEQ = setEQ;
window.resetStereo = resetStereo;
window.sendChatMessage = sendChatMessage;
window.switchTab = switchTab;
window.loadDemoMedia = loadDemoMedia;
window.prevSlide = prevSlide;
window.nextSlide = nextSlide;
window.goToSlide = goToSlide;
window.nudgeSync = nudgeSync;
window.handleAutoSync = handleAutoSync;
window.closeManualSync = closeManualSync;
window.openFileSelector = openFileSelector;
window.openYouTubePopup = openYouTubePopup;
window.closeMediaSourcePopup = closeMediaSourcePopup;
window.closeYouTubePopup = closeYouTubePopup;
window.fetchYouTubePreview = fetchYouTubePreview;
window.loadYouTubeFromInput = loadYouTubeFromInput;

// End of Script