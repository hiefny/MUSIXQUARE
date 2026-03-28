# fix11 — 구조 변경 후 전체 코드베이스 감사

> **날짜**: 2026-03-13
> **범위**: `src/` 전체 (86개 소스 파일)
> **방법**: 8개 병렬 분석 에이전트 (Audio, Core, Network, Player, Storage, YouTube, UI, Cross-module)
> **목적**: fix10 구조 변경 후 새로운 버그 탐지, 오탐 필터링 포함

---

## 요약 테이블

| 심각도 | 건수 | 설명 |
|--------|------|------|
| CRITICAL | 1 | 리버브 무한 루프 |
| HIGH | 7 | 데이터 핸들러 레이스, retryCount 누적, 직접 mutation 등 |
| MEDIUM | 22 | 엣지케이스 버그, 타이밍 이슈, UX 결함 |
| LOW | 제외 | 코드 품질/이론적 — 별도 목록 |

---

## 1. CRITICAL (1건)

### C-1. `_reverbTotalCycles` 리셋으로 MAX_TOTAL_CYCLES 가드 무효화
- **파일**: `src/audio/effects.ts:161`
- **상세**: `_generateReverbWithRetry()` 진입 시 `_reverbTotalCycles = 0`으로 리셋. 성공 후 pending이 있으면 line 187에서 재귀 호출 → 재귀 진입 시 다시 0으로 리셋. `MAX_TOTAL_CYCLES(6)` 가드가 절대 발동하지 않음.
- **영향**: 슬라이더 드래그 등으로 리버브 파라미터가 빠르게 변경되면 `_reverbGeneratePending`이 계속 true → 무한 재귀적 `generate()` 호출. CPU 폭주, UI 프리징 가능.
- **검증**: 코드 직접 확인 완료. line 161에서 매 진입마다 리셋, line 183의 `++_reverbTotalCycles`는 1이 된 직후 재귀로 다시 0으로 돌아감.

---

## 2. HIGH (7건)

### H-1. Guest `data` 핸들러가 `open` 내부에서 등록 — WELCOME 누락 가능
- **파일**: `src/network/guest.ts:126`
- **상세**: `conn.on('data', ...)` 핸들러가 `conn.on('open', () => { ... })` 콜백 내부에서 등록됨. Host의 `open` 이벤트가 Guest보다 먼저 발생하면 WELCOME 메시지가 `data` 핸들러 등록 전에 도착 → 누락.
- **영향**: `network.myDeviceLabel`이 기본값 'HOST'로 남음. 빠른 LAN 연결에서 발생 확률 높음.
- **참고**: `relay.ts:247`은 올바르게 `open` **이전**에 등록하며, 주석으로 이유를 명시함.

### H-2. `retryCount` 부분 복구 시 미리셋 — 누적으로 복구 영구 중단
- **파일**: `src/storage/recovery.ts:85`
- **상세**: `sendRecoveryRequest` 호출 시 `retryCount`를 즉시 증가. 부분 복구(일부 청크 도착 후 다시 정체) 성공 시 리셋 없음. 전체 완료(receivedCount >= total)에서만 리셋.
- **영향**: 세션 중 3번 부분 복구 후 `MAX_RECOVERY_RETRIES(3)` 도달 → 이후 복구 영구 중단.

### H-3. `preloadedIndexes` Set 직접 mutation (setState 우회)
- **파일**: `src/storage/preload.ts:637-639`
- **상세**: `p.preloadedIndexes.add(Number(data.index))` — getState로 가져온 peer 객체의 Set을 직접 변경. `setState` 미호출 → `state:` 이벤트 미발생.
- **영향**: 상태 구독자가 변경을 감지하지 못함. 프로젝트의 불변 업데이트 규칙 위반.

### H-4. `FILE_END`가 타임아웃된 피어에게도 전송
- **파일**: `src/storage/transfer-send.ts:118-122`
- **상세**: 청크 전송 시 `timedOutPeers` Set으로 제외하지만, `FILE_END` 전송 시에는 체크 없이 모든 `eligiblePeers`에게 발송.
- **영향**: 타임아웃된 피어가 불완전 파일로 finalize 시도 → OPFS 데이터 무결성 손상 가능.

### H-5. `request-*` 메시지 무조건 호스트로 포워딩
- **파일**: `src/network/protocol.ts:162-168`
- **상세**: `msgType.startsWith('request-')`로 모든 request 접두사 메시지를 호스트로 포워딩. `REQUEST_CURRENT_FILE`과 `REQUEST_DATA_RECOVERY`는 릴레이 노드에서 처리해야 하는데 호스트에도 전달.
- **영향**: 호스트가 remote 피어에게 직접 파일 전송 시도 가능 (TURN 비용 정책 위반). `_originPeer` 스푸핑과 결합 시 operator 권한 우회도 가능 (protocol.ts:114).

### H-6. YouTube `loadPlaylist` 후 즉시 `pauseVideo` — 비동기 무시
- **파일**: `src/youtube/iframe.ts:147-163`
- **상세**: 기존 플레이어 재사용 시 `loadPlaylist()` 호출 후 즉시 `pauseVideo()`. YouTube API에서 `loadPlaylist`는 비동기이므로 UNSTARTED 상태의 `pauseVideo()`는 no-op → 자동 재생 발생.
- **영향**: Guest가 `autoplay=false`로 받은 `YOUTUBE_PLAY`에서도 자동 재생되어 호스트와 디싱크.

### H-7. `_playPreloadedInProgress` 플래그 `stopAllMedia`에서 미해제
- **파일**: `src/player/transport.ts` (stopAllMedia) ↔ `src/player/decode.ts`
- **상세**: `stopAllMedia()`가 프리로드 디코딩 중에 호출되면 `_playPreloadedInProgress` 플래그가 true로 남음. 해제는 decode.ts의 성공/에러 경로에서만 수행.
- **영향**: 빠른 트랙 스킵 후 프리로드 로딩이 영구 차단될 수 있음.

---

## 3. MEDIUM (22건)

### 3.1 Audio (5건)

| # | 파일 | 설명 |
|---|------|------|
| M-A1 | `channel.ts:55-56` | `setChannelMode`에서 gain을 `.value =`로 즉시 설정 → 오디오 클릭/팝 발생 (rampTo 미사용) |
| M-A2 | `channel.ts:48` | Sub 모드 전환 시 lowpass가 20kHz로 먼저 열렸다가 subFreq로 재설정 → 20ms 풀레인지 플래시 |
| M-A3 | `effects.ts:172-177` | 리버브 generate() 타임아웃 시 이전 generate가 백그라운드에서 계속 실행 → 메모리 스파이크 |
| M-A4 | `effects.ts:549` | `handleReverbTypeMsg`에서 lowcut/highcut 값 클램핑이 저장 단계가 아닌 applySettings에서만 수행 → 네트워크 메시지로 극단값 주입 가능 |
| M-A5 | `engine.ts:449-485` | `audio:connect-surround` 호출 시 오디오 그래프 초기화 여부 미검증 → 고아 서라운드 노드 생성 가능 |

### 3.2 Core (3건)

| # | 파일 | 설명 |
|---|------|------|
| M-C1 | `state.ts:146` | `getState`가 내부 참조 그대로 반환 (deep clone 아님). `ShallowImmutable` 타입으로 컴파일 시 보호하지만 런타임 보호 없음 |
| M-C2 | `state.ts:184` | 같은 참조로 `setState` 호출 시 `oldValue === value`로 이벤트 스킵 — in-place mutation 후 re-set 시 이벤트 미발생 |
| M-C3 | `platform.ts:100-105` | Android 제스처 내비게이션(0dp) 기기에서 48px 하드코딩 보정이 잘못 적용 → 뷰포트 48px 손실 |

### 3.3 Network (4건)

| # | 파일 | 설명 |
|---|------|------|
| M-N1 | `orchestrator.ts:63` | `setPeerDataTarget`에서 peer 객체 직접 mutation 후 배열만 spread — 객체 참조 동일하여 diff 감지 불가 |
| M-N2 | `guest.ts:130-148` | `close`/`error` 핸들러도 `open` 내부에서 등록 → `open` 전 연결 실패 시 15초 타임아웃까지 에러 리포트 지연 |
| M-N3 | `peer.ts:128` | `setupPeerEvents`가 `open` promise 전에 에러 핸들러 등록 → 재시도 중 UI에 불필요한 에러 토스트 표시 |
| M-N4 | `relay.ts:466-468` | 복구 세션 ID 폴백으로 로컬 세션 사용 → 세션 전환 중 잘못된 파일 데이터 전달 가능 |

### 3.4 Player (5건)

| # | 파일 | 설명 |
|---|------|------|
| M-P1 | `transport.ts:303-305` | `startedAt` 계산에 sync offset 반영 + `getTrackPosition`에서 다시 반영 → 오프셋 이중 적용. 오프셋 변경 시 포지션 부정확 |
| M-P2 | `transport.ts:71-74` | `getTrackPosition()` (getter)에서 5초 초과 drift 시 `setState` 호출 — getter에 side effect |
| M-P3 | `transport.ts:256-257` | 끝 지점 seek 시 `duration - 0.001`에서 시작 → handleEnded의 0.05s 임계값에 즉시 도달 → 트랙 즉시 종료 |
| M-P4 | `playlist.ts:267-268` | Repeat-one 모드에서 `playTrack(currentIndex)` 호출 → 전체 리로드 + 3초 타이머. `play(0)` 재시작이 더 효율적 |
| M-P5 | `decode.ts:107` | `loadedmetadata` 리스너가 `{ once: true }` 없이 등록 → 이벤트 미발생 시 리스너 누수 |

### 3.5 Storage (3건)

| # | 파일 | 설명 |
|---|------|------|
| M-S1 | `transfer-receive.ts:499` | 얼리 청크가 세션 ID 구분 없이 `_pendingEarlyChunks`에 혼합 저장 → FILE_START 리플레이 시 다른 세션 청크 혼입 가능 (워커 세션 검증으로 부분 완화) |
| M-S2 | `transfer-send.ts:124` | abort 시 `activeBroadcastSession` 미해제 + scope 미dispose → 같은 세션 ID의 다음 broadcast 거부 가능 |
| M-S3 | `recovery.ts:80-81` | `currentSid`를 backoff 전에 캡처 → 2-10초 대기 중 새 세션 시작되면 구 세션 ID로 복구 요청 |

### 3.6 YouTube (4건)

| # | 파일 | 설명 |
|---|------|------|
| M-Y1 | `iframe.ts:246-267` | ENDED 시 `appState=IDLE` → `player:state-changed` 발생 → `playlist:next-track` → PLAYING_YOUTUBE. IDLE 플래시 발생 |
| M-Y2 | `player.ts:160-166` | `youtube:toggle-play`에서 즉시 broadcast + onStateChange에서도 broadcast → 이중 YOUTUBE_STATE 메시지 → 게스트 일시 seek 글리치 |
| M-Y3 | `player.ts:205-238` | `youtube:skip-time`, `youtube:seek-to`에서 호스트/게스트 구분 없이 로컬 플레이어 직접 조작 → 게스트 디싱크 |
| M-Y4 | `sync.ts:157-172` | Sub-index 변경 시 guest 플레이리스트 미로딩 상태면 `playVideoAt` 무시되지만 state는 업데이트 → state/실제 불일치 |

### 3.7 UI (3건)

| # | 파일 | 설명 |
|---|------|------|
| M-U1 | `settings.ts:155-173` | `detectReverbPreset()`의 부동소수점 strict equality 비교 → 슬라이더 rounding으로 프리셋 감지 실패 가능 |
| M-U2 | `playlist-view.ts:63` | 플레이리스트 업데이트마다 `innerHTML = ''` 후 전체 재생성 → 스크롤 위치/키보드 포커스 손실 |
| M-U3 | `connect.ts:117` | max guest 슬롯 축소 시 `peers.length`에 disconnected 피어 포함 → 실제보다 높은 카운트로 축소 차단 |

---

## 4. 오탐(False Positive) 필터링 결과

다음 항목들은 에이전트가 보고했으나 분석 후 오탐/의도적 설계/실질 영향 없음으로 제외:

| 원래 심각도 | 항목 | 제외 사유 |
|-------------|------|-----------|
| CRITICAL | StereoWidener width=1 초기값 (engine.ts:230) | `applySettings()`가 `audio:ready`에서 동기적으로 즉시 호출되어 교정. 실질 window 없음 → **LOW** |
| HIGH | 서라운드 채널 스테레오 무음 (engine.ts:127) | 스테레오 소스에서 채널 2-7이 무음인 것은 물리적으로 정상. UX 가이드 이슈 → **LOW** |
| HIGH | 오디오 그래프 teardown 미존재 (engine.ts) | SPA에서 teardown 불필요. iOS도 단일 AudioContext만 사용 → **MEDIUM** (설계 갭) |
| HIGH | 서라운드 모드에서 widener 미disconnect (engine.ts:449) | Widener에 input 없어 silence 통과. 실질 영향 없음 → **LOW** |
| HIGH | loadToken undefined 시 토큰 체크 우회 (decode.ts:67) | myLoadId 2차 가드 존재 (line 80). 현재 모든 caller가 token 전달 → **MEDIUM** |
| HIGH | PLAY_PRELOADED broadcast 후 host decode 실패 (playlist.ts:148) | Guest는 자체 프리로드 버퍼 사용. Host 실패가 Guest에 영향 없음 → **MEDIUM** |
| HIGH | Video sync play → body mode가 즉시 pause (transport+video) | stopAllMedia가 src를 removeAttribute → 이후 play에서 blob: 체크 통과 안 함. 정상 흐름에서 미발생 → **MEDIUM** |
| HIGH | YouTube drift compensation이 영상 끝 초과 seek (sync.ts:176) | Math.max/min 클램프 존재. 극단적 사용자 설정에서만 발생 → **MEDIUM** |
| HIGH | Heartbeat/close 핸들러 레이스 (sync+host) | `conn.close()`는 비동기, heartbeat 루프는 동기 → 실제 이중 실행 불가 → **MEDIUM** |
| MEDIUM | Reverb preset fire-and-forget applySettings | off→studio 전환 시 old IR이 silence(mix=0)이므로 인지 불가 → **LOW** |
| MEDIUM | resetState 이벤트 미발생 (state.ts) | 테스트 전용 함수 → **제외** |
| - | SPA 리스너 미제거 (~40건) | SPA 설계상 의도적. 모듈 로드 시 1회 등록 → **제외** |
| - | HMR 이중 등록 (~10건) | 개발 환경 전용 → **제외** |
| - | Dead exports (~40건) | 코드 정리 이슈. 런타임 영향 없음 → **제외** |

---

## 5. Cross-module 이벤트 버스 일관성

**결과: 양호** ✅

- `bus.emit` 109개 고유 이벤트 ↔ `bus.on` 112개 고유 이벤트 전수 대조
- **Orphaned emit**: 0건
- **Orphaned listener**: 0건 (`state:*` 리스너는 setState 자동 emit)
- **인자 불일치**: 0건 (TypeScript `EventMap` 제네릭이 컴파일 타임 보호)
- **MSG 타입 불일치**: 0건 (모든 MSG에 sender+handler 존재)
- **State 경로 불일치**: 0건 (모든 68개 경로에 reader+writer 존재)
- **유일한 우려**: 프로토콜 Validator가 50개 중 10개만 커버 (방어 심층 이슈)

---

## 6. 우선순위 수정 가이드

### 즉시 수정 권장 (CRITICAL + HIGH 핵심)
1. **C-1**: `_reverbTotalCycles`를 재귀 호출 바깥에서 관리하도록 변경
2. **H-1**: guest.ts에서 `data` 핸들러를 `open` 이전에 등록
3. **H-2**: recovery 성공(부분 포함) 시 `retryCount` 리셋 로직 추가
4. **H-3**: preloadedIndexes 업데이트를 immutable 패턴으로 변경

### 다음 스프린트 권장 (HIGH 나머지 + MEDIUM 핵심)
5. **H-4**: FILE_END 전송 시 `timedOutPeers` 필터링 추가
6. **H-5**: protocol.ts에서 `request-current-file`, `request-data-recovery` 포워딩 제외
7. **H-6**: YouTube loadPlaylist 완료 대기 후 pauseVideo 호출
8. **H-7**: stopAllMedia에서 `_playPreloadedInProgress = false` 처리
9. **M-A1/A2**: channel.ts gain 변경을 rampTo로 교체
10. **M-N1**: orchestrator.ts immutable 업데이트 패턴 적용
11. **M-S1**: 얼리 청크 버퍼에 세션 ID별 분리 저장

---

## 7. 통계

- **총 분석 파일**: 86개 소스 + 33개 테스트
- **총 원시 발견**: ~145건 (8개 에이전트 합산)
- **오탐 필터링**: ~115건 제외 (SPA 설계, 테스트 전용, dead export, 이론적 등)
- **확정 발견**: 30건 (C1 + H7 + M22)
- **이벤트 버스**: 일관성 양호 (TypeScript 타입 시스템 덕분)
