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
| **합계** | | **30** | |
