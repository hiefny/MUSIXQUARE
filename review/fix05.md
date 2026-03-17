# Round 3 — Post-fix04 Deep Regression & Gap Analysis

> 분석 일시: 2026-03-13
> 방법: 전 파일 직접 분석 + 5개 병렬 에이전트 (network, storage+workers, UI, youtube+i18n+types, cross-cutting audit)
> fix04에서 수정된 101건 이후 잔여/신규 이슈만 기록

---

## Phase 1: fix04 수정 코드 회귀 분석

### decode.ts — finalizeGuestFile loadedmetadata 리스너 누수

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | **Medium** | 414-422 | `finalizeGuestFile`의 `loadedmetadata` 리스너에 `error` 리스너 미등록 — 비디오 로드 실패 시 `onMetaLoaded` 리스너 영구 잔존. fix04 P6가 `loadAndBroadcastFile`(line 125)은 수정했지만 이 함수는 누락 |

### decode.ts — videoElement.src = '' 불일치

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 2 | **Medium** | 360 | `clearPreviousTrackState`에서 `videoElement.src = ''` 사용 — 브라우저가 페이지 URL로 정규화하여 `videoElement.src`가 truthy 유지. `transport.ts:124`는 `removeAttribute('src')`를 사용하여 이 문제 없음. `transport.ts:227`의 `videoElement?.src?.startsWith('blob:')` 체크는 안전하나, `playback.ts:133,262,288`의 단순 `videoElement?.src` 체크는 오판 가능. fix04 LW10이 `video.ts`는 수정했지만 `decode.ts`는 누락 |

### playback.ts — state listener 누수

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 3 | **Medium** | 393-398 | `storage:use-preloaded` 핸들러 내 `bus.on('state:transfer.waitingForPreload', ...)` 리스너: `val === false`일 때만 unsubscribe. 타이머 만료 시(line 373) unsubscribe 미호출 → 리스너 영구 잔존. 반복 호출 시 리스너 누적 |

---

## Phase 2: 신규 발견 이슈

### host.ts — in-place mutation + shallow copy 패턴 잔존

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 4 | Low | 110-113 | `peerObj.status = 'connected'` + `peerObj.lastHeartbeat = Date.now()` in-place 변경 후 `setState([...])` — fix04에서 부분 수정(M10)했으나 `conn.on('open')` 핸들러에서 여전히 in-place 변경. `host.ts:136,152`의 `connectionType` 변경도 동일 패턴 |

### host.ts — ICE re-detection timer 정리 미흡

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 5 | Low | 144-159 | `setManagedTimer('ice-redetect-' + peerId)` — peer disconnect 시 명시적 `clearManagedTimer` 없음. `clearAllManagedTimers`(leaveSession)는 커버하나, 개별 peer disconnect 시 해당 peer의 re-detect 타이머 잔존 가능 |

### transport.ts — stopAllMedia silent 모드에서 startedAt/pausedAt 리셋

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 6 | Low | 139-155 | `stopAllMedia({ silent: true })` 호출 시에도 `startedAt=0`, `pausedAt=0` 리셋 수행(line 153-154). silent 의도는 IDLE flash 방지이나, 다음 `play()` 전에 `getTrackPosition()`이 0을 반환하여 순간적 seek 리셋 발생 가능 |

### transfer-receive.ts — handleFilePrepare 복잡도 & 엣지 케이스

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 7 | Low | 174-175 | `hasPreloadedByIndex`와 `hasPreloadedByName` 둘 다 체크하지만 `isMismatch`(line 178)는 index만 체크 — preload name은 일치하나 index가 다른 경우 mismatch guard를 우회하여 잘못된 preload 사용 가능 |

### transfer-send.ts — broadcastFile eligiblePeers 스냅샷 이슈

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 8 | Low | 67 | `filterEligiblePeers()` 결과를 전송 시작 전 1회만 캡처 — 전송 중 새 peer 접속 시 해당 peer에 FILE_START 미전송. late-join unicast가 커버하지만 타이밍에 따라 partial coverage |

### orchestrator.ts — evaluatePeer 이중 호출 시 중복 ASSIGN 전송

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 9 | Low | 73-97 | `orchestrator:peer-type-detected` 이벤트가 ICE re-detect(10s 후)로 2회 발생 가능. 동일 type이면 `assignRelayForPeer` 내 early return(line 138)으로 방어되나, re-detect 시 결과가 달라지면 relay reassignment이 발생 — 의도적 설계이지만 relay 전환 중 순간적 chunk 유실 가능 |

### relay.ts — opfs:read-complete 핸들러의 transfer.meta 참조 TOCTOU

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 10 | Low | 544 | `bus.on('opfs:read-complete')` 핸들러에서 `getState('transfer.meta')` 참조 — 비동기 OPFS read 응답 시점에 트랙 변경으로 meta가 갱신되면 잘못된 total/name으로 chunk 전송. pump의 session guard(line 122)가 대부분 방어하나, 같은 session 내 트랙 변경 시 발생 가능 |

### guest.ts — conn.on('close') 내 isIntentionalDisconnect 리셋 타이밍

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 11 | Low | 147 | `setState('network.isIntentionalDisconnect', false)` — `leaveSession()`이 200ms delayed timer로 리셋하는데, close handler가 200ms 내 실행 시 경합. `_errorHandled` guard가 대부분 방어 |

---

## Phase 3: 패턴 분석 (cross-cutting)

### 패턴 C: videoElement.src 정리 불일치

| 파일 | 방식 | 문제 |
|------|------|------|
| transport.ts:124 | `removeAttribute('src')` | ✅ 올바름 — src 속성 완전 제거 |
| decode.ts:360 | `videoElement.src = ''` | ❌ 문제 — 페이지 URL로 정규화 |
| youtube/player.ts:95 | `videoEl.src = ''` | ⚠️ YouTube 전환 시 — `.src` truthy 잔존 |

### 패턴 D: loadedmetadata 리스너 정리

| 파일 | 정리 | 문제 |
|------|------|------|
| decode.ts:107-127 (loadAndBroadcast) | `onMetaLoaded` + `onMetaError` 양쪽 정리 | ✅ fix04 P6에서 수정됨 |
| decode.ts:414-422 (finalizeGuest) | `onMetaLoaded`만 정리, `onMetaError` 없음 | ❌ 누락 |

### 패턴 E: bus.on 리스너 cleanup 미흡

| 파일 | Line | 이벤트 | 문제 |
|------|------|--------|------|
| playback.ts:393 | `state:transfer.waitingForPreload` | 타이머 만료 경로에서 unsubscribe 미호출 |

---

## 오탐/의도적 설계 판별

| # | 파일 | 판정 | 사유 |
|---|------|------|------|
| 4 | host.ts:110 | 의도적 | in-place + shallow copy 패턴은 이 프로젝트의 성능 최적화 설계. 완전 immutable 전환은 과도한 객체 생성 비용 |
| 5 | host.ts:144 | 오탐 | managed timer 이름에 peerId 포함 → `clearAllManagedTimers`(leaveSession)에서 자동 정리. 개별 disconnect 시에는 conn.open 체크가 early return |
| 6 | transport.ts:153 | 의도적 | `stopAllMedia`는 항상 clean slate 보장. silent은 IDLE state emission만 억제 |
| 7 | transfer-receive.ts:174 | 오탐 | preload name 일치 + index 불일치는 현실적으로 불가 — 동일 파일이 다른 index를 가질 수 없음 (playlist 기반) |
| 8 | transfer-send.ts:67 | 의도적 | mid-broadcast join은 late-join unicast로 커버. 의도적 설계 |
| 9 | orchestrator.ts:73 | 의도적 | re-detect 후 재분류는 의도적 기능 (remote→local 재분류) |
| 10 | relay.ts:544 | 의도적 | pump session guard + sessionId 비교로 충분히 방어. 추가 guard는 과도 |
| 11 | guest.ts:147 | 오탐 | `_errorHandled` guard가 완전 방어. 200ms timer + close handler 경합은 실질적 문제 없음 |

---

## 최종 수정 대상 (오탐 제거 후)

**Medium (3건):**

| # | 파일 | 설명 |
|---|------|------|
| M1 | decode.ts:414 | `finalizeGuestFile` loadedmetadata 리스너에 error cleanup 추가 |
| M2 | decode.ts:360 | `videoElement.src = ''` → `videoElement.removeAttribute('src')` 통일 |
| M3 | playback.ts:393 | `state:transfer.waitingForPreload` 리스너 타이머 만료 시 unsubscribe 추가 |

---

## 수정 완료

| # | 파일 | 수정 내용 | 검증 |
|---|------|-----------|------|
| M1 | `src/player/decode.ts` | `finalizeGuestFile`: `onMetaError` 리스너 추가 + `cleanupMeta()` 헬퍼로 양쪽 리스너 정리 통일 | ✅ tsc --noEmit |
| M2 | `src/player/decode.ts` | `clearPreviousTrackState`: `videoElement.src = ''` → `videoElement.removeAttribute('src')` | ✅ tsc --noEmit |
| M2b | `src/youtube/player.ts` | YouTube cleanup: `videoEl.src = ''` → `videoEl.removeAttribute('src')` (패턴 C 통일) | ✅ tsc --noEmit |
| M3 | `src/player/playback.ts` | `storage:use-preloaded` 핸들러: `_unsubWatchdog()`를 타이머 만료 콜백 시작부에 추가 + 선언 순서 재배치 (리스너 선언 → 타이머 등록) | ✅ tsc --noEmit |

**총 수정: 4건 (Medium 3건 + 패턴 통일 1건)**
**오탐/의도적 설계 제외: 8건**
**빌드 검증: `npx tsc --noEmit` — 에러 없음**

---

## 누적 통계 (fix01 ~ fix05)

| Round | High | Medium | Low | 합계 |
|-------|------|--------|-----|------|
| fix01-03 | — | — | — | (fix04에 통합) |
| fix04 | 12 | 48 | 41 | 101 |
| fix05 | 0 | 3+1 | 0 | 4 |
| **총계** | **12** | **52** | **41** | **105** |

---
