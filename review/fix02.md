# MUSIXQUARE 전체 코드 리뷰 — 86개 파일 순차 검토

> 리뷰 일시: 2026-03-11
> 방법:
> - **Phase 1**: 5개 에이전트 병렬 — 파일별 한 줄씩 읽기 (app.ts → core/ → audio/ → network/ → player/ → storage/ → workers/ → youtube/ → i18n/ → types/ → ui/)
> - **Phase 2**: 30개 Opus 에이전트 병렬 검증 — 파일별 교차 참조 (cross-reference) 검토, false positive 식별, 누락 이슈 발굴
> - **Phase 2b**: State path audit 에이전트 + Types verification 에이전트
> 범례: ~~취소선~~ = 의심했으나 확인 후 문제 아님으로 판단 (Phase 1 또는 Phase 2에서 판별)

---

## 1. src/app.ts

### ~~#001 [Minor] `safeInit`이 async 함수의 에러를 잡지 못함~~
- **위치**: 206-208줄
- ~~향후 async init 추가 시 rejected Promise가 catch에 잡히지 않음~~
- **Phase 2 판정**: FALSE POSITIVE — 모든 init 함수가 `(): void` (동기). async 함수를 넘기면 TypeScript 타입 체크에서 걸림

### ~~#002 [Warning] `t()` 호출 시점 문제 — `checkSystemCompatibility`~~
- **위치**: 79, 86, 298줄
- ~~`initI18n`이 비동기로 로드한다면 100ms 내 번역이 준비 안 될 수 있음~~
- **Phase 2 판정**: FALSE POSITIVE — `t()`는 모듈 평가 시점에 동기적으로 동작. i18n 딕셔너리가 정적 import되어 `_resolved`가 모듈 로드 시 설정됨

### #003 [Minor] `_wakeLockActive` 플래그가 `acquireWakeLock()` 성공 전에 설정됨
- **위치**: 148-152줄
- 첫 호출이 permission denied로 실패해도 `_wakeLockActive = true`가 유지되어, 이후 호출이 skip됨. `visibilitychange`에서 재시도하므로 치명적이진 않음
- **Phase 2**: VERIFIED

### #087 [Minor] 키보드 단축키 P/S가 Ctrl/Cmd 조합에서도 발동 *(NEW)*
- **위치**: 키보드 이벤트 핸들러
- `P` (재생/일시정지), `S` (정지) 단축키가 `event.ctrlKey || event.metaKey` 체크 없이 등록되어, Ctrl+P(인쇄), Cmd+S(저장) 등 브라우저 기본 동작과 충돌 가능

### #088 [Info] app.ts ↔ setup.ts 순환 import *(NEW)*
- app.ts가 setup.ts를 import, setup.ts가 app.ts를 import — Vite ES 모듈 환경에서는 hoisting으로 동작하지만 구조적 의존성 순환

---

## 2. src/core/state.ts

### #004 [Warning] `transfer.meta` 초기값이 `{}` — `null`이어야 함
- **위치**: 213줄
- `preload.meta`는 `null`로 초기화되는데, `transfer.meta`는 `{}`(truthy). `if (meta)`로 "전송 중 메타 존재 여부"를 체크하는 코드가 초기 상태에서 false positive 발생 가능
- **Phase 2**: VERIFIED

### #005 [Warning] `setState` 참조 동등성으로 인한 이벤트 누락
- **위치**: 361줄
- `oldValue === value` (참조 비교)만 사용. 배열/객체를 in-place 수정 후 같은 참조로 `setState` 하면 이벤트가 발생하지 않음
- **Phase 2**: VERIFIED — 코드베이스 전체에서 17+ 인스턴스 확인 (#112 참조)

### #006 [Warning] `resetState()`가 bus 이벤트를 발생시키지 않음
- **위치**: 439-441줄
- 테스트 전용이라 현재는 문제없지만, 프로덕션에서 호출 시 모든 UI/모듈이 stale 상태를 가지게 됨
- **Phase 2**: VERIFIED

### ~~#007 [Minor] `snapshot()`에서 `structuredClone`이 DataConnection 객체에 실패~~
- ~~`structuredClone` 실패 시 JSON fallback에서 `.close()` 메서드 체크로 DataConnection을 `'[Connection]'`으로 대체 — 올바르게 처리됨~~

---

## 3. src/core/events.ts

### #008 [Minor] `once()` 리스너를 `bus.off(event, originalFn)`으로 제거 불가
- **위치**: 40-46줄
- `once`는 내부 `wrapper`를 등록하므로, 원본 함수로 `off()` 호출 시 제거 안 됨. 반환된 unsubscribe 함수만 사용 가능
- **Phase 2**: VERIFIED

---

## 4. src/core/constants.ts

> **Phase 1 판정**: "검토 완료 — 이상 없음" → **Phase 2에서 오판 확인. 다수 dead code 발견.**

### #089 [Warning] 4개 dead MSG 상수 — 전송/처리 코드 없음 *(NEW)*
- `MSG.STATUS_SYNC` — 전송 없음, 핸들러 없음
- `MSG.FORCE_SYNC_PLAY` — 전송 없음, 핸들러 없음
- `MSG.REQUEST_REVERB_RESET` — 전송 없음, 핸들러 없음
- `MSG.SYS_TOAST` — 전송 없음, 핸들러 없음
- types/index.ts의 ProtocolMap에도 대응 타입 정의 존재 → 타입도 dead code

### #090 [Minor] 6개 unused DELAY 멤버 *(NEW)*
- `DELAY.UI_REFRESH`, `DELAY.TRANSITION`, `DELAY.DEBOUNCE`, `DELAY.CONNECTION_CHECK`, `DELAY.JOIN_TIMEOUT`, `DELAY.RECOVERY_COOLDOWN`
- 코드베이스 어디에서도 참조되지 않음

### #091 [Minor] `MSG.SESSION_START` 핸들러 등록됨, 전송 코드 없음 *(NEW)*
- `youtube/sync.ts:310`에서 핸들러 등록되지만, 어떤 모듈도 `MSG.SESSION_START`를 `conn.send()`하지 않음
- 핸들러가 도달 불가능한 dead code

---

## 5. src/core/log.ts

### #009 [Minor] `setLogLevel` JSDoc 예시가 소문자인데 실제로는 대문자만 허용
- **위치**: 29-34줄
- JSDoc: `setLogLevel('debug')` → 실제로는 `LOG_LEVEL['debug']`가 `undefined`이므로 silent no-op
- **Phase 2**: VERIFIED

---

## 6. src/core/platform.ts

### #010 [Warning] iOS Safari에서 viewport probe DOM 엘리먼트가 매 리사이즈마다 생성/삭제
- **위치**: 127-136줄
- `updateAppHeightNow()`가 resize, orientationchange, visibilitychange 등에서 호출될 때마다 `<div>` probe를 createElement → appendChild → removeChild. reflow 유발
- **Phase 2**: VERIFIED

---

## 7. src/core/session.ts

검토 완료 — 이상 없음. overflow 보호, sentinel 값 0 처리, warn 캐시 크기 제한 모두 올바르게 설계됨.
- **Phase 2**: VERIFIED

---

## 8. src/core/blob-manager.ts

### #011 [Warning] `safeRevoke(url, { force: true })`에서 force가 무시되는 경우
- **위치**: 108줄
- `_pendingRevocations.has(url)` 체크가 `force` 플래그 확인보다 먼저 실행됨
- **Phase 2**: VERIFIED

### #012 [Minor] `flushDeferred()`가 즉시 revoke가 아닌 재스케줄링됨
- **위치**: 149-158줄
- flush 의도는 "즉시 정리"이나, 내부적으로 `DELAY.BLOB_REVOCATION` 만큼 다시 지연됨
- **Phase 2**: VERIFIED

### #013 [Note] `flushDeferred()`를 주기적으로 호출하는 곳 없음
- **위치**: 143줄
- `_deferredUntilDetached`에 들어간 URL은 외부에서 명시적 호출 필요. 자동 정리 메커니즘 부재
- **Phase 2**: VERIFIED

---

## 9. src/core/timers.ts

검토 완료 — 이상 없음.
- **Phase 2**: VERIFIED

---

## 10. src/audio/engine.ts

### #014 [Minor] StereoWidener 초기값 `1.0`이 applySettings 적용값 `0.5`와 불일치
- **위치**: 204줄
- **Phase 2**: VERIFIED — 오디오 소스 없는 시점이라 실제 문제 아니지만 초기값 불일치

### #015 [Minor] AudioContext `statechange` 리스너 제거 안 됨
- **위치**: 382-387줄
- **Phase 2**: VERIFIED

### #016 [Note] `disposeAudio()` 함수 부재
- 30+개 모듈 스코프 Tone.js 노드가 생성되지만 dispose 함수 없음
- **Phase 2**: VERIFIED

---

## 11. src/audio/effects.ts

### #017 [Warning] `MSG.REQUEST_REVERB_RESET` 정의만 존재, 핸들러/전송 코드 없음 (데드 프로토콜)
- **위치**: constants.ts:88, types/index.ts:192
- **Phase 2**: VERIFIED — #089와 연결

### #018 [Minor] `cutoff`(서브우퍼 컷오프) 변경이 네트워크로 broadcast 안 됨
- **위치**: effects.ts:377-379
- **Phase 2**: VERIFIED

### #092 [Warning] `setEQ`가 audio 모듈에서 DOM 직접 조작 (아키텍처 위반) *(NEW)*
- **위치**: effects.ts 내 `setEQ()` 함수
- audio 모듈이 `document.querySelector`로 EQ 슬라이더 DOM을 직접 조작. audio ↔ UI 레이어 분리 원칙 위반
- UI 업데이트는 bus 이벤트를 통해 UI 모듈에서 처리해야 함

### #093 [Minor] Peer bootstrap 시 channelMode, surroundMode, subFreq 누락 *(NEW)*
- 새 피어 접속 시 host가 전송하는 audio 설정에 channelMode, surroundMode, subFreq가 포함되지 않음
- 게스트의 audio 채널 설정이 host와 불일치할 수 있음

---

## 12. src/audio/channel.ts

검토 완료 — surround 모드 전환, 채널 모드 fallback 처리 올바름.
- **Phase 2**: VERIFIED

---

## 13. src/network/peer.ts

### #019 [Warning] State Map/Object 직접 변이 — setState 미호출
- **위치**: 87-88, 101-102, 277, 325, 347-348, 370-371, 419-421, 448-450줄
- **Phase 2**: VERIFIED — 17개 인스턴스 확인. `peerSlotByPeerId`, `activeHostConnByPeerId`, `peerLabels`, `peerObj.status/lastHeartbeat` 모두 직접 변이
- 현재 해당 state path에 `bus.on('state:...')` 리스너가 없어 즉각적 런타임 버그는 아니지만, 향후 리스너 추가 시 silent failure

### #020 [Minor] `joinSession` 재시도 중 외부에서 중복 호출 시 보호 없음
- **위치**: 506-512줄
- **Phase 2**: VERIFIED

### #021 [Minor] `window.toggleOperator` 전역 함수 노출
- **위치**: 1036-1038줄
- **Phase 2**: VERIFIED

### ~~#022 [Note] conn close + error 이벤트 이중 발생 시 cleanup 중복~~
- ~~`activeHostConnByPeerId.get(peerId) !== conn` 가드로 두 번째 이벤트의 cleanup이 올바르게 skip됨~~

### #094 [Minor] Pre-open 연결 에러가 silent swallow *(NEW)*
- 연결이 open되기 전에 발생하는 error 이벤트가 `conn.on('error')` 핸들러에서 기록만 되고 연결 정리가 안 됨
- open 전 에러 시 연결 객체가 stale 상태로 남을 수 있음

---

## 14. src/network/protocol.ts

### ~~#023 [Warning] `RELAYABLE_COMMANDS`에 `MSG.FORCE_SYNC_PLAY` 누락~~
- ~~Host가 `FORCE_SYNC_PLAY`를 보내면 relay 노드가 downstream 피어에게 전달하지 않음~~
- **Phase 2 판정**: FALSE POSITIVE — `FORCE_SYNC_PLAY`는 dead code. 코드베이스 어디에서도 전송/처리하지 않음 (#089 참조). RELAYABLE_COMMANDS 목록은 모든 live command에 대해 정확함

### #024 [Note] `registerHandler` 덮어쓰기 시 경고만 출력, 에러 아님
- **위치**: 64-68줄
- **Phase 2**: VERIFIED

---

## 15. src/network/sync.ts

### #025 [Warning] Heartbeat monitor와 peer.ts close 핸들러가 `network:peer-disconnected` 이중 emit
- **위치**: sync.ts:395-416, peer.ts:409-435
- **Phase 2**: VERIFIED — 원래 보고보다 심각. heartbeat monitor가 `activeHostConnByPeerId`를 정리하지 않아, peer.ts close 핸들러의 conn guard가 이중 emit을 방지하지 못함

### #026 [Minor] `_syncSampleTimer`, `_syncTimeoutTimer`가 raw setTimeout 사용
- **위치**: 72-73, 82-88줄
- **Phase 2**: VERIFIED

### #027 [Minor] `requestGlobalResyncDelayed`가 타이머 핸들을 state에 저장
- **위치**: 179-191줄
- **Phase 2**: VERIFIED

### #095 [Minor] `sync.latencyHistory`, `sync.lastLatencyMs` 세션 종료 시 미초기화 *(NEW)*
- 세션에서 나간 후에도 이전 세션의 latency 데이터가 state에 남아, 새 세션 접속 시 stale latency 값이 사용될 수 있음

### #096 [Minor] `handleGlobalResyncRequest`의 fire-and-forget setTimeout *(NEW)*
- **위치**: 281줄
- setTimeout 콜백이 cleanup 없이 발동. 세션 종료 후에도 콜백이 실행되어 stale state 접근 가능

---

## 16. src/network/relay.ts

### #028 [Warning] downstream relay 연결에 `error` 이벤트 핸들러 없음
- **위치**: relay.ts:288-324
- **Phase 2**: VERIFIED

### #029 [Minor] OPFS catch-up pump stuck 재시도에 최대 횟수 없음
- **위치**: 136-144줄
- **Phase 2**: VERIFIED

### #030 [Minor] relay recovery 요청 시 `index`가 -1일 수 있음
- **위치**: 226-234줄
- **Phase 2**: VERIFIED

### #097 [Warning] OPFS read-error가 catchup 요청에서 silent 무시 *(NEW)*
- catchup 태그가 붙은 OPFS 읽기 요청이 실패 시 에러가 기록만 되고, 클라이언트에게 실패 응답이 전송되지 않음
- 클라이언트는 응답을 무한 대기 → #029의 무한 재시도 루프의 **근본 원인**

---

## 17. src/network/orchestrator.ts

검토 완료 — `relayAssignments` cleanup 올바르게 동작.
- **Phase 2**: VERIFIED

---

## 18. src/player/playback.ts

### #031 [Warning] `_internalPlay` — video-only 파일에서 비디오 재생 시작 안 됨
- **위치**: 281-338줄
- **Phase 2**: VERIFIED

### #032 [Warning] `_pendingPlayDepth >= 2`일 때 pending play가 drop될 수 있음
- **위치**: 216-227줄
- **Phase 2**: VERIFIED

### #033 [Minor] preload watchdog가 raw `setTimeout` 사용
- **위치**: 1291-1308줄
- **Phase 2**: VERIFIED

### #034 [Minor] 에러용 toast 키가 일반 처리 중에 사용됨
- **위치**: 739, 1080줄
- **Phase 2**: VERIFIED

---

## 19. src/player/playlist.ts

### #035 [Warning] 이전 트랙 버튼이 마지막 트랙으로 순환하지 않음
- **위치**: 336줄
- **Phase 2**: VERIFIED

### #036 [Note] 첫 트랙 로드 시 auto-play 안 함 (의도적)
- **위치**: 216-228줄
- **Phase 2**: VERIFIED — 브라우저 autoplay 정책 대응

---

## 20. src/player/video.ts

### #037 [Warning] `updateBodyModeClass` early return 후 인라인 스타일 미갱신
- **위치**: 135줄
- **Phase 2**: VERIFIED

### #038 [Minor] `isMediaVideo`에서 `(blob as File).name` — File이 아닌 Blob에 name 없음
- **위치**: 46줄
- **Phase 2**: VERIFIED

---

## 21. src/player/media-session.ts

### #039 [Minor] IDLE 상태에서 `playbackState`가 `'paused'`로 설정됨
- **위치**: 128-132줄
- **Phase 2**: VERIFIED

---

## 22. src/storage/opfs.ts

### #040 [Note] `bus.on('worker:sync-command')`가 모듈 스코프에서 등록됨
- **위치**: 247-251줄
- **Phase 2**: VERIFIED

---

## 23. src/storage/transfer.ts

### #041 [Critical] Resume 전송이 절대 완료되지 않는 버그 — 두 개의 독립적 원인
- **위치**: transfer.ts:431,449,522-524,629줄
- **원인 1** (Phase 1 발견): `handleFileResume`에서 `receivedCount = 0`으로 리셋(431줄) → 완료 체크 `receivedCount >= total`(629줄)이 offset 미적용으로 영원히 미달
- **원인 2** (Phase 2 발견): `handleFileChunk`(522-524줄)에서 reorder buffer에 해당 세션이 없으면 `nextExpectedChunk = 0`으로 무조건 리셋. `handleFileResume`(430줄)이 reorder buffer를 clear했으므로, resume 후 첫 청크 도착 시 `nextExpectedChunk`가 `startChunk` → `0`으로 덮어씌워짐
- **Phase 2**: VERIFIED + 두 번째 독립 버그 추가 확인. **전체 resume/recovery 경로가 두 가지 독립적인 방법으로 깨져 있음**

### #042 [Warning] `broadcastFile` backpressure가 모든 피어를 순차 블로킹
- **위치**: 798-806줄
- **Phase 2**: VERIFIED

### #043 [Minor] `fileReorderBuffer`가 포기된 세션에서 정리 안 됨
- **위치**: 30줄
- **Phase 2**: VERIFIED

---

## 24. src/storage/preload.ts

### #044 [Note] repeat-one 모드에서 이미 로드된 같은 트랙을 preload 시도
- **위치**: 83-84줄
- **Phase 2**: VERIFIED

### #045 [Minor] preload watchdog가 매 progress마다 리셋 — 느린 전송을 감지 못함
- **위치**: 442-451줄
- **Phase 2**: VERIFIED

### #046 [Minor] `handlePlayPreloaded` retry/jitter가 raw `setTimeout` 사용
- **위치**: 644-695줄
- **Phase 2**: VERIFIED

---

## 25. src/storage/recovery.ts

### #047 [Warning] backoff 후 stale connection 참조 사용
- **위치**: 96-125줄
- **Phase 2**: VERIFIED

---

## 26. src/workers/sync.worker.ts

검토 완료 — 이상 없음.
- **Phase 2**: VERIFIED

---

## 27. src/workers/transfer.worker.ts

### #048 [Warning] OPFS integrity 실패 시 recovery 미트리거
- **위치**: 371-372, 388-389줄
- **Phase 2**: VERIFIED

### #049 [Minor] `OPFS_READ` 중 `OPFS_START` 도착 시 SyncAccessHandle 충돌 가능
- **위치**: 470-487줄
- **Phase 2**: VERIFIED — read 측 try/catch + async fallback이 있어 Minor로 하향

### #098 [Warning] OPFS_WRITE_ERROR가 silent swallow — 데이터 무결성 위험 *(NEW)*
- 청크 쓰기 실패 시 에러가 기록만 되고 main thread에 전달되지 않음
- 실패한 청크가 빈 상태로 남아 파일 데이터 손상 (silent data corruption)
- main thread는 성공으로 인식하고 `receivedCount`를 증가시킴

### #099 [Minor] OPFS_START lock 실패 시 transfer.state가 RECEIVING에 stuck *(NEW)*
- `OPFS_START` 처리 중 SyncAccessHandle 획득 실패 → `OPFS_ERROR` 전송 → main thread에서 transfer state가 RECEIVING으로 남음
- 후속 전송 시도가 "이미 수신 중" 가드에 걸려 영원히 차단될 수 있음

---

## 28. src/youtube/player.ts

### #050 [Warning] `youtube:load` 이벤트 파라미터 이름 `isSync`이 실제로는 `autoplay` 의미
- **위치**: 561-562줄
- **Phase 2**: VERIFIED — #064, #106과 연결

### #051 [Warning] `null` → `undefined` 변환으로 `videoId` 비교 실패
- **위치**: player.ts:727, 768줄
- `videoId: videoId || undefined` → `undefined !== null` → 항상 false → 타이틀 업데이트 실패
- **Phase 2**: VERIFIED — #062와 연결

### #052 [Warning] iOS 동기화 오버레이 텍스트 하드코딩 (i18n 미적용)
- **위치**: 349줄
- **Phase 2**: VERIFIED

### #053 [Minor] OP 게스트의 재생 토글이 `hostConn.send()` 직접 호출 (`safeSend` 미사용)
- **위치**: 579, 581줄
- **Phase 2**: VERIFIED

### #054 [Warning] `youtube:stop-playback` 시 state `2`(paused) broadcast — 실제론 stopped
- **위치**: 623-632줄
- **Phase 2**: VERIFIED

### #055 [Note] bus.on 핸들러 cleanup/teardown 함수 없음
- **위치**: 559-970줄
- **Phase 2**: VERIFIED

### #100 [Warning] `initYouTubePlayer` abort 경로에서 `_ytLoadInProgress`가 stuck true *(NEW)*
- YouTube 플레이어 초기화 중 abort되면 `_ytLoadInProgress` 플래그가 true로 남아, 이후 모든 YouTube 로드 요청이 차단됨

### #101 [Minor] null/undefined 불일치 — 로컬 state vs 네트워크 broadcast *(NEW)*
- 로컬에서는 `videoId: videoId || undefined`, 네트워크 broadcast에서는 `videoId || null`
- 같은 데이터의 null/undefined 표현이 전송 경계에서 불일치

---

## 29. src/youtube/search.ts

### #056 [Warning] `getState()` 반환 객체를 직접 변이 (immutability 위반)
- **위치**: 270줄
- **Phase 2**: VERIFIED — #085, #112와 연결

### #057 [Minor] `clearPreviewDebounce()`가 진행 중 fetch를 cancel하지 않음
- **위치**: 120-125줄
- **Phase 2**: VERIFIED

---

## 30. src/youtube/sync.ts

### #058 [Warning] `handleSubTitleUpdate`, `handleYouTubePlaylistInfo` — state 직접 변이
- **위치**: sync.ts:248-251, 278-280줄
- **Phase 2**: VERIFIED — #056과 동일 패턴

### #059 [Minor] Drift correction 시 duration이 0이면 `Infinity`
- **위치**: 179-180줄
- **Phase 2**: VERIFIED

---

## 31. src/i18n/index.ts

### #060 [Minor] MutationObserver가 `childList`만 감시 — `data-i18n` 속성 변경 미감지
- **위치**: 115-131줄
- **Phase 2**: VERIFIED

---

## 32. src/i18n/ko.ts + 33. src/i18n/en.ts

### #061 [Note] ko.ts ↔ en.ts 키 완전 일치 확인
- TypeScript `Record<I18nKey, string>` 타입 강제로 213개 키 모두 일치. **문제 없음.**
- **Phase 2**: VERIFIED

---

## 34. src/types/index.ts

### #062 [Warning] `PlaylistItem.videoId`가 `string | null | undefined` 삼중 타입
- **위치**: 62-63줄
- `videoId?: string | null` → optional이면서 nullable → 세 가지 가능
- **Phase 2**: VERIFIED — 코드베이스 전체에서 `|| null`, `|| undefined`, `?? null` 방어적 변환이 매 접근마다 반복됨. 통일 필요

### #063 [Minor] `ProtocolMap['play']`와 `['pause']`의 `state` 필드가 `string`
- **위치**: 134-135줄
- `AppStateValue` 리터럴 유니온이어야 함. `AppStateValue` 타입이 이미 같은 파일에 import되어 있음
- **Phase 2**: VERIFIED

### #064 [Warning] `EventMap['youtube:load']` 세 번째 파라미터 `isSync` — 실제 의미는 `autoplay`
- **위치**: 281줄
- **Phase 2**: VERIFIED — `loadYouTubeVideo` 함수 시그니처에서 해당 파라미터명이 `autoplay`

### #106 [Minor] `sync:response` EventMap의 `oneWayLatencyMs` — 실제 단위는 seconds *(NEW)*
- **위치**: types/index.ts:343
- `oneWayLatencyMs`로 명명되었지만, `sync.ts:153`에서 `(best.rtt / 2) / 1000`으로 계산 → 초(seconds) 단위
- `oneWayLatencyS` 또는 `oneWayLatencySeconds`로 수정 필요

### #107 [Minor] `ChannelMode` 타입이 export되지만 어디서도 사용 안 됨 *(NEW)*
- **위치**: types/index.ts:12
- `export type ChannelMode = -1 | 0 | 1 | 2` 정의됨
- `channel.ts:34`의 `setChannelMode`과 EventMap의 `audio:set-channel-mode`가 모두 `number`를 사용

### #108 [Info] 5개 dead ProtocolMap 엔트리 *(NEW)*
- **위치**: types/index.ts
- `'session-start': {}` — 핸들러 있으나 전송 없음 (#091)
- `'force-sync-play'` — 전송 없음, 핸들러 없음 (#089)
- `'status-sync'` — 전송 없음, 핸들러 없음 (#089)
- `'sys-toast'` — 전송 없음, 핸들러 없음 (#089)
- `'request-reverb-reset'` — 전송 없음, 핸들러 없음 (#089)

### #109 [Note] 모든 프로토콜 핸들러가 `Record<string, unknown>` 사용 — ProtocolMap 타입 무효화 *(NEW)*
- 핸들러마다 `(data: Record<string, unknown>)` 시그니처 사용
- `ProtocolMap`의 정밀한 타입 정의가 핸들러 레벨에서 전혀 강제되지 않음
- 사실상 documentation-only 타입

---

## 35. src/ui/dom.ts

### #065 [Minor] `onMarqueeResize` 리스너가 영구 등록
- **위치**: 116-119줄
- **Phase 2**: VERIFIED

---

## 36. src/ui/player-controls.ts

### #066 [Warning] `handleLogoReturnToMain`의 `isOnMain` 변수명 — 실제 의미와 불일치
- **위치**: 291-296줄
- **Phase 2**: VERIFIED — 실제로는 "setup overlay가 보이는가" 의미

---

## 37. src/ui/settings.ts

### #067 [Warning] Reverb "off" 선택 시 슬라이더 값 미리셋 — stale UI
- **위치**: 396-397줄
- **Phase 2**: VERIFIED

### #068 [Warning] `localStorage.getItem`이 try-catch 없이 호출
- **위치**: 513, 517, 275줄
- **Phase 2**: VERIFIED

### #069 [Minor] EQ "off" 클릭 시 중복 호출
- **위치**: 428-429줄
- **Phase 2**: VERIFIED

### #070 [Note] `_isGuestLocked()`, `_guardHostCtrl()` 중복 정의 (settings.ts + connect.ts)
- **Phase 2**: VERIFIED

### #105 [Minor] Lowcut/highcut 슬라이더가 preset 전환 시 stale 값 표시 *(NEW)*
- Reverb preset 전환 후 lowcut/highcut 슬라이더가 이전 preset의 값을 유지
- 사용자에게 현재 설정과 다른 값이 표시됨

---

## 38. src/ui/setup.ts

### ~~#071 [Warning] `joinSession(code)`가 await 없이 호출 — 동기 throw 시 unhandled rejection~~
- ~~`handleSetupJoinWithRole`가 async인데 `joinSession`의 반환값을 무시~~
- **Phase 2 판정**: FALSE POSITIVE — `joinSession`은 `void`를 반환 (async 아님). unhandled rejection 위험 없음

### #072 [Minor] auto-reconnect에서 여러 state를 개별 setState
- **위치**: 762-777줄
- **Phase 2**: VERIFIED

### #102 [High] Guest join UI가 CONNECT_FAILED/HOST_UNREACHABLE에서 영원히 stuck *(NEW)*
- `network:error` 이벤트 핸들러가 실행될 때 `isConnecting`이 이미 `false`인 상태 (타이밍 레이스)
- `isConnecting = false` 분기에서 join UI 복원 로직이 실행되지 않음
- 사용자가 로딩 상태에서 빠져나올 수 없음 — 페이지 새로고침만이 유일한 탈출구

### #103 [Warning] Auto-reconnect 실패 시 loader가 영원히 표시됨 *(NEW)*
- auto-reconnect 시도가 실패하면 loader를 숨기는 코드가 실행되지 않는 경로 존재
- 사용자에게 영원히 로딩 중으로 표시

---

## 39. src/ui/chat.ts

### ~~#073 [Warning] regex `lastIndex` 관리가 취약~~
- ~~`_ytRegex.lastIndex = 0` 수동 리셋 의존~~
- **Phase 2 판정**: FALSE POSITIVE — `lastIndex = 0` 리셋이 올바르고 방어적으로 정확히 구현됨

### ~~#074 [Warning] `sendChatMessage`에서 connection 유효성 미검증~~
- ~~`hostConn`이 닫힌 상태에서 `sendToHost` 호출 → silent fail~~
- **Phase 2 판정**: FALSE POSITIVE — `sendToHost`가 내부적으로 `safeSend`를 호출, `safeSend`가 `conn.open` 체크 수행

### #104 [Warning] 수신 채팅 메시지에 길이 검증 없음 *(NEW)*
- 피어로부터 수신되는 채팅 텍스트에 `maxLength` 제한이 없음
- 악의적 피어가 매우 긴 문자열을 전송하면 DOM에 삽입되어 렌더링 성능 저하 또는 메모리 문제

---

## 40. src/ui/connect.ts

### ~~#075 [Warning] stepper에 click 리스너 2개 → toast 이중 표시 가능~~
- ~~`.stepper-btn`과 `.stepper-value`가 겹칠 경우 두 핸들러 모두 실행~~
- **Phase 2 판정**: FALSE POSITIVE — `.stepper-btn`과 `.stepper-value`는 sibling 엘리먼트. `.closest()` 매칭이 겹칠 수 없음

### #076 [Minor] QR 코드 copy 버튼이 `navigator.clipboard.writeText` 직접 사용 — fallback 없음
- **위치**: 78줄
- **Phase 2**: VERIFIED

---

## 41. src/ui/playlist-view.ts

### #077 [Warning] `hc.send()` 직접 호출 — `sendToHost()` 미사용
- **위치**: 96, 169줄
- **Phase 2**: VERIFIED

### ~~#078 [Critical] `li.onclick`가 `innerHTML` 할당으로 덮어쓰여짐~~
- ~~onclick은 li 엘리먼트 자체에 등록되어 innerHTML(자식 교체)에 영향 없음~~

---

## 42. src/ui/visualizer.ts

### #079 [Minor] `initVisualizer()`에서 `_retryTimer` 미초기화
- **위치**: 267-269줄
- **Phase 2**: VERIFIED (downgraded from original severity)

### #080 [Minor] `drawIdleVisualizer`가 wrapper 크기 최소값 체크 없음
- **위치**: 227줄
- **Phase 2**: VERIFIED

---

## 43. src/ui/toast.ts

### #081 [Note] `showToast` 내부 변수 `t`가 i18n `t` 함수와 이름 충돌 가능성
- **위치**: 48줄
- **Phase 2**: VERIFIED

---

## 44. src/ui/dialog.ts

### #082 [Warning] `dismissible: false`인데 close 버튼이 `'ok'`로 동작
- **위치**: 144-147줄
- **Phase 2**: VERIFIED

### ~~#083 [Warning] `msgEl.textContent = message` — `\n` 줄바꿈이 시각적으로 표시 안 됨~~
- ~~여러 caller가 `t('key1') + '\n' + t('key2')` 형태로 전달하나, textContent는 `\n`을 무시~~
- **Phase 2 판정**: FALSE POSITIVE — CSS `white-space: pre-wrap`이 적용되어 있어 `\n`이 시각적 줄바꿈으로 올바르게 표시됨

---

## 45. src/ui/tabs.ts

검토 완료 — WAI-ARIA automatic activation 패턴 올바름.
- **Phase 2**: VERIFIED

---

## Cross-File 이슈

### #084 [Critical] Resume 전송 완료 불가 (#041 상세)
- **원인 1**: `receivedCount` 리셋 + offset 미적용
- **원인 2**: `nextExpectedChunk` 무조건 리셋 (reorder buffer 미존재 시)
- 두 버그가 독립적으로 resume를 깨뜨림 — 모든 resume 시도가 chunkWatchdog에 의해 전체 재전송으로 fallback
- **Phase 2**: VERIFIED — "전체 resume/recovery 경로가 두 가지 독립적인 방법으로 깨져 있음" 확인

### #085 [Warning] State 직접 변이 패턴 — 코드베이스 전반
- **Phase 1 식별**: peer.ts (#019), youtube/search.ts (#056), youtube/sync.ts (#058)
- **Phase 2 State Audit 확장**: 25+ 변이 사이트 확인

| State Path | 변이 유형 | 파일 | 라인 수 |
|---|---|---|---|
| `network.peerSlotByPeerId` | `.set()`, `.delete()`, `.clear()` | peer.ts | 3 |
| `network.activeHostConnByPeerId` | `.set()`, `.delete()`, `.clear()` | peer.ts | 5 |
| `network.peerLabels` | bracket assignment, `delete` | peer.ts | 3 |
| `preload.ackSent` | `.add()`, `.has()`, `.clear()` | transfer.ts, preload.ts, playback.ts, peer.ts | 4 |
| `preload.sessionState` | `.set()`, `.get()`, `.delete()`, `.clear()` | preload.ts, peer.ts | 10 |
| `connectedPeers[n].status` | direct assignment | peer.ts | 1 |
| `connectedPeers[n].lastHeartbeat` | direct assignment | peer.ts, sync.ts | 2 |
| `connectedPeers[n].preloadedIndexes` | `.add()` in-place | preload.ts | 1 |
| `youtube.subItemsMap` | bracket assignment | search.ts, sync.ts | 2+ |

- 현재 해당 state path들에 `bus.on('state:...')` 리스너가 없어 즉각적 런타임 버그는 아님
- 단, 향후 리스너 추가 시 silent failure

### #086 [Warning] 이벤트 이름/파라미터 시맨틱 불일치 (#050, #064, #106)
- `youtube:load`의 `isSync` → 실제 `autoplay`
- `sync:response`의 `oneWayLatencyMs` → 실제 단위 seconds
- **Phase 2**: VERIFIED + #106 추가

### #110 [Warning] 4개 EventMap 이벤트 — 리스너 있으나 emit 없음 (dead listener) *(NEW)*
- `audio:toggle-surround` — 리스너: channel.ts:216, emit: 없음
- `audio:set-surround-channel` — 리스너: channel.ts:220, emit: 없음
- `playlist:set-repeat-mode` — 리스너: playlist.ts:691, emit: 없음
- `playlist:set-shuffle` — 리스너: playlist.ts:695, emit: 없음
- 이 리스너들은 절대 실행되지 않는 dead code

### #111 [Minor] `sync.usePingCompensation` — dead state path *(NEW)*
- `createInitialState()`에 정의 (state.ts:79,252), 코드베이스 어디에서도 `getState()` 또는 `setState()` 호출 없음
- 제거 가능한 dead code (주석: "RTT compensation disabled")

### #112 [Note] State 변이 audit 요약 — 활성 리스너가 있는 5개 path는 모두 정상 *(NEW)*
- `state:network.sessionCode` — 5개 리스너, 모든 변경이 setState 경유 ✓
- `state:setup.sessionStarted` — 2개 리스너, 모든 변경이 setState 경유 ✓
- `state:transfer.waitingForPreload` — 1개 리스너, 모든 변경이 setState 경유 ✓
- `state:audio.masterVolume` — 테스트 전용 ✓
- `state:appState` — 테스트 전용 ✓
- **결론**: 활성 리스너가 있는 path에 대해서는 이벤트 누락 버그 없음

---

## 통계 요약

| 심각도 | 건수 |
|--------|------|
| Critical | 2 (#041, #084 — 동일 이슈의 두 가지 독립 원인) |
| High | 1 (#102 — guest join UI stuck) |
| Warning | 30 |
| Minor | 30 |
| Note/Info | 10 |
| ~~취소선 (문제 아님)~~ | 11 (#001, #002, #007, #022, #023, #071, #073, #074, #075, #078, #083) |
| **유효 이슈 합계** | **73** |

> Phase 1 → Phase 2 변화:
> - Phase 1 원본: 86개 항목 (취소선 3개, 유효 83개)
> - Phase 2 신규 false positive: 8개 추가 (#001, #002, #023, #071, #073, #074, #075, #083)
> - Phase 2 신규 발견: 26개 (#087-#112)
> - 최종: 112개 항목 (취소선 11개, 유효 73개 + 통합 카탈로그)

---

## Top 10 중요 이슈 (Phase 2 확정)

1. **#041/#084 [Critical]** — Resume 전송 완료 불가 (두 독립 원인)
2. **#102 [High]** — Guest join UI가 연결 실패 시 영원히 stuck
3. **#098 [Warning]** — OPFS write error silent swallow → 데이터 무결성 위험
4. **#097 [Warning]** — OPFS catchup read-error silent 무시 → 무한 재시도 루프
5. **#100 [Warning]** — YouTube 초기화 abort 시 영구 차단
6. **#051/#062 [Warning]** — `videoId` null↔undefined 비교 실패 → YouTube 타이틀 미갱신
7. **#019/#085/#112 [Warning]** — State 직접 변이 패턴 (25+ 사이트) → reactive 이벤트 누락
8. **#110 [Warning]** — 4개 dead bus 리스너 (surround, repeat, shuffle)
9. **#089/#108 [Warning]** — 4개 dead MSG 상수 + 5개 dead ProtocolMap 엔트리
10. **#103 [Warning]** — Auto-reconnect 실패 시 loader 영구 표시
