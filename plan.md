# MUSIXQUARE 종합 수정 계획

> 10-agent 분석 결과 기반 — ~250 이슈 중 실제 수정 가능 항목 정리
> 완료 시 ~~취소선~~ 처리

---

## Phase 1 — CRITICAL: State & Core 안정성

### ~~1-1. `getState()` undefined 안전 반환~~ → SKIP
- **사유**: 이미 DEV 경고 + undefined 반환 구현됨 (line 327-332). StatePath 타입이 컴파일 타임에 유효 경로만 허용. `| undefined` 추가 시 100+ 호출처 변경 필요 → 과도한 변경

### ~~1-2. `setState()` 오타 경로 자동 생성 방지~~ ✅
- setState + batchSetState 양쪽에 DEV `console.warn` 추가

### ~~1-3. `once()` identity 불일치 수정~~ → SKIP
- **사유**: 프로덕션 코드에 `bus.off()` 직접 호출 0건. `once()` 반환 unsubscribe 함수는 정상 작동. 이론적 이슈만 존재

### ~~1-4. EventMap 누락 이벤트 추가~~ ✅
- `opfs:cleanup-complete: [filename: string]` 추가
- `player:state-changed` dead `prev` 파라미터 제거

---

## Phase 2 — CRITICAL: YouTube & Player 안정성

### ~~2-1. `_ytLoadInProgress` 실패 시 reset~~ ✅
- 실제 영구 잠금은 아님 (guard가 `&&_youtubePlayer` 필요). 코드 품질 개선으로 script error + timeout에서 reset 추가

### ~~2-2. `onYouTubeIframeAPIReady` stale closure 방지~~ → SKIP
- **사유**: 콜백 덮어쓰기로 항상 최신 args 사용됨. 마지막 호출이 승리하는 올바른 동작

### ~~2-3. `youtube:load` subIndex 파라미터 누락~~ ✅
- handler에 4번째 arg 전달, EventMap 타입명 `startTime` → `subIndex` 수정

### ~~2-4. 플레이리스트 배열 in-place mutation 제거~~ ✅
- youtube/player.ts 2곳 `playlist.push()` → `[...playlist, newTrack]` 전환 (playlist.ts는 이미 spread 사용 확인)

### ~~2-5. `stopPlayback()` 상태 정리 누락~~ → SKIP
- **사유**: 의도된 동작. PLAYING_YOUTUBE 유지해야 togglePlay()에서 YouTube 재개 가능. IDLE 전환 시 YouTube 재개 불가

### ~~2-6. `fmtTime()` edge case 처리~~ ✅
- `isNaN()` → `Number.isFinite()` 전환 (NaN + Infinity 모두 처리)

---

## Phase 3 — CRITICAL: Audio 안전성

### ~~3-1. `setPreamp()` 게인 클램핑~~ ✅
- dB `[-48, +12]` 클램핑 추가

### ~~3-2. `setReverbParam()` 유효 범위 검증~~ ✅
- decay `[0.1, 30]`, predelay `[0, 1]` 클램핑 추가

### ~~3-3. `setEQ()` 값 클램핑~~ ✅
- `[-12, +12]` dB 클램핑 + DOM label/slider 연동

### ~~3-4. `frequency.value` 직접 대입 → `rampTo` 전환~~ ✅
- effects.ts는 이미 rampTo 사용 확인. channel.ts surround 모드(line 171) `.frequency.rampTo(v, 0.02)` 전환
- channel.ts lines 50, 78: disconnect/reconnect 사이 발생하므로 pop 없음, 유지

### ~~3-5. 오디오 그래프 dispose 함수 추가~~ ✅
- `disposeAudioGraph()` export 함수 추가. 실제 메모리 누수는 아님 (initAudio idempotent, 노드 1회 생성), 테스트/리셋용 코드 품질 개선

---

## Phase 4 — HIGH: Network 안정성

### ~~4-1. Peer slot mutable aliasing 수정~~ ✅
- `assignPeerSlot/releasePeerSlot/connectedPeers.push` spread 전환. state: 리스너 0건이라 실제 누락 없었지만 defensive fix

### ~~4-2. Protocol 메시지 타입 검증 강화~~ → SKIP
- **사유**: relay 비활성 (`!hostConn` early return), request-* 핸들러들이 각자 `verifyOperator` 호출

### ~~4-3. `toggleOperator` 직접 mutation 수정~~ ✅
- `map()` + spread로 새 배열/객체 생성 후 setState

---

## Phase 5 — HIGH: CSS & UI 안정성

### ~~5-1. `.nav-text-desktop` @layer !important 충돌 수정~~ ✅
- `!important` 제거 (`.bottom-nav`이 데스크탑에서 hidden이라 실질 영향 없었지만 cascade 버그)

### ~~5-2. 채팅 메시지 pruning 추가~~ ✅
- `MAX_CHAT_MESSAGES=200`, `pruneOldMessages()` 추가

### ~~5-3. Dead CSS 정리~~ ✅
- 삭제: `.rotate-lock-*`, `.boot-splash-*`, `@keyframes bootSpin`, `.vol-group`, `--text` 변수 (~124줄)

### ~~5-4. chat timestamp aria-label~~ ✅
- `aria-label="Seek to ${time}"` 추가

---

## Phase 6 — MEDIUM: 리스너 정리 & 메모리 관리

### ~~6-1. `player-controls.ts` 리스너 정리 함수 추가~~ → SKIP
- **사유**: `initPlayerControls()`는 app.ts에서 1회만 호출, 프로덕션에서 re-init 경로 없음. 리스너 스택 불가. 테스트/HMR 전용이므로 추후 필요 시 추가

### ~~6-2. `visualizer.ts` cleanup 함수 보강~~ → SKIP
- **사유**: 동일. `initVisualizer()` 1회 호출. window resize + bus 리스너 중복 등록 불가

### ~~6-3. `safeDisconnect()` 에러 로깅 추가~~ → SKIP
- **사유**: Tone.js는 연결 없는 노드 disconnect 시 항상 throw → 에러 삼킴은 의도된 동작 (주석 명시). DEV 로깅 시 채널 전환마다 스팸

---

## Phase 7 — MEDIUM: 타입 안전성

### ~~7-1. Dead constant 제거~~ ✅
- 삭제: `DEFAULT_SUB_FREQ`, `DEFAULT_REVERB_DECAY`, `DEFAULT_REVERB_PREDELAY`, `MAX_PEER_RELAY_QUEUE`, `MAX_EARLY_PRELOAD_CHUNKS`, `MAX_DIRECT_DATA_PEERS` (6개, 모두 import 0건)

### ~~7-2. `PeerSlot` dead type 제거~~ ✅
- `PeerSlot` 인터페이스 삭제 (export만 있고 import 0건)

### ~~7-3. Manifest `theme_color` 정합성~~ → SKIP
- **사유**: manifest `#000000`=PWA 스플래시(dark), HTML meta `#f2f2f7`=브라우저 주소바(light default, JS가 다크모드 시 동적 전환). 용도 별개, 불일치 아님

---

## Phase 8 — LOW: 테스트 개선

### ~~8-1. 테스트에서 프로덕션 코드 import 전환~~ → DEFERRED
- **사유**: 별도 리팩토링 작업. 현재 수정 범위 외. 기존 429 tests 전부 통과 확인

### ~~8-2. 미커버 모듈 기본 테스트 추가~~ → DEFERRED
- **사유**: 별도 작업. setPreamp 클램핑 테스트는 기존 테스트 수정으로 반영 완료

---

---

## Phase 9 — 세션 3: 심층 재분석 수정 (완료)

### ~~9-1. `setSurroundChannel()` applySettings() 누락~~ ✅
- `audio/channel.ts` — 서라운드 전환 시 VBass/LowPass/Preamp 미적용

### ~~9-2. Reverb generate() 레이스 컨디션~~ ✅
- `audio/effects.ts` — `_reverbGeneratePending` last-write-wins 패턴 추가

### ~~9-3. EQ DOM 캐시 무효화~~ ✅
- `audio/effects.ts` — `isConnected` 체크로 분리된 DOM 노드 감지

### ~~9-4. iOS 오디오 인터럽션 복구~~ ✅
- `app.ts` + `audio/engine.ts` — visibilitychange에서 AudioContext suspended/interrupted 자동 resume

### ~~9-5. Preload chunk 범위 검사~~ ✅
- `storage/preload.ts` — 청크 인덱스 범위 검사 + sessionId 폴백 경고 로그

### ~~9-6. ICE 재감지~~ ✅
- `network/peer.ts` — host/guest 양측 1.5s 후 remote 판정 시 10s 재감지

### ~~9-7. Play Lock 타임아웃 개선~~ ✅
- `player/playback.ts` — 3s→5s + 단계별 디버그 로깅

### ~~9-8. YouTube watchdog state=5 오탐~~ ✅
- `youtube/player.ts` — CUED(5) 제외, UNSTARTED(-1)만 감지

---

## Phase 10 — 세션 3: 신규 발견 이슈 (완료)

### HIGH

#### ~~10-1. `peer.ts` canSendFileTo() conn.open 미검증~~ ✅
- ICE 대기 후 `conn.open` 재확인 추가

#### ~~10-2. `transfer.ts` fileReorderBuffer 메모리 누수~~ ✅
- 전송 완료 시 `fileReorderBuffer.delete(sessionId)` 추가

#### ~~10-3. `playlist.ts` YouTube 전환 시 preload 상태 미정리~~ ✅
- YouTube 브랜치에서 `nextFileBlob`/`meta`/`nextTrackIndex` 강제 클리어 추가

### MEDIUM

#### ~~10-4. `video.ts` 모드 전환 시 비디오 미정지~~ ✅
- `updateBodyModeClass()`에서 비디오 숨김 시 `.pause()` 호출 추가

#### ~~10-5. `engine.ts` initAudio() 동시 호출 가드~~ → SKIP
- **사유**: 이미 `_initAudioPromise` 싱글톤 패턴으로 구현됨 (line 116, 178)

#### ~~10-6. `relay.ts` data 핸들러 'open' 내부 등록~~ ✅
- `conn.on('data')` 등록을 `conn.on('open')` 콜백 외부로 이동

### LOW

#### ~~10-7. `youtube/player.ts` API 타임아웃 후 콜백 실행~~ ✅
- `onYouTubeIframeAPIReady` 콜백에 `currentSessionId` 가드 추가 — 타임아웃 후 stale 콜백 무시

---

## Phase 11 — 세션 4-5: 10라운드 레전드 스캔 → 수정 완료 ✅

> 10라운드 전체 프로젝트 정밀 탐색 + 오탐 검증 → 일괄 수정

### HIGH — 실제 버그

#### ~~11-1. Reverb type NaN 브로드캐스트~~ ✅
- ~~**위치**: `audio/effects.ts:389` + `player/playlist.ts:473-476` + `types/index.ts:144`~~
- ~~**수정**: `value: number|string` 시그니처 변경, Number() cast 제거, host 로컬 적용 추가, ProtocolMap 타입 수정~~

#### ~~11-2. `#device-list` HTML 요소 누락~~ ✅
- ~~**위치**: `index.html` — Virtual Bass 섹션 아래~~
- ~~**수정**: `<div class="section-group">` + `<div id="device-list">` HTML 삽입~~

### MEDIUM — 논리 결함

#### ~~11-3. `peer.ts` `_errorHandled` close 핸들러 — isIntentionalDisconnect 잘못 리셋~~ ✅
- ~~**수정**: `_errorHandled` true 경로에서 `isIntentionalDisconnect` 리셋 제거~~

#### ~~11-4. `peer.ts` `connectionType` leaveSession 미리셋~~ ✅
- ~~**수정**: `batchSetState`에 `'network.connectionType': 'unknown'` 추가~~

#### ~~11-5. `peer.ts` 게스트 peer-level 에러 미전파~~ ✅
- ~~**수정**: `else if (appRole === 'guest')` 분기 추가, `bus.emit('network:error')` 실행~~

#### ~~11-6. `youtube/sync.ts` compensatedTime 미클램핑~~ ✅
- ~~**수정**: `Math.max(0, Math.min(rawCompensatedTime, duration))` 클램핑 적용~~

#### ~~11-7. `youtube/player.ts` `_ytLoadInProgress` 세션 가드 경로 미리셋~~ ✅
- ~~**수정**: early-return 경로에 `_ytLoadInProgress = false` 추가~~

#### ~~11-8. `engine.ts` 부분 초기화 위험~~ ✅
- ~~**수정**: post-reverb 노드 생성 전체를 try-catch로 감싸고, 실패 시 전체 dispose + re-throw~~

#### ~~11-9. `sw-register.ts` stale `inCooldown` 클로저~~ ✅
- ~~**수정**: `inCooldown` 평가를 등록 시점 → `statechange` 이벤트 시점으로 이동~~

#### ~~11-10. `.track-artist` 영구 `display: none`~~ ✅
- ~~**수정**: 의도 설명 주석 추가 (향후 활성화 안내)~~

#### ~~11-11. `.play-header-desktop` 이중 숨김~~ ✅
- ~~**수정**: 의도 설명 주석 추가 (향후 활성화 안내)~~

#### ~~11-12. `setup.ts` `_pendingGuestRoleMode` non-null assertion~~ ✅
- ~~**수정**: `_pendingGuestRoleMode!` → `?? null` (2곳)~~

### LOW — 데드 코드 & 정리 대상

#### ~~11-13. Dead exports 제거 (15개)~~ ✅
- ~~내부 사용 4개: `export` 제거 (`resetReverb`, `updateSubFreq`, `setChannel`, `handleMainSyncBtn`)~~
- ~~완전 미사용 7개: 함수 삭제 (`sendPauseState`, `disposeAudioGraph`, `relayPreloadFromCache`, `toggleFullscreen`, `getTransferWorker`, `getSyncWorker`, `getLogLevel`)~~
- ~~상수/타입 4개: `export` 제거 또는 삭제 (`LOG_LEVEL`, `LogLevelValue`, `setLogLevel`, `ENDED_CHECK_THROTTLE`)~~

#### ~~11-14. Dead CSS 클래스 (6개)~~ ✅
- ~~코드베이스에 이미 존재하지 않음 확인 — 이전 phase에서 처리 완료~~

#### ~~11-15. `VIDEO_EXTENSIONS` 중복 정의~~ ✅
- ~~`constants.ts`에서 삭제, `video.ts` 로컬 정의 유지~~

---

## 오탐(False Positive) 기록

| 보고 내용 | 판정 이유 |
|-----------|-----------|
| `playback.ts` sync offset 계산 오류 | `getTrackPosition()`이 보정값 재적용하여 상쇄. 수식 정확 |
| `setChannelMode()` initAudio 미호출 | bus 핸들러가 `setChannel()`(init 포함) 호출 |
| DOM event listener "메모리 누수" | `innerHTML=''`로 제거된 DOM의 리스너는 GC 자동 회수 |
| OPFS_RESET 쓰기 순서 문제 | `postMessage()`는 단일 워커 내 순서 보장 |
| Reverb retry 무한 재귀 | pending 플래그를 재귀 호출 전에 리셋하므로 안전 |
| State Map/Set 직접 변경 | 설계상 의도적 — 절차적 사용으로 이벤트 불필요 |
| `playback.ts` video-only path 도달 불가 | PLAYING_VIDEO 상태에서만 진입, 해당 분기 정상 |
| `player-controls.ts` isOnMain 반전 | 변수명이 혼동 유발하지만 로직 자체는 정확 |
| `sync.ts` handleGlobalResyncRequest 호스트 가드 | 내부에 hostConn 체크 존재 + 호스트는 자기 broadcast 수신 안 함 |
| `sync.ts` adjustSync 이중 카운트 | 보정값이 수식적으로 상쇄 — 정확한 계산 |
| `protocol.ts` relay가 file-request 전달 | relay가 handleData 전에 인터셉트하여 정상 처리 |
| `onYouTubeIframeAPIReady` 덮어쓰기 | 마지막 호출 승리 의도된 동작 (Phase 2-2 SKIP) |

---

## Phase 12 — 레전드 스캔 2차 (10라운드, 미수정)

> 10라운드 정밀 탐색 + 오탐 검증 완료. 수정은 종합 고려 후 일괄 진행.

### HIGH — 심각한 버그 / 보안

#### ~~12-1. `transfer.ts` handleFileResume — 수신 상태 미초기화~~ ✅
- ~~**위치**: `storage/transfer.ts` — handleFileResume 함수~~
- ~~**내용**: resume 시 `receivedCount`, `fileReorderBuffer`, `_pendingEarlyChunks` 미리셋 → 이전 전송의 stale 데이터가 신규 전송에 혼입~~
- ~~**시나리오**: 파일 전송 중단 → resume → 이전 청크가 새 파일에 섞여 파일 손상~~

#### ~~12-2. `playback.ts` _playPreloadedInProgress 영구 잠금~~ ✅
- ~~**위치**: `player/playback.ts` — loadPreloadedTrack 함수 early-return 경로~~
- ~~**내용**: early-return 시 `_playPreloadedInProgress = false` 미실행 → 이후 모든 프리로드 재생 차단~~
- ~~**시나리오**: 프리로드 트랙 로드 중 세션 ID 불일치로 early-return → 이후 프리로드 재생 불가~~

#### ~~12-3. `protocol.ts` _originPeer 스푸핑 (보안)~~ ✅
- ~~**위치**: `network/protocol.ts` — REQUEST_SETTING 등 오퍼레이터 권한 체크~~
- ~~**내용**: `_originPeer` 값은 연결 초기 한 번만 설정, 이후 변조 가능 → 비오퍼레이터가 오퍼레이터 권한 명령 실행 가능~~
- ~~**시나리오**: 악의적 게스트가 _originPeer를 조작하여 호스트 설정 변경~~

#### ~~12-4. `transfer.ts` fileReorderBuffer 무제한 증가 (보안/DoS)~~ ✅
- ~~**위치**: `storage/transfer.ts` — 청크 재정렬 버퍼~~
- ~~**내용**: out-of-order 청크 수신 시 버퍼 크기 제한 없음 → 메모리 폭주 가능~~
- ~~**시나리오**: 악의적 피어가 순서 불량 청크를 대량 전송 → 브라우저 OOM 크래시~~

#### ~~12-5. `index.html` + `i18n/*.ts` — settings.devices_title 누락~~ ✅
- ~~**위치**: `index.html` (Phase 11에서 추가된 HTML), `i18n/ko.ts`, `i18n/en.ts`~~
- ~~**내용**: `data-i18n="settings.devices_title"` 속성이 있지만 번역 키가 locale 파일에 없음~~
- ~~**시나리오**: Connected Devices 섹션 헤더에 raw key 문자열 표시~~

### MEDIUM — 논리 결함

#### ~~12-6. `effects.ts` reverb 프리셋 damping 미리셋~~ ✅
- ~~**위치**: `audio/effects.ts` — reverb preset 변경 함수~~
- ~~**내용**: reverb 프리셋 전환 시 `dampening` 파라미터를 리셋하지 않음 → 이전 프리셋의 damping 값 잔존~~

#### ~~12-7. `effects.ts` OP 게스트 reverb 이중 적용/브로드캐스트~~ ✅
- ~~**위치**: `audio/effects.ts` — OP 게스트 reverb 핸들러~~
- ~~**내용**: OP 게스트가 reverb 변경 시 로컬 적용 + REQUEST 메시지 전송 → 호스트가 다시 브로드캐스트하여 OP 게스트에 이중 적용~~

#### ~~12-8. `effects.ts` sub 모드 게인 순서 오류~~ ✅
- ~~**위치**: `audio/effects.ts` — sub bass gain 설정~~
- ~~**내용**: 가상 베이스 sub 모드에서 gain 노드 연결 순서가 의도와 불일치 가능~~

#### ~~12-9. `effects.ts` surround 비활성화 시 disconnect 후 미재연결~~ ✅
- ~~**위치**: `audio/effects.ts` — surround toggle~~
- ~~**내용**: surround 비활성화 시 노드 disconnect만 수행, 기본 스테레오 경로로 재연결 없음~~

#### ~~12-10. `engine.ts` surround 노드 에러 클린업 누락~~ ✅
- ~~**위치**: `audio/engine.ts` — initAudio partial init 에러 경로~~
- ~~**내용**: post-reverb 실패 시 surround 관련 노드가 cleanup 목록에서 누락~~

#### ~~12-11. `sync.ts` handleGlobalResyncRequest — autoSyncOffset 미리셋~~ ✅
- ~~**위치**: `network/sync.ts` — 글로벌 재동기화 핸들러~~
- ~~**내용**: 재동기화 시 `autoSyncOffset` 값을 0으로 리셋하지 않음 → 이전 보정값이 새 동기화에 개입~~

#### ~~12-12. `relay.ts` 다운스트림 중복 피어 미필터링~~ ✅
- ~~**위치**: `network/relay.ts` — relay 연결 관리~~
- ~~**내용**: 동일 피어가 다운스트림에 중복 등록 가능 → 메시지 이중 전송~~

#### ~~12-13. `transfer.ts` broadcastFile early-return 리소스 미정리~~ ✅
- ~~**위치**: `storage/transfer.ts` — broadcastFile 함수 초기 검증 실패 경로~~
- ~~**내용**: early-return 시 이미 할당된 리소스(세션 ID 등) 미해제~~

#### ~~12-14. `transfer.ts` relay 청크 total/name 필드 누락~~ ✅
- ~~**위치**: `storage/transfer.ts` — relay용 청크 메시지 구성~~
- ~~**내용**: relay 전달 시 `total`, `name` 필드가 누락되어 수신측 재조립 실패 가능~~

#### ~~12-15. `youtube/player.ts` _ytLoadInProgress — stopYouTubeMode 미리셋~~ ✅
- ~~**위치**: `youtube/player.ts` — stopYouTubeMode 함수~~
- ~~**내용**: YouTube 모드 중단 시 `_ytLoadInProgress` 플래그 미리셋 → 다음 YouTube 로드 차단~~

#### ~~12-16. `youtube/player.ts` _ytLoadInProgress — .video-wrapper null 시 영구 잠금~~ ✅
- ~~**위치**: `youtube/player.ts` — YouTube iframe 생성 경로~~
- ~~**내용**: `.video-wrapper` DOM 요소가 없을 때 `_ytLoadInProgress = true`인 채 return → 영구 잠금~~

#### ~~12-17. `youtube/player.ts` OP 게스트 REQUEST_YOUTUBE 토글 경쟁~~ ✅
- ~~**위치**: `youtube/player.ts` — REQUEST_YOUTUBE 핸들러~~
- ~~**내용**: OP 게스트의 YouTube 토글 요청이 호스트 응답과 경쟁 → 상태 불일치 가능~~

#### ~~12-18. `playlist-view.ts` toggleExpansion — setState 미사용~~ ✅
- ~~**위치**: `ui/playlist-view.ts` — 플레이리스트 확장/축소~~
- ~~**내용**: DOM 클래스 직접 조작만 수행, `setState` 미호출 → 상태-UI 불일치~~

#### ~~12-19. `media-session.ts` play 핸들러 IDLE 상태 차단~~ ✅
- ~~**위치**: `player/media-session.ts` — MediaSession play action handler~~
- ~~**내용**: appState가 IDLE일 때 MediaSession play 버튼이 동작하지 않음~~

#### ~~12-20. `youtube/player.ts` currentSubIndex 중단 시 미리셋~~ ✅
- ~~**위치**: `youtube/player.ts` — YouTube 정지 시~~
- ~~**내용**: YouTube 재생 정지 후 `currentSubIndex`가 이전 값 유지 → 다음 재생 시 잘못된 위치에서 시작~~

#### ~~12-21. `youtube/search.ts` fetchDemoFromServer XHR 타임아웃 없음~~ ✅
- ~~**위치**: `youtube/search.ts` — 데모 검색 XHR~~
- ~~**내용**: XMLHttpRequest에 timeout 미설정 → 서버 무응답 시 영구 대기~~

#### ~~12-22. `ui/chat.ts` 채팅 메시지 길이 미검증~~ ✅
- ~~**위치**: `ui/chat.ts` — 메시지 전송 핸들러~~
- ~~**내용**: 메시지 길이 제한 없음 → 초대형 문자열 전송 시 피어 측 렌더링/메모리 문제~~

#### ~~12-23. `transfer.ts` chunk 타입 미검증 (보안)~~ ✅
- ~~**위치**: `storage/transfer.ts` — 청크 수신 핸들러~~
- ~~**내용**: `data.chunk`이 Uint8Array/ArrayBuffer인지 타입 검증 없음 → 악의적 데이터 주입 가능~~

#### ~~12-24. `transfer.ts` broadcastFile 백프레셔 루프 타임아웃 없음~~ ✅
- ~~**위치**: `storage/transfer.ts` — broadcastFile 백프레셔 대기 루프~~
- ~~**내용**: 수신측 ACK 미응답 시 무한 대기 → 전송 영구 중단~~

#### ~~12-25. `protocol.ts` handlePlaylistUpdate 미검증 배열 저장 (보안/DoS)~~ ✅
- ~~**위치**: `network/protocol.ts` — PLAYLIST_UPDATE 핸들러~~
- ~~**내용**: 피어로부터 수신한 플레이리스트 배열을 검증 없이 setState → 악의적 대형 배열로 메모리 공격~~

#### ~~12-26. `engine.ts` initAudio() 에러 경로 경쟁 조건~~ ✅
- ~~**위치**: `audio/engine.ts` — initAudio 함수~~
- ~~**내용**: 초기화 실패 후 재시도 시 이전 부분 초기화 노드와 새 노드가 혼재~~

#### ~~12-27. `preload.ts` storage:use-preloaded 핸들러 와치독 없음~~ ✅
- ~~**위치**: `storage/preload.ts` — use-preloaded 이벤트 핸들러~~
- ~~**내용**: 프리로드 blob이 실제로 존재하지 않을 때 fallback/timeout 없음~~

#### ~~12-28. `preload.ts` _pendingEarlyChunks 미정리~~ ✅
- ~~**위치**: `storage/transfer.ts` — handleFileResume 함수~~
- ~~**내용**: resume 시 `_pendingEarlyChunks` 배열이 drain/clear 되지 않음 → 이전 전송의 조기 청크 혼입~~

#### ~~12-29. `video.ts` video element muted 속성 영구 true~~ ✅
- ~~**위치**: `player/video.ts:184`, `player/playback.ts:310,636,757,1216`~~
- ~~**내용**: `_videoElement.muted = true` 설정 후 `.muted = false`로 복원하는 코드 없음~~
- ~~**시나리오**: 버퍼 디코드 비디오 재생 → 이후 네이티브 비디오 재생 시 음소거 유지~~

#### ~~12-30. `peer.ts` leaveSession — recovery/transfer 상태 미리셋~~ ✅
- ~~**위치**: `network/peer.ts` — leaveSession batchSetState~~
- ~~**내용**: `recovery.pending`, `recovery.retryCount`, `transfer.currentSessionId`, `transfer.activeBroadcastSession`, `transfer.skipIncomingFile`, `transfer.waitingForPreload` 미리셋~~
- ~~**시나리오**: recovery 진행 중 세션 이탈 → 새 세션에서 recovery 요청 차단~~

#### ~~12-31. `preload.ts` 모듈 로컬 변수 세션 이탈 시 미정리~~ ✅
- ~~**위치**: `storage/preload.ts:23-24` — latestPreloadSessionId, preloadReorderBuffer~~
- ~~**내용**: peer.ts leaveSession이 state는 리셋하지만 모듈 로컬 변수는 리셋 불가 → 메모리 누수 + stale session ID로 유효 청크 거부~~

#### ~~12-32. `settings.ts` setChannel — _guardHostCtrl 누락~~ ✅
- ~~**위치**: `ui/settings.ts:388-390` — 채널 모드 버튼 클릭 핸들러~~
- ~~**내용**: 다른 오디오 설정(reverb, EQ, surround, bass)은 모두 `_guardHostCtrl()` 가드가 있으나 channel mode만 누락~~
- ~~**시나리오**: 비OP 게스트가 채널 모드(stereo/L/R/sub)를 자유롭게 변경 가능~~

#### ~~12-33. `tsconfig.json` workers 디렉토리 타입 체크 제외~~ ✅
- ~~**위치**: `tsconfig.json:25` — `"exclude": ["src/workers"]`~~
- ~~**내용**: sync.worker.ts, transfer.worker.ts의 타입 에러가 `tsc --noEmit`에서 검출되지 않음~~
- ~~**시나리오**: WorkerCommand 인터페이스 변경 시 워커 측 참조 깨짐을 빌드 타임에 감지 불가~~

#### ~~12-34. `i18n/index.ts` data-i18n-html XSS 풋건~~ ✅
- ~~**위치**: `i18n/index.ts:86` — `el.innerHTML = t(htmlKey)`~~
- ~~**내용**: `data-i18n-html` 속성의 번역 문자열이 `innerHTML`로 설정됨. 현재는 안전하나, 향후 `{{param}}` 보간 + 사용자 입력 결합 시 XSS 가능~~

### LOW — 경미한 이슈 / 데드 코드

#### ~~12-35. `sync.ts` nudgeSync 데드 코드~~ ✅
- ~~**위치**: `network/sync.ts` — nudgeSync 함수~~
- ~~**내용**: 호출처 없음, 완전한 데드 코드~~

#### ~~12-36. `relay.ts` RELAYABLE_COMMANDS 목록 불완전~~ ✅
- ~~**위치**: `network/relay.ts` — RELAYABLE_COMMANDS 배열~~
- ~~**내용**: 일부 릴레이 필요 커맨드 누락 (기능 미활성 상태이므로 LOW)~~

#### ~~12-37. `playback.ts` playPrevTrack 중복 리로드~~ ✅
- ~~**위치**: `player/playback.ts` — playPrevTrack 함수~~
- ~~**내용**: 이전 트랙 재생 시 불필요한 리로드 발생~~

#### ~~12-38. `preload.ts` preloadNextTrack 도달 불가 분기~~ ✅
- ~~**위치**: `storage/preload.ts` — preloadNextTrack 함수~~
- ~~**내용**: 특정 조건 분기가 논리적으로 도달 불가~~

#### ~~12-39. `platform.ts` navigator.platform 사용 (deprecated)~~ ✅
- ~~**위치**: `core/platform.ts`~~
- ~~**내용**: `navigator.platform`은 deprecated API — `navigator.userAgentData` 권장~~

#### ~~12-40. `blob-manager.ts` BlobURLManager.confirm() videoElement null 시 미호출~~ ✅
- ~~**위치**: `core/blob-manager.ts`~~
- ~~**내용**: videoElement이 null일 때 `confirm()` 호출 스킵 → blob URL 해제 지연~~

#### ~~12-41. `peer.ts` _relayConnTimer 세션 이탈 시 미정리~~ ✅
- ~~**위치**: `network/peer.ts`~~
- ~~**내용**: raw setTimeout으로 설정된 _relayConnTimer가 managedTimer 아님 → clearAllManagedTimers에서 미정리~~

#### ~~12-42. 데드 프로토콜 핸들러 (6개)~~ ✅
- ~~**위치**: `network/protocol.ts`~~
- ~~**내용**: DATA_RELAY, STATUS_SYNC, FORCE_SYNC_PLAY, SESSION_START, SYS_TOAST, REQUEST_REVERB_RESET — 핸들러 등록되어 있으나 발신처 없음~~

#### ~~12-43. 데드 DOM ID (4개)~~ ✅
- ~~**위치**: `index.html` + CSS/JS 참조~~
- ~~**내용**: `#grid-surround[data-surround-ch]`, `#my-id`, `#btn-surround-toggle`, `#btn-close-guide` — JS에서 참조하지만 HTML에 없거나 CSS에만 존재~~

#### ~~12-44. `style.css` is-rotating 클래스 미사용~~ ✅
- ~~**위치**: `css/style.css`~~
- ~~**내용**: `.is-rotating` CSS 규칙이 정의되어 있으나 JS에서 해당 클래스를 추가하는 코드 없음~~

#### ~~12-45. 데드 i18n 키 153개~~ ✅
- ~~**위치**: `i18n/ko.ts`, `i18n/en.ts`~~
- ~~**내용**: HTML/JS에서 참조되지 않는 번역 키 153개 제거 (421→268키, 번들 -18.5KB)~~

#### ~~12-46. `peer.ts` leaveSession peerSlots in-place mutation~~ ✅
- ~~**위치**: `network/peer.ts` — leaveSession~~
- ~~**내용**: `peerSlots` Map을 `.clear()`로 직접 변경 → setState 이벤트 미발생~~

#### ~~12-47. `app.ts` checkSystemCompatibility 항상 "passed" 로그~~ ✅
- ~~**위치**: `app.ts:84`~~
- ~~**내용**: 호환성 체크 실패 시에도 `"System compatibility check passed"` 로그 출력~~

#### ~~12-48. `peer.ts` leaveSession — peerSlots/sessionCode 미리셋~~ ✅
- ~~**위치**: `network/peer.ts` — leaveSession batchSetState~~
- ~~**내용**: `network.peerSlots`와 `network.sessionCode`가 batchSetState 목록에 누락~~

#### ~~12-49. `state.ts` snapshot() 뮤터블 참조 반환~~ ✅
- ~~**위치**: `core/state.ts:419-421`~~
- ~~**내용**: `Readonly<StateTree>` 타입은 컴파일 타임 전용 → 런타임에서 직접 변경 가능한 참조 반환~~

#### ~~12-50. `settings.ts` woofer cutoff 가시성 로직 중복~~ ✅
- ~~**위치**: `ui/settings.ts:85-111`~~
- ~~**내용**: `selectStandardChannelButton`과 `setChannel`에서 동일한 woofer cutoff 표시 로직 이중 실행~~

#### ~~12-51. `peer.ts` waitFor*ConnectionType 비관리 타이머~~ ✅
- ~~**위치**: `network/peer.ts:834-912`~~
- ~~**내용**: raw `setInterval`/`setTimeout` 사용 → `clearAllManagedTimers`로 정리 불가 (3초 내 자체 종료하므로 영향 미미)~~

#### ~~12-52. `style.css` dead constant() safe-area 선언~~ ✅
- ~~**위치**: `css/style.css:79-82`~~
- ~~**내용**: `constant(safe-area-inset-*)` 함수는 iOS 11.0-11.2 beta에서만 지원 → 현재 모든 브라우저에서 데드 코드~~

#### ~~12-53. `visualizer.ts` resize 리스너 이중 등록 방지 없음~~ ✅
- ~~**위치**: `ui/visualizer.ts:253`~~
- ~~**내용**: `initVisualizer()` 재호출 시 resize 리스너 중복 등록 (HMR 개발 환경에서 발생)~~

#### ~~12-54. `timers.ts` clearTimeout+clearInterval 동일 ID 사용~~ ✅
- ~~**위치**: `core/timers.ts:32-35`~~
- ~~**내용**: 관리 타이머 해제 시 `clearTimeout`+`clearInterval` 모두 호출 → 스펙상 옵셔널인 공유 ID 풀에 의존~~

#### ~~12-55. `session.ts` _globalSessionCounter 오버플로우 미방어~~ ✅
- ~~**위치**: `core/session.ts:17-20`~~
- ~~**내용**: 카운터가 `MAX_SAFE_INTEGER` 초과 가능 (이론적) vs `validateSessionId()`의 `isSafeInteger` 검증 → 비대칭~~

#### ~~12-56. `transfer.worker.ts` 메시지 큐 null 엔트리 축적~~ ✅
- ~~**위치**: `workers/transfer.worker.ts:55-87`~~
- ~~**내용**: null-set + index 패턴 → shift() 패턴으로 전환, null 축적 원천 제거~~

---

### Phase 12 오탐(False Positive) 기록

| 보고 내용 | 판정 이유 |
|-----------|-----------|
| `stopPlayback()` YouTube 상태 전이 | Phase 2-5에서 의도된 설계로 SKIP 처리 완료. PLAYING_YOUTUBE 유지해야 togglePlay()에서 YouTube 재개 가능 |
| `chat.ts` ytRegex stateful g flag | `ytRegex.lastIndex = 0` 명시적 리셋 수행 + 함수 로컬 변수로 매 호출 재생성 |
| `dom.ts` marquee resize hidden tab | `#track-title`은 탭 패널이 아닌 상시 표시 플레이어 영역에 위치. rAF가 브라우저 탭 비활성 시 일시정지 |
| `service-worker.js` background fetch 무음 실패 | 표준 stale-while-revalidate 패턴. 다음 요청이 자체 retry 역할. 추가 retry 불필요 |
| `settings.ts` guest UI sync reverb/EQ | 프로토콜 핸들러(REQUEST_SETTING)가 오디오 적용 별도 처리. ui:sync-* 이벤트는 슬라이더 표시 전용 |

---

## ~~Phase 13 — 레전드 스캔 3차 (10라운드)~~ ✅

> Phase 12 수정 후 회귀 검증 + 미탐색 영역 정밀 탐색. 10라운드 완료. **31건 전수 수정 완료.**

### ~~HIGH — 유지보수 / 번들 크기~~

#### ~~13-1. `style.css` 레거시 데드 CSS ~60+ 셀렉터 (~716줄 제거)~~ ✅
- `.sync-card`, `.help-modal`(12개), `.vinyl-loader`, `.chat-container`, `.setup-inner-slider`(6개), `.qr-card`, `.input-group`, `.toggle-switch` 등 85+ 셀렉터 전수 확인 후 제거

### ~~MEDIUM — 논리 결함~~

#### ~~13-2. `playlist.ts` 부트스트랩 PLAYLIST_UPDATE — currentTrackIndex 추가~~ ✅
#### ~~13-3. `blob-manager.ts` 큐 오버플로우 시 `_clearScheduled()` 호출로 타이머 해제~~ ✅
#### ~~13-4. `playlist.ts` loadDemoMedia XHR `timeout=15000` + `ontimeout` 추가~~ ✅
#### ~~13-5. `style.css` `-webkit-backdrop-filter: blur(4px)` 추가~~ ✅
#### ~~13-6. `style.css` `.graphic-line-active` 이중 정의 → 단일 병합~~ ✅
#### ~~13-7. `youtube/sync.ts` SESSION_START + youtube:load에서 `resetAdDetection()` 호출~~ ✅
#### ~~13-8. `transfer.ts` `data.chunk == null` 가드 추가 → 0바이트 기록 방지~~ ✅

### ~~LOW — 경미한 이슈 / 데드 코드~~

#### ~~13-9. `transfer.ts` 버퍼 오버플로우 시 `storage:request-recovery` 발행~~ ✅
#### ~~13-10. `transfer.ts` `isArrayBuffer()` 크로스 렐름 안전 헬퍼 도입~~ ✅
#### ~~13-11. `playback.ts` early-return 4곳에서 `_pendingPlayTime = undefined` 리셋~~ ✅
#### ~~13-12. `playlist.ts` 빈 플레이리스트 수신 시 `currentTrackIndex = -1` 리셋~~ ✅
#### ~~13-13. `player-controls.ts` 변수 `t` → `seekTime` 리네임~~ ✅
#### ~~13-14. `tabs.ts` 인덱스 → `data-tab` 속성 기반 선택으로 전환~~ ✅
#### ~~13-15. `dialog.ts` forward Tab 포커스 트랩 추가~~ ✅
#### ~~13-16. `index.html` 4개 tabpanel에 `aria-labelledby` 추가~~ ✅
#### ~~13-17. `index.html` `#vol-icon-btn`에 `role="button"` + `aria-label` + `tabindex="0"` + 키보드 핸들러~~ ✅
#### ~~13-18. `setup.ts` dead `setupShowInstruction` 함수 + 5개 호출처 제거~~ ✅
#### ~~13-19. `style.css` `.setup-code-label` 이중 정의 → 단일 병합~~ ✅
#### ~~13-20. `playback.ts` dead `sync:nudge-apply` 리스너 + EventMap 타입 제거~~ ✅
#### ~~13-21. `setup.ts` dead `setup:hide-overlay` 리스너 + EventMap 타입 제거~~ ✅
#### ~~13-22. `youtube/player.ts` dead `sync:youtube-nudge` 리스너 + EventMap 타입 제거~~ ✅
#### ~~13-23. `youtube/sync.ts` `handleYouTubeStop`에 PLAYING_YOUTUBE 가드 추가~~ ✅
#### ~~13-24. `youtube/search.ts` `AbortController` 기반 fetch 취소 도입~~ ✅
#### ~~13-25. `youtube/search.ts` 프리뷰 디바운스 타이머 오버레이 닫기 시 해제~~ ✅
#### ~~13-26. `visualizer.ts` rAF를 draw 성공 후로 이동 + try-catch 에러 차단~~ ✅
#### ~~13-27. `visualizer.ts` PLAYING_YOUTUBE 시 draw() 조기 종료~~ ✅
#### ~~13-28. `effects.ts` `_reverbGenerationId` 카운터로 stale 재귀 차단~~ ✅
#### ~~13-29. `chat.ts` 메시지 절삭 시 토스트 알림 + `maxlength` 동기화~~ ✅
#### ~~13-30. `youtube/search.ts` oEmbed 썸네일 null 체크 + `onerror` 핸들러~~ ✅
#### ~~13-31. `platform.ts` Android 48dp 제한 사항 문서화 (CSS `env()` 우선 처리 확인)~~ ✅

---

### Phase 13 오탐(False Positive) 기록

| 보고 내용 | 판정 이유 |
|-----------|-----------|
| `recovery.ts` 삼항 연산자 우선순위 | 조건부와 true-branch가 동일 표현식 → 결과는 항상 정확 (스타일 이슈만) |
| `youtube/sync.ts` subItemsMap in-place mutation | `setState`가 spread copy로 직후 호출 → 이벤트 정상 발생. anti-pattern이나 런타임 버그 아님 |
| `state.ts` snapshot() structuredClone 항상 fallback | 설계 의도. JSON fallback이 DataConnection 등 처리. 미미한 성능 낭비 |

---

## 수정 범위 요약

| Phase | 범위 | 항목 수 | 위험도 |
|-------|------|---------|--------|
| 1 | State & Core | 4 | CRITICAL |
| 2 | YouTube & Player | 6 | CRITICAL |
| 3 | Audio 안전 | 5 | CRITICAL |
| 4 | Network | 3 | HIGH |
| 5 | CSS & UI | 4 | HIGH |
| 6 | 리스너 정리 | 3 | MEDIUM |
| 7 | 타입 정리 | 3 | MEDIUM |
| 8 | 테스트 | 2 | LOW |
| 9 | 심층 재분석 | 8 | CRITICAL-HIGH |
| 10 | 신규 발견 이슈 | 7 | HIGH-LOW |
| 11 | 레전드 스캔 1차 | 15 | HIGH-LOW |
| 12 | 레전드 스캔 2차 | 56 | HIGH-LOW |
| ~~13~~ | ~~레전드 스캔 3차~~ | ~~31~~ | ~~HIGH-LOW~~ ✅ |
| **합계** | | **147** | **ALL DONE** ✅ |
