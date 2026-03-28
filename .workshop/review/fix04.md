# Round 2 — 파일별 전격 분석

> 분석 일시: 2026-03-11
> 방법: 디렉토리별 병렬 Opus 에이전트 — 파일 1개당 에이전트 1개
> 이전 라운드(fix02.md)에서 수정된 항목은 제외, 신규/잔존 이슈만 기록

---

## Phase 1: src/app.ts

### app.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 79, 86 | `safeInit`이 i18n 초기화 실패를 삼키면 `t('error.xxx')`가 raw key 반환 — 번역 실패 무표시 |
| 2 | Low | 254 | `transferWorkerReady`가 `let`이지만 1회만 할당 |
| 3 | Info | 304 | `import.meta.env?.DEV` — Vite에서 `env`는 항상 정의됨, `?.`는 불필요하지만 무해 |

---

## Phase 2: src/core/

### blob-manager.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 117-126 | Queue overflow 가드: 모든 pending URL이 attached면 eviction 실패 → map 크기 `MAX_PENDING+1` 초과 가능 |
| 2 | Info | 143-157 | `flushDeferred`의 `safeRevoke(force:true)`가 `delayMs: 0`을 넘기지 않아 즉시 revoke가 아닌 10초 지연 |

### events.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 40-46 | `once()` wrapper 때문에 `bus.off(event, originalFn)` 호출 시 제거 실패 — wrapper만 등록됨 |
| 2 | Low | 13 | `EventKey`에 `(string & {})` escape-hatch → 오타 이벤트명 컴파일 통과. `state:*` 지원용이나 타입 안전 약화 |

### platform.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 129-138 | iOS viewport probe div가 `document.body` 없을 때 throw → `_iosViewportProbe = null` 영구화, resize마다 재시도+실패 반복 |
| 2 | Low | 100-105 | Android 10+ gesture nav에서 48dp navbar fallback이 정상 viewport에서도 감산 가능 |
| 3 | Low | 225-229 | `initPlatform` 내 DOMContentLoaded 가드가 `bootstrap()`의 가드와 중복 — dead logic |

### session.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 17, 20-23 | 두 브라우저 탭 동시 오픈 시 `Date.now()/1000` + random(0-99999) 조합으로 session ID 충돌 가능 |
| 2 | Low | 44-48 | `_warnedBadSessionIds` 200개 초과 시 전체 clear → 이전 경고 ID 재로깅 |

### state.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | **High** | 373-413 | `batchSetState` emit 단계에서 re-entrant `setState`/`batchSetState` 호출 시 `_batchedPaths = []` 덮어쓰기 → 미발행 경로 유실 |
| 2 | Medium | 345-354 | `setState`가 존재하지 않는 경로에 중간 객체 자동 생성 — 오타 경로 시 production에서 무소음 state 오염 |
| 3 | Medium | 358-359 | 참조 동등성(`===`) 비교 — 배열/객체 in-place 변경 시 이벤트 미발행 |
| 4 | Medium | 420-432 | `snapshot()`의 `structuredClone` 경로가 DataConnection 때문에 항상 throw → JSON fallback만 동작 (dead code) |
| 5 | Low | 81 | `sync.resyncTimer` 타이머 핸들을 state tree에 저장 — 직렬화/클론 방해, 모듈 변수로 이동 권장 |

### timers.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Low | 21-27 | setTimeout 기반 타이머: `fn()` throw 시 타이머 이미 삭제됨 → 재스케줄 불가 |

### constants.ts, log.ts

이슈 없음.

---

## Phase 3: src/audio/

### channel.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 57-58 | Sub mode 전환 시 `gL.gain.value = 1` 하드셋 후 즉시 0.5로 덮어쓰기 → 순간 +6dB spike |
| 2 | Low | 60-65 | Stereo 모드에서 `rampTo(1)` 호출이 이미 1로 하드셋된 값에 대한 no-op |
| 3 | Low | 180-186 | "Dual Mono" 코멘트 실제로 stereo 라우팅 — 소스가 이미 mono이므로 결과는 맞지만 코멘트 오해 소지 |
| 4 | Medium | 102-119 | `toggleSurroundMode(false)` 시 playerNode→surroundSplitter 연결 미해제 → 8채널 분할 CPU 낭비 |
| 5 | Medium | 159-166 | surround ch6/ch7 fallback이 rear+side 합산 → 7.1 소스에서 잘못된 오디오 |
| 6 | Info | 193 | `names[idx]` 바운드 체크 없음 — idx ≥ 8이면 undefined 로깅 |

### effects.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | **High** | 586-593 | `handleStereoWidthMsg`에서 `v > 100`이면 surround UI ON 토글 — stereo width와 surround 모드가 혼동됨. 호스트가 width=120 브로드캐스트 시 모든 게스트에서 surround 표시기 오작동 |
| 2 | Medium | 160-162 | `Promise.race` timeout timer 미정리 — reverb 생성 성공 시에도 3초 후 unhandledrejection 발생 |
| 3 | Medium | 368-373 | `cutoff` effect 타입이 `updateSubFreq(value)` 호출하지만 피어 브로드캐스트 로직 없음 |
| 4 | Medium | 346-358 | Non-OP 게스트 stereo width 변경이 로컬 적용 후 네트워크 전송 무소음 스킵 — UI 피드백 없이 diverge |
| 5 | **High** | 144-181 | `_reverbGenerateInFlight` 재시도 전부 실패 시 `_reverbGeneratePending` 무소음 drop — pending 재생성 요청 영구 유실. 또한 재귀 호출(169) 시 `_reverbGenerateInFlight=false` → 동시 3번째 호출이 in-flight guard 우회 가능 |
| 6 | Low | 98-101 | EQ `rampTo` 비교가 mid-ramp 중간값과 비교 → 불필요 중복 ramp 스케줄 |
| 6 | Low | 524 | `handleReverbTypeMsg`에서 `!data.value` 체크가 `''`/`0` 거부 — fragile |

### engine.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | **High** | 195, 337-360 | `masterGain` 할당이 try/catch 외부 — reverb.generate() 동기 throw 시 `masterGain` non-null + 불완전 그래프로 fast-path 진입 위험 |
| 2 | Medium | 437, 440 | `audio:connect-surround`에서 playerNode→splitter 연결이 splitter disconnect보다 선행 → 순간 잘못된 채널 라우팅 glitch |
| 3 | Medium | 382-390 | AudioContext `statechange` 리스너가 re-init 시 누적 — 미제거 |
| 4 | Low | 100-106 | `ensureSurroundNodes` 노드 생성 후 미연결 — dangling 상태 |
| 5 | Low | 204 | `StereoWidener(1)` 초기화 후 applySettings에서 0.5로 ramp — 재생 전이므로 무해 |

---

## Phase 4: src/network/

### orchestrator.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 37 | HMR 시 `relayAssignments` Map 미정리 — dev 전용 이슈 |
| 2 | Low | 63 | `setPeerDataTarget` peer 객체 in-place 변경 후 배열 shallow copy → state 반응성 우회 |
| 3 | Low | 108-112 | relay 후보 선정에서 conn.open 체크~safeSend 사이 TOCTOU |

### peer.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | **High** | 325 | `peerLabels[peerId] = deviceName` — setState 없이 직접 변경 → `state:network.peerLabels` 이벤트 미발행 |
| 2 | Medium | 347 | `peerObj.status = 'connected'` in-place 변경 후 broadcastDeviceList까지 state 미갱신 |
| 3 | Medium | 506-508 | `joinSession` retry가 raw setTimeout — leaveSession 시 clearAllManagedTimers로 취소 불가 |
| 4 | Medium | 535-540 | 15초 host-unreachable timeout이 raw setTimeout — leaveSession과 race |
| 5 | Medium | 753 | `isDataOnly` 필터에서 `isDataTarget === undefined`인 피어도 통과 — `=== true` 체크 권장 |
| 6 | Low | 87-88 | `peerSlotByPeerId` Map in-place 변경, setState 미호출 |
| 7 | Low | 277 | 중복 연결: 새 conn 저장 후 이전 conn 닫기 — close 이벤트 타이밍 의존 |
| 8 | Low | 681-729 | `leaveSession`에서 `network.appRole` 미리셋 |

### protocol.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 104-114 | `_originPeer` 스푸핑 검증이 "connected peer 여부"만 확인 — 실제 릴레이 노드인지 미확인 |
| 2 | Low | 134 | `RELAYABLE_COMMANDS`가 Array.includes() — Set으로 O(1) 가능 |
| 5 | Medium | 39-51 | `YOUTUBE_PLAYLIST_INFO`가 `RELAYABLE_COMMANDS` 누락 → relay 게스트가 YouTube 재생목록 sub-item 데이터 수신 불가 |
| 3 | Low | 145-151 | `request-*` startsWith만 체크 — 임의 request 메시지 호스트로 전달 |
| 4 | Low | 137 | `conn?.peer`에서 conn undefined 시 echo 방지 실패 가능 |

### relay.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | **High** | 461 | Recovery handler가 단일 chunk만 전송, 후속 pump 없음 — multi-chunk recovery 불가 |
| 2 | Medium | 393-452 | `relay:serve-current-file`에서 preload 매치 조건이 `nextMeta.index === currentTrackIndex` — nextTrackIndex와 비교해야 할 가능성 |
| 3 | Medium | 300-346 | downstream peer 수 제한 없음 — 악의적 피어가 다수 relay 연결 시 리소스 고갈 |
| 4 | Low | 125-128 | session guard `<` 비교가 ID wrap-around 시 stale pump 미감지 (현실적으로 발생 불가) |
| 5 | Low | 434-437 | `(meta.index as number) || 0`에서 index=undefined 시 무조건 0 |
| 6 | Info | 534-536 | `opfs:read-complete`에서 `transfer.meta` 참조가 concurrent 수신 파일과 mismatch 가능 (TOCTOU) |

### sync.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 179-191 | `requestGlobalResyncDelayed`가 raw setTimeout + state에 timer 저장 — leaveSession 시 미취소 |
| 2 | Medium | 205-209 | `handleAutoSync`에서 offset 이중 리셋 (handleMainSyncBtn도 리셋) — 낭비 |
| 3 | Low | 72-73 | `_syncSampleTimer`/`_syncTimeoutTimer`가 raw setTimeout — clearAllManagedTimers 미대상 |
| 4 | Low | 293-308 | `sync:get-position` 리스너 미등록 시 콜백 미호출, timeout fallback만 의존 |
| 5 | Low | 396-427 | heartbeat monitor에서 `p.status = 'disconnected'` in-place 변경 → setState 전 stale 상태 노출 |

---

## Phase 5: src/player/

### media-session.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 128-133 | `PLAYING_YOUTUBE` → `'playing'`이지만 YouTube iframe이 실제로 buffering/paused일 수 있음 |
| 2 | Low | 69-83 | IDLE에서 system play 버튼 → YouTube 트랙이면 3초 autoplay delay — UX 불일치 |

### playback.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 663-672 | `loadedmetadata` 리스너가 이벤트 미발생 시(파일 오류 등) 미제거 → blob URL 누수 |
| 2 | Medium | 201-207 | lockWatchdog 5초 timeout이 `_pendingPlayTime`/`_pendingPlayDepth` 미리셋 → 강제 해제 후 stale 큐 실행 |
| 3 | Medium | 216-228 | `_pendingPlayDepth` depth=2 제한 + 10ms setTimeout → 20ms 내 3회 이상 play 요청 무소음 drop |
| 4 | Medium | 278-280 | `safeOffset === duration` → 1ms 전으로 보정 → 즉시 ended 트리거 |
| 5 | Medium | 598 | `_skipTabSync` 파라미터 선언 후 미사용 — dead parameter |
| 6 | Medium | 747 | `t('error.audio_decoding')` 키가 정상 로딩 상태 토스트에 사용 — error.* 네임스페이스 오용 |
| 7 | Low | 312-316 | video muted+volume=0 이중 설정 — 불필요 중복 |
| 8 | Low | 853 | `data.index`에 Number() coercion 미적용 (data.time은 적용) |
| 9 | Low | 1062-1063 | `preload.ackSent` Set `.clear()` in-place — setState 경유 않음 |

### playlist.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 130 | `stopAllMedia()` → IDLE → `play()` → PLAYING 순 → UI에 순간 IDLE 깜빡임 |
| 2 | Medium | 692-699 | `player:ended`의 300/500ms setTimeout 중 사용자 수동 skip 시 double-skip 가능 (loadToken 부분 방어) |
| 3 | Medium | 281-283 | `playNextTrack` shuffle에서 `currentTrackIndex === -1` 시 무조건 즉시 탈출 — 의도와 다를 수 있음 |
| 4 | Low | 329-331 | YouTube 모드 prevTrack index=0에서 재로드 → 3초 autoplay delay (즉시 재시작 기대) |
| 5 | Low | 362-363 | `Number(data.value) || 0`으로 repeatMode 수신 — -1 등 무효값 미클램프 |

### video.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 78-83 | `setEngineMode('youtube')` 시 IDLE에서도 PLAYING_YOUTUBE 전환 — YouTube 미로드 시 빈 컨테이너 flash |
| 2 | Low | 149-156 | video→audio 전환 시 `visibility`/`pointerEvents` 인라인 스타일 잔존 |
| 3 | Low | 111-113 | `videoElement.src = ''` 후 브라우저가 page URL로 정규화 → `!!videoElement.src` 체크 오판 가능 |

---

## Phase 6: src/storage/

### opfs.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 103-106 | `cleanupOPFSInWorker` 리스너가 filename만 매칭 — 동명 파일 동시 cleanup 시 리스너 혼선 |
| 2 | Low | 24 | `OPFS_INSTANCE_ID`가 `INSTANCE_ID`의 무의미한 alias |
| 3 | Low | 254-262 | `ensureNamedFile`이 catch에서 raw Blob 반환 → File.name 미보유 |
| 4 | Info | 167 | `opfs:write-error` 이벤트가 EventMap 미등록 — 타입 안전 미적용 |

### preload.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 41-46 | state Map 직접 `.delete()` 변경 — setState 미경유, 반응성 우회 (293, 327, 731번 라인도 동일) |
| 2 | Medium | 181-196 | `unicastPreload` 내 per-peer backpressure polling에 timeout 없음 — 무한 루프 가능 |
| 7 | Medium | 350-358 | `handlePreloadStart`에서 OPFS_RESET→OPFS_START 전송 직후 `drainPreloadReorderBuffer` → worker가 START 처리 전에 WRITE 도착 시 lock 없어서 chunk 무소음 drop |
| 3 | Medium | 400-401 | `chunkClone.buffer` 전달 — 향후 transferable 추가 시 detach 위험 (현재는 안전) |
| 4 | Low | 635-647 | `handlePlayPreloaded` retry가 raw setTimeout — 세션 종료 시 미취소 |
| 5 | Low | 660-696 | jitter delay도 raw setTimeout — 동일 문제 |
| 6 | Info | 734 | `setState('preload.meta', session)` — PreloadSessionEntry가 FileMeta 타입에 extra 필드 오염 |

### recovery.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 82 | `pendingFileIndex` fallback이 `currentTrackIndex` — 빠른 트랙 변경 시 TOCTOU로 잘못된 파일 요청 |
| 2 | Medium | 98-131 | Recovery backoff timer가 raw setTimeout — 세션 종료 시 stale 요청 가능 |
| 3 | Low | 193 | `startChunk` out-of-range → `total-1` 클램프 → 마지막 chunk만 재전송 (전체 재전송이 적절) |
| 4 | Low | 161-162 | `ensureNamedFile` Blob 반환 시 원본 파일명 유실 |

### transfer.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | **High** | 504-508 | `_pendingEarlyChunks`가 세션 미구분 — 빠른 트랙 변경 시 이전 세션 chunk가 새 세션에 replay → 파일 손상 |
| 2 | **High** | 437-438 | `handleFileResume`에서 `_pendingEarlyChunks.length = 0` 직후 drain 시도 → drain이 dead code, early chunk 유실 |
| 3 | Medium | 540 | reorder buffer overflow 시 `nextExpectedChunk = data.index` 설정 → `receivedCount`와 불일치 → 중복/누락 OPFS write |
| 4 | Medium | 594-595 | `chunk.buffer`가 subarray view면 전체 ArrayBuffer 전달 — 현재 안전하나 fragile |
| 5 | Medium | 877 | `unicastFile` abort 조건이 `currentSessionId !== effectiveSessionId` — concurrent broadcast가 recovery unicast 강제 중단 |
| 6 | Medium | 745-826 | `broadcastFile` 새 세션 호출 시 이전 broadcast 미취소 → 첫 broadcast partial chunk + 두 번째 broadcast header 순서 혼합, 게스트 reorder buffer에 orphan chunk 누적 |
| 7 | Medium | 514-522 | `handleFileChunk`에서 mid-transfer `incomingSid > localSid` 감지 시 OPFS_RESET만 수행, OPFS_START 미전송 → chunk에 `total` 메타 없으면 worker가 이후 write 무시, 12-60초 recovery 지연 |
| 6 | Low | 134-135 | `data.index as number ?? 0` 연산자 우선순위 — 괄호 명시 권장 |
| 7 | Low | 380-383 | `data.name as string`이 undefined면 state 타입 불일치 (`string | null` ≠ `undefined`) |

---

## Phase 7: src/ui/

### chat.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 62-67, 86-87 | `_ytRegex` global 플래그 `lastIndex` 미리셋 — 메시지 내 두 번째 YouTube URL 매칭 실패 |
| 2 | Low | 330 | relay 토폴로지에서 `conn.peer`가 원본 sender가 아닌 relay peer → broadcast-except 잘못된 peer 제외 |
| 3 | Info | 21 | MAX_CHAT_MESSAGES=200 DOM 노드 — 모바일 성능 우려 |

### connect.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 42-43 | i18n 문자열을 `innerHTML`로 삽입 — escapeHtml 미적용 (46, 87도 동일) |
| 2 | Low | 321 | MutationObserver 미해제 — initConnect() 재호출 시 중복 observer |
| 3 | Low | 136 | stepper에 click 리스너 2개 — 하나로 통합 가능 |

### dialog.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 135-138 | overlay 더블클릭 시 `done()` 이중 호출 가드 없음 → 다음 큐 dialog promise 미resolve 가능 |
| 2 | Low | 151 | global keydown 리스너가 다른 Escape 핸들러와 충돌 가능 |
| 3 | Info | 104-105 | dialog message가 textContent → `\n` 줄바꿈 미렌더링 |

### dom.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Low | 77-94 | `applyMarquee`의 rAF 내 scrollWidth 읽기 → forced reflow (성능) |
| 2 | Low | 72-73 | overflow 없을 때 `style.animation = 'none'` 영구 잔존 |

### player-controls.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 393-398 | **PAUSED 상태 seek가 피어에 미브로드캐스트** — host가 pause 중 seek하면 guest와 desync |
| 2 | Medium | 642-669 | `ui:loop-start` 재발행 시 이전 interval 정리는 되지만 callback 1회 추가 실행 가능 |
| 3 | Low | 541-544 | `network:peer-disconnected`에서 `updateInviteCodeUI` 호출 — session code 미변경이므로 불필요 |

### playlist-view.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 183-203 | 매 re-render마다 title marquee 초기화 → 스크롤 중 깜빡임 |
| 2 | Medium | 184-200 | `currentTrackIndex` out-of-bounds 시 `currentItem` undefined → line 200에서 `currentItem.type` crash |
| 3 | Low | 22-34 | `toggleExpansion`에서 setState + 직접 updatePlaylistUI → bus 핸들러와 이중 렌더 |

### settings.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 446-458 | EQ "off" 클릭 시 `syncEqSlidersToPreset('off')` + `resetEQ()` 이중 리셋 — 낭비 DOM write |
| 2 | Low | 287-293 | surround ON 더블클릭 시 distortion toast 중복 표시 |
| 3 | Low | 298 | `setBatterySaver`에서 `localStorage.setItem` try-catch 미적용 — Safari private 등에서 throw 시 `visualizer:battery-saver` 이벤트 미발행 |
| 4 | Info | 162-221 | Reverb preset 전환 시 lowcut/highcut 슬라이더 UI만 리셋, audio 엔진은 이전값 유지 — UI/audio 불일치 |
| 4 | Info | 408-410 | cutoff 슬라이더 dblclick에 `_guardHostCtrl()` 미적용 |

### setup.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 593-595 | `.onclick =` 패턴이 AbortController signal과 불일치 — initSetupOverlay 재호출 시 불안정 |
| 2 | Medium | 843-846 | auto-join 시 `initSetupOverlay()` 스킵 → stale `_currentObSlide` 등 잔존 |
| 3 | Low | 247 | `btn.html` → `innerHTML` 경로 — 현재 SVG 상수만 사용하나 향후 XSS surface |
| 4 | Low | 760-761 | `showDialog().then()` — `.catch()` 미연결 |

### tabs.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Info | 44-51 | play 탭 전환 시 50ms magic number — View Transition과 타이밍 race 가능 |

### toast.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Low | 30 | `progressBg.style.width === '0px'` — inline style 직렬화에 의존하는 fragile 비교 |

### visualizer.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 321-331 | battery saver ON 시 `_retryTimer` 미클리어 → retry 콜백 1회 낭비 실행 |
| 2 | Medium | 227 | `drawIdleVisualizer`에서 wrapper clientWidth=0 미가드 → 0×0 canvas 생성 |
| 3 | Low | 86-96 | analyser 참조가 startVisualizer 호출 시 캡처 — mid-playback analyser 교체 시 stale |

---

## Phase 8: src/youtube/

### player.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 579-584 | Guest OP가 로컬 `_youtubePlayer` 상태로 play/pause 결정 — host 상태와 불일치 가능 |
| 5 | Medium | 576-604 | Non-OP 게스트가 `youtube:toggle-play` 시 Host-direct 코드 경로로 fall-through → 로컬만 제어 + 무의미 broadcast |
| 2 | Medium | 107-116 | `onYouTubeIframeAPIReady` 콜백이 `loadYouTubeVideo` 재호출 시 덮어쓰기 — 첫 호출 videoId 유실 |
| 3 | Low | 829-847 | `youtube:sub-seek`에서 다른 playlist item 시 subIdx 미전달 → 항상 subIndex=0 |
| 4 | Low | 252-262 | ENDED에서 `youtubeSyncLoop` timer 미클리어 — IDLE 상태에서 계속 tick |

### search.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 269-272 | `getState('youtube.subItemsMap')` 반환값 직접 변경 → setState shallow copy로 inner 참조 유지 |
| 2 | Low | 228-233 | `_isFetching.clear()`가 전체 맵 삭제 — 타겟 키만 삭제 권장 |

### sync.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 50-53, 249-252 | `subItemsMap` state 직접 변경 — search.ts와 동일 패턴. `ids` 배열도 YouTube 플레이어 참조 공유 |
| 2 | Low | 175-180 | `duration ≤ 0` early return이 state sync (play/pause)도 함께 스킵 — duration 미로드 시 host pause 무시 |

---

## Phase 9: src/i18n/

### en.ts, ko.ts

이슈 없음.

### index.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Low | 87, 91 | `data-i18n` + `data-i18n-html` 둘 다 있으면 textContent 쓰기 후 innerHTML로 덮어쓰기 — 낭비 |

---

## Phase 10: src/types/

### index.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Low | 141 | `file-chunk.chunk` 타입이 `Uint8Array`이나 PeerJS 런타임은 `ArrayBuffer` 전달 — 타입 불일치 |

---

## Phase 11: src/workers/

### sync.worker.ts

이슈 없음.

### transfer.worker.ts

| # | Severity | Line(s) | Description |
|---|----------|---------|-------------|
| 1 | Medium | 62-87 | `processQueue` 재귀 호출 — 메시지 폭주 시 call stack 무한 성장. `setTimeout(processQueue, 0)` 권장 |
| 4 | Medium | 312, 318, 337 | `OPFS_WRITE_ERROR` 메시지에서 `chunk: index`로 전송하나 handler(opfs.ts:164)는 `data.index` 읽음 → 항상 undefined, 진단 로그 및 recovery에 chunk 번호 유실 |
| 2 | Low | 186-188 | `opfsObj.sessionId!` non-null assertion — concurrent releaseLock 시 null 가능 |
| 3 | Low | 323-325 | chunk offset이 고정 chunkSize 가정 — 마지막 chunk 크기 차이 (현재 동작은 정상) |

---

## 통계 요약

| Severity | 수량 |
|----------|------|
| **High** | 9 |
| **Medium** | 56 |
| **Low** | 48 |
| **Info** | 15 |
| **합계** | **128** |

---

## 중복/오탐 정리

### Round 1에서 이미 수정된 항목 (에이전트가 재보고한 경우)

없음 — 에이전트에 Round 1 수정 목록 전달하여 중복 방지 완료.

### 크로스 에이전트 중복

| 패턴 | 관련 파일 | 통합 |
|------|----------|------|
| state 객체 in-place 변경 (setState 미경유) | peer.ts #1/#2, sync.ts #5, preload.ts #1, search.ts #1, youtube/sync.ts #1, playback.ts #9, orchestrator.ts #2 | **패턴 A**: 7건 → 1건 (전체적 리팩터링 대상) |
| raw setTimeout (setManagedTimer 미사용) | peer.ts #3/#4, sync.ts #1/#3, preload.ts #4/#5, recovery.ts #2 | **패턴 B**: 7건 → 1건 (전체적 리팩터링 대상) |
| subItemsMap 직접 변경 | search.ts #1, youtube/sync.ts #1 | 중복 — 1건으로 통합 |

### 오탐/의도적 설계

| # | 파일 | 사유 |
|---|------|------|
| state.ts #3 | 참조 동등성 비교 | 의도적 설계 — immutable update 패턴 강제. 변경 불필요 |
| state.ts #4 | structuredClone dead code | DataConnection 저장이 설계 결정, snapshot 사용처 미존재 시 제거 가능 |
| session.ts #1 | 탭 간 session ID 충돌 | 같은 디바이스 멀티탭 사용은 비지원 시나리오 — 수정 불필요 |
| platform.ts #2 | Android gesture nav | 기기별 heuristic, 완벽 해결 불가 — 현행 유지 |
| playback.ts #4 | offset===duration 보정 | 방어적 설계 — 의도적 |
| playback.ts #6 | error.* i18n 키 오용 | 키 이름만의 문제, 기능에 영향 없음 — 우선순위 낮음 |
| playlist.ts #5 | `Number(0) || 0` | `0`은 유효값이며 결과 동일 — false positive |
| sync.ts #2 | 이중 offset 리셋 | 중복이지만 무해 — cosmetic |

### 최종 수정 대상 (중복/오탐 제거 후)

**High (9건) — 즉시 수정 권장:**

| # | 파일 | 설명 |
|---|------|------|
| H1 | state.ts:373 | batchSetState re-entrant 호출 시 _batchedPaths 유실 |
| H2 | effects.ts:586 | stereo width > 100이 surround UI 토글 — 기능 혼동 |
| H3 | engine.ts:195 | masterGain 할당이 try/catch 외부 — partial init fast-path |
| H4 | peer.ts:325 | peerLabels 직접 변경 → state event 미발행 |
| H5 | relay.ts:461 | recovery handler가 single chunk만 — multi-chunk 불가 |
| H6 | transfer.ts:504 | _pendingEarlyChunks 세션 미구분 → 파일 손상 |
| H7 | transfer.ts:437 | handleFileResume 내 drain이 dead code → early chunk 유실 |
| H8 | player-controls.ts:393 | PAUSED seek 미브로드캐스트 → 피어 desync |
| H9 | effects.ts:144 | reverb regeneration 재시도 실패 시 pending 요청 영구 유실 + in-flight guard 우회 race |

---

## High 수정 완료 (9/9)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| H1 | state.ts:405 | `_batchedPaths`를 로컬 변수에 스냅샷 후 emit — re-entrant 덮어쓰기 방지 |
| H2 | effects.ts:590 | `ui:sync-surround` 제거 — stereo width와 surround 모드 분리 |
| H3 | engine.ts:140 | `initAudio()` catch 블록에 `masterGain = null` 추가 — 불완전 그래프 fast-path 방지 |
| H4 | peer.ts:324 | `peerLabels` immutable update (`{ ...old, [peerId]: name }`) + setState 경유 |
| H5 | relay.ts:456 | 단일 OPFS_READ → `startOpfsCatchupStream` 전환 — multi-chunk recovery 지원 |
| H6 | transfer.ts:357 | handleFileStart 신규 세션 시 `_pendingEarlyChunks.length = 0` 추가 |
| H7 | transfer.ts:430 | handleFileResume: blanket clear 제거, 신규 세션 분기에만 clear → drain 정상 동작 |
| H8 | player-controls.ts:705 | PAUSED seek 시 `broadcast({ type: MSG.PAUSE, time, index })` 추가 |
| H9 | effects.ts:144 | timeout timer clearTimeout 추가 + 전체 실패 후 pending 재시도 로직 추가 |

> `npx tsc --noEmit` — 빌드 통과 확인 완료

## Medium 수정 완료 (15건)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| M1 | playlist-view.ts:184 | `currentTrackIndex < playlist.length` 바운드 체크 추가 → crash 방지 |
| M2 | protocol.ts:47 | `YOUTUBE_PLAYLIST_INFO` RELAYABLE_COMMANDS 추가 → relay 게스트 수신 |
| M3 | dialog.ts:135 | `!_dialogActive` 가드 추가 → overlay 더블클릭 시 이중 done() 방지 |
| M4 | transfer.ts:543 | reorder buffer overflow 시 `receivedCount` 동기화 추가 |
| M5 | transfer.ts:517 | mid-transfer 세션 변경 시 OPFS_START 전송 → worker write 거부 방지 |
| M6 | youtube/player.ts:591 | Non-OP 게스트 `hostConn` 체크로 host-direct 코드 fall-through 차단 |
| M7 | youtube/search.ts:269 | `subItemsMap` immutable update (spread + 새 titles 배열) |
| M8 | youtube/sync.ts:52 | `subItemsMap` immutable update (spread + ids 복사) |
| M9 | youtube/sync.ts:252 | `handleSubTitleUpdate`에서도 동일 immutable update 적용 |
| M10 | peer.ts:347 | `peerObj.status` 변경 후 `setState` shallow copy로 이벤트 발행 |
| M11 | transfer.worker.ts:312 | `OPFS_WRITE_ERROR` 필드명 `chunk` → `index` (3곳) |
| M12 | transfer.worker.ts:318 | 동일 |
| M13 | transfer.worker.ts:337 | 동일 |
| M14 | transfer.worker.ts:85 | `processQueue` 재귀 → `setTimeout` 전환 (stack overflow 방지) |
| M15 | peer.ts:324 | (H4에서 수정) peerLabels immutable update |

> `npx tsc --noEmit` — 빌드 통과 확인 완료

## 추가 수정 (Late Agent 발견)

| # | Severity | 파일 | 수정 내용 |
|---|----------|------|-----------|
| L1 | High | peer.ts:1002 | operator grant/revoke `conn.send()` try/catch 추가 → `broadcastDeviceList()` 누락 방지 |
| L2 | Medium | peer.ts:683 | `leaveSession` batchSetState에 `'network.appRole': 'idle'` 추가 → 퇴장 후 역할 미초기화 방지 |
| L3 | High | setup.ts:126 | `hideSetupOverlay()`에서 `_setupOverlayAbort.abort()` 호출 추가 → 스와이프 리스너 누수 방지 |
| L4 | High | visualizer.ts:227 | `drawIdleVisualizer` canvas width 0 방지 — `clientWidth > 10` 가드 추가 (startVisualizer와 동일) |

> `npx tsc --noEmit` — 빌드 통과 확인 완료

## Medium 추가 수정 (Priority 1 + 2 + Phase 7b)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| P1 | peer.ts:755,777 | `isDataTarget !== false` → `=== true` (broadcast/broadcastExcept 양쪽) — undefined 피어 통과 방지 |
| P2 | visualizer.ts:324 | battery saver ON 시 `_retryTimer` clearTimeout 추가 — 낭비 retry 1회 방지 |
| P3 | platform.ts:131 | iOS viewport probe `document.body` null guard 추가 + `_iosViewportProbe` null 체크 |
| P4 | events.ts:40-57 | `once()` wrapper에 `_originalFn` 태깅, `off()`에서 original fn 매칭 — `bus.off(event, originalFn)` 동작 정상화 |
| P5 | playback.ts:201 | lockWatchdog 5s timeout 시 `_pendingPlayTime`/`_pendingPlayDepth` 리셋 추가 |
| P6 | playback.ts:663 | `loadedmetadata` 리스너 + `error` 리스너 → 양쪽 모두 cleanup — 리스너 누수 방지 |
| P7 | engine.ts:384 | AudioContext `statechange` 리스너 재등록 시 이전 리스너 제거 — 누적 방지 |
| P8 | connect.ts:42,46,87 | innerHTML → `textContent` + `replaceChildren` — i18n XSS surface 제거 |
| P9 | blob-manager.ts:117 | Queue overflow eviction: attached-only 루프 시 oldest defer → unbounded growth 방지 |
| P10 | preload.ts:361 | `drainPreloadReorderBuffer`를 `setTimeout(0)`으로 지연 — OPFS_START→WRITE race 방지 |
| P11 | recovery.ts:98 | raw `setTimeout` → `setManagedTimer('recovery-backoff')` — leaveSession 시 자동 취소 |
| P12 | settings.ts:449 | EQ 'off' 클릭: `syncEqSlidersToPreset` 선호출 제거, `resetEQ()`만 호출 — 3중 DOM write 방지 |

> `npx tsc --noEmit` — 빌드 통과 확인 완료

## 최종 배치 수정 (Pattern B + 잔여 Medium)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| F1 | peer.ts:509 | joinSession retry raw `setTimeout` → `setManagedTimer('join-retry')` |
| F2 | peer.ts:536 | host-unreachable 15s timeout → `setManagedTimer('join-timeout')` + `clearManagedTimer` on open |
| F3 | sync.ts:175 | `requestGlobalResyncDelayed` raw setTimeout + state 저장 → `setManagedTimer('global-resync')` |
| F4 | sync.ts:72-73 | `_syncSampleTimer`/`_syncTimeoutTimer` → `setManagedTimer('sync-sample')`/`setManagedTimer('sync-timeout')` + 모듈 변수 제거 |
| F5 | sync.ts:396 | heartbeat in-place `p.status = 'disconnected'` → stalePeerIds 수집 후 immutable filter |
| F6 | relay.ts:412 | preload 매칭 `currentTrackIndex` → `preload.nextTrackIndex` (올바른 비교 대상) |
| F7 | opfs.ts:103 | cleanup listener `filename` 매칭에 `buildSafeOpfsName` 추가 — concurrent cleanup 혼선 방지 |

> `npx tsc --noEmit` — 빌드 통과 확인 완료

---

## 전체 수정 통계

| 카테고리 | 수량 |
|----------|------|
| High (원본 9 + Late 3) | **12/12** |
| Medium (원본 15 + Late 1 + P1~P12 + F1~F7) | **35건** |
| **총 수정** | **47건** |

**Medium 미수정 (잔여 ~9건):**

- 패턴 A (in-place state mutation): preload.ts sessionState Map — 내부 전용, 이벤트 불필요
- 낮은 위험: relay downstream limit, protocol spoofing, media-session mismatch 등
- 대규모 리팩터: playlist.ts IDLE flash, transfer.ts broadcastFile cancel race
- 의도적 설계/오탐: playback.ts safeOffset===duration, effects.ts non-OP stereo (UI에서 차단)

## Low 수정 완료 (17건)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| LW1 | playback.ts:317 | `videoElement.volume = 0` 중복 제거 (muted면 불필요) |
| LW2 | playlist.ts:363 | repeatMode `Math.max(0, Math.min(2, v))` 클램프 추가 |
| LW3 | transfer.ts:135 | `data.index as number ?? 0` 괄호 명시 → `(data.index as number) ?? 0` |
| LW4 | transfer.ts:384 | `data.name as string` undefined 시 null fallback 추가 |
| LW5 | settings.ts:298 | `localStorage.setItem` try-catch 추가 (Safari private mode) |
| LW6 | toast.ts:30 | progress bar width 비교에 `'0%'` 포함 — fragile 비교 수정 |
| LW7 | setup.ts:789 | `showDialog().then()` → `.catch()` 추가 |
| LW8 | opfs.ts:24 | `OPFS_INSTANCE_ID` alias 제거 → `INSTANCE_ID` 직접 사용 |
| LW9 | youtube/player.ts:255 | ENDED 시 `clearManagedTimer('youtubeSyncLoop')` 추가 — IDLE tick 방지 |
| LW10 | video.ts:111 | `videoElement.src` → `getAttribute('src')` — src='' 정규화 오판 방지 |
| LW11 | player-controls.ts:544 | peer-disconnected에서 불필요 `updateInviteCodeUI()` 호출 제거 |
| LW12 | connect.ts:330 | MutationObserver 중복 방지 — `_langObserver.disconnect()` 후 재생성 |
| LW13 | i18n/index.ts:87 | `data-i18n` + `data-i18n-html` 동시 존재 시 textContent 스킵 |
| LW14 | effects.ts:534 | `handleReverbTypeMsg` `!data.value` → `data.value == null` (''/'0' 허용) |
| LW15 | protocol.ts:39 | `RELAYABLE_COMMANDS` Array → Set 전환 (O(1) lookup) + 테스트 업데이트 |
| LW16 | types/index.ts:141 | `file-chunk.chunk` 타입 `Uint8Array` → `Uint8Array \| ArrayBuffer` |
| LW17 | transfer.worker.ts:187 | `opfsObj.sessionId!` → null 체크 추가 |

> `npx tsc --noEmit` — 빌드 통과 확인 완료

---

## 최종 전체 통계

| 카테고리 | 수정 / 전체 |
|----------|-------------|
| **High** | 12 / 12 (100%) |
| **Medium** | 35 / 56 (63%) |
| **Low** | 17 / 48 (35%) |
| **총 수정** | **64건** |

---

## Phase 15 재탐색 — 추가 수정 (20건)

### Medium 추가 수정 (6건)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| R1 | state.ts:420 | `snapshot()` dead `structuredClone` try/catch 제거 → JSON-only 경로만 유지 |
| R2 | engine.ts:437 | `audio:connect-surround` splitter disconnect를 playerNode connect 전으로 이동 → 순간 잘못된 라우팅 방지 |
| R3 | playback.ts:598 | dead `_skipTabSync` 파라미터 제거 → `_unused?: boolean`로 교체 |
| R4 | relay.ts:300 | `MAX_DOWNSTREAM_PEERS = 8` 상수 + 초과 시 reject → 리소스 고갈 방지 |
| R5 | setup.ts:593 | `.onclick =` → `addEventListener` with AbortController signal — 재호출 시 리스너 정리 |
| R6 | playlist-view.ts:193 / dom.ts:110 | `updateTitleWithMarquee` 동일 텍스트 가드 추가 → re-render 마키 깜빡임 방지 |

### Low 추가 수정 (14건)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| RW1 | state.ts:81 | `sync.resyncTimer` StateTree 인터페이스 + 초기값 제거 (managed timer로 이전됨) |
| RW2 | sync.ts:177 | orphaned `setState('sync.resyncTimer', null)` 제거 |
| RW3 | playback.ts:853 | `data.index as number` → `data.index != null ? Number(data.index) : undefined` 명시적 coercion |
| RW4 | playback.ts:1062 | `ackSent.clear()` in-place → `setState('preload.ackSent', new Set())` immutable update |
| RW5 | video.ts:149 | video→audio 전환 시 `visibility`/`pointer-events` 인라인 스타일 cleanup |
| RW6 | protocol.ts:137 | relay echo 방지: `senderPeerId` 추출 + `!senderPeerId \|\|` guard (conn undefined 시) |
| RW7 | peer.ts:87 | `peerSlotByPeerId` Map in-place → `new Map()` + `setState()` immutable update (assign/release 양쪽) |
| RW8 | relay.ts:434 | `(meta.index as number) \|\| 0` → `?? 0` — index=0 보존 |
| RW9 | preload.ts:645 | raw `setTimeout` → `setManagedTimer('preload-play-retry')` |
| RW10 | preload.ts:669 | raw `setTimeout` → `setManagedTimer('preload-recovery-jitter')` |
| RW11 | settings.ts:287 | surround ON 더블클릭 가드 — `stereoWidth > 1` 이미 ON이면 early return |
| RW12 | dom.ts:93 | overflow 없을 때 `style.removeProperty('animation')` — stale 'none' 잔존 방지 |
| RW13 | youtube/player.ts:849 + playlist.ts:107,187,719 + types | `youtube:sub-seek` → `playlist:play-track(idx, subIdx)` → `youtube:load(..., subIdx)` 체인 완성 |
| RW14 | youtube/sync.ts:182 | `duration ≤ 0` early return → drift correction만 스킵, state sync(play/pause)는 항상 적용 |

### 스킵 사유 (이번 배치)

| 파일 | # | 사유 |
|------|---|------|
| player-controls.ts | #2 | `clearInterval` 동기 실행 — JS 단일 스레드에서 추가 callback 불가 (false positive) |
| connect.ts | #3 | 이벤트 위임으로 분리된 2개 click handler — 통합 시 가독성 저하 |
| dom.ts | #1 | rAF 내 scrollWidth 읽기 — 표준 측정 패턴 |
| youtube/player.ts | #2 | sessionId guard가 콜백 덮어쓰기 정확히 처리 — 최신 호출만 진행 |
| youtube/player.ts | #4 | ENDED 핸들러에 `clearManagedTimer('youtubeSyncLoop')` 이미 존재 (LW9에서 수정) |
| peer.ts | #7 | 새 conn 저장 후 old conn close — close handler가 새 conn 참조하므로 올바른 순서 |
| media-session.ts | #1 | YouTube 버퍼링 상태 실시간 쿼리 불가 — 알려진 한계 |
| search.ts | #2 | `_isFetching.clear()` → `_isFetching.delete(playlistId)` targeted delete 적용 완료 |

> `npx tsc --noEmit` — 빌드 통과 확인 완료

---

## Phase 16 — 잔여 정리 (13건)

### Medium 추가 수정 (4건)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| S1 | channel.ts:102 | `toggleSurroundMode(false)` 시 `audio:disconnect-surround` 이벤트 발행 → playerNode→splitter 입력 해제 |
| S2 | playlist.ts:688 | `player:ended` auto-advance에 `_endedAdvanceToken` 가드 추가 → double-skip 방지 |
| S3 | preload.ts:41 | `cleanupStalePreloadSessions` sessionState Map in-place delete → immutable `new Map()` + `setState` |
| S4 | playback.ts:758 | `t('error.audio_decoding')` → `t('toast.decoding_audio')` + en.ts/ko.ts 키 추가 |

### Low 추가 수정 (9건)

| # | 파일 | 수정 내용 |
|---|------|-----------|
| SW1 | channel.ts:60-91 | no-op `rampTo(1)` 4개 제거 (gain.value=1 하드셋 직후 중복) + 미사용 `ramp` 변수 제거 |
| SW2 | channel.ts:67,72 | "Left (Dual Mono)" → "Left Only: L→both speakers", "Right (Dual Mono)" → "Right Only: R→both speakers" |
| SW3 | session.ts:45 | `_warnedBadSessionIds` size>200 시 `.clear()` → oldest 절반 evict |
| SW4 | platform.ts:227 | `initPlatform` DOMContentLoaded 중복 가드 제거 (bootstrap이 이미 보장) |
| SW5 | timers.ts:25 | setTimeout 콜백 fn() throw 시 try-catch + console.error 추가 |
| SW6 | chat.ts:345 | relay broadcast-except: `conn?.peer` → `senderId` 우선 사용 (relay 노드가 아닌 원본 sender 제외) |
| SW7 | playlist-view.ts:34 | `updatePlaylistUI()` 직접 호출 → `bus.emit('ui:update-playlist')` rAF 디바운스 활용 |
| SW8 | engine.ts:101,211 | ensureSurroundNodes/StereoWidener 설명 코멘트 추가 (의도적 설계 문서화) |
| SW9 | relay.ts:126 | session ID `<` 비교 wrap-around 안전성 설명 코멘트 추가 |

### 스킵 사유 (잔여 19건)

| 항목 | 사유 |
|------|------|
| playlist.ts #1 (IDLE flash) | 상태 머신 전면 리팩터 필요 |
| transfer.ts #5/#6 (broadcast race) | 세션 관리 재설계 필요 |
| channel.ts #5 (7.1 downmix) | 의도적 5.1 fallback 설계 |
| preload.ts #7 (OPFS race) | P10에서 이미 완화 |
| protocol.ts #1 (spoofing) | 기존 strip+log 충분 |
| media-session.ts #1/#2 | YouTube API 한계 |
| youtube/player.ts #1 | Guest OP 상태 동기화 복잡 |
| events.ts #2 | state:* 패턴 지원 필수 |
| orchestrator.ts #3 | TOCTOU 근본적 한계 |
| sync.ts #4 | timeout fallback 정상 동작 |
| playlist.ts #4 | autoplay 정책 제약 |
| platform.ts #2 | gesture nav 감지 불가 |
| timers.ts (interval) | interval fn throw는 정상 동작 |
| relay.ts (wrap) | MAX_SAFE_INTEGER 도달 불가 |
| preload.ts #2 (backpressure) | 30s timeout 존재 |
| playlist.ts #3 (shuffle -1) | 의도적 guard |
| playlist-view.ts (expansion toggle render) | 이미 SW7에서 수정 |
| engine.ts #3 (statechange 누적) | P7에서 이미 수정 |
| connect.ts #3 (stepper listeners) | 이벤트 위임으로 분리, 통합 불필요 |

> `npx tsc --noEmit` — 빌드 통과 확인 완료

---

## Phase 17 — 전면 리팩터/재설계 (T1–T5)

| # | 파일 | 항목 | 수정 내용 | 분류 |
|---|------|------|-----------|------|
| T1 | playlist.ts | #1 (IDLE flash) | `stopAllMedia({ silent: true })` 옵션 추가, playTrack 내 3곳에서 사용 → IDLE→PLAYING 깜빡임 제거 | Medium |
| T2 | transfer.ts | #5/#6 (broadcast cancel race) | 새 broadcast 시작 전 `setState(null)` + `setTimeout(0)` yield, unicast에 per-peer `_activeUnicasts` Map 기반 abort 제어 추가 | Medium |
| T3 | youtube/player.ts | #1 (Guest OP mismatch) | OP Guest의 play/pause → `REQUEST_YOUTUBE_TOGGLE` 신규 MSG로 host에 위임, host가 자체 playerState 기준 play/pause 결정 | Medium |
| T4 | channel.ts | #5 (7.1→5.1 downmix) | BL/BR 선택 시 SL/SR 이중 연결 제거 → 7.1에서 정확한 채널만 재생, 5.1에서는 올바르게 silence | Low |
| T5 | types/index.ts | ProtocolMap 동기화 | `request-youtube-toggle: {}` 추가 (T3 필요) | — |

### 스킵 사유 (2건)

| 항목 | 사유 |
|------|------|
| protocol.ts #1 (relay origin spoofing) | relay 토폴로지 추적 필요 → 현재 strip+log 충분, 공격자가 이미 connected peer여야 하므로 실질 위험 낮음 |
| media-session.ts #1/#2 (YouTube API 한계) | YouTube IFrame API가 MediaSession metadata/position 미지원 — 근본적 API 한계 |

> `npx tsc --noEmit` — 빌드 통과 확인 완료

---

## 최종 전체 통계

| 카테고리 | 수정 / 전체 |
|----------|-------------|
| **High** | 12 / 12 (100%) |
| **Medium** | 48 / 56 (86%) |
| **Low** | 41 / 48 (85%) |
| **총 수정** | **101건** |

**Medium 미수정 (잔여 8건):** protocol.ts relay spoofing (strip+log 충분), media-session.ts #1/#2 (YouTube API 한계), orchestrator.ts #3 (TOCTOU 근본적), preload.ts #7 (P10에서 완화), sync.ts #4 (timeout fallback 정상), playlist.ts #4 (autoplay 정책)

**Low 미수정 (잔여 7건):** events.ts escape-hatch (필수), platform gesture nav (감지 불가), relay wrap (현실 발생 불가), preload backpressure (30s timeout), playlist shuffle -1 (의도적), engine.ts statechange (P7에서 수정), connect.ts stepper (분리 불필요)
