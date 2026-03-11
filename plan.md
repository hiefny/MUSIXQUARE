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

---

## Phase 14 — 6-에이전트 병렬 정밀 탐색 (검증 완료)

> Opus 에이전트 6개 병렬 투입: Core, Audio, Network, Player+YouTube, UI, Storage+Workers+Config
> 기존 Phase 1-13에서 수정/SKIP/오탐 처리된 항목 제외, 순수 신규 이슈만 기록
> **전수 처리 완료: 85건 중 25건 수정 ✅, 38건 SKIP(오탐), 22건 SKIP(설계)**

---

### CRITICAL (2건)

#### ~~14-1. `sync.ts` 하트비트 감지 → 좀비 피어 잔존~~ ✅
- **위치**: `network/sync.ts:386-405`
- **내용**: 하트비트 stale 감지 시 `p.status = 'disconnected'` + `conn.close()` 호출하지만, RTCDataChannel이 이미 broken이면 `close` 이벤트 미발생 → `activeHostConnByPeerId`, `peerSlots`, `peerLabels`에서 영구 잔존
- **시나리오**: 피어가 브라우저 크래시/네트워크 단절 → 좀비 피어가 `connectedPeers`에 남아 슬롯 점유 + 기기 목록에 유령 표시

#### ~~14-2. `state.ts` resetState() 변경 알림 미발행~~ → SKIP
- **위치**: `core/state.ts:439-441`
- **내용**: `resetState()`가 전체 상태를 초기값으로 교체하면서 `state:*` 이벤트를 하나도 emit 하지 않음
- **시나리오**: 현재 테스트 전용이므로 프로덕션 무영향. 향후 disconnect → reset 경로 도입 시 모든 UI 구독자 stale

---

### HIGH — Network (11건)

#### ~~14-3. `peer.ts` 피어 상태 변경 1.5초간 미통보~~ → SKIP
- **위치**: `network/peer.ts:347-372`
- **내용**: `conn.on('open')` 시 `peerObj.status = 'connected'` 직접 대입 후, `setState`는 1.5초 뒤 `setTimeout`에서 호출. UI 구독자가 그 사이 stale 상태를 봄

#### ~~14-4. `peer.ts` 중복 접속 시 old connection open 핸들러 레이스~~ → SKIP (설계)
- **위치**: `network/peer.ts:275-288`
- **내용**: 빠른 재접속 시 old connection의 `on('open')` 콜백이 뒤늦게 실행 → `connectedPeers`에 같은 peerId 이중 등록 가능

#### ~~14-5. `peer.ts` ICE 감지 setTimeout 취소 불가~~ → SKIP
- **위치**: `network/peer.ts:366-396`
- **내용**: 1.5s + 8.5s `setTimeout`이 raw (managed timer 아님). 피어 disconnect 후에도 콜백 실행 → 불필요한 `broadcastDeviceList()` + conn 참조 GC 10초 지연

#### ~~14-6. `peer.ts` 동시 initNetwork 호출 시 peer/ID 불일치~~ → SKIP
- **위치**: `network/peer.ts:22, 111-121`
- **내용**: 더블클릭 등으로 `initNetwork` 동시 호출 시, 첫 번째 호출의 `peer.on('open')` → `setState('network.myId', id)` 실행되지만 `peer` 모듈 변수는 두 번째 인스턴스를 가리킴

#### ~~14-7. `peer.ts` peerLabels 직접 mutation~~ → SKIP
- **위치**: `network/peer.ts:325, 419-421, 448-450`
- **내용**: `peerLabels[peerId] = deviceName`, `delete peerLabels[peerId]` — setState 미호출로 `state:network.peerLabels` 이벤트 미발생

#### ~~14-8. `orchestrator.ts` relayAssignments 역할 전환 시 미정리~~ → SKIP
- **위치**: `network/orchestrator.ts:37, 248-253`
- **내용**: `network.sessionCode`가 falsy일 때만 정리. 호스트→게스트 전환 시 session code 클리어 없이 역할 변경하면 stale relay 잔존

#### ~~14-9. `relay.ts` 다운스트림 메시지 검증/로깅 없음~~ → SKIP
- **위치**: `network/relay.ts:306-314`
- **내용**: `conn.on('data')` 핸들러가 `msg.type` 검증 없이 처리. 비정상 데이터(문자열, ArrayBuffer 등) 무음 드롭

#### ~~14-10. `relay.ts` opfsCatchupPumps 세션 이탈 시 미정리~~ ✅
- **위치**: `network/relay.ts:53`
- **내용**: `leaveSession` → `peer.destroy()` 시 `close` 이벤트 미발생하면 펌프 + raw setTimeout 잔존

#### ~~14-11. `relay.ts` 타임아웃 복구 요청에 stale transfer 메타데이터~~ → SKIP
- **위치**: `network/relay.ts:217-236`
- **내용**: 10초 릴레이 타임아웃 후 `REQUEST_DATA_RECOVERY` 전송 시 `transfer.meta`가 이미 다른 트랙으로 변경되었을 수 있음

#### ~~14-12. `sync.ts` 모듈 스코프 싱크 상태 세션 종료 시 미정리~~ ✅
- **위치**: `network/sync.ts:31-34`
- **내용**: `_syncSamples`, `_syncSampleExpected`, `_syncSampleTimer`, `_syncTimeoutTimer`가 세션 이탈 시 리셋 안 됨 → 재접속 시 이전 세션 데이터 개입

#### ~~14-13. `sync.ts` resyncTimer를 state tree에 저장~~ → SKIP
- **위치**: `network/sync.ts:179-191`
- **내용**: `setState('sync.resyncTimer', timer)` — setTimeout 핸들은 비직렬화 값. state 디버깅/스냅샷 도구에서 오류 유발

---

### HIGH — Audio (4건)

#### ~~14-14. `engine.ts` 오디오 그래프 teardown 함수 부재~~ → SKIP (설계)
- **위치**: `audio/engine.ts` 전체
- **내용**: 30+ Tone.js 노드 생성 후 dispose 경로 없음. `initAudio()` idempotency가 `masterGain` 존재 여부로 판단하므로, 에러 후 재초기화 불가. bus 이벤트 리스너(399-462줄)도 해제 불가

#### ~~14-15. `engine.ts` AudioContext statechange 리스너 누수~~ → SKIP (설계)
- **위치**: `audio/engine.ts:382`
- **내용**: 익명 화살표 함수로 `statechange` 리스너 등록 → `removeEventListener` 불가. AudioContext 참조를 클로저로 잡아 GC 차단

#### ~~14-16. `channel.ts` 서라운드 채널 변경 시 순간 끊김~~ → SKIP (설계)
- **위치**: `audio/channel.ts:156`, `audio/engine.ts:436`
- **내용**: `safeDisconnect(splitter)` → 모든 출력 끊김 → 새 채널만 연결. 재생 중이면 수 ms 무음/클릭 발생

#### ~~14-17. `effects.ts` 부트스트랩 유닛 인코딩 fragile~~ → SKIP (설계)
- **위치**: `audio/effects.ts:435-481`
- **내용**: 네트워크 싱크 시 `reverbMix * 100`, `stereoWidth * 100` 등 값별 변환 로직이 encode/decode 양쪽에 분산. 공유 스키마 없어 한쪽 변경 시 상대측 무음 깨짐

---

### HIGH — Player / YouTube (8건)

#### ~~14-18. `playback.ts` stopAllMedia → player:state-changed 이중 발화~~ ✅
- **위치**: `player/playback.ts:164-173`
- **내용**: `stopAllMedia()`가 `youtube:stop-mode` emit + 자체 `player:state-changed` emit. `stopYouTubeMode()`도 같은 이벤트 발화 → 2회 발사, updateBodyModeClass 이중 실행

#### ~~14-19. `playback.ts` play() 락 해제 시 _pendingPlayTime 단일 슬롯~~ → SKIP
- **위치**: `player/playback.ts:210-224`
- **내용**: `_isPlayLocked` 해제 10ms 내 다수 play 요청 도착 시, `_pendingPlayTime`은 마지막 값만 저장. 네트워크 싱크 보정이 누락될 수 있음

#### ~~14-20. `playback.ts` clearPreviousTrackState null 접근~~ → SKIP
- **위치**: `player/playback.ts:1053`
- **내용**: `getState('files.currentFileOpfs')` 반환값에 `.name` 직접 접근. state 미초기화/리셋 후 null이면 런타임 크래시

#### ~~14-21. `playlist.ts` 트랙 제거 시 preload 인덱스 무효화 누락~~ → SKIP
- **위치**: `player/playlist.ts:707-752`
- **내용**: 제거된 트랙이 프리로드 대상(`preload.nextTrackIndex`)일 때 프리로드 상태 미리셋 → 자동 진행 시 엉뚱한 트랙 재생

#### ~~14-22. `video.ts` YouTube setEngineMode idle/paused 우회~~ → SKIP
- **위치**: `player/video.ts:80-81`
- **내용**: YouTube 모드 전환 시 paused 상태 무시하고 `PLAYING_YOUTUBE`로 직행. API 로드 실패 시 PLAYING_YOUTUBE 상태에서 복구 불가

#### ~~14-23. `media-session.ts` stop 핸들러 isBlocked 가드 누락~~ ✅
- **위치**: `player/media-session.ts:113-115`
- **내용**: 다른 핸들러(play, pause, seek 등)는 `isBlocked()` 체크하지만 stop만 누락 → 비OP 게스트가 잠금 화면에서 재생 중지 가능

#### ~~14-24. `media-session.ts` playbackState 미설정~~ ✅
- **위치**: `player/media-session.ts` 전체
- **내용**: `navigator.mediaSession.playbackState`를 명시적으로 `'playing'`/`'paused'`/`'none'`으로 설정하는 코드 없음. Tone.js(Web Audio) 사용 시 브라우저가 상태 추론 불가 → 잠금 화면 play/pause 버튼 불일치

#### ~~14-25. `youtube/player.ts` currentSubIndex 재생 중 미업데이트~~ → SKIP
- **위치**: `youtube/player.ts:238-271`
- **내용**: `onStateChange`에서 `getPlaylistIndex()` 결과를 게스트에 브로드캐스트하지만 로컬 `youtube.currentSubIndex` setState 안 함 → MediaSession 메타데이터(잠금 화면 제목)가 stale

---

### HIGH — UI / i18n (8건)

#### ~~14-26. 하드코딩 영어 문자열 12곳+ (i18n 누락)~~ ✅
- **위치**: 다수 파일
- **내용**: `t()` 함수를 사용하지 않고 영어 리터럴 직접 사용. 한국어 사용자에게 영어 표시
- **수정**: 18개 번역 키 추가 (ko.ts/en.ts) + 7개 UI 파일에서 `t()` 호출로 전환

#### ~~14-27. `i18n/index.ts` t() 함수 타입이 string (I18nKey 아님)~~ ✅
- **위치**: `i18n/index.ts:31`
- **내용**: `t(key: string, ...)` — 아무 문자열 허용. `t('tost.file_ready')` 같은 오타가 컴파일 통과
- **수정**: `t(key: I18nKey)`, `tHtml(key: I18nKey)` 시그니처 전환. DOM 속성 조회는 `as I18nKey` assertion

#### ~~14-28. `player-controls.ts` touchstart 비passive~~ ✅
- **위치**: `ui/player-controls.ts:357`
- **내용**: seek slider `touchstart` 리스너에 `{ passive: true }` 누락. `preventDefault()` 미사용이므로 passive 가능. Chrome 모바일에서 intervention 경고 + 터치 jank

#### ~~14-29. `tabs.ts` 탭 키보드 네비게이션 누락~~ ✅
- **위치**: `ui/tabs.ts:18-31`
- **내용**: WAI-ARIA tabs 패턴의 화살표 키 탐색 미구현
- **수정**: ArrowLeft/Right, Home/End 키보드 네비게이션 + `role="tab"` + `tabindex` 관리 추가

#### ~~14-30. `visualizer.ts` analyser 대기 rAF 폴링 비효율~~ ✅
- **위치**: `ui/visualizer.ts:83-91`
- **내용**: `getAnalyser()` null일 때 rAF로 120프레임 폴링
- **수정**: `setTimeout(startVisualizer, 100)` + MAX_RETRIES 120→20 전환

#### ~~14-31. `playlist-view.ts` 전체 DOM 재구축~~ → SKIP (설계)
- **위치**: `ui/playlist-view.ts:63`
- **내용**: `updatePlaylistUI()` 호출 시 `ul.innerHTML = ''`로 전체 파괴 → 전체 재생성. 대형 플레이리스트에서 비효율

#### ~~14-32. `chat.ts` combinedRegex 매 호출 재생성~~ ✅
- **위치**: `ui/chat.ts:70-73`
- **내용**: `parseMessageContent` 호출마다 `new RegExp(...)` 생성
- **수정**: 모듈 스코프로 이동 + `lastIndex = 0` 리셋

#### ~~14-33. `constants.ts` PEER_NAME_PREFIX 3중 정의~~ ✅
- **위치**: `core/constants.ts:52`, `ui/setup.ts:27`, `ui/chat.ts:25`
- **내용**: 동일 상수 `'Peer'`가 3곳에 별도 정의. 변경 시 3곳 수정 필요

---

### HIGH — Storage / Workers / Config (8건)

#### ~~14-34. `opfs.ts` 메인 스레드 OPFS 읽기 vs 워커 SyncAccessHandle 충돌~~ → SKIP
- **위치**: `storage/opfs.ts:121-133`
- **내용**: `readFileFromOpfs()`가 메인 스레드에서 `getFile()` 호출. 워커가 동일 파일에 `SyncAccessHandle` 보유 중이면 stale/불완전 데이터 반환 가능

#### ~~14-35. `preload.ts` state Map 직접 mutation~~ → SKIP
- **위치**: `storage/preload.ts:42-52, 289-299, 323-333`
- **내용**: `getState('preload.sessionState')` 반환 Map에 `.set()`, `.delete()` 직접 호출 → `state:preload.sessionState` 이벤트 미발생

#### ~~14-36. `transfer.ts` 세션 변경 시 OPFS_START 전 청크 처리~~ → SKIP (설계)
- **위치**: `storage/transfer.ts:508-516`
- **내용**: `incomingSid > localSid` 감지 → `nextExpectedChunk = 0` 리셋하지만 OPFS_START 미발행. 워커가 SESSION_MISMATCH 오류 emit

#### ~~14-37. `transfer.worker.ts` OPFS_READ와 활성 OPFS_WRITE 충돌~~ → SKIP
- **위치**: `workers/transfer.worker.ts:438-499`
- **내용**: 활성 쓰기 세션 중 읽기 요청 시 SyncAccessHandle 재사용으로 불완전 데이터 반환. fallback `getFile()`은 flush 전 stale 데이터 반환

#### ~~14-38. `transfer.worker.ts` 청크 사이즈 결합 implicit~~ → SKIP
- **위치**: `workers/transfer.worker.ts:323`
- **내용**: `offset = index * opfsObj.chunkSize` — 메인 스레드 `CHUNK_SIZE`와 워커 `chunkSize`가 `OPFS_START` 메시지로만 연결. 상수 변경 시 파일 손상 위험

#### ~~14-39. `service-worker.js` CACHE_VERSION 수동 관리~~ → SKIP (설계)
- **위치**: `public/service-worker.js:38`
- **내용**: `CACHE_VERSION = "v107"` 수동 번호. 빌드 시 자동 주입 없으면 stale 캐시 미정리

#### ~~14-40. `vite.config.ts` __dirname ESM 컨텍스트 사용~~ → SKIP
- **위치**: `vite.config.ts:9, 17`
- **내용**: `"type": "module"` 프로젝트에서 CJS 전용 `__dirname` 사용. Vite가 내부 shim 제공하지만, 번들러 변경 시 깨짐. `import.meta.dirname` 권장

#### ~~14-41. `types/index.ts` FileMeta.type 필드 vestigial~~ → SKIP (설계)
- **위치**: `types/index.ts:34`
- **내용**: `FileMeta`에 `type: string` + `mime: string` 이중 존재. `type`은 protocol 메시지의 메시지 타입과 혼동 가능. `Partial<FileMeta>` cast로 마스킹

---

### MEDIUM — Core (5건)

#### ~~14-42. `state.ts` setState 참조 동일성 비교로 in-place mutation 무시~~ → SKIP
- **위치**: `core/state.ts:361`
- **내용**: `if (oldValue === value) return` — 같은 배열/객체를 mutate 후 다시 set하면 변경 무시. `items.push(x); setState('items', items)` 패턴 실패

#### ~~14-43. `state.ts` batchSetState 로직 중복~~ → SKIP
- **위치**: `core/state.ts:375-416`
- **내용**: `setState`의 경로 탐색/변경 로직을 독립적으로 재구현. 향후 한쪽만 수정 시 불일치 발생

#### ~~14-44. `state.ts` batchSetState Object.entries 타입 손실~~ → SKIP
- **위치**: `core/state.ts:380`
- **내용**: `Object.entries(updates)` → key가 `string`, value가 `unknown`으로 변환. 유효하지 않은 경로 전달 시 중간 객체 자동 생성, 상태 트리 오염

#### ~~14-45. `timers.ts` setTimeout 만료 후 stale 엔트리 잔존~~ ✅
- **위치**: `core/timers.ts:21-24`
- **내용**: `setTimeout` 콜백 실행 후 `_timers` Map에서 자동 제거 안 됨. `getManagedTimer(name)`이 이미 만료된 타이머를 "활성"으로 오판

#### ~~14-46. `platform.ts` iOS Safari DOM probe 매 호출 생성/제거~~ → SKIP
- **위치**: `core/platform.ts:129-135`
- **내용**: `updateAppHeightNow()` 호출마다 `<div>` 생성 → body 추가 → offsetHeight 읽기 → 제거. resize/scroll/orientation 이벤트마다 forced reflow

---

### MEDIUM — Network 추가 (3건)

#### ~~14-47. `protocol.ts` 핸들러 덮어쓰기 경고만, 방지 없음~~ → SKIP
- **위치**: `network/protocol.ts:64-67`
- **내용**: `registerHandler` 중복 등록 시 console.warn만 출력하고 덮어쓰기 허용. 모듈 초기화 순서 변경 시 핸들러 무음 교체

#### ~~14-48. `protocol.ts` 릴레이 루프 방지 단일 홉 전용~~ → SKIP
- **위치**: `network/protocol.ts:137`
- **내용**: `p.peer !== conn?.peer` 비교로 송신자에 되돌리기 방지. 다중 홉 토폴로지에서 메시지 증폭 루프 가능 (현재 단일 홉이므로 이론적)

#### ~~14-49. `relay.ts` OPFS catch-up pump raw setTimeout~~ → SKIP (설계)
- **위치**: `network/relay.ts:50, 107-111`
- **내용**: `OpfsCatchupPump._timer`가 raw setTimeout. managed timer 아니므로 `clearAllManagedTimers`에서 미정리

---

### MEDIUM — Audio 추가 (3건)

#### ~~14-50. `effects.ts` reverb generate() 재시도 timeout 누수~~ → SKIP
- **위치**: `audio/effects.ts:161-163`
- **내용**: `Promise.race([rev.generate(), timeout(3000)])` — generate 성공 시 timeout의 setTimeout 미해제. 빠른 파라미터 변경 시 dangling timer 축적

#### ~~14-51. `effects.ts` EQ gain.value 비교 mid-ramp 시 부정확~~ → SKIP
- **위치**: `audio/effects.ts:95-101`
- **내용**: `node.gain.value !== clamped` 비교로 중복 ramp 방지 시도. ramp 진행 중 `value`가 target을 반환할 수 있어 최적화 불안정

#### ~~14-52. `effects.ts` stereoWidth * 0.5 매핑 — UI 100%가 실제 50%~~ → SKIP
- **위치**: `audio/effects.ts:110`
- **내용**: `wid.width.rampTo(stereoWidth * 0.5, ...)` — UI "100%" = Tone.js width 0.5. 사용자 기대와 불일치 (의도적이면 문서화 필요)

---

### MEDIUM — Player 추가 (3건)

#### ~~14-53. `youtube/player.ts` YouTube 스크립트 실패 시 DOM 잔류 → 재시도 영구 차단~~ ✅
- **위치**: `youtube/player.ts:95-105`
- **내용**: `tag.onerror`에서 `_ytScriptLoading = false` 리셋하지만 `<script>` 태그 미제거. `document.querySelector('script[src*="youtube"]')` 가드가 깨진 태그를 찾아 재로드 스킵

#### ~~14-54. `youtube/player.ts` async title fetch 시 stale playlist index~~ ✅
- **위치**: `youtube/player.ts:785-795, 934-944`
- **내용**: 비동기 resolve 전 플레이리스트 변경 시 stale index로 덮어쓰기
- **수정**: `_addYouTubeToPlaylist` 헬퍼에서 resolve 시점에 playlist.length 재검증

#### ~~14-55. `youtube/player.ts` populate-sub-items state 직접 mutation~~ ✅
- **위치**: `youtube/player.ts:850-858`
- **내용**: getState 반환 객체 직접 변경 후 spread
- **수정**: inner 배열도 `[...items]` deep copy 후 setState

---

### MEDIUM — Storage / Config 추가 (3건)

#### ~~14-56. `sw-register.ts` 이중 reload 경로 혼동~~ → SKIP
- **위치**: `sw-register.ts:69-75`
- **내용**: `SKIP_WAITING` 후 `controllerchange` 이벤트와 직접 `reload()` 두 경로가 공존. `_swReloading` 플래그로 방어하지만 코드 흐름이 모호

#### ~~14-57. `service-worker.js` stale-while-revalidate로 old hashed 에셋 축적~~ → SKIP
- **위치**: `public/service-worker.js:167-194`
- **내용**: Vite 해시 파일명 에셋이 캐시에 누적. 이전 버전 파일은 더 이상 요청되지 않으므로 업데이트된 캐시 엔트리는 무의미한 용량 차지

#### ~~14-58. `tsconfig.json` vitest/globals 타입 프로덕션 코드 노출~~ ✅
- **위치**: `tsconfig.json:18`
- **내용**: `"types": ["vitest/globals"]`가 프로덕션 코드에 노출
- **수정**: `tsconfig.test.json` 분리 (extends + vitest/globals), tsconfig.json에서 `__tests__` exclude + types 제거

---

### LOW (27건)

#### Core
- ~~**14-59.**~~ `events.ts` — 리스너 수 경고 없음 (maxListeners) → SKIP (설계: EventBus 아키텍처 변경 필요)
- ~~**14-60.**~~ `session.ts` — `_warnedBadSessionIds` Set clear 후 재경고 → SKIP (설계: 영향 미미)
- ~~**14-61.**~~ `session.ts` — `nextSessionId()` 동일 초 내 다른 탭과 카운터 충돌 가능 → SKIP
- ~~**14-62.**~~ `platform.ts` — `IS_ANDROID` 판정이 userAgent 의존 → SKIP (설계: 표준 방식)
- ~~**14-63.**~~ `platform.ts` — `initPlatform()` 리스너 해제 없음 → SKIP (설계: SPA 1회 init)
- ~~**14-64.**~~ `log.ts` — 런타임 `setLogLevel()` 함수 없음 → ✅ (`setLogLevel` export + globalThis 노출)
- ~~**14-65.**~~ `blob-manager.ts` — `BlobURLManager` object literal + `this` → SKIP (설계: 리팩토링 위험)

#### Audio
- ~~**14-66.**~~ `channel.ts` — `setChannelMode()` audio init 전 state만 변경 → SKIP (설계: 의도된 동작)
- ~~**14-67.**~~ `engine.ts` — `_initAudioPromise` 실패 후 null → 재시도 가능 → SKIP (설계: 의도된 재시도)
- ~~**14-68.**~~ `engine.ts` — `audio:connect-surround` channelIdx 미검증 → ✅ (범위 검증 추가)
- ~~**14-69.**~~ `effects.ts` — `widener.wet` 매 applySettings() 중복 rampTo(1) → ✅ (값 비교 가드 추가)

#### Network
- ~~**14-70.**~~ `peer.ts` — `_errorHandled` duck-typing → SKIP (설계: PeerJS API 제한)
- ~~**14-71.**~~ `peer.ts` — `sendFullAndClose` 500ms delay (슬롯 미할당 → 무영향) → SKIP
- ~~**14-72.**~~ `peer.ts` — 하트비트/핑 즉시 시작 (의도된 동작) → SKIP
- ~~**14-73.**~~ `orchestrator.ts` — `evaluatePeer` peerId 미검증 (find+guard 패턴 존재) → SKIP
- ~~**14-74.**~~ `relay.ts` — conn already open before on('open') → SKIP (설계: 이론적 레이스)
- ~~**14-75.**~~ `sync.ts` — `sync:get-position` 콜백 (playback.ts에서 동기 호출 확인) → SKIP
- ~~**14-76.**~~ `sync.ts` — `sync:display-update` 직접 DOM 접근 → ✅ (sync.ts→player-controls.ts 이관)

#### Player / YouTube
- ~~**14-77.**~~ `playback.ts` — `adjustSync` pausedAt 미클램핑 → ✅ (`Math.max(0, Math.min(duration))` 클램핑)
- ~~**14-78.**~~ `playback.ts` — `handleEnded` duration ≤ 0.5초 스킵 → SKIP (설계: 의도적 글리치 방지)
- ~~**14-79.**~~ `playback.ts` — `loadAndBroadcastFile` pausedAt 이중 리셋 (실제 이중 아님) → SKIP
- ~~**14-80.**~~ `playback.ts` — `_internalPlay` [BufferMode] 로그 라벨 → SKIP (설계: cosmetic)
- ~~**14-81.**~~ `playback.ts` — `playPrevTrack` 첫 트랙 재시작 (표준 UX) → SKIP
- ~~**14-82.**~~ `video.ts` — `updateBodyModeClass` 불필요한 remove/re-add → ✅ (`classList.toggle(cls, force)` 최적화)
- ~~**14-83.**~~ `youtube/player.ts` — ENDED 핸들러 순서 (guard가 처리) → SKIP
- ~~**14-84.**~~ `youtube/player.ts` — load-from-input/load-from-chat 100줄+ 중복 → ✅ (`_addYouTubeToPlaylist` 공유 헬퍼 추출)
- ~~**14-85.**~~ `youtube/player.ts` — stopYouTubeMode 비디오 src 클리어 → SKIP (설계: 의도적 clean slate)

---

### Phase 14 최종 검증 결과 요약

| 판정 | 건수 | 상세 |
|------|------|------|
| ✅ 수정 완료 | 25 | 14-1, 14-10, 14-12, 14-18, 14-23, 14-24, 14-26~27, 14-28~30, 14-32~33, 14-45, 14-53~55, 14-58, 14-64, 14-68~69, 14-76~77, 14-82, 14-84 |
| SKIP (오탐) | 38 | 14-2~3, 14-5~9, 14-11, 14-13, 14-19~22, 14-25, 14-34~35, 14-37~38, 14-40, 14-42~44, 14-46~48, 14-50~52, 14-56~57, 14-61, 14-71~73, 14-75, 14-79, 14-81, 14-83 |
| SKIP (설계) | 22 | 14-4, 14-14~17, 14-31, 14-36, 14-39, 14-41, 14-49, 14-59~60, 14-62~63, 14-65~67, 14-70, 14-74, 14-78, 14-80, 14-85 |

### Phase 14 오탐(False Positive) 기록

| 이슈 | 판정 이유 |
|------|-----------|
| 14-2 resetState 알림 미발행 | 테스트 전용, 프로덕션 미사용 |
| 14-3 피어 상태 1.5초 지연 | `state:network.connectedPeers` 구독자 없음 |
| 14-5 ICE setTimeout 취소 불가 | conn.open/peers.find 가드 존재 |
| 14-6 동시 initNetwork | PeerJS destroy() → error → promise reject 자동 해소 |
| 14-7 peerLabels mutation | `state:network.peerLabels` 구독자 없음 |
| 14-8 relayAssignments 미정리 | leaveSession이 sessionCode 클리어 → cleanup 트리거 |
| 14-9 다운스트림 메시지 미검증 | 2개 타입만 처리, 나머지 무시는 의도적 |
| 14-11 stale transfer metadata | fresh state 읽기 정상, managed timer 정리됨 |
| 14-13 resyncTimer in state | 브라우저 setTimeout은 number, 직렬화 가능 |
| 14-19 _pendingPlayTime 단일 슬롯 | last-write-wins 의도적 |
| 14-20 clearPreviousTrackState null | initial state `{ name: null }` 안전 |
| 14-21 preload 인덱스 무효화 | playTrack → clearPreloadState 처리 |
| 14-22 YouTube setEngineMode bypass | body.mode-youtube 클래스 적용 필수, 의도적 설계 |
| 14-25 currentSubIndex 미업데이트 | youtube/sync.ts UI loop에서 업데이트 |
| 14-42 setState 참조 동일성 | Phase 2-4, 4-1에서 모든 호출처 spread 전환 완료 |
| 14-43 batchSetState 중복 | 성능 의도적 인라인 |
| 14-44 Object.entries 타입 손실 | TypeScript 컴파일 타임 안전성 + DEV 경고 |
| 14-46 iOS DOM probe | iOS Safari 뷰포트 정확도 필수 |
| 14-47 핸들러 덮어쓰기 | init-time only, 런타임 재등록 없음 |
| 14-48 릴레이 루프 방지 | 단일 홉 설계, 이론적 이슈 |
| 14-50 reverb timeout 누수 | 3초 후 settled promise reject → 무해 |
| 14-51 EQ gain.value 비교 | extra rampTo 무해 (교체/연장만) |
| 14-52 stereoWidth × 0.5 | 의도적 매핑 — Tone.js width 1.0 = full L-R swap |
| 14-56 이중 reload 경로 | _swReloading 플래그 정상 방어 |
| 14-57 stale-while-revalidate 축적 | activate 이벤트에서 old cache 삭제 |

---

### Phase 14 이전 Phase에서 이미 처리된 항목 (제외 목록)

| 이슈 | 처리 Phase |
|------|-----------|
| `masterGain` 부분 초기화 | 11-8 ✅ |
| `_originPeer` 스푸핑 | 12-3 ✅ |
| Reverb `generate()` 레이스 | 9-2 ✅ |
| `ensureSurroundNodes` 에러 클린업 | 12-10 ✅ |
| Reverb 프리셋 damping | 12-6 ✅ |
| `youtube:sub-seek` subIndex 누락 | 2-3 ✅ |
| 플레이리스트 in-place mutation | 2-4 ✅ |
| `_ytLoadInProgress` 리셋 | 2-1, 12-15, 12-16 ✅ |
| `onYouTubeIframeAPIReady` 덮어쓰기 | 2-2 SKIP (의도된 동작) |
| 메시지 타입 allow-list | 4-2 SKIP (relay 비활성) |
| 리스너 정리 함수 | 6-1, 6-2 SKIP (init 1회) |
| 워커 tsconfig | 12-33 ✅ |
| `broadcastFile` 에러 정리 | 12-13 ✅ |
| `snapshot()` structuredClone | Phase 13 오탐 |
| 비디오 전용 재생 경로 | Phase 12 오탐 |

---

### 수정 범위 요약 (최종)

| Phase | 범위 | 항목 수 | 위험도 | 상태 |
|-------|------|---------|--------|------|
| 1-13 | 기존 수정 완료 | 147 | ALL DONE | ✅ |
| 14 | 6-에이전트 정밀 탐색 | 85 | CRITICAL~LOW | ✅ 전수 처리 완료 |
| **합계** | | **232** | | **172 수정 + 60 SKIP** |

**Phase 14 수정 파일 목록 (25건):**
- `src/network/sync.ts` — 14-1 좀비 피어 제거, 14-12 싱크 상태 정리, 14-76 display-update 핸들러 이관
- `src/network/relay.ts` — 14-10 opfsCatchupPumps 세션 정리
- `src/player/playback.ts` — 14-18 이중 state-changed 방지, 14-77 pausedAt 클램핑
- `src/player/media-session.ts` — 14-23 stop isBlocked 가드, 14-24 playbackState 동기화
- `src/player/video.ts` — 14-82 classList.toggle 최적화
- `src/core/timers.ts` — 14-45 setTimeout 자동 정리
- `src/core/log.ts` — 14-64 setLogLevel 런타임 함수 추가
- `src/youtube/player.ts` — 14-53 실패 스크립트 태그 제거, 14-54 stale index 검증, 14-55 deep copy, 14-84 _addYouTubeToPlaylist 헬퍼
- `src/audio/engine.ts` — 14-68 channelIdx 범위 검증
- `src/audio/effects.ts` — 14-69 widener.wet 중복 ramp 가드
- `src/i18n/index.ts` — 14-27 t()/tHtml() I18nKey 타입 전환
- `src/i18n/ko.ts` — 14-26 번역 키 18개 추가
- `src/i18n/en.ts` — 14-26 번역 키 18개 추가
- `src/ui/player-controls.ts` — 14-26 i18n 전환, 14-28 touchstart passive, 14-76 sync:display-update 핸들러
- `src/ui/setup.ts` — 14-33 PEER_NAME_PREFIX import
- `src/ui/chat.ts` — 14-26 i18n, 14-32 regex 모듈 스코프, 14-33 PEER_NAME_PREFIX import
- `src/ui/settings.ts` — 14-26 i18n 전환
- `src/ui/connect.ts` — 14-26 i18n 전환
- `src/ui/playlist-view.ts` — 14-26 i18n 전환
- `src/ui/tabs.ts` — 14-29 WAI-ARIA 키보드 네비게이션
- `src/ui/visualizer.ts` — 14-30 analyser 대기 setTimeout 전환
- `tsconfig.json` — 14-58 vitest/globals 분리
- `tsconfig.test.json` — 14-58 신규 (vitest/globals 전용)
- `vitest.config.ts` — 14-58 tsconfig.test.json 참조
- `src/ui/__tests__/player-controls.test.ts` — 14-26 labelKey 테스트 업데이트
