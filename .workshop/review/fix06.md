# Round 4 — Post-fix05 Deep Full-Codebase Analysis

> 분석 일시: 2026-03-13
> 방법: 15개 병렬 에이전트 (audio, state, playback+transport, decode, network+protocol, host+guest, relay+orchestrator, transfer-receive, OPFS+workers, UI, YouTube, core lifecycle, sync, cross-cutting duplicates, app bootstrap) + 전 파일 직접 분석
> fix05까지 수정된 105건 이후 잔여/신규 이슈만 기록

---

## Phase 1: 직접 분석 발견

### preload.ts — unicastPreload 공유 scope로 동시 late-join 취소

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | **Medium** | 251 | `unicastPreload`가 전역 `_preloadScope`를 공유. 두 peer가 동시에 late-join하면 두 번째 호출이 `SessionScope.replace()`로 첫 번째 peer의 scope를 abort → 첫 번째 peer는 PRELOAD_START만 받고 chunks 중단. `unicastFile`(transfer-send.ts:151-154)은 per-peer `_activeUnicasts` Map으로 올바르게 격리하지만, `unicastPreload`는 이 패턴을 따르지 않음 |

### preload.ts — unicastPreload backpressure 무한 루프

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 2 | **Medium** | 280-282 | `unicastPreload`의 backpressure `while` 루프에 timeout 없음. `conn.open`이 true이고 `bufferedAmount`가 256KB 이상으로 유지되면 무한 루프. 코드베이스 내 다른 모든 backpressure 루프는 30초 timeout 보유: `backgroundTransfer`(preload.ts:214), `broadcastFile`(transfer-send.ts:96), `unicastFile`(transfer-send.ts:186) |

---

## Phase 2: 패턴 분석 (cross-cutting)

### 패턴 F: backpressure timeout 일관성

| 파일 | Line | Timeout | 문제 |
|------|------|---------|------|
| transfer-send.ts:96 (broadcastFile) | `Date.now() - backpressureStart > 30_000` | ✅ 30s | - |
| transfer-send.ts:186 (unicastFile) | `Date.now() - startWait > 30000` | ✅ 30s | - |
| preload.ts:204 (backgroundTransfer) | `Date.now() - bpStart > 30_000` | ✅ 30s | - |
| preload.ts:280 (unicastPreload) | **없음** | ❌ 누락 | M2 |

### 패턴 G: per-peer scope 격리

| 파일 | 방식 | 문제 |
|------|------|------|
| transfer-send.ts:151 (unicastFile) | `_activeUnicasts` Map — per-peer scope | ✅ 올바름 |
| preload.ts:251 (unicastPreload) | 전역 `_preloadScope` 공유 | ❌ 동시 호출 간 상호 취소 |

---

## Phase 3: 에이전트 발견

> 15개 병렬 에이전트 + 2개 추가 에이전트 (app.ts bootstrap, storage/transfer*) 탐색 완료.

### app.ts — safeInit 미적용 (bootstrap agent)

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 3 | **Medium** | 270-272 | `initTransfer/initPreload/initRecovery`가 `safeInit()` 미사용 — 하나가 throw하면 나머지 부트스트랩(7-12단계) 전부 중단 |

### transfer-send.ts — unicast backpressure timeout 후 전송 폴스루 (transfer agent)

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 4 | **High** | 187 | `unicastFile` backpressure timeout 시 `break`가 while만 탈출 → `conn.send()` 폴스루. 버퍼 가득 찬 상태에서 전송 시도. `broadcastFile`(line 100)은 올바르게 `return` 사용 |

### preload.ts — unicastPreload backpressure timeout 폴스루 (M2 수정 보완)

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 4b | **Medium** | 287 | M2에서 추가한 timeout의 `break`도 동일한 폴스루 문제. `return`으로 변경 필요 |

### transfer-receive.ts — handleFileEnd sessionId 미검증 (transfer agent)

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 5 | **Medium** | 683-691 | `handleFileEnd`가 `sessionId` 미검증. `handleFileStart/Resume/Chunk`는 모두 stale session 필터링하지만 `handleFileEnd`는 그대로 downstream 릴레이 → stale FILE_END 전파 |

---

## 오탐/의도적 설계 판별

| # | 파일 | 판정 | 사유 |
|---|------|------|------|
| - | preload.ts:805 | 의도적 | `code === ''` vs `!code` 불일치는 sessionCode가 항상 string이므로 실질적 차이 없음 |
| - | preload.ts:457 | 의도적 | session 객체 in-place mutation — UI 업데이트는 직접 bus.emit으로 처리. state 리스너 알림 불필요 |
| - | preload.ts:599 | 의도적 | `preloadedIndexes.add()` in-place mutation — 이 값에 대한 state 리스너 없음 |

---

## 최종 수정 대상

**High (4건) + Medium (6건):**

| # | 파일 | 설명 |
|---|------|------|
| M1 | preload.ts:251 | `unicastPreload`에 per-peer scope 격리 도입 (unicastFile 패턴 적용) |
| M2 | preload.ts:280 | backpressure 루프에 30초 timeout 추가 |
| M3 | app.ts:270-272 | `initTransfer/initPreload/initRecovery`가 `safeInit()` 미사용 |
| H1 | transfer-send.ts:187 | unicastFile backpressure timeout `break` → `return` (폴스루 방지) |
| M4 | preload.ts:287 | unicastPreload backpressure timeout `break` → `return` (M2 보완) |
| M5 | transfer-receive.ts:683 | `handleFileEnd` sessionId 검증 추가 (stale FILE_END 릴레이 방지) |
| H2 | iframe.ts:183-188 | YouTube player `onError` 미등록 → 에러 시 로딩 영구 stuck |
| H3 | iframe.ts:242-253 | ENDED 후 broadcast 블록 실행 → 게스트에 ENDED 전파, next-track과 레이스 |
| H4 | handlers.ts:112-116 | `handleRequestYouTubeSubSeek` sub-index 변경 broadcast 누락 |
| M6 | iframe.ts:146-157 | player reuse 시 `currentSubIndex` state 미갱신 |

---

## 수정 완료

| # | 파일 | 수정 내용 | 검증 |
|---|------|-----------|------|
| M1 | `src/storage/preload.ts` | `unicastPreload`: 전역 `_preloadScope` → per-peer `_activePreloadUnicasts` Map 도입. `unicastFile` 패턴과 동일하게 `SessionScope.replace(prevScope)` + `Map.set()`. try/finally에서 scope cleanup + Map.delete. session leave 시 `_activePreloadUnicasts.forEach(dispose) + clear()` | ✅ tsc --noEmit |
| M2 | `src/storage/preload.ts` | `unicastPreload` backpressure 루프: `const bpStart = Date.now()` + `if (Date.now() - bpStart > 30_000) break` 추가 — 다른 3개 backpressure 루프와 동일 패턴 | ✅ tsc --noEmit |
| M3 | `src/app.ts` | `initTransfer()`, `initPreload()`, `initRecovery()` → `safeInit('Transfer', initTransfer)` 등으로 변경 — 다른 모든 init 호출과 동일 패턴 | ✅ tsc --noEmit |
| H1 | `src/storage/transfer-send.ts` | `unicastFile` backpressure: `break` → `return` + log.warn. `return`은 try 내부에서 finally(scope cleanup)를 정상 통과 | ✅ tsc --noEmit |
| M4 | `src/storage/preload.ts` | `unicastPreload` backpressure: `break` → `return`. M2에서 추가한 timeout이 동일 폴스루 문제 보유 — `return`은 finally 블록의 scope cleanup 정상 통과 | ✅ tsc --noEmit |
| M5 | `src/storage/transfer-receive.ts` | `handleFileEnd`: `incomingSid < localSid` 검증 추가 — `handleFileStart/Resume/Chunk`와 동일 패턴 | ✅ tsc --noEmit |
| H2 | `src/youtube/iframe.ts` | `createYouTubePlayer` events에 `onError: onYouTubePlayerError` 추가. 핸들러: `setYtLoadInProgress(false)` + loader 해제 + toast | ✅ tsc --noEmit |
| H3 | `src/youtube/iframe.ts` | ENDED 블록 끝에 `return` 추가 — broadcast 블록 실행 방지. 게스트는 자체 ENDED 이벤트로 처리 | ✅ tsc --noEmit |
| H4 | `src/youtube/handlers.ts` | `handleRequestYouTubeSubSeek`에 `broadcast({ type: MSG.YOUTUBE_STATE, state: 1, time: 0, subIndex: subIdx })` 추가 — `youtube:sub-seek` 핸들러와 동일 패턴 | ✅ tsc --noEmit |
| M6 | `src/youtube/iframe.ts` | player reuse 경로에 `setState('youtube.currentSubIndex', subIndex)` 추가 | ✅ tsc --noEmit |

**총 수정: 10건 (High 4건, Medium 6건)**
**오탐/의도적 설계 제외: 3건 + transfer 10건 + youtube 8건 + workers 6건 + state 5건 + UI 7건 + error-handling 67건 + chat+misc 10건 + audio/engine 5건 = 121건**
**빌드 검증: `npx tsc --noEmit` — 에러 없음**
**프리뷰 검증: 콘솔 에러 0건, 네트워크 실패 0건**

---

## 누적 통계 (fix01 ~ fix06)

| Round | High | Medium | Low | 합계 |
|-------|------|--------|-----|------|
| fix01-03 | — | — | — | (fix04에 통합) |
| fix04 | 12 | 48 | 41 | 101 |
| fix05 | 0 | 3+1 | 0 | 4 |
| fix06 | 4 | 6 | 0 | 10 |
| **총계** | **16** | **58** | **41** | **115** |

---
